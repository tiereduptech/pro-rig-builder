#!/usr/bin/env node
/**
 * bestbuy-merge.js — merge Best Buy products into parts.js
 *
 * For each Best Buy product from catalog-build/bestbuy-discovery/{category}.json:
 *   1. Try to match to an existing Amazon product by UPC/GTIN
 *   2. If matched: append deals.bestbuy = {price, url, inStock} to that product
 *   3. If unmatched: add as new product (deals.bestbuy only, no Amazon data)
 *
 * Writes a timestamped backup of parts.js before modifying.
 *
 * Usage:
 *   node bestbuy-merge.js
 *   node bestbuy-merge.js --dry-run        # show stats, don't write
 *   node bestbuy-merge.js --match-only     # only merge matches, skip new products
 *   node bestbuy-merge.js --filter-3p      # drop 3P (marketplace) items during merge
 */

import { readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const BESTBUY_DIR = join(process.cwd(), 'catalog-build', 'bestbuy-enriched');

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const flags = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  flags[k] = v ?? true;
}
const DRY_RUN = !!flags['dry-run'];
const MATCH_ONLY = !!flags['match-only'];
const FILTER_3P = !!flags['filter-3p'];

// ─────────────────────────────────────────────────────────────────────────────
// Load parts.js as module (it uses `export const PARTS` + `export default`)
// ─────────────────────────────────────────────────────────────────────────────

async function loadParts() {
  if (!existsSync(PARTS_PATH)) {
    console.error(`parts.js not found at ${PARTS_PATH}`);
    process.exit(1);
  }
  const partsUrl = `file://${PARTS_PATH.replace(/\\/g, '/')}`;
  const mod = await import(partsUrl);
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) {
    console.error('parts.js did not export an array (PARTS or default)');
    process.exit(1);
  }
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Best Buy discovery
// ─────────────────────────────────────────────────────────────────────────────

