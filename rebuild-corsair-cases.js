#!/usr/bin/env node
/**
 * rebuild-corsair-cases.js
 *
 * For every Corsair case in the catalog:
 *   1. WIPE: clear maxGPU, maxCooler, rads, mobo, fans_inc, drive25, drive35
 *      (these were dictionary-derived and untrustworthy).
 *      Keep tg, rgb, color, usb_c, tower, ff (high-confidence from titles).
 *   2. RESOLVE URL: DuckDuckGo HTML search → corsair.com product page.
 *   3. SCRAPE: fetch the product page, parse <th>label</th><td>value</td>
 *      spec table.
 *   4. PARSE: extract maxGPU, maxCooler, rads (array), mobo, drive25, drive35
 *      from spec table fields like "Maximum GPU Length: 420mm".
 *   5. TITLE FALLBACK: For fields still blank, scan the product title for
 *      explicit phrases like "415mm GPU" or "360mm Radiator". High-
 *      confidence pattern only.
 *   6. APPLY + REPORT.
 *
 * NO GUESSING. If a field can't be found in the spec table or title, it
 * stays blank.
 *
 * Saves progress every 5 products (Ctrl-C safe).
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DOMAIN = 'corsair.com';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

const corsairCases = parts.filter(p => p.c === 'Case' && p.b === 'Corsair');
console.log(`━━━ FOUND ${corsairCases.length} CORSAIR CASES ━━━\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: WIPE GUESSED FIELDS
// ═══════════════════════════════════════════════════════════════════════════
const WIPE_FIELDS = ['maxGPU', 'maxCooler', 'rads', 'mobo', 'fans_inc', 'drive25', 'drive35'];
let wiped = 0;
for (const p of corsairCases) {
  for (const f of WIPE_FIELDS) {
    if (p[f] !== undefined) {
      delete p[f];
      wiped++;
    }
  }
}
console.log(`STEP 1: Wiped ${wiped} field values across ${corsairCases.length} cases\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: URL RESOLUTION via DuckDuckGo HTML
// ═══════════════════════════════════════════════════════════════════════════
async function ddgSearch(query) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const urls = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      let u = m[1];
      const uddg = u.match(/uddg=([^&]+)/);
      if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch {} }
      if (u.startsWith('//')) u = 'https:' + u;
      urls.push(u);
    }
    return urls;
  } catch (e) {
    return [];
  }
}

function buildQuery(name) {
  const clean = name
    .replace(/\bATX\s*Mid-?Tower\b/gi, '')
    .replace(/\b(?:Mid|Full|Micro|Mini)-?Tower\b/gi, '')
    .replace(/\bCompact\b|\bGaming\b|\bComputer\b|\bChassis\b/gi, '')
    .replace(/\bPC\s*Case\b|\bCase\b/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[,–—-]\s*[\w\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `Corsair ${clean}`.slice(0, 80);
}

function pickProductUrl(urls) {
  const candidates = urls.filter(u => u.includes(DOMAIN));
  if (!candidates.length) return null;
  const ranked = candidates.map(u => {
    let score = 0;
    if (/\/p\/pc-cases\//i.test(u)) score += 200; // perfect: corsair.com/.../p/pc-cases/...
    else if (/\/p\//i.test(u)) score += 100;
    if (/\/explorer\/|\/blog\/|\/news\/|\/community\/|\/forum/i.test(u)) score -= 100;
    if (/\.pdf$/.test(u)) score -= 100;
    score -= u.length / 200;
    return { url: u, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0].url;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: SCRAPE SPEC TABLE
// ═══════════════════════════════════════════════════════════════════════════
async function scrapeSpecTable(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Parse <table>...<tr><th>label</th><td>value</td></tr>...</table>
    // Corsair format observed: <th>...</th><td>...</td> or similar markdown table
    const specs = {};
    // Try HTML table rows
    const rowRe = /<tr[^>]*>\s*<t[hd][^>]*>([^<]+)<\/t[hd]>\s*<t[hd][^>]*>([^<]+)<\/t[hd]>/g;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const label = m[1].trim();
      const value = m[2].trim();
      if (label && value) specs[label] = value;
    }
    // Also try <th>label</th> immediately followed by <td>value</td> outside <tr>
    if (Object.keys(specs).length < 5) {
      const flatRe = /<th[^>]*>([^<]+)<\/th>\s*<td[^>]*>([^<]+)<\/td>/g;
      while ((m = flatRe.exec(html)) !== null) {
        const label = m[1].trim();
        const value = m[2].trim();
        if (label && value && !specs[label]) specs[label] = value;
      }
    }
    return Object.keys(specs).length ? specs : null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4: PARSE SPEC FIELDS
// ═══════════════════════════════════════════════════════════════════════════
function parseSpecsToFields(specs) {
  const out = {};
  if (!specs) return out;

  // Normalize keys for matching (case-insensitive, trim)
  const norm = {};
  for (const [k, v] of Object.entries(specs)) {
    norm[k.toLowerCase().trim()] = v;
  }

  function find(...keys) {
    for (const k of keys) {
      if (norm[k.toLowerCase()]) return norm[k.toLowerCase()];
    }
    return null;
  }

  // maxGPU: "Maximum GPU Length: 420mm"
  const gpuStr = find('Maximum GPU Length', 'GPU Clearance', 'Max GPU Length', 'GPU Length');
  if (gpuStr) {
    const m = gpuStr.match(/(\d{2,4})\s*mm/);
    if (m) out.maxGPU = parseInt(m[1], 10);
  }

  // maxCooler
  const coolerStr = find('Maximum CPU Cooler Height', 'CPU Cooler Clearance', 'CPU Cooler Height', 'Max CPU Cooler');
  if (coolerStr) {
    const m = coolerStr.match(/(\d{2,4})\s*mm/);
    if (m) out.maxCooler = parseInt(m[1], 10);
  }

  // rads: "Radiator Compatibility: 120mm, 140mm, 240mm, 280mm, 360mm"
  const radStr = find('Radiator Compatibility', 'Radiator Support', 'Maximum Radiator');
  if (radStr) {
    const sizes = [...radStr.matchAll(/(\d{3})\s*mm/g)].map(m => parseInt(m[1], 10));
    if (sizes.length) out.rads = [...new Set(sizes)].sort((a, b) => a - b);
  }

  // mobo: "Motherboard Support: Mini-ITX, Micro-ATX, ATX, E-ATX (305mm x 277mm)"
  const moboStr = find('Motherboard Support', 'Case Supported', 'Form Factor Support');
  if (moboStr) {
    const mobo = [];
    if (/E-?ATX/i.test(moboStr)) mobo.push('E-ATX');
    if (/(?<![Ee]-)\bATX\b/.test(moboStr)) mobo.push('ATX');
    if (/Micro-?ATX|mATX/i.test(moboStr)) mobo.push('mATX');
    if (/Mini-?ITX|\bITX\b/i.test(moboStr)) mobo.push('ITX');
    if (mobo.length) out.mobo = mobo;
  }

  // drive35
  const d35 = find('Internal 3.5" Drive Bays', 'Internal 3.5\u201d Drive Bays', '3.5" Drive Bays', 'Internal 3.5 Drive Bays');
  if (d35) {
    const m = String(d35).match(/^(\d+)/);
    if (m) out.drive35 = parseInt(m[1], 10);
  }

  // drive25
  const d25 = find('Internal 2.5" Drive Bays', 'Internal 2.5\u201d Drive Bays', '2.5" Drive Bays', 'Internal 2.5 Drive Bays');
  if (d25) {
    const m = String(d25).match(/^(\d+)/);
    if (m) out.drive25 = parseInt(m[1], 10);
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 5: TITLE FALLBACK (high-confidence patterns only)
// ═══════════════════════════════════════════════════════════════════════════
function parseTitleFields(name) {
  const out = {};

  // "415mm GPU", "Up to 415mm GPU"
  let m = name.match(/(?:Up\s*to\s*)?(\d{2,4})\s*mm\s*GPU/i);
  if (m) out.maxGPU = parseInt(m[1], 10);

  // "360mm Radiator" or "360mm AIO"
  m = name.match(/(\d{3})\s*mm\s*(?:Rad|Radiator|AIO)/i);
  if (m) out.rads = [parseInt(m[1], 10)];

  // "170mm CPU Cooler"
  m = name.match(/(\d{2,4})\s*mm\s*(?:CPU\s*)?Cooler/i);
  if (m) out.maxCooler = parseInt(m[1], 10);

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════
function save() {
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);
}
// Save the wipe immediately
save();
console.log('Wiped state saved.\n');

console.log('━━━ STEP 2-5: RESOLVE → SCRAPE → PARSE → APPLY ━━━\n');

const stats = { resolved: 0, scraped: 0, applied: { maxGPU: 0, maxCooler: 0, rads: 0, mobo: 0, drive25: 0, drive35: 0 } };

for (let i = 0; i < corsairCases.length; i++) {
  const p = corsairCases[i];
  const num = `[${(i + 1).toString().padStart(2)}/${corsairCases.length}]`;
  process.stdout.write(`${num} ${p.n.slice(0, 65).padEnd(67)}`);

  // Resolve URL
  const query = buildQuery(p.n);
  const urls = await ddgSearch(query);
  const url = pickProductUrl(urls);
  if (!url) {
    process.stdout.write(' ✗ no URL\n');
    await new Promise(r => setTimeout(r, 2000));
    continue;
  }
  stats.resolved++;
  await new Promise(r => setTimeout(r, 1500));

  // Scrape
  const specs = await scrapeSpecTable(url);
  if (!specs) {
    process.stdout.write(' ✗ scrape failed\n');
    await new Promise(r => setTimeout(r, 1500));
    continue;
  }
  stats.scraped++;

  // Parse
  const fromSpecs = parseSpecsToFields(specs);
  const fromTitle = parseTitleFields(p.n);

  // Apply: spec table wins; title fills gaps
  const applied = [];
  for (const [k, v] of Object.entries(fromSpecs)) {
    if (v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0)) {
      p[k] = v;
      stats.applied[k] = (stats.applied[k] || 0) + 1;
      applied.push(k);
    }
  }
  for (const [k, v] of Object.entries(fromTitle)) {
    if (p[k] == null && v !== null && v !== undefined) {
      p[k] = v;
      stats.applied[k] = (stats.applied[k] || 0) + 1;
      applied.push(k + '(title)');
    }
  }

  process.stdout.write(` ✓ ${applied.length ? applied.join(',') : '(no fields)'}\n`);

  // Save every 5
  if ((i + 1) % 5 === 0) save();
  await new Promise(r => setTimeout(r, 1500));
}

save();

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  URLs resolved: ${stats.resolved}/${corsairCases.length}`);
console.log(`  Pages scraped: ${stats.scraped}/${corsairCases.length}`);
console.log(`\n  Field coverage:`);
const final = parts.filter(p => p.c === 'Case' && p.b === 'Corsair');
for (const f of ['maxGPU', 'maxCooler', 'rads', 'mobo', 'drive25', 'drive35']) {
  const filled = final.filter(p => p[f] != null && (!Array.isArray(p[f]) || p[f].length > 0)).length;
  const pct = Math.round(filled / final.length * 100);
  console.log(`    ${f.padEnd(12)} ${filled}/${final.length}  (${pct}%)`);
}
console.log('\nDone.');
