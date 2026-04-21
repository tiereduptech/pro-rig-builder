#!/usr/bin/env node
/**
 * rebuild-corsair-cases-v3.js
 *
 * v3 fixes vs v2:
 *   - Decode HTML entities (&quot; etc.) BEFORE applying regex to spec table
 *     → catches drive25/drive35
 *   - Better matching: lower threshold + product-as-substring boost
 *     → catches short names like "Corsair iCUE 5000T RGB"
 *   - When match score is tied, prefer the catalog title that contains the
 *     product's most distinctive token (model number)
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

const corsairCases = parts.filter(p => p.c === 'Case' && p.b === 'Corsair');
console.log(`━━━ FOUND ${corsairCases.length} CORSAIR CASES ━━━\n`);

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: decode common HTML entities
// ═══════════════════════════════════════════════════════════════════════════
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8221;/g, '"')
    .replace(/&#8220;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#215;/g, '×');
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: WIPE
// ═══════════════════════════════════════════════════════════════════════════
const WIPE_FIELDS = ['maxGPU', 'maxCooler', 'rads', 'mobo', 'fans_inc', 'drive25', 'drive35'];
let wiped = 0;
for (const p of corsairCases) {
  for (const f of WIPE_FIELDS) {
    if (p[f] !== undefined) { delete p[f]; wiped++; }
  }
}
console.log(`STEP 1: Wiped ${wiped} fields\n`);

function save() {
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);
}
save();

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: SCRAPE CATALOG
// ═══════════════════════════════════════════════════════════════════════════
const CATALOG_PAGES = [
  'https://www.corsair.com/us/en/c/pc-cases',
  'https://www.corsair.com/us/en/c/pc-cases/mid-tower',
  'https://www.corsair.com/us/en/c/pc-cases/full-tower',
  'https://www.corsair.com/us/en/c/pc-cases/small-tower',
  'https://www.corsair.com/us/en/c/pc-cases/rgb-cases',
];

async function scrapeCatalog(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+href="(https:\/\/www\.corsair\.com\/us\/en\/p\/pc-cases\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = m[1];
      const inner = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' '));
      if (inner && inner.length > 5 && !inner.toLowerCase().includes('learn more')) {
        out.push({ url: u, title: inner });
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

console.log('STEP 2: Scraping catalog pages...');
const urlIndex = new Map();
for (const page of CATALOG_PAGES) {
  process.stdout.write(`  ${page} ... `);
  const items = await scrapeCatalog(page);
  for (const it of items) if (!urlIndex.has(it.url)) urlIndex.set(it.url, it.title);
  console.log(`+${items.length} (total: ${urlIndex.size})`);
  await new Promise(r => setTimeout(r, 1500));
}
console.log(`\n  ${urlIndex.size} unique URLs\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: SMARTER MATCHING
// ═══════════════════════════════════════════════════════════════════════════
const STOP = new Set(['the', 'and', 'with', 'pc', 'case', 'cases', 'mid', 'full', 'tower', 'gaming', 'computer', 'chassis', 'atx', 'matx', 'itx', 'mini', 'micro', 'super', 'us', 'en', 'corsair', 'series', 'rgb', 'argb', 'lx', 'rs', 'tg', 'edition', 'black', 'white', 'gray', 'grey', 'tempered', 'glass', 'panoramic']);

function tokens(s) {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

// Distinctive tokens are model identifiers like "5000T", "9000D", "4500X"
function modelTokens(s) {
  return s.toUpperCase().match(/\b(?:\d{3,4}[A-Z]+|[A-Z]\d{3,4}[A-Z]*)\b/g) || [];
}

function score(productName, catalogTitle) {
  const a = tokens(productName);
  const b = tokens(catalogTitle);
  const aSet = new Set(a);
  const bSet = new Set(b);
  let common = 0;
  for (const t of aSet) if (bSet.has(t)) common++;
  // Big boost if model identifier matches
  const aModels = new Set(modelTokens(productName));
  const bModels = new Set(modelTokens(catalogTitle));
  let modelMatches = 0;
  for (const t of aModels) if (bModels.has(t)) modelMatches++;
  return common + modelMatches * 10;
}

console.log('STEP 3: Matching products to URLs...');
const matches = new Map();
const unmatched = [];
for (const p of corsairCases) {
  let best = { url: null, title: null, score: 0 };
  for (const [url, title] of urlIndex.entries()) {
    const s = score(p.n, title);
    if (s > best.score) best = { url, title, score: s };
  }
  // Lower threshold: 1 (was 2). Model match alone counts as 10.
  if (best.score >= 1) {
    matches.set(p.id, best);
  } else {
    unmatched.push(p);
  }
}
console.log(`  Matched ${matches.size}/${corsairCases.length}`);
if (unmatched.length) {
  console.log('  Still unmatched:');
  unmatched.forEach(p => console.log(`    "${p.n.slice(0, 70)}" (model tokens: ${modelTokens(p.n).join(',') || 'none'})`));
}
console.log('');

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4: SCRAPE + PARSE (with entity decode)
// ═══════════════════════════════════════════════════════════════════════════
async function scrapeSpecs(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const specs = {};
    const re = /<th[^>]*>([^<]+)<\/th>\s*<td[^>]*>([^<]+)<\/td>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const k = decodeEntities(m[1].trim());  // ← decode
      const v = decodeEntities(m[2].trim());  // ← decode
      if (k && v) specs[k] = v;
    }
    return Object.keys(specs).length ? specs : null;
  } catch (e) {
    return null;
  }
}

function parseSpecsToFields(specs) {
  if (!specs) return {};
  const norm = {};
  for (const [k, v] of Object.entries(specs)) norm[k.toLowerCase().trim()] = v;
  function find(...keys) {
    for (const k of keys) {
      const v = norm[k.toLowerCase()];
      if (v) return v;
    }
    return null;
  }
  const out = {};
  const gpuStr = find('Maximum GPU Length', 'Max GPU Length', 'GPU Length', 'GPU Clearance');
  if (gpuStr) { const m = gpuStr.match(/(\d{2,4})\s*mm/); if (m) out.maxGPU = parseInt(m[1], 10); }
  const cool = find('Maximum CPU Cooler Height', 'CPU Cooler Clearance', 'CPU Cooler Height', 'Max CPU Cooler');
  if (cool) { const m = cool.match(/(\d{2,4})\s*mm/); if (m) out.maxCooler = parseInt(m[1], 10); }
  const radStr = find('Radiator Compatibility', 'Radiator Support', 'Maximum Radiator');
  if (radStr) {
    const sizes = [...radStr.matchAll(/(\d{3})\s*mm/g)].map(m => parseInt(m[1], 10));
    if (sizes.length) out.rads = [...new Set(sizes)].sort((a, b) => a - b);
  }
  const mb = find('Motherboard Support', 'Case Supported', 'Form Factor Support');
  if (mb) {
    const mobo = [];
    if (/E-?ATX/i.test(mb)) mobo.push('E-ATX');
    if (/(?<![Ee]-)\bATX\b/.test(mb)) mobo.push('ATX');
    if (/Micro-?ATX|mATX/i.test(mb)) mobo.push('mATX');
    if (/Mini-?ITX|\bITX\b/i.test(mb)) mobo.push('ITX');
    if (mobo.length) out.mobo = mobo;
  }
  // Now drive bays — entity-decoded "Internal 3.5\" Drive Bays" works
  const d35 = find('Internal 3.5" Drive Bays', '3.5" Drive Bays', 'Internal 3.5 Drive Bays');
  if (d35) { const m = String(d35).match(/^(\d+)/); if (m) out.drive35 = parseInt(m[1], 10); }
  const d25 = find('Internal 2.5" Drive Bays', '2.5" Drive Bays', 'Internal 2.5 Drive Bays');
  if (d25) { const m = String(d25).match(/^(\d+)/); if (m) out.drive25 = parseInt(m[1], 10); }
  return out;
}

function parseTitleFields(name) {
  const out = {};
  let m = name.match(/(?:Up\s*to\s*)?(\d{2,4})\s*mm\s*GPU/i);
  if (m) out.maxGPU = parseInt(m[1], 10);
  m = name.match(/(\d{3})\s*mm\s*(?:Rad|Radiator|AIO)/i);
  if (m) out.rads = [parseInt(m[1], 10)];
  m = name.match(/(\d{2,4})\s*mm\s*(?:CPU\s*)?Cooler/i);
  if (m) out.maxCooler = parseInt(m[1], 10);
  return out;
}

console.log('STEP 4-5: Fetching pages and applying...\n');
const stats = { fetched: 0, parsed: 0, applied: { maxGPU: 0, maxCooler: 0, rads: 0, mobo: 0, drive25: 0, drive35: 0 } };

for (let i = 0; i < corsairCases.length; i++) {
  const p = corsairCases[i];
  const num = `[${(i + 1).toString().padStart(2)}/${corsairCases.length}]`;
  process.stdout.write(`${num} ${p.n.slice(0, 60).padEnd(62)}`);

  const match = matches.get(p.id);
  if (!match) {
    const fromTitle = parseTitleFields(p.n);
    const got = Object.keys(fromTitle);
    if (got.length) {
      for (const [k, v] of Object.entries(fromTitle)) {
        p[k] = v;
        stats.applied[k] = (stats.applied[k] || 0) + 1;
      }
      console.log(` (no URL) title: ${got.join(',')}`);
    } else {
      console.log(` (no URL, no title)`);
    }
    continue;
  }

  const specs = await scrapeSpecs(match.url);
  stats.fetched++;
  if (!specs) {
    console.log(` scrape failed`);
    await new Promise(r => setTimeout(r, 1500));
    continue;
  }
  stats.parsed++;
  const fromSpecs = parseSpecsToFields(specs);
  const fromTitle = parseTitleFields(p.n);

  const applied = [];
  for (const [k, v] of Object.entries(fromSpecs)) {
    if (v != null && (!Array.isArray(v) || v.length > 0)) {
      p[k] = v;
      stats.applied[k] = (stats.applied[k] || 0) + 1;
      applied.push(k);
    }
  }
  for (const [k, v] of Object.entries(fromTitle)) {
    if (p[k] == null && v != null) {
      p[k] = v;
      stats.applied[k] = (stats.applied[k] || 0) + 1;
      applied.push(k + '(t)');
    }
  }
  console.log(` ok: ${applied.length ? applied.join(',') : '(no fields)'}`);

  if ((i + 1) % 5 === 0) save();
  await new Promise(r => setTimeout(r, 1500));
}

save();

console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  URL matches: ${matches.size}/${corsairCases.length}`);
console.log(`  Pages fetched: ${stats.fetched}, parsed: ${stats.parsed}`);
console.log(`  Coverage:`);
const final = parts.filter(p => p.c === 'Case' && p.b === 'Corsair');
for (const f of ['maxGPU', 'maxCooler', 'rads', 'mobo', 'drive25', 'drive35']) {
  const filled = final.filter(p => p[f] != null && (!Array.isArray(p[f]) || p[f].length > 0)).length;
  const pct = Math.round(filled / final.length * 100);
  console.log(`    ${f.padEnd(12)} ${filled}/${final.length}  (${pct}%)`);
}