function loadBestBuyProducts() {
  if (!existsSync(BESTBUY_DIR)) {
    console.error(`Discovery directory not found: ${BESTBUY_DIR}`);
    console.error('Run bestbuy-discover.js first.');
    process.exit(1);
  }
  const files = readdirSync(BESTBUY_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error(`No JSON files in ${BESTBUY_DIR}`);
    process.exit(1);
  }

  const byCategory = {};
  for (const file of files) {
    const category = file.replace(/\.json$/, '');
    const path = join(BESTBUY_DIR, file);
    const products = JSON.parse(readFileSync(path, 'utf8'));
    byCategory[category] = products;
  }
  return byCategory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build UPC index from existing Amazon products
// ─────────────────────────────────────────────────────────────────────────────

function buildUpcIndex(parts) {
  const index = new Map();
  for (const p of parts) {
    if (p.upc) {
      // Handle comma-separated (multi-UPC from DataForSEO enrichment)
      const upcs = String(p.upc).split(',').map(s => s.trim()).filter(Boolean);
      for (const upc of upcs) {
        // Normalize: strip non-digits, pad/trim common variations
        const clean = upc.replace(/\D/g, '');
        if (clean.length >= 11 && clean.length <= 14) {
          // Try both as-is and with leading zero stripped (UPC-A vs EAN-13)
          index.set(clean, p);
          if (clean.length === 13 && clean.startsWith('0')) {
            index.set(clean.slice(1), p); // UPC-A without leading 0
          }
          if (clean.length === 12) {
            index.set('0' + clean, p); // as EAN-13
          }
        }
      }
    }
  }
  return index;
}

function normalizeGtin(gtin) {
  if (!gtin) return null;
  const clean = String(gtin).replace(/\D/g, '');
  if (clean.length < 11 || clean.length > 14) return null;
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category mapping: our canonical categories → parts.js `c` field
// parts.js uses same names as our discovery script, so this is mostly identity
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_MAP = {
  Motherboard: 'Motherboard',
  CPU: 'CPU',
  GPU: 'GPU',
  RAM: 'RAM',
  Storage: 'Storage',
  PSU: 'PSU',
  Case: 'Case',
  CPUCooler: 'CPUCooler',
  Monitor: 'Monitor',
  CaseFan: 'CaseFan',
  SoundCard: 'SoundCard',
  NetworkCard: 'NetworkCard',
  OpticalDrive: 'OpticalDrive',
};

// ─────────────────────────────────────────────────────────────────────────────
// Convert a Best Buy product → new parts.js entry (when no Amazon match)
// ─────────────────────────────────────────────────────────────────────────────

function bestBuyToNewPart(bb, nextId) {
  const part = {
    id: nextId,
    n: bb.name.slice(0, 120),
    img: bb.imageUrl,
    c: CATEGORY_MAP[bb.ourCategory] || bb.ourCategory,
    b: bb.manufacturer || 'Unknown',
    pr: bb.price,
    msrp: bb.originalPrice,
    r: 0,
    upc: bb.gtin,
    mpn: bb.mpn || undefined,
    deals: {
      bestbuy: {
        price: bb.price,
        url: bb.url,
        inStock: bb.stockAvailability === 'InStock',
      },
    },
  };

  // Spread enriched specs (cores, tdp, vram, watts, etc.) onto the part
  if (bb.specs && typeof bb.specs === 'object') {
    for (const [k, v] of Object.entries(bb.specs)) {
      if (v !== undefined && v !== null && v !== '') {
        part[k] = v;
      }
    }
  }

  // Mark refurbished / open-box products so UI can display a badge
  if (bb.condition && bb.condition !== 'new') {
    part.condition = bb.condition;
  }

  return part;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializer (must produce `export const PARTS` + `export default PARTS`)
// ─────────────────────────────────────────────────────────────────────────────

function serializeParts(parts) {
  const json = JSON.stringify(parts, null, 2);
  return `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${json};\n\nexport default PARTS;\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Best Buy merger — UPC/GTIN matching against parts.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Match only: ', MATCH_ONLY ? 'yes (skip unmatched products)' : 'no (add unmatched as new)');
  console.log('Filter 3P:  ', FILTER_3P ? 'yes' : 'no');
  console.log('Dry run:    ', DRY_RUN);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const parts = await loadParts();
  console.log(`Loaded ${parts.length} existing products from parts.js`);

  const upcIndex = buildUpcIndex(parts);
  console.log(`Built UPC index: ${upcIndex.size} unique UPCs (from ${parts.filter(p => p.upc).length} products with UPC)\n`);

  const byCategory = loadBestBuyProducts();
  const totalBB = Object.values(byCategory).reduce((s, arr) => s + arr.length, 0);
  console.log(`Loaded ${totalBB} Best Buy products across ${Object.keys(byCategory).length} categories\n`);

  // Track next ID for new products (continue from existing max)
  let nextId = Math.max(...parts.map(p => p.id || 0)) + 1;

  // Stats
  const stats = {};
  let totalMatched = 0;
  let totalAdded = 0;
  let totalSkippedNoGtin = 0;
  let totalSkipped3p = 0;

  for (const [category, products] of Object.entries(byCategory)) {
    let matched = 0;
    let added = 0;
    let skippedNoGtin = 0;
    let skipped3p = 0;

    for (const bb of products) {
      if (FILTER_3P && bb.subCategory === '3P') {
        skipped3p++;
        continue;
      }

      const gtin = normalizeGtin(bb.gtin);
      if (!gtin) {
        skippedNoGtin++;
        continue;
      }

      // Try match: normalized GTIN, also try stripped leading zero and prefixed zero
      let match = upcIndex.get(gtin);
      if (!match && gtin.length === 13 && gtin.startsWith('0')) {
        match = upcIndex.get(gtin.slice(1));
      }
      if (!match && gtin.length === 12) {
        match = upcIndex.get('0' + gtin);
      }

      if (match) {
        // Merge Best Buy deal onto existing product
        if (!match.deals) match.deals = {};
        match.deals.bestbuy = {
          price: bb.price,
          url: bb.url,
          inStock: bb.stockAvailability === 'InStock',
        };
        matched++;
      } else if (!MATCH_ONLY) {
        // Add as new product
        parts.push(bestBuyToNewPart(bb, nextId++));
        added++;
      }
    }

    stats[category] = { total: products.length, matched, added, skippedNoGtin, skipped3p };
    totalMatched += matched;
    totalAdded += added;
    totalSkippedNoGtin += skippedNoGtin;
    totalSkipped3p += skipped3p;

    const matchRate = products.length ? ((matched / products.length) * 100).toFixed(1) : '0.0';
    console.log(`  ${category.padEnd(14)} ${products.length.toString().padStart(5)} items  match ${matched} (${matchRate}%)  +new ${added}  no-gtin ${skippedNoGtin}  3p ${skipped3p}`);
  }

  console.log('\n━━━ TOTALS ━━━');
  console.log(`  Matched (Amazon + Best Buy): ${totalMatched}`);
  console.log(`  Added (Best Buy only):       ${totalAdded}`);
  console.log(`  Skipped (no GTIN):           ${totalSkippedNoGtin}`);
  console.log(`  Skipped (3P marketplace):    ${totalSkipped3p}`);
  console.log(`  Final catalog size:          ${parts.length}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — parts.js not modified.');
    return;
  }

  // Backup before writing
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = `${PARTS_PATH}.backup-bestbuy-${ts}`;
  copyFileSync(PARTS_PATH, backupPath);
  console.log(`\nBacked up → ${backupPath}`);

  const source = serializeParts(parts);
  writeFileSync(PARTS_PATH, source);
  const sizeMB = (Buffer.byteLength(source) / 1024 / 1024).toFixed(2);
  console.log(`✓ Wrote ${parts.length} products to parts.js (${sizeMB} MB)`);

  console.log('\nNext steps:');
  console.log('  1. npm run dev             # verify locally');
  console.log('  2. Visit a product with both Amazon + Best Buy deals to confirm both retailer tiles show');
  console.log('  3. git add . && git commit -m "Merge Best Buy catalog" && git push');
})();
