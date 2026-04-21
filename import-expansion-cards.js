#!/usr/bin/env node
/**
 * import-expansion-cards.js
 *
 * Imports products into 4 categories that are currently sparse:
 *   - SoundCard
 *   - EthernetCard
 *   - OpticalDrive
 *   - WiFiCard
 *
 * Strategy:
 *   1. Best Buy API first (free, already authenticated) — gets SKUs with
 *      inventory, prices, images, ratings, reviews.
 *   2. DataForSEO Amazon keyword search to top up with ASINs that Best Buy
 *      doesn't carry (Amazon has much deeper inventory on these categories).
 *   3. Deduplicate by UPC/title, merge deals from both sources.
 *   4. Write to parts.js preserving existing products.
 *
 * Env vars required (injected via `railway run`):
 *   BESTBUY_API_KEY
 *   DATAFORSEO_LOGIN
 *   DATAFORSEO_PASSWORD
 *
 * Usage:
 *   railway run node import-expansion-cards.js
 */
import { writeFileSync } from 'node:fs';

const BESTBUY_KEY = process.env.BESTBUY_API_KEY;
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN;
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD;
const AMAZON_TAG = 'tiereduptech-20';

if (!BESTBUY_KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }
if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD'); process.exit(1); }

// ─── Category → search config ──────────────────────────────────────────────
// Each category has multiple keyword variants for breadth, and the right
// Best Buy categoryPath / keyword for the Best Buy API.
const CATEGORIES = {
  SoundCard: {
    bestbuy: {
      queries: ['sound card pcie', 'internal sound card', 'creative sound blaster pcie'],
    },
    amazon: {
      queries: ['pcie sound card', 'sound card internal pc', 'creative sound blaster pcie'],
    },
  },
  EthernetCard: {
    bestbuy: {
      queries: ['10gbe pcie ethernet adapter', '2.5gbe pcie network card', 'pcie ethernet adapter'],
    },
    amazon: {
      queries: ['10gbe pcie network card', '2.5gbe pcie network adapter', '5gbe pcie ethernet card', 'pcie ethernet card intel'],
    },
  },
  OpticalDrive: {
    bestbuy: {
      queries: ['internal blu-ray drive', 'internal dvd writer', 'dvd-rw internal'],
    },
    amazon: {
      queries: ['internal blu ray drive', 'internal dvd writer sata', 'blu-ray burner internal', 'dvd-rw sata internal'],
    },
  },
  WiFiCard: {
    bestbuy: {
      queries: ['wifi 6e pcie card', 'wifi 7 pcie adapter', 'pcie wifi card bluetooth'],
    },
    amazon: {
      queries: ['wifi 6e pcie card', 'wifi 7 pcie adapter', 'pcie wifi card bluetooth', 'tp-link pcie wifi'],
    },
  },
};

