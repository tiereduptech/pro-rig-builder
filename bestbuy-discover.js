#!/usr/bin/env node
/**
 * bestbuy-discover.js — discover Best Buy PC parts via Impact /Catalogs/ItemSearch
 *
 * Mirrors the DataForSEO discovery pattern: loops through queries for each
 * category, collects matching products, dedupes by CatalogItemId, saves to
 * catalog-build/bestbuy-discovery/{category}.json.
 *
 * Output shape (per category file):
 *   [
 *     {
 *       catalogItemId: "11079104",
 *       name: "...",
 *       manufacturer: "Lenovo",
 *       price: 63.25,
 *       originalPrice: 63.25,
 *       stockAvailability: "InStock",
 *       url: "https://bestbuycreators.7tiv.net/...",  // affiliate-wrapped
 *       imageUrl: "...",
 *       gtin: "195892088424",                         // UPC — matching key
 *       mpn: "",
 *       category: "GPUs / Video Graphics Cards",
 *       subCategory: "3P",                            // "3P" = marketplace seller
 *       discoveredVia: "graphics card",
 *     },
 *     ...
 *   ]
 *
 * Usage (on Railway so env vars are loaded):
 *   railway run node bestbuy-discover.js
 *   railway run node bestbuy-discover.js --dry-run
 *   railway run node bestbuy-discover.js --category=GPU
 *   railway run node bestbuy-discover.js --filter-3p   # exclude marketplace sellers
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;

if (!SID || !TOKEN) {
  console.error('ERROR: IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN env vars required.');
  console.error('Run via: railway run node bestbuy-discover.js');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

const flags = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  flags[k] = v ?? true;
}
const DRY_RUN = !!flags['dry-run'];
const FILTER_3P = !!flags['filter-3p'];          // drop SubCategory "3P" (3rd-party marketplace)
const ONLY_CATEGORY = flags.category || null;
const MAX_PAGES_PER_QUERY = parseInt(flags.maxpages || '5'); // 200 items/page × 5 = 1000 per query max
const PAGE_SIZE = 200; // Impact's maximum

// ─────────────────────────────────────────────────────────────────────────────
// Category → search queries
//
// Impact's Keyword search matches item names + descriptions. Use specific
// product-class keywords, not brand names (which would bias coverage).
// Each query returns up to MAX_PAGES_PER_QUERY × PAGE_SIZE = 1000 items.
// Dedupe across queries happens by CatalogItemId.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = {
  Motherboard: ['motherboard', 'am5 motherboard', 'lga 1851 motherboard', 'b650 motherboard', 'x670 motherboard', 'z790 motherboard'],
  CPU:         ['cpu processor', 'ryzen processor', 'intel core processor', 'core i7', 'core i9', 'ryzen 7', 'ryzen 9'],
  GPU:         ['graphics card', 'geforce rtx', 'radeon rx', 'rtx 4070', 'rtx 4080', 'rtx 5070', 'rtx 5080', 'gaming graphics card'],
  RAM:         ['ddr5 memory', 'ddr4 memory', 'desktop ram', 'gaming ram', 'corsair vengeance ddr5', 'g.skill trident'],
  Storage:     ['nvme ssd', 'm.2 ssd', 'internal ssd', '2tb nvme', '1tb nvme', 'internal hard drive'],
  PSU:         ['power supply', '750w power supply', '850w power supply', 'atx power supply', 'modular psu'],
  Case:        ['pc case', 'computer case', 'mid tower case', 'atx case', 'gaming pc case'],
  CPUCooler:   ['cpu cooler', 'aio cooler', 'liquid cpu cooler', 'air cpu cooler', '360mm aio'],
  Monitor:     ['gaming monitor', '4k monitor', '1440p monitor', '144hz monitor', '240hz monitor', 'oled monitor', 'ultrawide monitor'],
  CaseFan:     ['pc case fan', '120mm fan', '140mm fan', 'rgb case fan'],
  // New categories we didn't do on DataForSEO (because user mentioned them)
  SoundCard:   ['sound card', 'pcie sound card', 'gaming sound card'],
  NetworkCard: ['ethernet adapter', 'wifi pcie card', 'wifi 6 pcie', 'wifi 7 card'],
  OpticalDrive:['blu-ray drive', 'dvd drive', 'internal optical drive'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Category whitelist — Best Buy's `Category` field must match one of these
// for the product to be kept in the corresponding bucket.
//
// Rationale: keyword search is noisy. Searching "graphics card" returns 939
// products including 341 Gaming Desktops and 118 Gaming Laptops that just
// mention "graphics card" in their name. Filtering by Best Buy's own category
// taxonomy eliminates this.
//
// These are the `Category` values observed in real API responses. Extend if
// new categories show up in future discovery runs.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_WHITELIST = {
  Motherboard: [/^Motherboards$/i, /\bMotherboards\b/i],
  CPU:         [/CPUs?\s*\/\s*Processors/i, /\bProcessors\b/i],
  GPU:         [/GPUs?\s*\/\s*Video Graphics Cards/i, /Graphics Cards/i],
  RAM:         [/Computer Memory/i, /\bRAM\b/i, /Desktop Memory/i],
  // Storage — broad regex covers "Internal SSDs", "Samsung Internal SSDs",
  // "Internal Hard Drives", "NVMe", "PS5 Storage", etc.
  Storage: [
    /Internal\s*(Solid State|SSDs?|Hard Drives?|M\.?2|NVMe)/i,
    /\bNVMe\b/i,
    /\bSSDs?\b/i,
    /Hard Drives/i,
    /PS5 Storage/i,
  ],
  PSU:         [/Power Supplies/i, /\bPSUs?\b/i],
  Case:        [/Computer Cases/i, /\bPC Cases\b/i, /\bTower Cases\b/i],
  CPUCooler: [
    /CPU Fans/i,
    /CPU Cooler/i,
    /Computer Cooling/i,
    /Water Cooling/i,
    /AIO/i,
  ],
  Monitor: [
    /\bMonitors\b/i,
  ],
  CaseFan:     [/Case Fans/i, /\bComputer Cooling\b/i],
  SoundCard:   [/Sound Cards?/i],
  NetworkCard: [
    /Network Cards/i,
    /Ethernet Cards/i,
    /Wireless Network/i,
    /Wi-?Fi Adapters?/i,
    /Network Adapters/i,
  ],
  OpticalDrive:[/Internal Optical Drives/i, /Optical Drives/i, /Blu-?ray Drives/i, /DVD Drives/i],
};

function matchesWhitelist(whitelist, category) {
  if (!whitelist || !category) return false;
  for (const entry of whitelist) {
    if (entry instanceof RegExp) {
      if (entry.test(category)) return true;
    } else if (entry === category) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Impact API call
// ─────────────────────────────────────────────────────────────────────────────

const basicAuth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');

async function searchImpact(keyword, page = 0) {
  const params = new URLSearchParams({
    Keyword: keyword,
    Query: "StockAvailability = 'InStock'",
    PageSize: String(PAGE_SIZE),
    Page: String(page),
  });
  const url = `https://api.impact.com/Mediapartners/${SID}/Catalogs/ItemSearch?${params}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Impact API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalize Impact item → our flat discovery schema
// ─────────────────────────────────────────────────────────────────────────────

function normalize(item, category, discoveredVia) {
  // Parse price — Impact returns strings like "63.25"
  const price = item.CurrentPrice ? parseFloat(item.CurrentPrice) : null;
  const originalPrice = item.OriginalPrice ? parseFloat(item.OriginalPrice) : price;

  // Extract Best Buy SKU from the affiliate URL (most reliable source)
  // URL format: https://bestbuycreators.7tiv.net/.../prodsku=6519473&u=...
  const bbSkuMatch = String(item.Url || '').match(/prodsku=(\d+)/);
  const bestBuySku = bbSkuMatch ? bbSkuMatch[1] : null;

  return {
    catalogItemId: item.CatalogItemId,    // Impact's per-seller ID (not stable across 1P/3P)
    bestBuySku,                           // Actual Best Buy SKU, used for Developer API lookups
    name: item.Name || '',
    manufacturer: item.Manufacturer || '',
    price,
    originalPrice,
    currency: item.Currency || 'USD',
    stockAvailability: item.StockAvailability || 'Unknown',
    url: item.Url || '',
    imageUrl: item.ImageUrl || '',
    gtin: item.Gtin || '',
    mpn: item.Mpn || '',
    asin: item.Asin || '',
    category: item.Category || '',
    subCategory: item.SubCategory || '',
    campaignId: item.CampaignId,
    campaignName: item.CampaignName,
    retailer: 'bestbuy',
    ourCategory: category,
    discoveredVia,
    discoveredAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-category discovery loop
// ─────────────────────────────────────────────────────────────────────────────

async function discoverCategory(category, keywords) {
  console.log(`\n━━━ ${category} (${keywords.length} queries) ━━━`);
  // seen: bestBuySku → { item, sub }
  //   Dedup by actual Best Buy SKU (from the affiliate URL), not Impact's
  //   CatalogItemId (which is different per-seller). Same product from
  //   1P and 3P will share a Best Buy SKU.
  //   Prefer 1P (Best Buy direct) over 3P (marketplace) — if we see 1P
  //   after a 3P, we swap them.
  const seen = new Map();
  const rejectedByCategory = new Map();
  const whitelist = CATEGORY_WHITELIST[category] || null;

  function extractBestBuySku(url) {
    if (!url) return null;
    const m = url.match(/prodsku=(\d+)/);
    return m ? m[1] : null;
  }

  for (const keyword of keywords) {
    let kept = 0;
    let upgraded3Pto1P = 0;
    let totalMatching = 0;
    let categoryRejected = 0;

    for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
      let resp;
      try {
        resp = await searchImpact(keyword, page);
      } catch (err) {
        console.log(`  ❌ "${keyword}" page ${page}: ${err.message}`);
        break;
      }

      const items = resp.Items || [];
      if (page === 0) totalMatching = parseInt(resp['@total'] || '0');

      if (items.length === 0) break;

      for (const raw of items) {
        if (!raw.CampaignName || !/best\s*buy/i.test(raw.CampaignName)) continue;

        // Category whitelist filter (loose — real filter happens at enrichment)
        if (whitelist && !matchesWhitelist(whitelist, raw.Category)) {
          categoryRejected++;
          rejectedByCategory.set(raw.Category, (rejectedByCategory.get(raw.Category) || 0) + 1);
          continue;
        }

        // Use the Best Buy SKU as dedup key (stable across 1P/3P variants)
        const bbSku = extractBestBuySku(raw.Url) || raw.CatalogItemId;
        if (!bbSku) continue;

        const isOneP = raw.SubCategory === '1P';
        const isThreeP = raw.SubCategory === '3P';

        // If filtering 3P: skip 3P entirely (we'll accept 1P-only)
        if (FILTER_3P && isThreeP) continue;

        const existing = seen.get(bbSku);
        if (existing) {
          // Upgrade: replace an existing 3P with 1P when we find the better variant
          if (existing.sub === '3P' && isOneP) {
            seen.set(bbSku, { item: normalize(raw, category, keyword), sub: '1P' });
            upgraded3Pto1P++;
          }
          // Otherwise keep whatever we already have
          continue;
        }

        seen.set(bbSku, {
          item: normalize(raw, category, keyword),
          sub: raw.SubCategory || 'unknown',
        });
        kept++;
      }

      if (items.length < PAGE_SIZE) break;
    }

    console.log(`  ${('"' + keyword + '"').padEnd(40)}  ${totalMatching.toString().padStart(6)} total, kept ${kept}, filtered-cat ${categoryRejected}, upgraded-to-1P ${upgraded3Pto1P}`);
  }

  // Show top rejection reasons so we can refine whitelist if needed
  if (rejectedByCategory.size > 0) {
    const top = [...rejectedByCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`  Top rejected categories: ${top.map(([c, n]) => `"${c}" (${n})`).join(', ')}`);
  }

  // Return just the items (drop sub tracking)
  return [...seen.values()].map(x => x.item);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const outDir = join(process.cwd(), 'catalog-build', 'bestbuy-discovery');
  if (!DRY_RUN) mkdirSync(outDir, { recursive: true });

  const cats = ONLY_CATEGORY
    ? { [ONLY_CATEGORY]: CATEGORIES[ONLY_CATEGORY] }
    : CATEGORIES;

  if (ONLY_CATEGORY && !CATEGORIES[ONLY_CATEGORY]) {
    console.error(`Unknown category: ${ONLY_CATEGORY}`);
    console.error(`Valid categories: ${Object.keys(CATEGORIES).join(', ')}`);
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Best Buy discovery via Impact /Catalogs/ItemSearch');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Categories: ', Object.keys(cats).join(', '));
  console.log('Filter 3P:  ', FILTER_3P ? 'yes (exclude marketplace sellers)' : 'no (include all)');
  console.log('Dry run:    ', DRY_RUN);
  console.log('Output:     ', outDir);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const summary = {};

  for (const [category, keywords] of Object.entries(cats)) {
    const items = await discoverCategory(category, keywords);
    summary[category] = items.length;

    if (!DRY_RUN) {
      const path = join(outDir, `${category}.json`);
      writeFileSync(path, JSON.stringify(items, null, 2));
      console.log(`  → saved ${items.length} products to ${path}`);
    } else {
      console.log(`  → would save ${items.length} products (dry-run)`);
    }
  }

  console.log('\n━━━ SUMMARY ━━━');
  let total = 0;
  for (const [cat, count] of Object.entries(summary)) {
    console.log(`  ${cat.padEnd(14)} ${count}`);
    total += count;
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${total}`);

  console.log('\nNext: run bestbuy-merge.js to match against existing Amazon products in parts.js');
})();
