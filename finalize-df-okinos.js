#!/usr/bin/env node
/**
 * finalize-df-okinos.js
 *
 * Final step: prepend model codes to DarkFlash and Okinos cases.
 * MUSETEX already handled by rematch-musetex.js.
 *
 * DarkFlash HTML pattern (confirmed from inspector):
 *   <a title="DS950V ATX PC Case" href="/product/ds950v">
 * (title BEFORE href, which is why earlier parser failed)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const CACHE = './catalog-build/manufacturer-cache';
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchCached(url, cacheFile) {
  if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');
  console.log(`  GET ${url}`);
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const body = await r.text();
  writeFileSync(cacheFile, body);
  await new Promise(res => setTimeout(res, 400));
  return body;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function stripBrand(name, brand) {
  return name.replace(new RegExp(`^\\s*${brand}\\s+`, 'i'), '').trim();
}

function hasModelCode(name, brand) {
  const rest = stripBrand(name, brand);
  const words = rest.split(/[\s,.]+/).slice(0, 4);
  for (const w of words) {
    if (w.length >= 2 && /[A-Za-z]/.test(w) && /\d/.test(w)) return true;
  }
  if (words.length >= 2 && /^[A-Za-z]+$/.test(words[0]) && /^\d+$/.test(words[1])) return true;
  const head = rest.slice(0, 50);
  if (/\b(?:iCUE|Meshify|Define|Torrent|Pop|North|Terra|Ridge|Mood|Era|Epoch|Lancool|Eclipse|Evolv|Enthoo|Shadow|Silent|Pure|Dark|Light|Hyperion|Vector|Vision|Dynamic|Elite|Compact|Versa|Sekira|Classico|Morpheus|Aqua|Mirage|Cypress|MiniArt|FLOATRON|Air\s+Cross|AQUA\s+UNO)\b/i.test(head)) return true;
  return false;
}

function tokenize(text) {
  const t = String(text).toLowerCase();
  const fanMatch = t.match(/(\d+)\s*(?:×|x)?\s*(?:\d+\s*mm\s*)?(?:pwm\s*|argb\s*|non[\s-]?pwm\s*|non[\s-]?led\s*|3[\s-]?pin\s*)*fans?/);
  return {
    fanCount: fanMatch ? parseInt(fanMatch[1], 10) : null,
    wood: /walnut|wood/.test(t),
    argb: /argb/.test(t),
    rgb: /\brgb\b/.test(t) && !/argb/.test(t),
    typeC: /type[\s-]?c/.test(t),
    vertical: /vertical\s*gpu/.test(t),
    screen: /with\s*screen|\bscreen\b/.test(t),
    backPlug: /back[\s-]?(?:plug|connect)/.test(t),
    rad360: /360\s*mm/.test(t),
    rad240: /240\s*mm/.test(t),
    rad420: /420\s*mm/.test(t),
    eatx: /\be[\s-]?atx\b/.test(t),
    matx: /\bm[\s-]?atx\b|micro[\s-]?atx/.test(t),
    itx: /mini[\s-]?itx|\bitx\b/.test(t) && !/m[\s-]?atx/.test(t),
    fullTower: /full[\s-]?tower/.test(t),
    midTower: /mid[\s-]?tower/.test(t),
  };
}

function similarity(a, b) {
  let score = 0, total = 0;
  if (a.fanCount !== null && b.fanCount !== null) {
    total += 3;
    if (a.fanCount === b.fanCount) score += 3;
  }
  for (const key of ['wood', 'argb', 'rgb', 'typeC', 'vertical', 'screen', 'backPlug', 'rad360', 'rad240', 'rad420']) {
    total += 1;
    if (a[key] === b[key]) score += 1;
  }
  for (const key of ['eatx', 'matx', 'itx', 'fullTower', 'midTower']) {
    if (a[key] || b[key]) {
      total += 2;
      if (a[key] === b[key]) score += 2;
    }
  }
  return total === 0 ? 0 : score / total;
}

// ─── DARKFLASH SCRAPER (FIXED) ───────────────────────────────────────────────
async function scrapeDarkFlash() {
  console.log('\n━━━ DarkFlash ━━━');
  const models = [];
  const seen = new Set();
  for (let page = 1; page <= 8; page++) {
    const url = page === 1
      ? 'https://www.darkflash.com/product/class/pc-cases'
      : `https://www.darkflash.com/product/class/pc-cases?page=${page}`;
    const cacheFile = `${CACHE}/darkflash-list-${page}.html`;
    let html;
    try { html = await fetchCached(url, cacheFile); } catch { break; }
    // CORRECT pattern: <a title="..." href="/product/...">
    const re = /<a\s+title="([^"]+)"\s+href="\/product\/([^"\/]+)"/g;
    let m, found = 0;
    while ((m = re.exec(html)) !== null) {
      const title = m[1];
      const slug = m[2];
      if (seen.has(slug)) continue;
      seen.add(slug);
      // Extract model. Handle:
      //   "DS950V ATX PC Case"       → "DS950V"
      //   "B275 Pro M-ATX PC Case"   → "B275 Pro"
      //   "C365 Mesh E-ATX PC Case"  → "C365 Mesh"
      //   "FLOATRON F1 M-ATX PC Case" → "FLOATRON F1"
      //   "WD200(2025) ..." → "WD200"
      let model = null;
      const mm = title.match(/^(FLOATRON\s+F\d+|[A-Z][A-Z0-9]+(?:\s+(?:Pro|Mesh|MAX|Lite))?(?:\(\d+\))?)\s+(?:E-ATX|ATX|M-ATX|Micro-ATX|Mini-ITX|ITX)/);
      if (mm) model = mm[1].replace(/\(\d+\)/, '');
      if (!model) continue;
      models.push({ model, title, slug });
      found++;
    }
    console.log(`  Page ${page}: ${found} new models`);
    if (found === 0 && page > 1) break;
  }
  console.log(`  Total DarkFlash models: ${models.length}`);
  if (models.length) console.log(`  First 10: ${models.slice(0, 10).map(m => m.model).join(', ')}`);
  return models;
}

// ─── OKINOS SCRAPER (FROM CACHE) ─────────────────────────────────────────────
function prettySlug(slug) {
  const acronyms = new Set(['ARGB', 'RGB', 'PWM', 'ATX', 'ITX', 'EATX', 'MATX', 'LED', 'USB', 'TG']);
  return slug.split('-').map(w => {
    const up = w.toUpperCase();
    if (acronyms.has(up)) return up;
    if (/^\d+$/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

async function scrapeOkinos() {
  console.log('\n━━━ Okinos ━━━');
  const models = [];
  const seen = new Set();
  for (let page = 1; page <= 5; page++) {
    const url = page === 1
      ? 'https://www.okinos.com/product-category/pc-case/'
      : `https://www.okinos.com/product-category/pc-case/page/${page}/`;
    const cacheFile = `${CACHE}/okinos-list-${page}.html`;
    let html;
    try { html = await fetchCached(url, cacheFile); } catch { break; }
    const hrefRe = /<a[^>]+href="https:\/\/www\.okinos\.com\/product\/([^"\/]+)\/"/g;
    let m, found = 0;
    while ((m = hrefRe.exec(html)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const nearby = html.slice(m.index, m.index + 800);
      const h2 = nearby.match(/<h2[^>]*>([^<]+)<\/h2>/);
      const title = h2 ? h2[1].trim() : prettySlug(slug);
      models.push({ model: title, title, slug });
      found++;
    }
    console.log(`  Page ${page}: ${found} new models`);
    if (found === 0 && page > 1) break;
  }
  console.log(`  Total Okinos models: ${models.length}`);
  return models;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const darkflash = await scrapeDarkFlash();
const okinos = await scrapeOkinos();

console.log('\n━━━ MATCHING ━━━');

const results = { DARKFLASH: [], OKINOS: [] };
const misses = { DARKFLASH: [], OKINOS: [] };
const taken = { DARKFLASH: new Set(), OKINOS: new Set() };

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const brand = (p.b || '').toUpperCase();
  if (!['DARKFLASH', 'OKINOS'].includes(brand)) continue;
  if (hasModelCode(p.n, p.b)) continue;

  const pt = tokenize(p.n);
  const list = brand === 'DARKFLASH' ? darkflash : okinos;
  if (list.length === 0) continue;

  let best = null, bestScore = 0;
  for (const c of list) {
    if (taken[brand].has(c.model)) continue;
    const ct = tokenize(c.title);
    const s = similarity(pt, ct);
    if (s > bestScore) { bestScore = s; best = c; }
  }

  if (best && bestScore >= 0.5) {
    taken[brand].add(best.model);
    p.n = `${p.b} ${best.model} — ${stripBrand(p.n, p.b)}`;
    results[brand].push({ sku: best.model, score: bestScore.toFixed(2), name: p.n.slice(0, 95), src: best.title.slice(0, 70) });
  } else {
    misses[brand].push({ score: bestScore.toFixed(2), src: stripBrand(p.n, p.b).slice(0, 70), best: best?.title?.slice(0, 70) });
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const brand of ['DARKFLASH', 'OKINOS']) {
  const r = results[brand];
  const miss = misses[brand];
  console.log(`\n${brand}: ${r.length} matched, ${miss.length} missed`);
  for (const x of r) {
    console.log(`  ✓ [${x.sku}] score=${x.score}`);
    console.log(`      ${x.name}`);
    console.log(`      ← ${x.src}`);
  }
  for (const x of miss) {
    console.log(`  ✗ best score=${x.score}`);
    console.log(`      src:  ${x.src}`);
    console.log(`      best: ${x.best}`);
  }
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

// ─── FINAL COVERAGE REPORT ───────────────────────────────────────────────────
const brandsTargeted = ['MUSETEX', 'DARKROCK', 'FOIFKIN', 'DARKFLASH', 'OKINOS'];
console.log('\n━━━ FINAL MODEL CODE COVERAGE ━━━');
for (const b of brandsTargeted) {
  const cases = parts.filter(p => p.c === 'Case' && (p.b || '').toUpperCase() === b);
  const withCode = cases.filter(p => hasModelCode(p.n, p.b)).length;
  console.log(`  ${b}: ${withCode}/${cases.length} have model codes`);
}
