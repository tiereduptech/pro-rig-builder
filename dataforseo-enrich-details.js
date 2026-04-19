/**
 * dataforseo-enrich-details.js — enrich discovered products with full Amazon spec data
 *
 * Reads:  catalog-build/enriched/*.json  (2,977 products with basic data)
 * Writes: catalog-build/enriched-v2/*.json  (same + full spec tables, UPC, better images)
 *
 * Cost: ~$0.0015 per ASIN × ~2,073 new products = ~$3.11
 *       (existing products already have data — we enrich only NEW ones added this session)
 *
 * Runtime: ~30-60 minutes (task-based API with polling)
 *
 * Endpoint: /v3/merchant/amazon/asin/task_post → tasks_ready → task_get/advanced/{id}
 *
 * USAGE:
 *   railway run node dataforseo-enrich-details.js --dry-run     # show plan, no $ spend
 *   railway run node dataforseo-enrich-details.js --limit 10    # test 10 ASINs (~$0.015)
 *   railway run node dataforseo-enrich-details.js --category motherboard  # one category
 *   railway run node dataforseo-enrich-details.js               # full run (~$3.11)
 *   railway run node dataforseo-enrich-details.js --resume      # continue interrupted run
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('✗ Missing DATAFORSEO env vars.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const INPUT_DIR = './catalog-build/enriched';
const OUTPUT_DIR = './catalog-build/enriched-v2';
const PROGRESS_PATH = join(OUTPUT_DIR, '_progress.json');
const TASKS_PATH = join(OUTPUT_DIR, '_tasks.json');

const BATCH_SIZE = 50;           // max tasks per POST (DataForSEO allows up to 100)
const POLL_INTERVAL_MS = 10000;  // poll tasks_ready every 10s
const MAX_POLL_WAIT_MS = 1800000; // 30 min cap on polling wait
const GET_CONCURRENCY = 5;

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const flags = {
  dryRun:   getFlag('--dry-run'),
  limit:    Number(getFlag('--limit', true)) || null,
  category: getFlag('--category', true),
  resume:   getFlag('--resume'),
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function dfsRequest(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = 3000 + attempt * 5000;
        console.log(`   ⚠ HTTP ${res.status} — backing off ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
    }
  }
  throw new Error('retries exhausted');
}

// ─────────────────────────────────────────────────────────────────────────────
// Flatten product_information into a single key-value map for easy lookup
// ─────────────────────────────────────────────────────────────────────────────

function flattenProductInfo(productInformation) {
  const flat = {};
  if (!Array.isArray(productInformation)) return flat;

  for (const section of productInformation) {
    if (section.body && typeof section.body === 'object') {
      // "Features & Specs" or "Item details" sections have structured body
      for (const [k, v] of Object.entries(section.body)) {
        if (typeof v === 'string' || typeof v === 'number') flat[k] = v;
      }
    }
  }
  return flat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case-insensitive lookup with fallback field names
// ─────────────────────────────────────────────────────────────────────────────

function find(flat, names) {
  for (const name of names) {
    // Exact match
    if (flat[name] !== undefined) return flat[name];
    // Case-insensitive match
    const lower = name.toLowerCase();
    for (const k of Object.keys(flat)) {
      if (k.toLowerCase() === lower) return flat[k];
    }
  }
  return null;
}

// Helper to extract numbers from strings like "170 Watts" → 170
function extractNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return null;
  const m = val.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Map DataForSEO detail response → category-specific spec fields
// ─────────────────────────────────────────────────────────────────────────────

function extractSpecs(category, flat, title, bullets) {
  const specs = {};
  const combinedText = `${title || ''} ${(bullets || []).join(' ')}`;

  // Common fields across all categories
  const modelNumber = find(flat, ['Model Number', 'Model Name', 'Part Number']);
  if (modelNumber) specs.modelNumber = modelNumber;

  const upc = find(flat, ['UPC', 'GTIN', 'GTIN-13', 'GTIN-12']);
  if (upc) specs.upc = String(upc).replace(/[^\d]/g, '');

  const weight = find(flat, ['Item Weight', 'Package Weight', 'Weight']);
  if (weight) specs.weight = weight;

  switch (category) {
    case 'Motherboard': {
      const socket = find(flat, ['Processor Socket', 'CPU Socket Type', 'Socket Type']);
      if (socket) specs.socket = String(socket).replace(/^Socket\s+/i, '').toUpperCase();
      const chipset = find(flat, ['Chipset Type', 'Chipset']);
      if (chipset) specs.chipset = String(chipset).replace(/^(AMD|Intel)\s+/i, '').toUpperCase();
      const memType = find(flat, ['RAM Memory Technology', 'Memory Technology', 'Memory Type']);
      if (memType) specs.memType = String(memType).toUpperCase();
      const maxMem = find(flat, ['Ram Memory Maximum Size', 'Memory Storage Capacity', 'Maximum Memory Supported']);
      if (maxMem) specs.maxMem = extractNumber(maxMem);
      const memSlots = find(flat, ['Memory Slots Available', 'Memory Slots', 'Number of Memory Slots']);
      if (memSlots) specs.memSlots = extractNumber(memSlots);
      const formFactor = find(flat, ['Form Factor', 'Motherboard Form Factor']);
      if (formFactor) specs.formFactor = formFactor;
      break;
    }

    case 'CPU': {
      const socket = find(flat, ['CPU Socket', 'Processor Socket', 'Socket Type']);
      if (socket) specs.socket = String(socket).replace(/^Socket\s+/i, '').toUpperCase();
      const cores = find(flat, ['Number of Processors', 'Processor Count', 'CPU Cores', 'Number of Cores']);
      if (cores) specs.cores = extractNumber(cores);
      // Threads usually only in title (e.g. "16-Core, 32-Thread")
      const threadMatch = combinedText.match(/(\d+)[-\s]thread/i);
      if (threadMatch) specs.threads = parseInt(threadMatch[1]);
      const baseClock = find(flat, ['CPU Speed', 'Processor Speed', 'Clock Speed']);
      if (baseClock) specs.baseClock = extractNumber(baseClock);
      const boostMatch = combinedText.match(/(?:boost|max)\s+(?:clock|speed)?\s*(?:up to\s*)?(\d+(?:\.\d+)?)\s*GHz/i);
      if (boostMatch) specs.boostClock = parseFloat(boostMatch[1]);
      const tdpMatch = combinedText.match(/(\d+)\s*W\s*TDP/i);
      if (tdpMatch) specs.tdp = parseInt(tdpMatch[1]);
      const archMatch = combinedText.match(/\b(Zen\s*[1-5]|Arrow\s*Lake|Raptor\s*Lake|Alder\s*Lake|Meteor\s*Lake)\b/i);
      if (archMatch) specs.arch = archMatch[1];
      break;
    }

    case 'GPU': {
      const vram = find(flat, ['Graphics RAM Size', 'GPU Memory', 'Video RAM']);
      if (vram) specs.vram = extractNumber(vram);
      const vramType = find(flat, ['GPU Memory Type', 'Graphics RAM Type']);
      if (vramType) specs.vramType = vramType;
      const chipset = find(flat, ['Graphics Coprocessor', 'Chipset', 'Graphics Chipset']);
      if (chipset) specs.chipset = chipset;
      const interface_ = find(flat, ['Graphics Card Interface', 'Interface']);
      if (interface_) specs.interface = interface_;
      break;
    }

    case 'RAM': {
      const capacity = find(flat, ['Computer Memory Size', 'Memory Storage Capacity', 'RAM Capacity']);
      if (capacity) specs.capacity = capacity;
      const speed = find(flat, ['Memory Clock Speed', 'RAM Speed']);
      if (speed) specs.speed = extractNumber(speed);
      const type = find(flat, ['RAM Memory Technology', 'Memory Type']);
      if (type) specs.memType = String(type).toUpperCase();
      const latency = find(flat, ['CAS Latency', 'Memory Latency']);
      if (latency) specs.cas = latency;
      break;
    }

    case 'Storage': {
      const capacity = find(flat, ['Digital Storage Capacity', 'Hard Disk Size', 'Capacity']);
      if (capacity) specs.capacity = capacity;
      const interface_ = find(flat, ['Hard Drive Interface', 'Interface']);
      if (interface_) specs.interface = interface_;
      const formFactor = find(flat, ['Form Factor', 'Hard Drive Form Factor']);
      if (formFactor) specs.formFactor = formFactor;
      const rpm = find(flat, ['Hard Drive Rotational Speed', 'RPM']);
      if (rpm) specs.rpm = extractNumber(rpm);
      break;
    }

    case 'PSU': {
      const wattage = find(flat, ['Wattage', 'Power Supply']);
      if (wattage) specs.wattage = extractNumber(wattage);
      const efficiency = find(flat, ['Efficiency', 'Certification']);
      if (efficiency) specs.efficiency = efficiency;
      break;
    }

    case 'Case': {
      const formFactor = find(flat, ['Motherboard Form Factor', 'Compatible Motherboards', 'Form Factor']);
      if (formFactor) specs.formFactor = formFactor;
      const dimensions = find(flat, ['Item Dimensions L x W x H', 'Product Dimensions', 'Dimensions']);
      if (dimensions) specs.dimensions = dimensions;
      break;
    }

    case 'CPUCooler': {
      const compat = find(flat, ['Compatible Devices', 'CPU Socket']);
      if (compat) specs.compatibility = compat;
      const noise = find(flat, ['Noise Level']);
      if (noise) specs.noise = extractNumber(noise);
      break;
    }

    case 'Monitor': {
      const resolution = find(flat, ['Max Screen Resolution', 'Screen Resolution', 'Display Resolution']);
      if (resolution) specs.resolution = resolution;
      const size = find(flat, ['Screen Size', 'Display Size']);
      if (size) specs.size = size;
      const refresh = find(flat, ['Refresh Rate']);
      if (refresh) specs.refresh = extractNumber(refresh);
      const panel = find(flat, ['Display Technology', 'Panel Type']);
      if (panel) specs.panel = panel;
      const responseTime = find(flat, ['Response Time']);
      if (responseTime) specs.responseTime = responseTime;
      break;
    }

    case 'CaseFan': {
      const size = find(flat, ['Size', 'Fan Size', 'Dimensions']);
      if (size) specs.size = size;
      const noise = find(flat, ['Noise Level']);
      if (noise) specs.noise = extractNumber(noise);
      break;
    }
  }

  return specs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge enriched v1 + detail response → enriched v2 product
// ─────────────────────────────────────────────────────────────────────────────

function buildV2Product(original, detail) {
  if (!detail) return original; // preserve what we have if API failed

  const flat = flattenProductInfo(detail.product_information);
  const title = detail.title || original.fullTitle;
  const bullets = []; // bullets aren't always in detail response, keep empty

  // Extract structured specs
  const extractedSpecs = extractSpecs(original.category, flat, title, bullets);

  // Merge with v1 specs (v1 from title regex, v2 from Amazon data — v2 wins on conflict)
  const mergedSpecs = { ...original.specs, ...extractedSpecs };

  // Brand: prefer Amazon's direct field over our regex guess
  const amazonBrand = find(flat, ['Brand', 'Manufacturer']);
  const brand = amazonBrand || original.brand;

  // Prefer longer product image list
  const bestImage = detail.product_images_list?.[0] || detail.image_url || original.imageUrl;

  // Price: DataForSEO gives us price_from and price_to
  //   - If they differ, there's a discount/coupon in play
  //   - price_from is the current (post-discount) price
  //   - price_to is the list price
  const currentPrice = detail.price_from ?? original.price;
  const listPrice = detail.price_to ?? currentPrice;
  const percentageDiscount = detail.percentage_discount ?? null;

  return {
    ...original,
    title: title,
    name: cleanNameFromAmazon(title, brand) || original.name,
    brand,
    imageUrl: bestImage,
    price: currentPrice,
    listPrice: listPrice !== currentPrice ? listPrice : null,
    percentageDiscount,
    rating: detail.rating?.value ?? original.rating,
    reviews: detail.rating?.votes_count ?? original.reviews,
    isAmazonChoice: detail.is_amazon_choice ?? original.isAmazonChoice,
    isAvailable: detail.is_available ?? true,
    description: (detail.description || '').slice(0, 500), // truncate long descriptions
    additionalImages: (detail.product_images_list || []).slice(1, 5), // up to 4 extra
    amazonCategories: (detail.categories || []).map(c => c.category),
    applicableVouchers: detail.applicable_vouchers || null,
    specs: mergedSpecs,
    enrichedAt: new Date().toISOString(),
  };
}

function cleanNameFromAmazon(title, brand) {
  if (!title) return null;
  let n = title.replace(/\s+/g, ' ').trim();
  // Strip brand prefix if present
  if (brand) {
    const re = new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');
    n = n.replace(re, '');
  }
  // Cut at first comma chain of marketing copy
  const parts = n.split(',');
  if (parts.length > 3) n = parts.slice(0, 3).join(',').trim();
  // Truncate if still way too long
  if (n.length > 120) n = n.slice(0, 117) + '...';
  return n.replace(/,\s*$/, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-based flow
// ─────────────────────────────────────────────────────────────────────────────

async function submitBatch(products) {
  const body = products.map(p => ({
    asin: p.asin,
    location_code: 2840,
    language_code: 'en_US',
    load_more_local_reviews: false,
    tag: `${p.category}:${p.asin}`,
  }));

  const resp = await dfsRequest('POST', '/merchant/amazon/asin/task_post', body);
  if (resp.status_code !== 20000) {
    throw new Error(`Batch submit failed: ${resp.status_code} ${resp.status_message}`);
  }

  const submitted = [];
  for (let i = 0; i < resp.tasks.length; i++) {
    const t = resp.tasks[i];
    if (t.status_code !== 20100) {
      console.log(`     ⚠ failed to create task for ${products[i].asin}: ${t.status_code}`);
      continue;
    }
    submitted.push({ taskId: t.id, asin: products[i].asin, category: products[i].category });
  }
  return submitted;
}

async function waitForTasks(taskIds) {
  const pending = new Set(taskIds);
  const ready = new Set();
  const startWait = Date.now();

  while (pending.size > 0) {
    if (Date.now() - startWait > MAX_POLL_WAIT_MS) {
      console.log(`   ⚠ poll timeout — ${pending.size} still pending; will try to fetch anyway`);
      break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const resp = await dfsRequest('GET', '/merchant/amazon/asin/tasks_ready');
    if (resp.status_code !== 20000) continue;

    let newlyReady = 0;
    for (const task of resp.tasks || []) {
      for (const result of task.result || []) {
        if (pending.has(result.id)) {
          pending.delete(result.id);
          ready.add(result.id);
          newlyReady++;
        }
      }
    }
    const elapsed = Math.round((Date.now() - startWait) / 1000);
    console.log(`   [${elapsed}s] +${newlyReady} ready, ${pending.size} pending`);
  }

  return { ready: [...ready], stillPending: [...pending] };
}

async function fetchTaskResult(taskId) {
  try {
    const resp = await dfsRequest('GET', `/merchant/amazon/asin/task_get/advanced/${taskId}`);
    if (resp.status_code !== 20000) return null;
    const items = resp.tasks?.[0]?.result?.[0]?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    return items[0];
  } catch {
    return null;
  }
}

async function fetchAllResults(tasks) {
  const results = new Map(); // taskId -> detail
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      const t = tasks[i];
      const detail = await fetchTaskResult(t.taskId);
      results.set(t.taskId, detail);
      if ((i + 1) % 50 === 0 || i + 1 === tasks.length) {
        console.log(`   fetched ${i + 1}/${tasks.length}`);
      }
    }
  }

  const workers = Array.from({ length: GET_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress / resume
// ─────────────────────────────────────────────────────────────────────────────

function loadProgress() {
  if (!existsSync(PROGRESS_PATH)) return { completed: new Set(), enriched: {} };
  try {
    const raw = JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8'));
    return {
      completed: new Set(raw.completed || []),
      enriched: raw.enriched || {},
    };
  } catch {
    return { completed: new Set(), enriched: {} };
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_PATH, JSON.stringify({
    completed: [...progress.completed],
    enriched: progress.enriched,
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── DataForSEO ASIN Detail Enrichment ──\n');

  if (!existsSync(INPUT_DIR)) {
    console.error(`Input dir not found: ${INPUT_DIR}. Run local-enrich.js first.`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load existing parts.js to identify products that ALREADY HAVE RICH SPECS
  // (we should skip those since enrichment would be redundant).
  //
  // Rich-specs markers: fields that only hand-curated products tend to have.
  // Products WITHOUT these markers are either new DataForSEO-added (thin specs)
  // or dropped-for-no-brand (not in parts.js at all) — both need enrichment.
  const RICH_SPEC_MARKERS = [
    'tdp', 'cores', 'threads', 'baseClock', 'boostClock', 'arch', 'bench',
    'memSlots', 'maxMem', 'wattage', 'vram', 'resolution', 'refresh',
    'mpn',  // manufacturer part number — hand-entered, not auto-extractable from titles
  ];

  const richSpecAsins = new Set();  // skip these
  try {
    const path = `file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`;
    const mod = await import(path);
    const parts = mod.PARTS || mod.default || Object.values(mod).find(v => Array.isArray(v));
    for (const p of parts || []) {
      // Check if product has rich specs
      const hasRichSpecs = RICH_SPEC_MARKERS.some(key => p[key] !== undefined && p[key] !== null && p[key] !== '');
      if (!hasRichSpecs) continue; // thin-spec product — don't add to skip list

      // Extract ASIN from product (either direct or from amazon URL)
      if (p.asin) richSpecAsins.add(p.asin);
      if (p.deals?.amazon?.url) {
        const m = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/i);
        if (m) richSpecAsins.add(m[1]);
      }
    }
    console.log(`Existing parts.js has ${parts.length} products; ${richSpecAsins.size} have rich specs (will skip those)`);
  } catch (e) {
    console.log(`⚠ could not read existing parts.js: ${e.message} — will enrich everything`);
  }

  // Collect ASINs needing enrichment
  const files = readdirSync(INPUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const allProducts = [];
  for (const file of files) {
    const category = file.replace('.json', '').replace(/^./, c => c.toUpperCase())
      .replace('Cpucooler', 'CPUCooler').replace('Casefan', 'CaseFan')
      .replace('Cpu', 'CPU').replace('Gpu', 'GPU').replace('Ram', 'RAM').replace('Psu', 'PSU');

    if (flags.category && category.toLowerCase() !== flags.category.toLowerCase()) continue;

    const arr = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf-8'));
    for (const p of arr) {
      if (p.asin) allProducts.push({ ...p, category, sourceFile: file });
    }
  }

  // Filter out products that already have rich specs
  const toEnrich = allProducts.filter(p => !richSpecAsins.has(p.asin));
  const skipped = allProducts.length - toEnrich.length;

  console.log(`\nDiscovered: ${allProducts.length} total products with ASINs`);
  console.log(`Skipping:   ${skipped} with rich specs already (hand-curated products)`);
  console.log(`To enrich:  ${toEnrich.length} new products`);

  let target = toEnrich;
  if (flags.limit) {
    target = target.slice(0, flags.limit);
    console.log(`Limit:      ${target.length} (test run)`);
  }

  const estimatedCost = target.length * 0.0015;
  console.log(`\nEstimated cost: $${estimatedCost.toFixed(2)}`);

  if (flags.dryRun) {
    console.log('\nDRY RUN — query plan:');
    const byCategory = new Map();
    for (const p of target) byCategory.set(p.category, (byCategory.get(p.category) || 0) + 1);
    for (const [cat, n] of byCategory) console.log(`  ${cat.padEnd(15)} ${n}`);
    console.log('\n(no API calls made)');
    return;
  }

  // Resume support
  const progress = flags.resume ? loadProgress() : { completed: new Set(), enriched: {} };
  if (progress.completed.size > 0) {
    console.log(`\nResuming: ${progress.completed.size} ASINs already enriched`);
    target = target.filter(p => !progress.completed.has(p.asin));
    console.log(`Remaining: ${target.length}`);
  }

  if (target.length === 0) {
    console.log('\nNothing to do. Exiting.');
    return;
  }

  // ─── Phase 1: submit tasks in batches of 50 ──────────────────
  console.log('\nPhase 1: Submitting tasks...');
  const submittedTasks = [];
  for (let i = 0; i < target.length; i += BATCH_SIZE) {
    const batch = target.slice(i, i + BATCH_SIZE);
    console.log(`   batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(target.length/BATCH_SIZE)} (${batch.length} tasks)...`);
    try {
      const submitted = await submitBatch(batch);
      submittedTasks.push(...submitted);
      // persist task IDs so we can recover from crashes
      writeFileSync(TASKS_PATH, JSON.stringify(submittedTasks, null, 2));
    } catch (e) {
      console.log(`     ✗ batch failed: ${e.message}`);
    }
    if (i + BATCH_SIZE < target.length) await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`   ✓ ${submittedTasks.length} total tasks submitted`);

  // ─── Phase 2: poll ──────────────────
  console.log('\nPhase 2: Polling for completion...');
  const { ready, stillPending } = await waitForTasks(submittedTasks.map(t => t.taskId));
  console.log(`   ✓ ${ready.length} ready, ${stillPending.length} timed out`);

  // ─── Phase 3: fetch results ──────────────────
  console.log('\nPhase 3: Fetching results...');
  const taskToFetch = submittedTasks.filter(t => !stillPending.includes(t.taskId) || true); // fetch all, DataForSEO usually has them even if tasks_ready was slow
  const resultMap = await fetchAllResults(taskToFetch);

  // ─── Phase 4: build v2 products ──────────────────
  console.log('\nPhase 4: Building v2 products...');

  // Map taskId → original product
  const asinToProduct = new Map(target.map(p => [p.asin, p]));
  const taskToAsin = new Map(submittedTasks.map(t => [t.taskId, t.asin]));

  const v2ByCategory = new Map();
  let enrichedCount = 0;
  let failedCount = 0;

  // First, load any existing v2 files (for --resume)
  for (const file of files) {
    if (flags.category) {
      const cat = file.replace('.json','').replace(/^./, c => c.toUpperCase())
        .replace('Cpucooler', 'CPUCooler').replace('Casefan', 'CaseFan')
        .replace('Cpu', 'CPU').replace('Gpu', 'GPU').replace('Ram', 'RAM').replace('Psu', 'PSU');
      if (cat.toLowerCase() !== flags.category.toLowerCase()) continue;
    }

    const outPath = join(OUTPUT_DIR, file);
    if (existsSync(outPath)) {
      const existing = JSON.parse(readFileSync(outPath, 'utf-8'));
      const cat = file.replace('.json','');
      v2ByCategory.set(cat, new Map(existing.map(p => [p.asin, p])));
    }
  }

  for (const [taskId, detail] of resultMap) {
    const asin = taskToAsin.get(taskId);
    if (!asin) continue;
    const original = asinToProduct.get(asin);
    if (!original) continue;

    const v2Product = buildV2Product(original, detail);
    if (detail) enrichedCount++; else failedCount++;

    const fileKey = original.sourceFile.replace('.json','');
    if (!v2ByCategory.has(fileKey)) v2ByCategory.set(fileKey, new Map());
    v2ByCategory.get(fileKey).set(asin, v2Product);

    progress.completed.add(asin);
  }

  // ─── Phase 5: write output files ──────────────────
  console.log('\nPhase 5: Writing output files...');
  for (const [cat, map] of v2ByCategory) {
    const arr = [...map.values()];
    const outPath = join(OUTPUT_DIR, `${cat}.json`);
    writeFileSync(outPath, JSON.stringify(arr, null, 2));
    console.log(`   ${cat.padEnd(15)} ${arr.length} products → ${outPath}`);
  }

  saveProgress(progress);

  console.log('\n── Enrichment Complete ──');
  console.log(`Successfully enriched: ${enrichedCount}`);
  console.log(`Failed (no detail):    ${failedCount}`);
  console.log(`Total cost:            ~$${(enrichedCount * 0.0015).toFixed(2)}`);
  console.log(`\nNext step: re-run merge-to-parts.js (it will read from enriched-v2 if available)`);
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