// ─── Best Buy API helpers ──────────────────────────────────────────────────
async function bbSearch(keyword) {
  // Best Buy Products API v1
  // https://api.bestbuy.com/v1/products((search=KEYWORD)&?apiKey=KEY&format=json&pageSize=25&show=sku,name,manufacturer,salePrice,regularPrice,customerReviewAverage,customerReviewCount,image,upc,url,modelNumber,onlineAvailability,categoryPath
  const q = encodeURIComponent(keyword);
  const show = 'sku,name,manufacturer,salePrice,regularPrice,customerReviewAverage,customerReviewCount,image,upc,url,modelNumber,onlineAvailability';
  const url = `https://api.bestbuy.com/v1/products((search=${q}))?apiKey=${BESTBUY_KEY}&format=json&pageSize=25&show=${show}&sort=bestSellingRank.asc`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Best Buy error ${res.status} for "${keyword}"`);
    return [];
  }
  const json = await res.json();
  return json.products || [];
}

// ─── DataForSEO Amazon helper ──────────────────────────────────────────────
async function dfsAmazonSearch(keyword) {
  // DataForSEO Merchant/Amazon Products endpoint — live
  const url = 'https://api.dataforseo.com/v3/merchant/amazon/products/live/advanced';
  const auth = Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');
  const body = [{
    keyword,
    location_code: 2840, // United States
    language_code: 'en_US',
    depth: 40,
  }];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`  DataForSEO error ${res.status} for "${keyword}"`);
    return [];
  }
  const json = await res.json();
  const items = json?.tasks?.[0]?.result?.[0]?.items || [];
  return items.filter(i => i.type === 'amazon_product_search_organic');
}

// ─── Normalize Best Buy product → our schema ───────────────────────────────
let nextId = 20000; // we'll scan existing parts and start above max
function bbToProduct(p, category) {
  if (!p.sku || !p.name) return null;
  if (p.onlineAvailability === false) return null;
  const price = p.salePrice ?? p.regularPrice;
  if (!price || price <= 0) return null;
  return {
    id: nextId++,
    n: p.name.substring(0, 200),
    img: p.image || '',
    c: category,
    b: p.manufacturer || 'Unknown',
    pr: Math.round(price),
    msrp: Math.round(p.regularPrice || price),
    r: p.customerReviewAverage || 0,
    reviews: p.customerReviewCount || 0,
    upc: p.upc || null,
    mpn: p.modelNumber || null,
    deals: {
      bestbuy: {
        price: Math.round(price),
        url: p.url,
        inStock: p.onlineAvailability !== false,
        sku: String(p.sku),
      },
    },
  };
}

// ─── Normalize DataForSEO Amazon product → our schema ──────────────────────
function dfsToProduct(item, category) {
  if (!item.title || !item.asin) return null;
  const price = item.price?.current ?? item.price?.price;
  if (!price || price <= 0) return null;
  // Skip Amazon bundle listings
  if (/refurbished|renewed\b/i.test(item.title)) return null;
  return {
    id: nextId++,
    n: item.title.substring(0, 200),
    img: item.image_url || '',
    c: category,
    b: item.brand || guessBrand(item.title) || 'Unknown',
    pr: Math.round(price),
    msrp: Math.round(item.price?.regular || price),
    r: item.rating?.value || 0,
    reviews: item.rating?.votes_count || 0,
    asin: item.asin,
    deals: {
      amazon: {
        price: Math.round(price),
        url: `https://www.amazon.com/dp/${item.asin}?tag=${AMAZON_TAG}`,
        inStock: true,
      },
    },
  };
}

