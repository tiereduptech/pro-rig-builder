#!/usr/bin/env node
/**
 * finalize-case-models.js
 *
 * Closes the last 12 cases without model codes:
 *   - MUSETEX (2) — use cached Shopify data with lower match threshold
 *   - DarkFlash (7) — scrape darkflash.com product listings
 *   - Okinos (3) — scrape okinos.com product listings
 *
 * Focuses on prepending the model code. Spec backfill can happen later
 * by re-running backfill-case-specs.js (after expanding the dictionary).
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

// ─── MODEL CODE DETECTION ────────────────────────────────────────────────────
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

// ─── TOKENIZATION ────────────────────────────────────────────────────────────
function tokenize(text) {
  const t = String(text).toLowerCase();
  const fanMatch = t.match(/(\d+)\s*(?:×|x)?\s*(?:\d+\s*mm\s*)?(?:pwm\s*|argb\s*|non[\s-]?pwm\s*|non[\s-]?led\s*|3[\s-]?pin\s*)*fans?/);
  return {
    fanCount: fanMatch ? parseInt(fanMatch[1], 10) : null,
    color: (t.match(/\b(black|white|pink|grey|gray|walnut)\b/) || [])[1] || null,
    wood: /walnut|wood/.test(t),
    argb: /argb/.test(t),
    rgb: /\brgb\b/.test(t) && !/argb/.test(t),
    typeC: /type[\s-]?c/.test(t),
    vertical: /vertical\s*gpu/.test(t),
    screen: /with\s*screen/.test(t),
    rad360: /360\s*mm/.test(t),
    rad240: /240\s*mm/.test(t),
    rad420: /420\s*mm/.test(t),
    eatx: /\be[\s-]?atx\b|full[\s-]?tower/.test(t),
    matx: /\bm[\s-]?atx\b|micro[\s-]?atx/.test(t),
    itx: /mini[\s-]?itx|\bitx\b/.test(t) && !/m[\s-]?atx/.test(t),
    fullTower: /full[\s-]?tower/.test(t),
    midTower: /mid[\s-]?tower/.test(t),
  };
}

function similarity(a, b, { strictFans = true, strictColor = false } = {}) {
  let score = 0, total = 0;
  if (strictFans && a.fanCount !== null && b.fanCount !== null) {
    if (a.fanCount !== b.fanCount) return 0;
    score += 3; total += 3;
  }
  if (strictColor && a.color && b.color && a.color !== b.color) return 0;
  // Boolean features
  for (const key of ['wood', 'argb', 'rgb', 'typeC', 'vertical', 'screen', 'rad360', 'rad240', 'rad420']) {
    total += 1;
    if (a[key] === b[key]) score += 1;
  }
  // Form factor
  const ffScoreKeys = ['eatx', 'matx', 'itx', 'fullTower', 'midTower'];
  for (const key of ffScoreKeys) {
    if (a[key] || b[key]) {
      total += 2;
      if (a[key] === b[key]) score += 2;
    }
  }
  return total === 0 ? 0 : score / total;
}

// ─── MUSETEX (SHOPIFY CACHE) ─────────────────────────────────────────────────
function loadMusetex() {
  const p = './catalog-build/shopify-scrape/MUSETEX.json';
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).filter(x => /case/i.test(`${x.title} ${x.product_type || ''}`));
}

function extractSku(title) {
  const m = title.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\b/);
  if (m) return m[1];
  const m2 = title.match(/^[A-Z]+\s+([A-Z][A-Z0-9]*\d+[A-Z0-9]*)\b/);
  if (m2) return m2[1];
  return null;
}

// ─── DARKFLASH SCRAPER ───────────────────────────────────────────────────────
async function scrapeDarkFlash() {
  console.log('\n━━━ DarkFlash ━━━');
  const models = [];
  for (let page = 1; page <= 8; page++) {
    const url = page === 1
      ? 'https://www.darkflash.com/product/class/pc-cases'
      : `https://www.darkflash.com/product/class/pc-cases?page=${page}`;
    let html;
    try {
      html = await fetchCached(url, `${CACHE}/darkflash-list-${page}.html`);
    } catch (e) { break; }
    // Extract product cards. Structure from fetch:
    //   <a href="/product/ds950v" title="DS950V ATX PC Case">...</a>
    //   followed by: model_name / form-factor / dimensions
    const linkRe = /href="\/product\/([^"]+)"\s+title="([^"]+)"/g;
    let m, found = 0;
    while ((m = linkRe.exec(html)) !== null) {
      const slug = m[1];
      const title = m[2];
      // Extract model from title: "DS950V ATX PC Case", "B275 Pro M-ATX PC Case", "FLOATRON F1 M-ATX PC Case"
      let modelMatch = title.match(/^(FLOATRON\s+F\d+|[A-Z][A-Z0-9]+(?:\s+Pro)?)\s+/);
      if (!modelMatch) continue;
      const model = modelMatch[1];
      // Extract form factor
      const ffMatch = title.match(/\b(E-ATX|ATX|M-ATX|Micro-ATX|Mini-ITX|ITX)\b/);
      if (!models.find(x => x.model === model)) {
        models.push({
          model, title, slug,
          url: `https://www.darkflash.com/product/${slug}`,
          ff: ffMatch ? ffMatch[1] : null,
        });
        found++;
      }
    }
    console.log(`  Page ${page}: ${found} new models`);
    if (found === 0 && page > 1) break;
  }
  console.log(`  Total DarkFlash models: ${models.length}`);
  return models;
}

// ─── OKINOS SCRAPER ──────────────────────────────────────────────────────────
async function scrapeOkinos() {
  console.log('\n━━━ Okinos ━━━');
  const models = [];
  for (let page = 1; page <= 5; page++) {
    const url = page === 1
      ? 'https://www.okinos.com/product-category/pc-case/'
      : `https://www.okinos.com/product-category/pc-case/page/${page}/`;
    let html;
    try {
      html = await fetchCached(url, `${CACHE}/okinos-list-${page}.html`);
    } catch (e) { break; }
    // WooCommerce products: <a href="https://www.okinos.com/product/{slug}/">...<h2 class="woocommerce-loop-product__title">MODEL</h2>
    const re = /href="https:\/\/www\.okinos\.com\/product\/([^"]+)\/"[\s\S]{0,1000}?<h2[^>]*class="[^"]*woocommerce-loop-product__title[^"]*"[^>]*>([^<]+)<\/h2>/g;
    let m, found = 0;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      const title = m[2].trim();
      if (!models.find(x => x.slug === slug)) {
        models.push({
          model: title,
          title,
          slug,
          url: `https://www.okinos.com/product/${slug}/`,
        });
        found++;
      }
    }
    console.log(`  Page ${page}: ${found} new models`);
    if (found === 0 && page > 1) break;
  }
  // Also try a simpler href-only extraction as fallback
  if (models.length === 0) {
    console.log('  Structured extraction failed, trying fallback...');
    const html = readFileSync(`${CACHE}/okinos-list-1.html`, 'utf8');
    const hrefRe = /href="https:\/\/www\.okinos\.com\/product\/([^"/]+)\/"/g;
    const seen = new Set();
    let m;
    while ((m = hrefRe.exec(html)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      // Derive model from slug: "aqua-3-black-argb" → "Aqua 3 Black ARGB"
      const model = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      models.push({
        model,
        title: model,
        slug,
        url: `https://www.okinos.com/product/${slug}/`,
      });
    }
  }
  console.log(`  Total Okinos models: ${models.length}`);
  return models;
}

// ─── MATCHING ────────────────────────────────────────────────────────────────
function findBestMatch(productTokens, candidates, getTitle, opts = {}) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const ct = tokenize(getTitle(c));
    const s = similarity(productTokens, ct, opts);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return { match: best, score: bestScore };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const musetex = loadMusetex();
const darkflash = await scrapeDarkFlash();
const okinos = await scrapeOkinos();

console.log('\n━━━ MATCHING ━━━');

const results = { MUSETEX: [], DARKFLASH: [], OKINOS: [] };

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const brand = (p.b || '').toUpperCase();
  if (!['MUSETEX', 'DARKFLASH', 'OKINOS'].includes(brand)) continue;
  if (hasModelCode(p.n, p.b)) continue;

  const pt = tokenize(p.n);

  if (brand === 'MUSETEX' && musetex.length) {
    const { match, score } = findBestMatch(pt, musetex, m => m.title, { strictFans: true });
    if (match && score >= 0.55) {
      const sku = extractSku(match.title);
      if (sku) {
        p.n = `${p.b} ${sku} — ${stripBrand(p.n, p.b)}`;
        results.MUSETEX.push({ sku, score: score.toFixed(2), name: p.n.slice(0, 90) });
      }
    }
  }

  if (brand === 'DARKFLASH' && darkflash.length) {
    const { match, score } = findBestMatch(pt, darkflash, m => m.title, { strictFans: false });
    if (match && score >= 0.5) {
      p.n = `${p.b} ${match.model} — ${stripBrand(p.n, p.b)}`;
      results.DARKFLASH.push({ sku: match.model, score: score.toFixed(2), name: p.n.slice(0, 90) });
    }
  }

  if (brand === 'OKINOS' && okinos.length) {
    const { match, score } = findBestMatch(pt, okinos, m => m.title, { strictFans: false });
    if (match && score >= 0.5) {
      p.n = `${p.b} ${match.model} — ${stripBrand(p.n, p.b)}`;
      results.OKINOS.push({ sku: match.model, score: score.toFixed(2), name: p.n.slice(0, 90) });
    }
  }
}

// ─── REPORT ──────────────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const brand of ['MUSETEX', 'DARKFLASH', 'OKINOS']) {
  const r = results[brand];
  console.log(`${brand}: ${r.length} matched`);
  for (const x of r) {
    console.log(`  [${x.sku}] score=${x.score}`);
    console.log(`    ${x.name}`);
  }
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
console.log('\nNext: run prepend-case-models-v2.js again to confirm remaining gaps.');
