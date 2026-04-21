#!/usr/bin/env node
/**
 * finalize-case-models-v2.js
 *
 * Fixes from v1:
 *   - DarkFlash: target <a> tags only, skip <meta>/<link>
 *   - Okinos: preserve uppercase acronyms (ARGB, RGB, ITX, PWM)
 *   - Okinos: deduplicate — don't assign same model to multiple products
 *   - MUSETEX: lower threshold, relaxed fan strictness
 *   - Diagnostic dump when no matches found
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
    screen: /with\s*screen|\bscreen\b/.test(t),
    rad360: /360\s*mm/.test(t),
    rad240: /240\s*mm/.test(t),
    rad420: /420\s*mm/.test(t),
    backPlug: /back[\s-]?(?:plug|connect)/.test(t),
    eatx: /\be[\s-]?atx\b|full[\s-]?tower/.test(t),
    matx: /\bm[\s-]?atx\b|micro[\s-]?atx/.test(t),
    itx: /mini[\s-]?itx|\bitx\b/.test(t) && !/m[\s-]?atx/.test(t),
    fullTower: /full[\s-]?tower/.test(t),
    midTower: /mid[\s-]?tower/.test(t),
  };
}

function similarity(a, b, { strictFans = false, strictColor = false } = {}) {
  let score = 0, total = 0;
  if (a.fanCount !== null && b.fanCount !== null) {
    total += 3;
    if (a.fanCount === b.fanCount) score += 3;
    else if (strictFans) return 0;
  }
  if (strictColor && a.color && b.color && a.color !== b.color) return 0;
  for (const key of ['wood', 'argb', 'rgb', 'typeC', 'vertical', 'screen', 'rad360', 'rad240', 'rad420', 'backPlug']) {
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

// ─── MUSETEX (SHOPIFY CACHE) ─────────────────────────────────────────────────
function loadMusetex() {
  const p = './catalog-build/shopify-scrape/MUSETEX.json';
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).filter(x => /case/i.test(`${x.title} ${x.product_type || ''}`));
}

function extractMusetexSku(title) {
  const m = title.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\b/);
  if (m) return m[1];
  const m2 = title.match(/^[A-Z]+\s+([A-Z][A-Z0-9]*\d+[A-Z0-9]*)\b/);
  if (m2) return m2[1];
  return null;
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
    try { html = await fetchCached(url, cacheFile); } catch (e) { break; }
    // Target <a> tags specifically — skip <meta>/<link>/other tags
    const re = /<a\s+[^>]*href="(?:https:\/\/www\.darkflash\.com)?\/product\/([^"\/]+)"[^>]*title="([^"]+)"/g;
    let m, found = 0;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      const title = m[2];
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (slug === 'class' || slug.startsWith('class/')) continue;
      // Extract model from title: "DS950V ATX PC Case", "B275 Pro M-ATX PC Case", "FLOATRON F1(2025) M-ATX PC Case"
      let modelMatch = title.match(/^(FLOATRON\s+F\d+(?:\(\d+\))?|[A-Z][A-Z0-9]+(?:\s+Pro)?(?:\s+Mesh)?)\s+/);
      if (!modelMatch) continue;
      const model = modelMatch[1];
      const ffMatch = title.match(/\b(E-ATX|ATX|M-ATX|Micro-ATX|Mini-ITX|ITX)\b/);
      models.push({ model, title, slug, url: `https://www.darkflash.com/product/${slug}`, ff: ffMatch?.[1] || null });
      found++;
    }
    console.log(`  Page ${page}: ${found} new models (cached: ${cacheFile})`);
    if (found === 0 && page > 1) break;
  }
  console.log(`  Total DarkFlash models: ${models.length}`);
  if (models.length) console.log(`  Sample: ${models.slice(0, 5).map(m => m.model).join(', ')}`);
  return models;
}

// ─── OKINOS SCRAPER (FIXED) ──────────────────────────────────────────────────
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
    try { html = await fetchCached(url, cacheFile); } catch (e) { break; }
    // WooCommerce uses <a href="URL/" class="woocommerce-loop-product__link">
    // Just pull slug + try to find title nearby
    const hrefRe = /<a[^>]+href="https:\/\/www\.okinos\.com\/product\/([^"\/]+)\/"/g;
    let m, found = 0;
    while ((m = hrefRe.exec(html)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      // Try to find <h2>...</h2> within 500 chars after the anchor
      const nearby = html.slice(m.index, m.index + 800);
      const h2 = nearby.match(/<h2[^>]*>([^<]+)<\/h2>/);
      const title = h2 ? h2[1].trim() : prettySlug(slug);
      models.push({ model: title, title, slug, url: `https://www.okinos.com/product/${slug}/` });
      found++;
    }
    console.log(`  Page ${page}: ${found} new models`);
    if (found === 0 && page > 1) break;
  }
  console.log(`  Total Okinos models: ${models.length}`);
  if (models.length) console.log(`  Sample: ${models.slice(0, 5).map(m => m.model).join(', ')}`);
  return models;
}

// ─── MATCHING WITH DEDUPLICATION ─────────────────────────────────────────────
function findBestMatch(productTokens, candidates, getTitle, opts = {}) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    if (c._taken) continue;  // already assigned
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
const misses = { MUSETEX: [], DARKFLASH: [], OKINOS: [] };

// For each unmatched case, try to match and prepend
const unmatchedCases = parts.filter(p => {
  if (p.c !== 'Case') return false;
  const brand = (p.b || '').toUpperCase();
  return ['MUSETEX', 'DARKFLASH', 'OKINOS'].includes(brand) && !hasModelCode(p.n, p.b);
});

for (const p of unmatchedCases) {
  const brand = (p.b || '').toUpperCase();
  const pt = tokenize(p.n);

  let match = null, score = 0;
  if (brand === 'MUSETEX' && musetex.length) {
    const r = findBestMatch(pt, musetex, m => m.title);
    match = r.match; score = r.score;
    if (match && score >= 0.45) {
      const sku = extractMusetexSku(match.title);
      if (sku) {
        match._taken = true;
        p.n = `${p.b} ${sku} — ${stripBrand(p.n, p.b)}`;
        results.MUSETEX.push({ sku, score: score.toFixed(2), name: p.n.slice(0, 90) });
        continue;
      }
    }
    misses.MUSETEX.push({ score: score.toFixed(2), src: stripBrand(p.n, p.b).slice(0, 70), best: match?.title?.slice(0, 70) });
  }

  if (brand === 'DARKFLASH' && darkflash.length) {
    const r = findBestMatch(pt, darkflash, m => m.title);
    match = r.match; score = r.score;
    if (match && score >= 0.5) {
      match._taken = true;
      p.n = `${p.b} ${match.model} — ${stripBrand(p.n, p.b)}`;
      results.DARKFLASH.push({ sku: match.model, score: score.toFixed(2), name: p.n.slice(0, 90) });
      continue;
    }
    misses.DARKFLASH.push({ score: score.toFixed(2), src: stripBrand(p.n, p.b).slice(0, 70), best: match?.title?.slice(0, 70) });
  }

  if (brand === 'OKINOS' && okinos.length) {
    const r = findBestMatch(pt, okinos, m => m.title);
    match = r.match; score = r.score;
    if (match && score >= 0.5) {
      match._taken = true;
      p.n = `${p.b} ${match.model} — ${stripBrand(p.n, p.b)}`;
      results.OKINOS.push({ sku: match.model, score: score.toFixed(2), name: p.n.slice(0, 90) });
      continue;
    }
    misses.OKINOS.push({ score: score.toFixed(2), src: stripBrand(p.n, p.b).slice(0, 70), best: match?.title?.slice(0, 70) });
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const brand of ['MUSETEX', 'DARKFLASH', 'OKINOS']) {
  const r = results[brand];
  const miss = misses[brand];
  console.log(`\n${brand}: ${r.length} matched, ${miss.length} missed`);
  for (const x of r) {
    console.log(`  ✓ [${x.sku}] score=${x.score}`);
    console.log(`      ${x.name}`);
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