// ─── Brand guesser for products that don't report brand ────────────────────
const KNOWN_BRANDS = [
  'Creative', 'ASUS', 'ROG', 'TP-Link', 'TP Link', 'Intel', 'Netgear', 'QNAP',
  'Sonnet', 'Syba', 'IO Crest', 'IOCrest', 'StarTech', 'Sabrent', 'MSI',
  'Ubit', 'LG', 'ASUS', 'Pioneer', 'Plextor', 'Samsung', 'Verbatim',
  'Gigabyte', 'EDUP', 'Rosewill', 'Orico', 'ORICO', 'Cable Matters',
  'Anewish', 'Anewkodi', 'Wavlink', 'Cudy', 'Ziyituod', 'FebSmart',
  'Fenvi', 'TRENDnet', '10Gtek', 'Mokerlink',
];
function guessBrand(title) {
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp(`\\b${b.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i');
    if (re.test(title)) return b;
  }
  return null;
}

// ─── Deduplication ─────────────────────────────────────────────────────────
// Two products match if: (a) same UPC/ASIN OR (b) normalized title similar
function normalizeTitle(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function mergeIntoExisting(newProduct, existing) {
  // Merge: keep existing id/n/b/img; add deals and asin/upc
  if (newProduct.deals?.bestbuy) existing.deals = { ...(existing.deals || {}), bestbuy: newProduct.deals.bestbuy };
  if (newProduct.deals?.amazon) existing.deals = { ...(existing.deals || {}), amazon: newProduct.deals.amazon };
  if (newProduct.asin && !existing.asin) existing.asin = newProduct.asin;
  if (newProduct.upc && !existing.upc) existing.upc = newProduct.upc;
  if (newProduct.mpn && !existing.mpn) existing.mpn = newProduct.mpn;
  // Reviews: keep higher count
  if ((newProduct.reviews || 0) > (existing.reviews || 0)) {
    existing.reviews = newProduct.reviews;
    if (newProduct.r) existing.r = newProduct.r;
  }
  // Prices: keep lower pr as the display price
  if (newProduct.pr && newProduct.pr < existing.pr) existing.pr = newProduct.pr;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
  const parts = [...mod.PARTS];
  nextId = Math.max(...parts.map(p => p.id || 0)) + 1;
  console.log(`Starting ID: ${nextId}`);

  const byKey = new Map(); // normalized title → product
  const byUpc = new Map();
  const byAsin = new Map();

  // Index existing products so we can merge rather than duplicate
  for (const p of parts) {
    if (!Object.keys(CATEGORIES).includes(p.c)) continue;
    byKey.set(normalizeTitle(p.n), p);
    if (p.upc) byUpc.set(p.upc, p);
    if (p.asin) byAsin.set(p.asin, p);
  }
  console.log(`Indexed ${byKey.size} existing products across the 4 categories\n`);

  const importedPerCategory = {};
  const skippedPerCategory = {};

  for (const [category, config] of Object.entries(CATEGORIES)) {
    console.log(`━━━ ${category} ━━━`);
    importedPerCategory[category] = 0;
    skippedPerCategory[category] = 0;

    // ── Best Buy ────────────────────────────────────────────────────────
    const bbSeen = new Set();
    for (const q of config.bestbuy.queries) {
      console.log(`  Best Buy: "${q}"`);
      const results = await bbSearch(q);
      await new Promise(r => setTimeout(r, 600)); // rate limit politeness
      for (const bb of results) {
        if (bbSeen.has(bb.sku)) continue;
        bbSeen.add(bb.sku);
        const prod = bbToProduct(bb, category);
        if (!prod) { skippedPerCategory[category]++; continue; }

        // Category sanity: exclude obvious wrong matches
        if (category === 'SoundCard' && !/sound\s*card|sound\s*blaster|audio\s*card|xonar|creative/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'EthernetCard' && !/ethernet|network\s*(card|adapter)|10gbe|2\.5\s*gbe|nic\b/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'OpticalDrive' && !/blu-?ray|dvd|optical\s*drive|cd-?rw/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'WiFiCard' && !/wi-?fi|wireless|pcie.*wifi|bluetooth.*adapter/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }

        // Deduplicate: if we already have this product, just merge deals
        const existing = (prod.upc && byUpc.get(prod.upc)) || byKey.get(normalizeTitle(prod.n));
        if (existing) {
          mergeIntoExisting(prod, existing);
          continue;
        }
        parts.push(prod);
        byKey.set(normalizeTitle(prod.n), prod);
        if (prod.upc) byUpc.set(prod.upc, prod);
        importedPerCategory[category]++;
      }
    }

    // ── Amazon via DataForSEO ──────────────────────────────────────────
    const asinSeen = new Set();
    for (const q of config.amazon.queries) {
      console.log(`  Amazon: "${q}"`);
      const results = await dfsAmazonSearch(q);
      await new Promise(r => setTimeout(r, 800));
      for (const item of results) {
        if (!item.asin || asinSeen.has(item.asin)) continue;
        asinSeen.add(item.asin);
        const prod = dfsToProduct(item, category);
        if (!prod) { skippedPerCategory[category]++; continue; }

        // Category sanity filters
        if (category === 'SoundCard' && !/sound\s*card|sound\s*blaster|audio\s*card|xonar|creative.*pcie|dac.*pcie/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'EthernetCard' && !/ethernet|network\s*(card|adapter)|10gbe|2\.5\s*gbe|5gbe|nic\b/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'OpticalDrive' && !/blu-?ray|dvd|optical\s*drive|cd-?rw/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }
        if (category === 'WiFiCard' && !/wi-?fi|wireless|pcie.*wifi|bluetooth.*adapter/i.test(prod.n)) {
          skippedPerCategory[category]++; continue;
        }

        // Dedupe
        const existing = byAsin.get(prod.asin) || byKey.get(normalizeTitle(prod.n));
        if (existing) {
          mergeIntoExisting(prod, existing);
          continue;
        }
        parts.push(prod);
        byKey.set(normalizeTitle(prod.n), prod);
        byAsin.set(prod.asin, prod);
        importedPerCategory[category]++;
      }
    }

    console.log(`  → Imported ${importedPerCategory[category]} new (skipped ${skippedPerCategory[category]})\n`);
  }

  // ─── Write ────────────────────────────────────────────────────────────
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);

  console.log('━━━ SUMMARY ━━━');
  for (const cat of Object.keys(CATEGORIES)) {
    const total = parts.filter(p => p.c === cat).length;
    console.log(`  ${cat.padEnd(14)} +${importedPerCategory[cat]} new  = ${total} total`);
  }
  console.log('\nWrote parts.js');
}

main().catch(e => { console.error(e); process.exit(1); });
