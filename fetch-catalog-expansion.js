#!/usr/bin/env node
/**
 * fetch-catalog-expansion.js
 *
 * Fetches ~735 new Windows 11-compatible products and merges them into parts.js.
 *
 * USAGE:
 *   railway run node fetch-catalog-expansion.js --category cpu [--limit N] [--dry-run]
 *   railway run node fetch-catalog-expansion.js --category gpu [--limit N] [--dry-run]
 *   railway run node fetch-catalog-expansion.js --category mobo [--limit N] [--dry-run]
 *   railway run node fetch-catalog-expansion.js --category all [--limit N] [--dry-run]
 *
 * Flags:
 *   --category   : cpu | gpu | mobo | all  (required)
 *   --dry-run    : show what would be fetched, no API calls or writes
 *   --limit N    : only process first N items (for testing)
 *   --skip-existing : skip products whose canonical name already exists in parts.js
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { CPU_SPECS, GPU_SPECS, MOBO_CHIPSET_SPECS, extractCPUModel, extractGPUModel } from './src/data/product-specs.js';

// ─── Flags ───
const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i < 0) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const CATEGORY = getFlag('--category', true);
const DRY_RUN = getFlag('--dry-run');
const LIMIT = parseInt(getFlag('--limit', true)) || null;
const SKIP_EXISTING = getFlag('--skip-existing');

if (!CATEGORY || !['cpu', 'gpu', 'mobo', 'all'].includes(CATEGORY)) {
  console.error('Must specify --category (cpu|gpu|mobo|all)');
  process.exit(1);
}

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!DRY_RUN && (!LOGIN || !PASSWORD)) {
  console.error('Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD env vars');
  process.exit(1);
}
const AUTH = LOGIN ? 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64') : null;
const BASE = 'https://api.dataforseo.com/v3';

// ═══════════════════════════════════════════════════════════════════
// TARGET PRODUCT LISTS
// ═══════════════════════════════════════════════════════════════════

// ─── CPU TARGETS ───
// One entry per canonical SKU. Brand is implicit in the name.
const CPU_TARGETS = Object.keys(CPU_SPECS).map(model => ({
  searchQuery: model.startsWith('Ryzen') ? `AMD ${model} desktop processor`
    : model.startsWith('Core Ultra') ? `Intel ${model} desktop processor`
    : `Intel Core ${model} desktop processor`,
  canonical: model.startsWith('Ryzen') ? `AMD ${model}`
    : model.startsWith('Core Ultra') ? `Intel ${model}`
    : `Intel Core ${model}`,
  spec: CPU_SPECS[model],
  category: 'CPU',
}));

// ─── GPU TARGETS ───
// GPUs have multiple brand variants. We fetch 3 per SKU (typically ASUS/MSI/Gigabyte).
const GPU_BRANDS_NVIDIA_AMD = ['ASUS', 'MSI', 'Gigabyte'];
const GPU_BRANDS_INTEL = ['Sparkle', 'ASRock', 'Intel']; // Arc-specific AIB brands
const GPU_TARGETS = [];
for (const [model, spec] of Object.entries(GPU_SPECS)) {
  // Intel Arc uses different AIB brands (Sparkle, ASRock, Intel Limited Edition)
  const isArc = /^Arc /.test(model);
  const brands = isArc ? GPU_BRANDS_INTEL : GPU_BRANDS_NVIDIA_AMD;
  for (const brand of brands) {
    GPU_TARGETS.push({
      searchQuery: `${brand} ${model} graphics card`,
      canonical: `${brand} ${model}`,
      spec,
      category: 'GPU',
      model,
    });
  }
}

// ─── MOTHERBOARD TARGETS ───
// Motherboards are chipset × brand × form-factor combinations. We target major
// product lines per brand per chipset.
const MOBO_BRANDS = ['ASUS', 'MSI', 'Gigabyte', 'ASRock'];
const MOBO_FORM_FACTORS = ['ATX', 'Micro ATX']; // "Micro ATX" search is cheaper/common
const MOBO_TARGETS = [];
for (const [chipset, spec] of Object.entries(MOBO_CHIPSET_SPECS)) {
  // Skip enthusiast chipsets for smaller brands (budget tier fewer options)
  for (const brand of MOBO_BRANDS) {
    MOBO_TARGETS.push({
      searchQuery: `${brand} ${chipset} motherboard ATX ${spec.socket}`,
      canonical: `${brand} ${chipset}`,
      spec: { ...spec, ff: 'ATX', chipset },
      category: 'Motherboard',
      chipset,
    });
    // Only add Micro ATX variant for mainstream/budget chipsets
    if (spec.tier === 'mainstream' || spec.tier === 'budget') {
      MOBO_TARGETS.push({
        searchQuery: `${brand} ${chipset} motherboard micro ATX ${spec.socket}`,
        canonical: `${brand} ${chipset} Micro ATX`,
        spec: { ...spec, ff: 'Micro ATX', chipset, m2Slots: Math.max(1, spec.m2Slots - 1) },
        category: 'Motherboard',
        chipset,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// DATAFORSEO API — Amazon search + ASIN verify
// ═══════════════════════════════════════════════════════════════════
async function postAmazonSearch(query) {
  const payload = [{
    keyword: query,
    location_code: 2840,
    language_code: 'en_US',
    depth: 10, // get top 10 results
  }];
  const res = await fetch(`${BASE}/merchant/amazon/products/task_post`, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return json?.tasks?.[0]?.id || null;
}

async function getAmazonSearchResults(taskId) {
  // DataForSEO Amazon search tasks typically take 45-90s
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 30000 : 10000));
    const res = await fetch(`${BASE}/merchant/amazon/products/task_get/advanced/${taskId}`, {
      headers: { 'Authorization': AUTH },
    });
    const json = await res.json();
    const task = json?.tasks?.[0];
    if (task?.status_code === 20000 && task?.result) {
      return task.result[0]?.items || [];
    }
    // 40601/40602 = still in progress, keep polling. Anything else = error
    if (task?.status_code && task.status_code !== 40601 && task.status_code !== 40602) {
      console.error(`  ! Task ${taskId} failed: ${task.status_code} ${task.status_message}`);
      return [];
    }
  }
  return [];
}

// Helper: check if an Amazon result matches our target
function resultMatchesTarget(item, target) {
  // Reject counterfeit/aftermarket listings
  const titleLower = (item.title || '').toLowerCase();
  if (/\bfit\s+for\b|replacement\s+for|compatible\s+replacement/i.test(titleLower)) return false;
  if (titleLower.startsWith("pc motherboard") || titleLower.startsWith("motherboards fit")) return false;
  const title = (item.title || '').toUpperCase();
  const canonical = target.canonical.toUpperCase();

  if (target.category === 'CPU') {
    const storedModel = extractCPUModel(target.canonical);
    const resultModel = extractCPUModel(item.title);
    if (!storedModel || !resultModel) return false;
    return storedModel.toUpperCase() === resultModel.toUpperCase();
  }

  if (target.category === 'GPU') {
    const storedModel = extractGPUModel(target.canonical);
    const resultModel = extractGPUModel(item.title);
    if (!storedModel || !resultModel) return false;
    // Check brand also appears
    const brandInTitle = title.includes(target.canonical.split(' ')[0].toUpperCase());
    return storedModel === resultModel && brandInTitle;
  }

  if (target.category === 'Motherboard') {
    // Must contain the chipset AND brand
    const brandMatch = title.includes(target.canonical.split(' ')[0].toUpperCase());
    const chipsetMatch = title.includes(target.spec.chipset.toUpperCase());
    return brandMatch && chipsetMatch;
  }

  return false;
}

// Extract used/new status from Amazon result
function detectCondition(item) {
  const title = (item.title || '').toLowerCase();
  const seller = (item.sellerName || item.merchant_name || '').toLowerCase();
  const priceFrom = item.price_from || item.price?.from;
  const priceTo = item.price_to || item.price?.to;
  const priceCurrent = item.price?.current || item.price;

  // Heuristics:
  // - "used", "renewed", "refurbished" in title = used
  // - "Amazon.com" or major retailer as seller = new
  // - Only "used" price available, no new = used-only
  if (/\b(used|renewed|refurb)/i.test(title)) return { used: true, condition: 'used' };
  if (/renewed|refurb/i.test(seller)) return { used: true, condition: 'refurbished' };
  if (item.condition === 'used' || item.condition === 'refurbished') {
    return { used: true, condition: item.condition };
  }
  return { used: false, condition: 'new' };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN FETCH LOOP
// ═══════════════════════════════════════════════════════════════════
console.log('Loading current catalog...');
const currentParts = (await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now())).PARTS;
console.log(`Current catalog: ${currentParts.length} products`);

// Build a canonical-name lookup to avoid duplicates
const existingCanonicals = new Set();
for (const p of currentParts) {
  if (p.c === 'CPU') {
    const m = extractCPUModel(p.n);
    if (m) existingCanonicals.add('CPU:' + m.toUpperCase());
  } else if (p.c === 'GPU') {
    const m = extractGPUModel(p.n);
    if (m) existingCanonicals.add('GPU:' + m.toUpperCase() + ':' + (p.b || '').toUpperCase());
  }
}

// Find next available IDs per category
const ID_RANGES = {
  CPU: 10000,
  Motherboard: 20000,
  GPU: 30000,
};
const nextIdByCategory = {};
for (const [cat, start] of Object.entries(ID_RANGES)) {
  const existing = currentParts.filter(p => p.c === cat).map(p => p.id || 0);
  nextIdByCategory[cat] = Math.max(...existing, start - 1) + 1;
}
console.log(`Next IDs: CPU=${nextIdByCategory.CPU}, GPU=${nextIdByCategory.GPU}, Mobo=${nextIdByCategory.Motherboard}`);

// Select targets based on --category flag
let targets = [];
if (CATEGORY === 'cpu' || CATEGORY === 'all') targets = targets.concat(CPU_TARGETS);
if (CATEGORY === 'gpu' || CATEGORY === 'all') targets = targets.concat(GPU_TARGETS);
if (CATEGORY === 'mobo' || CATEGORY === 'all') targets = targets.concat(MOBO_TARGETS);

// Skip existing if flag set
if (SKIP_EXISTING) {
  const before = targets.length;
  targets = targets.filter(t => {
    if (t.category === 'CPU') {
      const m = extractCPUModel(t.canonical);
      return !existingCanonicals.has('CPU:' + m.toUpperCase());
    }
    if (t.category === 'GPU') {
      const m = extractGPUModel(t.canonical);
      const brand = t.canonical.split(' ')[0].toUpperCase();
      return !existingCanonicals.has('GPU:' + m.toUpperCase() + ':' + brand);
    }
    return true; // always attempt mobos
  });
  console.log(`Skip-existing: filtered ${before - targets.length} already-present products`);
}

if (LIMIT) targets = targets.slice(0, LIMIT);

console.log(`\n═══ Fetch Plan ═══`);
console.log(`Targets: ${targets.length}`);
console.log(`  CPU:  ${targets.filter(t => t.category === 'CPU').length}`);
console.log(`  GPU:  ${targets.filter(t => t.category === 'GPU').length}`);
console.log(`  Mobo: ${targets.filter(t => t.category === 'Motherboard').length}`);
console.log(`Est cost: ~$${(targets.length * 0.0015).toFixed(2)}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE FETCH'}\n`);

if (DRY_RUN) {
  console.log('Sample targets:');
  targets.slice(0, 20).forEach((t, i) => console.log(`  ${i + 1}. [${t.category}] ${t.searchQuery}`));
  console.log('\n(Dry run — no API calls made)');
  process.exit(0);
}

// ═══ LIVE FETCH ═══
console.log('─── Posting search tasks in batches of 20 (rate-limit safe) ───\n');

const BATCH_SIZE = 20;
const results = [];
const stats = { posted: 0, completed: 0, matched: 0, skipped: 0, failed: 0 };

for (let batchStart = 0; batchStart < targets.length; batchStart += BATCH_SIZE) {
  const batch = targets.slice(batchStart, batchStart + BATCH_SIZE);
  console.log(`\nBatch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(targets.length / BATCH_SIZE)} (${batch.length} items)`);

  // Post all tasks in batch
  const batchTasks = [];
  for (const target of batch) {
    try {
      const taskId = await postAmazonSearch(target.searchQuery);
      if (taskId) {
        batchTasks.push({ target, taskId });
        stats.posted++;
      } else {
        stats.failed++;
      }
    } catch (e) {
      console.error(`  ! Post failed for "${target.searchQuery}": ${e.message}`);
      stats.failed++;
    }
  }
  console.log(`  Posted ${batchTasks.length}/${batch.length} tasks`);

  // Wait for completions (DataForSEO needs ~30s per task typically)
  for (const { target, taskId } of batchTasks) {
    try {
      const items = await getAmazonSearchResults(taskId);
      if (!items.length) {
        console.log(`  ? No results for "${target.searchQuery}"`);
        stats.completed++;
        continue;
      }

      // Find the best matching item (iterate top 10)
      let bestMatch = null;
      for (const item of items) {
        if (resultMatchesTarget(item, target)) {
          bestMatch = item;
          break;
        }
      }

      if (!bestMatch) {
        console.log(`  ✗ No matching result for "${target.canonical}" (top title: "${(items[0]?.title || '').slice(0, 60)}")`);
        stats.completed++;
        continue;
      }

      // Extract product data (DataForSEO Amazon field names)
      const asin = bestMatch.data_asin;
      const price = bestMatch.price_from ?? bestMatch.price_to ?? (typeof bestMatch.price === 'number' ? bestMatch.price : bestMatch.price?.current);
      const title = bestMatch.title;
      const image = bestMatch.image_url;
      const rating = bestMatch.rating?.value;
      const condition = detectCondition(bestMatch);

      if (!asin || !price) {
        console.log(`  ✗ Missing ASIN or price for "${target.canonical}"`);
        stats.completed++;
        continue;
      }

      // Build the product entry
      const id = nextIdByCategory[target.category]++;
      const brand = target.canonical.split(' ')[0];
      const product = {
        id,
        c: target.category,
        n: title,
        b: brand,
        pr: price,
        msrp: price,
        r: rating || 4.0,
        img: image,
        deals: {
          amazon: {
            price,
            url: `https://www.amazon.com/dp/${asin}?tag=tiereduptech-20`,
            inStock: true,
          },
        },
        // Category-specific fields from spec tables
        ...(target.category === 'CPU' && {
          socket: target.spec.socket,
          cores: target.spec.cores,
          threads: target.spec.threads,
          boostClock: target.spec.boostClock,
          tdp: target.spec.tdp,
          bench: target.spec.bench,
        }),
        ...(target.category === 'GPU' && {
          tdp: target.spec.tdp,
          bench: target.spec.bench,
          vram: target.spec.vram,
        }),
        ...(target.category === 'Motherboard' && {
          socket: target.spec.socket,
          chipset: target.spec.chipset,
          memType: target.spec.memType,
          memSlots: target.spec.memSlots,
          maxMem: target.spec.maxMem,
          m2Slots: target.spec.m2Slots,
          sata: target.spec.sataPorts,
          ff: target.spec.ff,
        }),
        // Used/new flag
        ...(condition.used && { used: true, condition: condition.condition }),
      };

      results.push(product);
      stats.matched++;
      stats.completed++;
      console.log(`  ✓ id=${id} ${target.canonical} → ${asin} $${price}${condition.used ? ' [USED]' : ''}`);
    } catch (e) {
      console.error(`  ! Fetch failed for "${target.canonical}": ${e.message}`);
      stats.failed++;
    }
  }

  // Rate limit: wait between batches
  if (batchStart + BATCH_SIZE < targets.length) {
    console.log('  ...waiting 5s before next batch...');
    await new Promise(r => setTimeout(r, 5000));
  }
}

// ═══ SAVE RESULTS ═══
console.log('\n═══ FETCH RESULTS ═══');
console.log(`Posted: ${stats.posted}`);
console.log(`Completed: ${stats.completed}`);
console.log(`Matched + saved: ${stats.matched}`);
console.log(`Failed: ${stats.failed}`);

if (results.length === 0) {
  console.log('\nNo products to add. Exiting.');
  process.exit(0);
}

// Backup parts.js
const backup = `./src/data/parts.js.pre-expansion-${Date.now()}.backup`;
copyFileSync('./src/data/parts.js', backup);
console.log(`\nBackup: ${backup}`);

// Append new products to catalog
const updated = [...currentParts, ...results];
updated.sort((a, b) => a.id - b.id);

const content = '// Auto-merged catalog. Edit with care.\nexport const PARTS = ' + JSON.stringify(updated, null, 2) + ';\n\nexport default PARTS;\n';
writeFileSync('./src/data/parts.js', content);
console.log(`✓ Added ${results.length} products. Catalog now has ${updated.length} products.`);

// Save a summary report
const timestamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
const reportPath = `./fetch-reports/expansion-${timestamp}.json`;
if (!existsSync('./fetch-reports')) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync('./fetch-reports');
}
writeFileSync(reportPath, JSON.stringify({ category: CATEGORY, stats, results: results.map(r => ({ id: r.id, c: r.c, n: r.n, used: r.used || false })) }, null, 2));
console.log(`Report: ${reportPath}`);
