/**
 * dataforseo-enrich-recover.js — recover from stuck enrichment run
 *
 * The main enrich-details script got stuck waiting on tasks_ready because
 * DataForSEO caps that endpoint at 1000 ready tasks. The tasks themselves
 * ARE complete — we just need to fetch them directly via task_get.
 *
 * This script:
 *   1. Reads catalog-build/enriched-v2/_tasks.json (saved task IDs)
 *   2. Fetches each task's result directly via /task_get/advanced/{id}
 *   3. Skips tasks we've already processed (uses _progress.json)
 *   4. Retries unready tasks with backoff
 *   5. Writes category-grouped v2 files
 *
 * Cost: $0 (we already paid at task_post time)
 * Runtime: ~10-20 minutes depending on how many still need fetching
 *
 * USAGE:
 *   railway run node dataforseo-enrich-recover.js
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

const CONCURRENCY = 8;      // parallel fetches
const MAX_ROUNDS = 8;       // if some tasks aren't ready, retry up to N times
const RETRY_DELAY_MS = 30000;  // wait 30s between rounds

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper (same as main script)
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
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
    }
  }
  throw new Error('retries exhausted');
}

async function fetchTaskResult(taskId) {
  try {
    const resp = await dfsRequest('GET', `/merchant/amazon/asin/task_get/advanced/${taskId}`);
    // Status 20000 with result = success
    // Status 40602 = task in queue, not ready
    // Status 40200 = not found (expired)
    const taskStatus = resp.tasks?.[0]?.status_code;
    if (taskStatus !== 20000) {
      return { ready: false, status: taskStatus };
    }
    const items = resp.tasks[0].result?.[0]?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { ready: true, data: null }; // task completed but no product data
    }
    return { ready: true, data: items[0] };
  } catch (e) {
    return { ready: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reuse spec extraction from main script
// ─────────────────────────────────────────────────────────────────────────────

function flattenProductInfo(productInformation) {
  const flat = {};
  if (!Array.isArray(productInformation)) return flat;
  for (const section of productInformation) {
    if (section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) {
        if (typeof v === 'string' || typeof v === 'number') flat[k] = v;
      }
    }
  }
  return flat;
}

function find(flat, names) {
  for (const name of names) {
    if (flat[name] !== undefined) return flat[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(flat)) {
      if (k.toLowerCase() === lower) return flat[k];
    }
  }
  return null;
}

function extractNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return null;
  const m = val.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function extractSpecs(category, flat, title) {
  const specs = {};
  const text = title || '';

  const modelNumber = find(flat, ['Model Number', 'Model Name', 'Part Number']);
  if (modelNumber) specs.modelNumber = modelNumber;
  // UPC — only take first valid 12-14 digit code (Amazon sometimes lists multiple)
  const upcRaw = find(flat, ['UPC', 'GTIN', 'GTIN-13', 'GTIN-12']);
  if (upcRaw) {
    const allCodes = String(upcRaw).match(/\d{12,14}/g) || [];
    if (allCodes.length > 0) specs.upc = allCodes[0];
  }
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
      const threadMatch = text.match(/(\d+)[-\s]thread/i);
      if (threadMatch) specs.threads = parseInt(threadMatch[1]);
      const baseClock = find(flat, ['CPU Speed', 'Processor Speed', 'Clock Speed']);
      if (baseClock) specs.baseClock = extractNumber(baseClock);
      const boostMatch = text.match(/(?:boost|max)\s+(?:clock|speed)?\s*(?:up to\s*)?(\d+(?:\.\d+)?)\s*GHz/i);
      if (boostMatch) specs.boostClock = parseFloat(boostMatch[1]);
      const tdpMatch = text.match(/(\d+)\s*W\s*TDP/i);
      if (tdpMatch) specs.tdp = parseInt(tdpMatch[1]);
      const archMatch = text.match(/\b(Zen\s*[1-5]|Arrow\s*Lake|Raptor\s*Lake|Alder\s*Lake|Meteor\s*Lake)\b/i);
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
      const iface = find(flat, ['Graphics Card Interface', 'Interface']);
      if (iface) specs.interface = iface;
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
      const iface = find(flat, ['Hard Drive Interface', 'Interface']);
      if (iface) specs.interface = iface;
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

function cleanNameFromAmazon(title, brand) {
  if (!title) return null;
  let n = title.replace(/\s+/g, ' ').trim();
  if (brand) {
    const re = new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');
    n = n.replace(re, '');
  }
  const parts = n.split(',');
  if (parts.length > 3) n = parts.slice(0, 3).join(',').trim();
  if (n.length > 120) n = n.slice(0, 117) + '...';
  return n.replace(/,\s*$/, '').trim();
}

function buildV2Product(original, detail) {
  if (!detail) return original;

  const flat = flattenProductInfo(detail.product_information);
  const title = detail.title || original.fullTitle;
  const extractedSpecs = extractSpecs(original.category, flat, title);
  const mergedSpecs = { ...original.specs, ...extractedSpecs };
  const amazonBrand = find(flat, ['Brand', 'Manufacturer']);
  const brand = amazonBrand || original.brand;
  const bestImage = detail.product_images_list?.[0] || detail.image_url || original.imageUrl;
  const currentPrice = detail.price_from ?? original.price;
  const listPrice = detail.price_to ?? currentPrice;
  const percentageDiscount = detail.percentage_discount ?? null;

  return {
    ...original,
    title,
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
    description: (detail.description || '').slice(0, 500),
    additionalImages: (detail.product_images_list || []).slice(1, 5),
    amazonCategories: (detail.categories || []).map(c => c.category),
    applicableVouchers: detail.applicable_vouchers || null,
    specs: mergedSpecs,
    enrichedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main recovery
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── DataForSEO Enrichment Recovery ──\n');

  if (!existsSync(TASKS_PATH)) {
    console.error(`✗ ${TASKS_PATH} not found — nothing to recover.`);
    process.exit(1);
  }

  const tasks = JSON.parse(readFileSync(TASKS_PATH, 'utf-8'));
  console.log(`Loaded ${tasks.length} submitted task IDs from ${TASKS_PATH}`);

  // Load original v1 data to build v2 products from
  const asinToOriginal = new Map();
  const files = readdirSync(INPUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  for (const file of files) {
    const category = file.replace('.json', '').replace(/^./, c => c.toUpperCase())
      .replace('Cpucooler', 'CPUCooler').replace('Casefan', 'CaseFan')
      .replace('Cpu', 'CPU').replace('Gpu', 'GPU').replace('Ram', 'RAM').replace('Psu', 'PSU');
    const arr = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf-8'));
    for (const p of arr) {
      if (p.asin) asinToOriginal.set(p.asin, { ...p, category, sourceFile: file });
    }
  }
  console.log(`Loaded ${asinToOriginal.size} original v1 products`);

  // Load any existing v2 files (for incremental recovery)
  const v2ByCategory = new Map();
  for (const file of files) {
    const outPath = join(OUTPUT_DIR, file);
    if (existsSync(outPath)) {
      try {
        const existing = JSON.parse(readFileSync(outPath, 'utf-8'));
        const cat = file.replace('.json', '');
        v2ByCategory.set(cat, new Map(existing.map(p => [p.asin, p])));
      } catch {}
    }
  }

  // Load progress (ASINs already successfully enriched)
  let alreadyDone = new Set();
  if (existsSync(PROGRESS_PATH)) {
    try {
      const p = JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8'));
      alreadyDone = new Set(p.completed || []);
    } catch {}
  }
  console.log(`Already enriched in previous runs: ${alreadyDone.size}`);

  // Filter tasks we still need to fetch
  let pending = tasks.filter(t => !alreadyDone.has(t.asin));
  console.log(`Tasks to fetch: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('Nothing to recover. Done.');
    return;
  }

  // Multi-round recovery — retry unready tasks
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`──── Round ${round}/${MAX_ROUNDS} ──── ${pending.length} tasks ────\n`);

    const stillPending = [];
    const notFoundAsins = new Set();
    let succeeded = 0;
    let notReady = 0;
    let noData = 0;
    let errors = 0;

    let idx = 0;
    async function worker() {
      while (idx < pending.length) {
        const i = idx++;
        const t = pending[i];
        const result = await fetchTaskResult(t.taskId);

        if (!result.ready) {
          if (result.status === 40200) {
            // Task not found — likely expired. Mark as done so we don't retry.
            notFoundAsins.add(t.asin);
            errors++;
          } else {
            stillPending.push(t);
            notReady++;
          }
          continue;
        }

        if (!result.data) {
          // Task completed but returned no product data
          noData++;
          alreadyDone.add(t.asin);
          // Keep original v1 product in output
          const original = asinToOriginal.get(t.asin);
          if (original) {
            const cat = original.sourceFile.replace('.json', '');
            if (!v2ByCategory.has(cat)) v2ByCategory.set(cat, new Map());
            v2ByCategory.get(cat).set(t.asin, original);
          }
          continue;
        }

        const original = asinToOriginal.get(t.asin);
        if (!original) {
          errors++;
          continue;
        }
        const v2Product = buildV2Product(original, result.data);
        const cat = original.sourceFile.replace('.json', '');
        if (!v2ByCategory.has(cat)) v2ByCategory.set(cat, new Map());
        v2ByCategory.get(cat).set(t.asin, v2Product);
        alreadyDone.add(t.asin);
        succeeded++;

        if (succeeded % 100 === 0) console.log(`   ... ${succeeded} enriched`);
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    console.log(`\n   enriched=${succeeded}, notReady=${notReady}, noData=${noData}, errors/notFound=${errors}`);

    // Write output files after each round (incremental progress)
    for (const [cat, map] of v2ByCategory) {
      const arr = [...map.values()];
      const outPath = join(OUTPUT_DIR, `${cat}.json`);
      writeFileSync(outPath, JSON.stringify(arr, null, 2));
    }
    writeFileSync(PROGRESS_PATH, JSON.stringify({
      completed: [...alreadyDone],
      round,
    }, null, 2));

    pending = stillPending;
    if (pending.length === 0) {
      console.log('\n✓ All tasks recovered!');
      break;
    }

    if (round < MAX_ROUNDS) {
      console.log(`\n   Waiting ${RETRY_DELAY_MS/1000}s before retry...\n`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  // Final summary
  console.log('\n──── Final Summary ────');
  let totalEnriched = 0;
  for (const [cat, map] of v2ByCategory) {
    console.log(`   ${cat.padEnd(15)} ${map.size} products`);
    totalEnriched += map.size;
  }
  console.log(`\nTotal in v2 output: ${totalEnriched}`);
  console.log(`Completed ASINs:    ${alreadyDone.size}`);
  console.log(`Still pending:      ${pending.length}`);
  if (pending.length > 0) {
    console.log(`\nTo retry the pending tasks later, run this script again.`);
  }
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
