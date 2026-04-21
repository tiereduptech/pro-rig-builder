#!/usr/bin/env node
/**
 * scrape-fractal.js — scrape Fractal Design product pages for case specs.
 *
 * Approach:
 *   1. Find all Fractal Design cases in catalog missing data
 *   2. For each, construct slug from product name
 *   3. Fetch https://www.fractal-design.com/products/cases/{series}/{slug}/
 *   4. Parse the spec table (consistent across all Fractal product pages)
 *   5. Extract: maxGPU, maxCooler, fans_inc, rads, drive25, drive35
 *
 * Rate limit: 2 sec between requests (polite scraping)
 *
 * USAGE:
 *   node scrape-fractal.js --dry-run   # show plan, no requests
 *   node scrape-fractal.js --limit 3   # test 3 products
 *   node scrape-fractal.js             # full run
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit'));
let LIMIT = 0;
if (limitArg) {
  const eq = limitArg.split('=');
  if (eq.length === 2) LIMIT = parseInt(eq[1]) || 0;
  else {
    const idx = process.argv.indexOf('--limit');
    LIMIT = parseInt(process.argv[idx + 1]) || 0;
  }
}
const CACHE_DIR = './catalog-build/fractal-scrape';
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// Find Fractal cases missing maxGPU/fans_inc/rads
const candidates = parts.filter(p =>
  p.c === 'Case'
  && p.b && /Fractal/i.test(p.b)
  && (!p.maxGPU || !p.fans_inc || !p.rads)
);

const target = LIMIT ? candidates.slice(0, LIMIT) : candidates;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Fractal Design product page scraper');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Candidates:', candidates.length);
console.log('Processing:', target.length);
console.log('Dry run:', DRY);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ─── Name → slug conversion ─────────────────────────────────────────────────
// Fractal URLs look like:
//   /products/cases/north/north/black-tg-clear-tint/
//   /products/cases/meshify/meshify-2-compact/black-solid/
//   /products/cases/define/define-7-xl/black-solid/
//   /products/cases/torrent/torrent/black-tg-light-tint/
//   /products/cases/pop/pop-air/black-solid-clear-tint/
//
// Our product names are like:
//   "Fractal Design Meshify 2 Compact"
//   "Meshify 2 XL Black ATX Flexible Light Tinted Tempered Glass Window Full Tower Computer Case"
//   "North Chalk White - Genuine Oak Wood Front..."

function nameToSlugs(name) {
  // Strip brand prefix + marketing suffix and normalize
  let s = String(name || '')
    .replace(/^Fractal\s*Design\s*-?\s*/i, '')
    .replace(/[™®©]/g, '')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .trim();

  // Extract the model name before the first long description
  // e.g. "meshify 2 black atx flexible light..." → "meshify 2"
  // e.g. "north - genuine walnut wood front..." → "north"
  // e.g. "define 7 xl black atx flexible..." → "define 7 xl"

  // Grab up to first separator (-, |, ,) or before descriptive words
  const firstPart = s.split(/\s*[-|,]\s*/)[0];

  // Remove trailing descriptive filler
  let model = firstPart
    .replace(/\s*(black|white|chalk|grey|gray|light tint|dark tint|tempered glass|tg|solid|mesh|clear tint|computer case|pc case|atx|matx|itx|e-atx|full tower|mid tower|mini|compact rgb|rgb|ambience pro).*/i, '')
    .trim();

  // Collapse multiple spaces to single dash
  const modelSlug = model.replace(/\s+/g, '-');

  // Derive series (first word usually)
  const series = modelSlug.split('-')[0];

  // Try several URL patterns (model has a specific color variant path)
  // We'll just try the product overview page without color variant
  return {
    series,
    modelSlug,
    urls: [
      `https://www.fractal-design.com/products/cases/${series}/${modelSlug}/`,
      `https://www.fractal-design.com/products/cases/${modelSlug}/`,
    ],
  };
}

// ─── HTML spec table parser ────────────────────────────────────────────────
// Fractal uses a "comparison-table" with:
//   <thead><tr><th></th><th>North</th><th>North XL</th>...</tr></thead>
//   <tbody>
//     <tr><td>Spec Name</td><td>value-for-col1</td><td>value-for-col2</td>...</tr>
//   </tbody>
// We need to find which column matches the product we're looking up, then
// extract spec values from that column only.

