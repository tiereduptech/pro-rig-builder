#!/usr/bin/env node
/**
 * bestbuy-discover-v2.js — Best Buy catalog discovery via Developer API
 *
 * Replaces Impact-based keyword search with clean category-ID filtering
 * via Best Buy's Developer API. Also pulls full spec details in the same
 * call, combining the old discovery + enrichment steps into one.
 *
 * Each category is queried using its Best Buy category ID(s). The API
 * returns real Best Buy direct-inventory only (no marketplace noise).
 *
 * Affiliate URLs are constructed from a template derived from the user's
 * Impact partnership:
 *   https://bestbuycreators.7tiv.net/c/{PARTNER}/{OFFER}/{CAMPAIGN}?
 *     prodsku={SKU}&u={ENCODED_URL}
 *
 * Usage:
 *   railway run node bestbuy-discover-v2.js
 *   railway run node bestbuy-discover-v2.js --category=GPU
 *   railway run node bestbuy-discover-v2.js --limit=50      # for dev testing
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY env var required.');
  process.exit(1);
}

const OUTPUT_DIR = join(process.cwd(), 'catalog-build', 'bestbuy-discovery');

// Affiliate URL template — derived from Impact attribution structure
const AFFILIATE = {
  host: 'bestbuycreators.7tiv.net',
  partner: '7109270',
  offer: '3337161',
  campaign: '28102',
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const flags = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  flags[k] = v ?? true;
}
const ONLY_CATEGORY = flags.category || null;
const LIMIT = flags.limit ? parseInt(flags.limit) : null;
const DRY_RUN = !!flags['dry-run'];
const RATE_LIMIT_MS = parseInt(flags.rate || '500'); // 2/sec — very safe given earlier 403s

// ─────────────────────────────────────────────────────────────────────────────
// Category ID map
//
// Each our-category maps to one or more Best Buy category IDs.
// Multiple IDs = union. The API supports OR syntax: ((categoryPath.id=X|Y|Z))
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_IDS = {
  // Core PC components
  GPU:          ['abcat0507002'],
  CPU:          ['abcat0507010'],
  Motherboard:  ['abcat0507008'],
  RAM:          ['abcat0506000'],             // Parent Computer Memory (RAM) — desktop memory subcat is empty
  Case:         ['abcat0507006'],
  PSU:          ['abcat0507009'],
  SoundCard:    ['abcat0507003'],             // Best Buy may have 0 in stock; leave for future

  // Storage — Internal SSDs, Internal Hard Drives (not external/NAS/flash)
  Storage:      ['pcmcat1538498095184', 'pcmcat270900050001', 'abcat0504002'],

  // Cooling — CPU coolers and case fans split properly
  CPUCooler:    ['pcmcat339900050006', 'pcmcat339900050008'],  // CPU Fans & Heatsinks + Water Cooling
  CaseFan:      ['pcmcat339900050005'],                        // Case Fans

  // Display
  Monitor:      ['abcat0509000'],

  // Networking — internal expansion cards (PCIe). Best Buy has ~0 in stock.
  NetworkCard:  ['abcat0503011', 'abcat0503010', 'pcmcat252800050013'],

  // Optical — Internal DVD drives only (CD/DVD and Blu-ray empty at Best Buy)
  OpticalDrive: ['pcmcat189600050010'],

  // Peripherals — accessories
  Mouse:        ['pcmcat304600050013'],                              // Gaming Mice
  Keyboard:     ['pcmcat304600050014'],                              // Gaming Keyboards
  Headset:      ['pcmcat230800050019', 'pcmcat1572279759550'],       // PC Gaming Headsets + Gaming Headsets
  Microphone:   ['pcmcat221400050015', 'pcmcat221400050014'],        // Condenser + Dynamic Microphones
  Webcam:       ['abcat0515046'],                                    // Webcams
  MousePad:     ['pcmcat1503427739152', 'abcat0515032'],             // Gaming Mouse Pads + Mouse Pads
  // ExtensionCables: not stocked by Best Buy in any meaningful volume - skip
};

// ─────────────────────────────────────────────────────────────────────────────
// API call with rate limit handling
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(categoryIds, page = 1, pageSize = 100, attempt = 1) {
  const filter = categoryIds.length === 1
    ? `categoryPath.id=${categoryIds[0]}`
    : categoryIds.map(id => `categoryPath.id=${id}`).join('|');

  // Fields we want per product — includes everything needed for discovery AND specs
  const show = [
    'sku', 'name', 'manufacturer', 'modelNumber', 'upc',
    'salePrice', 'regularPrice', 'onSale',
    'onlineAvailability', 'inStoreAvailability',
    'image', 'url',
    'details', 'features',
    'color', 'weight', 'depth', 'height', 'width',
    'categoryPath',
    'customerReviewAverage', 'customerReviewCount',
  ].join(',');

  const url = `https://api.bestbuy.com/v1/products((${filter}))?apiKey=${KEY}&page=${page}&pageSize=${pageSize}&show=${show}&format=json`;

  const resp = await fetch(url);

  if (resp.status === 403) {
    // Best Buy rate limit — back off
    if (attempt < 5) {
      const backoff = attempt * 2000;
      await sleep(backoff);
      return fetchPage(categoryIds, page, pageSize, attempt + 1);
    }
    throw new Error(`403 rate limited after ${attempt} retries`);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Affiliate URL construction
//
// Best Buy's product page URL follows: https://www.bestbuy.com/site/{slug}/{sku}.p?skuId={sku}
// We can construct it, or use the `url` field from the API (which is a Best Buy
// click-tracking URL). Simpler: use Best Buy's canonical product URL.
// ─────────────────────────────────────────────────────────────────────────────

function buildAffiliateUrl(sku, bestBuyProductUrl) {
  // bestBuyProductUrl looks like https://www.bestbuy.com/site/...
  const encoded = encodeURIComponent(bestBuyProductUrl);
  return `https://${AFFILIATE.host}/c/${AFFILIATE.partner}/${AFFILIATE.offer}/${AFFILIATE.campaign}?prodsku=${sku}&u=${encoded}`;
}

// Best Buy Dev API returns url like "https://api.bestbuy.com/click/-/6519473/pdp"
// We want the canonical product URL. Construct it from SKU.
// Best Buy convention: https://www.bestbuy.com/site/{slug}/{sku}.p?skuId={sku}
// Since we don't have the slug, use a simpler redirect URL that works:
function bestBuyProductUrl(sku) {
  return `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Refurbished detection
// Best Buy doesn't expose a dedicated condition field, but refurb products
// always include "Refurbished" or "Geek Squad" in the name/model.
// ─────────────────────────────────────────────────────────────────────────────

function detectCondition(name, modelNumber) {
  const combined = `${name || ''} ${modelNumber || ''}`;
  if (/\b(refurbished|geek squad certified|GSRF)\b/i.test(combined)) {
    return 'refurbished';
  }
  if (/\bopen[- ]box\b/i.test(combined)) {
    return 'open-box';
  }
  return 'new';
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec parsers (lightweight inline versions — category-specific mapping still
// happens in bestbuy-enrich.js if we keep it, but we also extract basics here
// so the discovery file is usable on its own)
// ─────────────────────────────────────────────────────────────────────────────

function parseNum(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function detailsToMap(details) {
  const map = {};
  if (!Array.isArray(details)) return map;
  for (const d of details) {
    if (d?.name) map[d.name] = d.value;
  }
  return map;
}

function normalize(product, ourCategory) {
  const sku = String(product.sku);
  const bbUrl = bestBuyProductUrl(sku);
  const affiliateUrl = buildAffiliateUrl(sku, bbUrl);
  const condition = detectCondition(product.name, product.modelNumber);

  return {
    catalogItemId: sku,             // Kept for backward compat with merge script
    bestBuySku: sku,                // Clean name for future use
    name: product.name || '',
    manufacturer: product.manufacturer || '',
    price: product.salePrice ?? product.regularPrice ?? null,
    originalPrice: product.regularPrice ?? null,
    currency: 'USD',
    condition,                      // 'new' | 'refurbished' | 'open-box'
    stockAvailability: product.onlineAvailability ? 'InStock' : 'OutOfStock',
    url: affiliateUrl,              // Your affiliate-attributed URL
    directUrl: bbUrl,               // Raw Best Buy URL (for debugging)
    imageUrl: product.image || '',
    gtin: product.upc || '',
    mpn: product.modelNumber || '',
    asin: '',                       // Not available from Best Buy
    category: product.categoryPath?.[product.categoryPath.length - 1]?.name || '',
    categoryPath: product.categoryPath?.map(c => c.name).join(' > ') || '',
    subCategory: '1P',              // Developer API only returns 1P direct inventory
    retailer: 'bestbuy',
    ourCategory,
    onSale: product.onSale === true,
    rating: product.customerReviewAverage ? parseFloat(product.customerReviewAverage) : null,
    reviews: product.customerReviewCount || 0,
    // Merged spec fields (direct from details array, raw)
    _details: detailsToMap(product.details),
    _scalars: {
      color: product.color,
      weight: product.weight,
      depth: product.depth,
      height: product.height,
      width: product.width,
    },
    features: product.features || [],
    discoveredAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category discovery
// ─────────────────────────────────────────────────────────────────────────────

async function discoverCategory(category, categoryIds) {
  console.log(`\n━━━ ${category} (category IDs: ${categoryIds.join(', ')}) ━━━`);

  const products = [];
  let page = 1;
  let totalPages = 1;
  let totalAvailable = 0;

  while (page <= totalPages) {
    process.stdout.write(`  page ${page}/${totalPages}... `);

    let resp;
    try {
      resp = await fetchPage(categoryIds, page, 100);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      break;
    }

    if (page === 1) {
      totalAvailable = resp.total || 0;
      totalPages = resp.totalPages || 1;
      console.log(`${resp.products?.length || 0} products (total available: ${totalAvailable})`);
    } else {
      console.log(`${resp.products?.length || 0} products`);
    }

    for (const p of (resp.products || [])) {
      products.push(normalize(p, category));
      if (LIMIT && products.length >= LIMIT) break;
    }

    if (LIMIT && products.length >= LIMIT) {
      console.log(`  limit ${LIMIT} reached, stopping`);
      break;
    }

    page++;
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`  → collected ${products.length} products`);
  return products;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const categories = ONLY_CATEGORY
    ? [ONLY_CATEGORY]
    : Object.keys(CATEGORY_IDS);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Best Buy discovery via Developer API (v2)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Categories:', categories.join(', '));
  console.log('Limit per cat:', LIMIT || 'none');
  console.log('Output:   ', OUTPUT_DIR);
  console.log('Rate:     ', `1 req every ${RATE_LIMIT_MS}ms`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const summary = {};

  for (const category of categories) {
    const ids = CATEGORY_IDS[category];
    if (!ids) {
      console.log(`\n${category}: no category IDs defined, skipping`);
      continue;
    }

    const products = await discoverCategory(category, ids);
    summary[category] = products.length;

    if (!DRY_RUN && products.length > 0) {
      const outPath = join(OUTPUT_DIR, `${category}.json`);
      writeFileSync(outPath, JSON.stringify(products, null, 2));
      console.log(`  saved → ${outPath}`);
    }
  }

  console.log('\n━━━ SUMMARY ━━━');
  let total = 0;
  for (const [cat, count] of Object.entries(summary)) {
    console.log(`  ${cat.padEnd(14)}  ${count}`);
    total += count;
  }
  console.log(`  ${'TOTAL'.padEnd(14)}  ${total}`);

  console.log('\nNext: update bestbuy-enrich.js to use _details map (already in discovery file)');
  console.log('      OR skip enrichment — specs are already discovered.');
})();
