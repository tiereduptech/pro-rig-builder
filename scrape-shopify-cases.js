#!/usr/bin/env node
/**
 * scrape-shopify-cases.js
 *
 * Hits /products.json on manufacturer Shopify stores (MUSETEX, DARKROCK),
 * extracts spec data from body_html descriptions, and matches to unmatched
 * cases in parts.js.
 *
 * Shopify's /products.json is a public endpoint that returns structured
 * product data including the full HTML body (which typically contains
 * spec tables).
 *
 * Usage: node scrape-shopify-cases.js
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

// ─── TARGETS ─────────────────────────────────────────────────────────────────
const SITES = [
  { brand: 'MUSETEX',  base: 'https://www.musetex.com' },
  { brand: 'DARKROCK', base: 'https://darkrockpc.com' },
];

const CACHE_DIR = './catalog-build/shopify-scrape';
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// ─── FETCH ALL SHOPIFY PRODUCTS ──────────────────────────────────────────────
async function fetchShopifyProducts(base) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${base}/products.json?limit=250&page=${page}`;
    console.log(`  Fetching ${url}`);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProRigBuilder/1.0; +https://prorigbuilder.com)',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      console.log(`    ${r.status} — stopping`);
      break;
    }
    const data = await r.json();
    if (!data.products || data.products.length === 0) break;
    all.push(...data.products);
    if (data.products.length < 250) break;
  }
  return all;
}

// ─── SPEC EXTRACTION ─────────────────────────────────────────────────────────
function stripHTML(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSpecs(product) {
  const title = product.title || '';
  const body = stripHTML(product.body_html || '');
  const text = `${title} ${body}`;
  const specs = {};

  // ── GPU length (maxGPU) ─────────────────────────────────────────
  // Patterns: "GPU length up to 395mm", "supports up to 400mm GPU",
  //          "Max GPU Length: 395mm", "VGA Card: 400mm"
  const gpuPatterns = [
    /(?:GPU|VGA|graphics?\s*card)\s*(?:length|len)?\s*(?:up\s*to|max)?\s*:?\s*(\d{3})\s*mm/i,
    /(?:max(?:imum)?|up\s*to)\s*(?:GPU|VGA|graphics?\s*card)\s*(?:length|len)?\s*:?\s*(\d{3})\s*mm/i,
    /(\d{3})\s*mm\s*(?:GPU|VGA|graphics?\s*card)/i,
    /(?:support|fit)s?\s*(?:up\s*to\s*)?(\d{3})\s*mm\s*(?:GPU|VGA|graphics?\s*card)/i,
  ];
  for (const p of gpuPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 150 && v <= 550) { specs.maxGPU = v; break; }
    }
  }

  // ── CPU cooler height (maxCooler) ───────────────────────────────
  const coolerPatterns = [
    /(?:CPU\s*)?cooler\s*(?:height|h)?\s*(?:up\s*to|max)?\s*:?\s*(\d{2,3})\s*mm/i,
    /(?:max(?:imum)?|up\s*to)\s*(?:CPU\s*)?cooler\s*(?:height|h)?\s*:?\s*(\d{2,3})\s*mm/i,
    /heatsink\s*(?:height)?\s*:?\s*(\d{2,3})\s*mm/i,
  ];
  for (const p of coolerPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 40 && v <= 220) { specs.maxCooler = v; break; }
    }
  }

  // ── Fans included (fans_inc) ───────────────────────────────────
  // "Pre-Installed 6 PWM ARGB Fans", "3 x 120mm Fans Pre-Installed",
  // "Comes with 4 fans", "Includes 3 fans"
  const fansPatterns = [
    /pre[\s-]*install(?:ed)?[\s\w]*?(\d+)\s*(?:x\s*\d+mm)?\s*(?:PWM\s*ARGB\s*)?fans?/i,
    /(\d+)\s*(?:x\s*\d+\s*mm)?\s*(?:PWM\s*(?:ARGB)?\s*)?fans?\s*pre[\s-]*install(?:ed)?/i,
    /(\d+)\s*x\s*\d+\s*mm\s*fans?\s*included/i,
    /includes?\s*(\d+)\s*fans?/i,
    /comes?\s*with\s*(\d+)\s*fans?/i,
  ];
  for (const p of fansPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 0 && v <= 12) { specs.fans_inc = v; break; }
    }
  }

  // ── Radiator support (rads) ──────────────────────────────────────
  // Build a set of supported sizes by searching for each.
  const radSizes = [];
  for (const size of [120, 140, 240, 280, 360, 420, 480]) {
    const re = new RegExp(`${size}\\s*mm\\s*(?:AIO|radiator|rad|liquid|water)`, 'i');
    if (re.test(text)) radSizes.push(`${size}mm`);
  }
  // Also match ranges like "supports 120/240/360mm"
  const rangeMatch = text.match(/(\d{3}(?:\s*[\/,]\s*\d{3})+)\s*mm\s*(?:radiator|AIO)/i);
  if (rangeMatch) {
    const nums = rangeMatch[1].match(/\d{3}/g) || [];
    for (const n of nums) {
      const s = `${n}mm`;
      if ([120, 140, 240, 280, 360, 420, 480].includes(parseInt(n, 10)) && !radSizes.includes(s)) {
        radSizes.push(s);
      }
    }
  }
  if (radSizes.length) specs.rads = radSizes.sort((a, b) => parseInt(a) - parseInt(b)).join(',');

  // ── Model token (for matching) ───────────────────────────────────
  // Extract SKU-like tokens from title: "Y6-N6-W", "K2-3-B", "F600", "EC2"
  const tokens = [];
  const tokenMatches = title.match(/\b([A-Z]{1,4}\d{1,4}(?:-[A-Z\d]+)*)\b/g) || [];
  for (const t of tokenMatches) {
    if (!['PWM', 'ARGB', 'ATX', 'USB', 'RGB', 'LED', 'CPU', 'GPU', 'MOBO', 'TG', 'SSD', 'HDD', 'PSU'].includes(t)) {
      tokens.push(t);
    }
  }

  return { specs, tokens, title, handle: product.handle };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
const scraped = {};

for (const { brand, base } of SITES) {
  console.log(`\n━━━ ${brand} ━━━`);
  const cacheFile = `${CACHE_DIR}/${brand}.json`;
  let products;
  if (existsSync(cacheFile)) {
    console.log('  (using cache)');
    products = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } else {
    try {
      products = await fetchShopifyProducts(base);
      writeFileSync(cacheFile, JSON.stringify(products, null, 2));
    } catch (e) {
      console.log(`  ✗ failed: ${e.message}`);
      continue;
    }
  }
  console.log(`  Got ${products.length} products total`);

  const cases = products.filter(p => {
    const text = `${p.title} ${p.product_type || ''}`.toLowerCase();
    return text.includes('case') || text.includes('chassis') || text.includes('tower');
  });
  console.log(`  Cases: ${cases.length}`);

  scraped[brand] = [];
  for (const p of cases) {
    const { specs, tokens, title, handle } = extractSpecs(p);
    if (Object.keys(specs).length === 0) continue;
    scraped[brand].push({ title, handle, tokens, specs });
  }
  console.log(`  Extracted specs: ${scraped[brand].length}`);
}

// ─── MATCH TO CATALOG ────────────────────────────────────────────────────────
console.log('\n━━━ MATCHING TO CATALOG ━━━');
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const stats = { maxGPU: 0, maxCooler: 0, fans_inc: 0, rads: 0, matched: 0 };

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const brand = (p.b || '').toUpperCase();
  const manufEntries = scraped[brand];
  if (!manufEntries) continue;

  const caseName = String(p.n || '').toUpperCase();

  // Try to match by model token
  let match = null;
  for (const entry of manufEntries) {
    for (const tok of entry.tokens) {
      // Token must appear in product name as a whole word
      const re = new RegExp(`\\b${tok.replace(/[-]/g, '[-\\s]?')}\\b`, 'i');
      if (re.test(caseName)) {
        match = entry;
        break;
      }
    }
    if (match) break;
  }
  // Fallback: substring match on first few words of title
  if (!match) {
    for (const entry of manufEntries) {
      const titleFirst = entry.title.replace(/[™®©]/g, '').slice(0, 30).toUpperCase();
      if (titleFirst.length > 8 && caseName.includes(titleFirst)) {
        match = entry;
        break;
      }
    }
  }
  if (!match) continue;

  stats.matched++;
  if (p.maxGPU == null && match.specs.maxGPU != null) { p.maxGPU = match.specs.maxGPU; stats.maxGPU++; }
  if (p.maxCooler == null && match.specs.maxCooler != null) { p.maxCooler = match.specs.maxCooler; stats.maxCooler++; }
  if (p.fans_inc == null && match.specs.fans_inc != null) { p.fans_inc = match.specs.fans_inc; stats.fans_inc++; }
  if (p.rads == null && match.specs.rads != null) { p.rads = match.specs.rads; stats.rads++; }
}

console.log('\nResult:', JSON.stringify(stats));

const cases = parts.filter(p => p.c === 'Case');
console.log('\nCase coverage after Shopify scrape:');
console.log('  maxGPU:   ', cases.filter(x => x.maxGPU).length + '/' + cases.length);
console.log('  maxCooler:', cases.filter(x => x.maxCooler).length + '/' + cases.length);
console.log('  fans_inc: ', cases.filter(x => x.fans_inc != null).length + '/' + cases.length);
console.log('  rads:     ', cases.filter(x => x.rads).length + '/' + cases.length);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