function parseSpecs(html, productName) {
  const specs = {};
  const specName = productName.replace(/^Fractal\s*Design\s*-?\s*/i, '').trim();
  let kv = {};
  let targetCol = -1;
  let headers = [];

  // Layout 1: comparison-table (used on "North", "Meshify 2", etc. overview pages)
  const tableMatch = html.match(/<table class="comparison-table"[\s\S]*?<\/table>/i);
  if (tableMatch) {
    const tableHtml = tableMatch[0];
    const headMatch = tableHtml.match(/<thead[\s\S]*?<\/thead>/i);
    if (headMatch) {
      const thPat = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let m;
      while ((m = thPat.exec(headMatch[0])) !== null) {
        headers.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim());
      }
    }
    // Pick column: best word-overlap, then exact-name match wins
    const modelWords = specName.toLowerCase().split(/[\s\-]+/).filter(w => w.length > 1);
    let bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
      if (!headers[i]) continue;
      const hWords = headers[i].toLowerCase().split(/[\s\-()]+/).filter(w => w.length > 1);
      let score = 0;
      for (const w of modelWords) if (hWords.includes(w)) score++;
      // Penalize if header has EXTRA words the product name doesn't
      // e.g. product="North" header="North XL" — header has an extra "xl" word
      const extras = hWords.filter(h => !modelWords.includes(h) && h !== 'mesh' && h !== 'tg' && h !== 'rc');
      score -= extras.length * 0.5;
      // Exact match wins
      if (headers[i].toLowerCase() === specName.toLowerCase()) score += 100;
      if (score > bestScore) { bestScore = score; targetCol = i; }
    }
    if (targetCol < 0) targetCol = 1;

    const bodyMatch = tableHtml.match(/<tbody[\s\S]*?<\/tbody>/i);
    if (bodyMatch) {
      const rowPat = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowM;
      while ((rowM = rowPat.exec(bodyMatch[0])) !== null) {
        const tdPat = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        const cells = [];
        let tdM;
        while ((tdM = tdPat.exec(rowM[1])) !== null) {
          cells.push(tdM[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim());
        }
        if (cells.length >= 2 && cells[targetCol]) {
          kv[cells[0].toLowerCase()] = cells[targetCol];
        }
      }
    }
  }

  // Layout 2: c-product-spec__item list (single-product pages: Terra, Ridge, Torrent, etc.)
  if (Object.keys(kv).length === 0) {
    const itemPat = /<li class="c-product-spec__item[^"]*"[^>]*>\s*<div class="c-product-spec__label"[^>]*>([\s\S]*?)<\/div>\s*<div class="c-product-spec__value"[^>]*>([\s\S]*?)<\/div>/gi;
    let m;
    while ((m = itemPat.exec(html)) !== null) {
      const key = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim().toLowerCase();
      const val = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
      if (key && val) kv[key] = val;
    }
  }

  // ─── Extract fields from kv ────────────────────────────────────────────
  // maxGPU — "GPU", "Graphics card length", "GPU max"
  for (const k of Object.keys(kv)) {
    if (/(?:^|\b)(?:gpu|graphics\s*card)(?:\s|$|\b)/i.test(k)) {
      const n = kv[k].match(/(\d{3})\s*mm/);
      if (n) { specs.maxGPU = parseInt(n[1]); break; }
    }
  }

  // maxCooler — "CPU cooler", "Cooler height"
  for (const k of Object.keys(kv)) {
    if (/cpu\s*cooler|cooler\s*(?:max|height|clearance)/i.test(k)) {
      const n = kv[k].match(/(\d{2,3})\s*mm/);
      if (n) { specs.maxCooler = parseInt(n[1]); break; }
    }
  }

  // fans_inc — "Included fans", "Pre-installed fans"
  for (const k of Object.keys(kv)) {
    if (/included\s*fans?|fans?\s*included|pre[-\s]?installed\s*fans?/i.test(k)) {
      const v = kv[k];
      // Count like "3x Dynamic X2 GP-14" or "3 x 120mm"
      const n = v.match(/(\d{1,2})\s*x/i) || v.match(/^(\d{1,2})\b/);
      if (n) { specs.fans_inc = parseInt(n[1]); break; }
    }
  }
  // If "fans" row lists just the quantity format like "2 (included)"
  if (specs.fans_inc == null) {
    for (const [k, v] of Object.entries(kv)) {
      if (/\bfans?\b/i.test(k) && /\binclude/i.test(v)) {
        const n = v.match(/^(\d{1,2})\b/);
        if (n) { specs.fans_inc = parseInt(n[1]); break; }
      }
    }
  }

  // rads — from "Front radiator", "Top radiator", "Rear radiator", etc.
  const rads = new Set();
  for (const [k, v] of Object.entries(kv)) {
    if (/radiator|aio/i.test(k)) {
      const sizes = v.match(/\b(120|140|240|280|360|420)\s*mm/gi) || [];
      sizes.forEach(s => rads.add(s.replace(/\s+/g, '').toLowerCase()));
    }
  }
  if (rads.size) specs.rads = [...rads].sort().join(',');

  // drives — "2.5\" drive mounts", "3.5\" drive bays"
  for (const k of Object.keys(kv)) {
    if (/2\.5.*drive|drive.*2\.5/i.test(k)) {
      const n = kv[k].match(/(\d{1,2})/);
      if (n) specs.drive25 = parseInt(n[1]);
    }
    if (/3\.5.*drive|drive.*3\.5/i.test(k)) {
      const n = kv[k].match(/(\d{1,2})/);
      if (n) specs.drive35 = parseInt(n[1]);
    }
  }

  return { specs, foundKeys: Object.keys(kv).slice(0, 30), targetCol, headers };
}

// ─── Fetch with cache ───────────────────────────────────────────────────────
async function fetchUrl(url) {
  const cacheKey = url.replace(/[^a-z0-9]/gi, '_').slice(0, 100) + '.html';
  const cachePath = join(CACHE_DIR, cacheKey);
  if (existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf8');
  }
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ProRigBuilder-SpecEnrich/1.0; catalog@prorigbuilder.com)',
      'Accept': 'text/html',
    },
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  writeFileSync(cachePath, html);
  return html;
}

// ─── Main ───────────────────────────────────────────────────────────────────
let ok = 0, fail = 0;
const stats = { maxGPU: 0, maxCooler: 0, fans_inc: 0, rads: 0, drive25: 0, drive35: 0 };

for (let i = 0; i < target.length; i++) {
  const p = target[i];
  const { series, modelSlug, urls } = nameToSlugs(p.n);
  process.stdout.write(`[${i + 1}/${target.length}] ${p.b} ${modelSlug} ... `);

  if (DRY) {
    console.log(`would try: ${urls[0]}`);
    continue;
  }

  let html = null;
  let hit = null;
  for (const u of urls) {
    html = await fetchUrl(u);
    if (html && html.includes('specifications')) { hit = u; break; }
    if (html && html.length > 10000) { hit = u; break; }
  }

  if (!html) {
    console.log('✗ no page found');
    fail++;
    continue;
  }

  const { specs, foundKeys, targetCol, headers } = parseSpecs(html, p.n);
  const filled = [];
  for (const [k, v] of Object.entries(specs)) {
    if (p[k] == null && v != null) {
      p[k] = v;
      stats[k]++;
      filled.push(`${k}=${v}`);
    }
  }
  if (filled.length) {
    console.log(`✓ col${targetCol} [${headers[targetCol] || '?'}] → ${filled.join(' ')}`);
    ok++;
  } else if (foundKeys.length) {
    console.log(`? col${targetCol} [${headers[targetCol] || '?'}] has data but no new fields extracted. keys: ${foundKeys.slice(0, 4).join(', ')}`);
  } else {
    console.log(`? no spec table found in page`);
  }

  // Polite delay
  await new Promise(r => setTimeout(r, 2000));
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Succeeded:', ok, '| Failed:', fail);
console.log('Fields filled:', JSON.stringify(stats));

if (!DRY && ok > 0) {
  writeFileSync(
    './src/data/parts.js',
    `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`
  );
  console.log('Wrote', parts.length, 'products');
}
