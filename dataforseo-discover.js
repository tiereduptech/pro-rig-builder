/**
 * dataforseo-discover.js — v2 (async task-based flow)
 *
 * CHANGE from v1: /live/advanced doesn't exist for Amazon products.
 * Using proper task-based flow:
 *   1. POST task_post with batched queries (up to 100 per POST) → task IDs
 *   2. Poll tasks_ready until tasks complete (~1-5 min on standard priority)
 *   3. GET task_get/advanced/{id} for each completed task
 *
 * Pricing: ~$0.002 per query × 162 queries = ~$0.33
 *
 * OUTPUT:
 *   catalog-build/amazon-discovery/{category}.json   (deduped products)
 *   catalog-build/amazon-discovery/_tasks.json       (task IDs for resume)
 *   catalog-build/amazon-discovery/_summary.json     (stats)
 *
 * USAGE:
 *   railway run node dataforseo-discover.js --dry-run                  # free, shows queries
 *   railway run node dataforseo-discover.js --category motherboard --limit 3   # small test
 *   railway run node dataforseo-discover.js --category motherboard     # one full category
 *   railway run node dataforseo-discover.js                            # full run (~10 min)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('✗ Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD env vars.');
  console.error('  Run via: railway run node dataforseo-discover.js');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const OUTPUT_DIR = './catalog-build/amazon-discovery';
const TASKS_PATH = join(OUTPUT_DIR, '_tasks.json');
const SUMMARY_PATH = join(OUTPUT_DIR, '_summary.json');

const BATCH_SIZE = 50;           // submit up to 100 per POST; stay conservative
const POLL_INTERVAL_MS = 8000;   // check completion every 8 seconds
const MAX_POLL_WAIT_MS = 600000; // give up after 10 minutes
const GET_CONCURRENCY = 5;       // parallel fetches for results

// ─────────────────────────────────────────────────────────────────────────────
// Query plan — 162 queries
// ─────────────────────────────────────────────────────────────────────────────

const QUERIES = {
  Motherboard: [
    'motherboard X870E', 'motherboard X870', 'motherboard B850', 'motherboard B840', 'motherboard A620',
    'motherboard X670E', 'motherboard X670', 'motherboard B650E', 'motherboard B650',
    'motherboard Z890', 'motherboard B860', 'motherboard H810',
    'motherboard Z790', 'motherboard B760', 'motherboard H610',
    'ASUS ROG motherboard AM5', 'ASUS TUF motherboard',
    'MSI MEG motherboard', 'MSI MPG motherboard', 'MSI MAG motherboard',
    'Gigabyte AORUS motherboard', 'Gigabyte motherboard AM5',
    'ASRock Taichi motherboard', 'ASRock Steel Legend motherboard',
    'NZXT motherboard',
  ],
  CPU: [
    'Ryzen 9 9950X', 'Ryzen 9 9900X', 'Ryzen 7 9800X3D', 'Ryzen 7 9700X', 'Ryzen 5 9600X',
    'Ryzen 9 7950X3D', 'Ryzen 9 7950X', 'Ryzen 9 7900X', 'Ryzen 7 7800X3D', 'Ryzen 7 7700X', 'Ryzen 5 7600X',
    'Intel Core Ultra 9 285K', 'Intel Core Ultra 7 265K', 'Intel Core Ultra 5 245K',
    'Intel Core i9 14900K', 'Intel Core i7 14700K', 'Intel Core i5 14600K',
    'Intel Core i9 13900K', 'Intel Core i7 13700K', 'Intel Core i5 13600K',
  ],
  GPU: [
    'RTX 5090', 'RTX 5080', 'RTX 5070 Ti', 'RTX 5070', 'RTX 5060 Ti', 'RTX 5060',
    'RTX 4090', 'RTX 4080 Super', 'RTX 4070 Ti Super', 'RTX 4070 Super', 'RTX 4060 Ti',
    'Radeon RX 9070 XT', 'Radeon RX 9070',
    'Radeon RX 7900 XTX', 'Radeon RX 7800 XT', 'Radeon RX 7700 XT',
  ],
  RAM: [
    'DDR5 32GB 6000', 'DDR5 32GB 6400', 'DDR5 32GB 7200',
    'DDR5 64GB 6000', 'DDR5 64GB 6400', 'DDR5 96GB', 'DDR5 16GB 6000',
    'Corsair Vengeance DDR5', 'G.Skill Trident Z5 DDR5', 'Kingston Fury Beast DDR5',
    'Crucial Pro DDR5', 'TeamGroup T-Force DDR5',
    'DDR4 32GB 3600', 'DDR4 16GB 3200', 'Corsair Vengeance DDR4',
  ],
  Storage: [
    '2TB NVMe Gen5 SSD', '4TB NVMe Gen5 SSD', '1TB NVMe Gen5 SSD',
    '2TB NVMe Gen4 SSD', '4TB NVMe Gen4 SSD', '1TB NVMe Gen4 SSD', '500GB NVMe SSD',
    'Samsung 990 Pro', 'Samsung 990 EVO', 'WD Black SN850X', 'WD Blue SN5000',
    'Crucial T705', 'Crucial T500', 'Seagate FireCuda',
    'Samsung 870 EVO', 'Crucial MX500', '2TB SATA SSD',
    'Seagate Barracuda 4TB', 'WD Red Plus NAS', 'Seagate IronWolf',
  ],
  PSU: [
    '1000W PSU 80 Plus Gold', '850W PSU 80 Plus Gold', '750W PSU 80 Plus Gold',
    '1200W PSU 80 Plus Platinum', '850W PSU 80 Plus Platinum',
    '650W PSU 80 Plus Bronze', '550W PSU 80 Plus Bronze',
    'Corsair RMx PSU', 'Corsair HX PSU', 'EVGA SuperNOVA PSU',
    'Seasonic Focus PSU', 'be quiet! PSU',
  ],
  Case: [
    'ATX PC case tempered glass', 'ATX mid tower case',
    'mATX PC case', 'mini ITX PC case',
    'full tower PC case', 'E-ATX PC case',
    'Lian Li O11 Dynamic', 'Fractal Design Meshify', 'Fractal Design North',
    'NZXT H9', 'NZXT H7', 'Corsair iCUE PC case',
    'Phanteks Eclipse case', 'be quiet! Pure Base', 'HYTE Y40',
  ],
  CPUCooler: [
    'Noctua NH-D15', 'Noctua NH-U12A', 'be quiet! Dark Rock Pro',
    'Thermalright Peerless Assassin', 'Deepcool AK620',
    '360mm AIO liquid cooler',
    'Arctic Liquid Freezer II 360', 'Corsair iCUE H150i',
    'NZXT Kraken 360', 'Lian Li Galahad II',
    '240mm AIO liquid cooler',
    'Arctic Liquid Freezer II 240', 'Corsair iCUE H100i',
    'Cooler Master Hyper 212',
  ],
  Monitor: [
    '4K 144Hz gaming monitor', '4K 240Hz OLED monitor',
    '1440p 240Hz gaming monitor', '1440p 180Hz monitor',
    '1080p 240Hz gaming monitor',
    'ultrawide gaming monitor 1440p', 'ultrawide 3440x1440 OLED',
    'LG UltraGear OLED', 'Samsung Odyssey OLED',
    'ASUS ROG Swift OLED', 'Alienware QD-OLED',
    'Gigabyte Aorus FO32U2P',
    '4K IPS monitor 27 inch', '32 inch 4K monitor',
    'portable monitor USB-C',
    '24 inch IPS monitor 1080p', '27 inch 1440p IPS',
  ],
  CaseFan: [
    '120mm case fan RGB', '140mm case fan RGB',
    '120mm PWM case fan', '140mm PWM case fan',
    'Noctua NF-A12x25', 'Noctua NF-A14',
    'Corsair iCUE QL120', 'Lian Li UNI Fan',
    'Arctic P12 PWM', 'be quiet! Silent Wings',
  ],
  Mouse: [
    'gaming mouse', 'wireless gaming mouse', 'esports mouse', 'lightweight gaming mouse',
    'Logitech G Pro mouse', 'Logitech G502', 'Logitech MX Master',
    'Razer DeathAdder', 'Razer Viper', 'Razer Basilisk',
    'Glorious Model O', 'Glorious Model D',
    'Corsair gaming mouse', 'SteelSeries Aerox', 'SteelSeries Rival',
    'Pulsar gaming mouse', 'Endgame Gear mouse', 'Zowie mouse',
  ],
  Keyboard: [
    'gaming keyboard', 'mechanical keyboard', 'wireless mechanical keyboard',
    'TKL gaming keyboard', '60% mechanical keyboard', '75% mechanical keyboard',
    'Logitech G Pro keyboard', 'Logitech MX Keys',
    'Razer Huntsman', 'Razer BlackWidow', 'Razer Cynosa',
    'Corsair K70', 'Corsair K100', 'Corsair gaming keyboard',
    'SteelSeries Apex', 'Keychron mechanical keyboard',
    'GMMK keyboard', 'Akko mechanical keyboard', 'Drop keyboard',
  ],
  Headset: [
    'gaming headset', 'wireless gaming headset', 'wired gaming headset',
    'Logitech G Pro headset', 'Logitech G733',
    'Razer BlackShark', 'Razer Kraken',
    'SteelSeries Arctis Nova', 'SteelSeries Arctis 7',
    'HyperX Cloud', 'HyperX Cloud III',
    'Sennheiser HD 560S', 'Sennheiser HD 600', 'Audio-Technica gaming',
    'Astro A50', 'Beyerdynamic DT 770', 'Drop headphones',
  ],
  Microphone: [
    'USB microphone', 'streaming microphone', 'podcast microphone',
    'Blue Yeti', 'Blue Yeti X', 'Blue Snowball',
    'Shure MV7', 'Shure SM7B', 'Shure MV6',
    'Elgato Wave', 'HyperX QuadCast', 'Razer Seiren',
    'Rode NT-USB', 'Rode PodMic', 'Audio-Technica AT2020',
  ],
  Webcam: [
    '1080p webcam', '4K webcam', 'streaming webcam',
    'Logitech C920', 'Logitech Brio', 'Logitech StreamCam',
    'Razer Kiyo', 'Razer Kiyo Pro', 'Razer Kiyo Pro Ultra',
    'Elgato Facecam', 'Insta360 webcam', 'Anker PowerConf',
    'Opal C1', 'Aukey webcam',
  ],
  MousePad: [
    'large gaming mousepad', 'XL gaming mousepad', 'desk mat XXL',
    'Logitech G840', 'Razer Goliathus Extended', 'Razer Gigantus',
    'SteelSeries QcK', 'SteelSeries QcK Heavy', 'SteelSeries QcK Prism',
    'Corsair MM700', 'Glorious 3XL mousepad', 'HyperX Fury mousepad',
    'Pulsar mousepad', 'Artisan mousepad',
  ],
  ExtensionCables: [
    'PCIe riser cable', 'PCIe 4.0 riser cable', 'PCIe extension cable',
    'GPU power extension cable', '24-pin ATX extension cable', 'EPS 8-pin extension cable',
    'cable extension kit PSU', 'CableMod extension', 'Lian Li PCIe riser',
    'Thermaltake riser cable', 'CORSAIR Premium PSU cables', 'PCIe 5.0 cable',
    'GPU sag bracket', '12VHPWR adapter cable',
  ],
};

const FILTERS = {
  Motherboard: { minPrice: 60,  maxPrice: 2000, minReviews: 2,  titleMustInclude: /motherboard|mobo/i },
  CPU:         { minPrice: 80,  maxPrice: 1500, minReviews: 5,  titleMustInclude: /ryzen|intel|core (i|ultra)/i },
  GPU:         { minPrice: 150, maxPrice: 5000, minReviews: 2,  titleMustInclude: /rtx|radeon|rx \d|geforce/i },
  RAM:         { minPrice: 20,  maxPrice: 1500, minReviews: 5,  titleMustInclude: /ddr[345]|memory|ram/i },
  Storage:     { minPrice: 20,  maxPrice: 2000, minReviews: 5,  titleMustInclude: /ssd|nvme|hdd|hard drive|solid state/i },
  PSU:         { minPrice: 40,  maxPrice: 800,  minReviews: 5,  titleMustInclude: /power supply|psu|80\+|80 plus/i },
  Case:        { minPrice: 30,  maxPrice: 800,  minReviews: 5,  titleMustInclude: /case|tower|chassis/i },
  CPUCooler:   { minPrice: 20,  maxPrice: 500,  minReviews: 5,  titleMustInclude: /cooler|heatsink|aio|liquid|radiator/i },
  Monitor:     { minPrice: 100, maxPrice: 3500, minReviews: 5,  titleMustInclude: /monitor|display|oled|ultragear|odyssey/i },
  CaseFan:     { minPrice: 8,   maxPrice: 200,  minReviews: 2,  titleMustInclude: /fan|cooling/i },
  Mouse:           { minPrice: 15,  maxPrice: 250,  minReviews: 50, titleMustInclude: /mouse|wireless/i },
  Keyboard:        { minPrice: 25,  maxPrice: 400,  minReviews: 30, titleMustInclude: /keyboard|mechanical|tkl|gaming/i },
  Headset:         { minPrice: 30,  maxPrice: 700,  minReviews: 30, titleMustInclude: /headset|headphone|gaming audio/i },
  Microphone:      { minPrice: 30,  maxPrice: 500,  minReviews: 30, titleMustInclude: /microphone|mic|podcast|streaming/i },
  Webcam:          { minPrice: 25,  maxPrice: 500,  minReviews: 30, titleMustInclude: /webcam|camera|streaming/i },
  MousePad:        { minPrice: 8,   maxPrice: 100,  minReviews: 30, titleMustInclude: /mouse\s*pad|mousepad|desk mat/i },
  ExtensionCables: { minPrice: 5,   maxPrice: 200,  minReviews: 10, titleMustInclude: /cable|riser|extension|adapter/i },
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const flags = {
  dryRun:   getFlag('--dry-run'),
  category: getFlag('--category', true),
  limit:    Number(getFlag('--limit', true)) || null,
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function dfsRequest(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          'Authorization': AUTH,
          'Content-Type': 'application/json',
        },
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
  throw new Error('all retries exhausted');
}

// ─────────────────────────────────────────────────────────────────────────────
// Task submission / polling / retrieval
// ─────────────────────────────────────────────────────────────────────────────

async function submitTasks(queries) {
  // queries = [{ keyword, category }, ...]
  const tasks = [];

  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const body = batch.map(q => ({
      keyword: q.keyword,
      location_code: 2840,     // United States
      language_code: 'en_US',
      depth: 50,
      tag: q.category,          // carry category through for reassembly later
    }));

    console.log(`   submitting batch ${Math.floor(i/BATCH_SIZE)+1} (${batch.length} tasks)...`);
    const resp = await dfsRequest('POST', '/merchant/amazon/products/task_post', body);

    if (resp.status_code !== 20000) {
      throw new Error(`batch submit failed: ${resp.status_code} ${resp.status_message}`);
    }

    for (let j = 0; j < resp.tasks.length; j++) {
      const t = resp.tasks[j];
      if (t.status_code !== 20100) {
        console.log(`     ⚠ task failed to create: ${t.status_code} ${t.status_message} (keyword: "${batch[j].keyword}")`);
        continue;
      }
      tasks.push({
        id: t.id,
        keyword: batch[j].keyword,
        category: batch[j].category,
        cost: t.cost || 0,
      });
    }

    // Tiny pause between batches
    if (i + BATCH_SIZE < queries.length) await new Promise(r => setTimeout(r, 1000));
  }

  return tasks;
}

async function waitForCompletion(taskIds) {
  const pending = new Set(taskIds);
  const ready = new Set();
  const startWait = Date.now();

  console.log(`   waiting for ${pending.size} tasks (poll every ${POLL_INTERVAL_MS/1000}s)...`);

  while (pending.size > 0) {
    if (Date.now() - startWait > MAX_POLL_WAIT_MS) {
      console.log(`   ⚠ timeout after ${MAX_POLL_WAIT_MS/1000}s — ${pending.size} still pending; will try to fetch anyway`);
      break;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const resp = await dfsRequest('GET', '/merchant/amazon/products/tasks_ready');
    if (resp.status_code !== 20000) {
      console.log(`   ⚠ tasks_ready returned ${resp.status_code}: ${resp.status_message}`);
      continue;
    }

    // Response structure: tasks[0].result[] contains completed task IDs
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
    console.log(`   [${elapsed}s] +${newlyReady} ready, ${pending.size} still pending`);
  }

  return { ready: [...ready], stillPending: [...pending] };
}

async function fetchTaskResult(taskId) {
  const resp = await dfsRequest('GET', `/merchant/amazon/products/task_get/advanced/${taskId}`);
  if (resp.status_code !== 20000) {
    return { error: `${resp.status_code}: ${resp.status_message}`, items: [] };
  }
  const items = resp.tasks?.[0]?.result?.[0]?.items || [];
  return { error: null, items };
}

async function fetchAllResults(taskIds, knownTasks) {
  const results = new Map(); // taskId -> { items, category, keyword }

  // Build lookup of taskId -> metadata
  const meta = new Map();
  for (const t of knownTasks) meta.set(t.id, t);

  // Concurrency-limited parallel fetch
  let i = 0;
  async function worker() {
    while (i < taskIds.length) {
      const idx = i++;
      const id = taskIds[idx];
      const m = meta.get(id);
      if (!m) continue;

      try {
        const { error, items } = await fetchTaskResult(id);
        if (error) {
          console.log(`   ✗ "${m.keyword}" fetch failed: ${error}`);
          results.set(id, { items: [], category: m.category, keyword: m.keyword });
        } else {
          results.set(id, { items, category: m.category, keyword: m.keyword });
          if ((idx + 1) % 20 === 0 || idx + 1 === taskIds.length) {
            console.log(`   fetched ${idx + 1}/${taskIds.length}`);
          }
        }
      } catch (e) {
        console.log(`   ✗ "${m.keyword}" exception: ${e.message}`);
        results.set(id, { items: [], category: m.category, keyword: m.keyword });
      }
    }
  }

  const workers = Array.from({ length: GET_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization / filtering
// ─────────────────────────────────────────────────────────────────────────────

function normalizeItem(it, category, query) {
  const f = FILTERS[category];

  // DataForSEO actual field names (corrected after inspecting real response):
  //   price is in price_from (price.current doesn't exist)
  //   asin is in data_asin (asin doesn't exist)
  //   reviews is in rating.votes_count
  //   sponsored ads have type === 'amazon_paid'
  const price = it.price_from ?? null;
  const reviews = it.rating?.votes_count ?? 0;
  const title = it.title || '';
  const asin = it.data_asin || null;

  if (price === null) return null;
  if (price < f.minPrice || price > f.maxPrice) return null;
  if (reviews < f.minReviews) return null;
  if (f.titleMustInclude && !f.titleMustInclude.test(title)) return null;
  if (!asin) return null;
  if (it.type === 'amazon_paid') return null; // sponsored slot, skip

  // Append affiliate tag to Amazon URL
  let amazonUrl = it.url || `https://www.amazon.com/dp/${asin}/`;
  // If URL doesn't have our tag, append it
  if (!amazonUrl.includes('tag=tiereduptech-20')) {
    amazonUrl += amazonUrl.includes('?') ? '&tag=tiereduptech-20' : '?tag=tiereduptech-20';
  }

  return {
    asin,
    title: title.trim(),
    brand: null, // will be filled by enrichment step
    price,
    currency: it.currency || 'USD',
    rating: it.rating?.value ?? null,
    reviews,
    imageUrl: it.image_url || null,
    amazonUrl,
    boughtPastMonth: it.bought_past_month ?? null,
    isAmazonChoice: it.is_amazon_choice === true,
    isBestSeller: it.is_best_seller === true,
    category,
    discoveredVia: query,
    discoveredAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── DataForSEO Amazon Discovery v2 (task-based) ──\n');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Build query plan
  const queries = [];
  for (const [cat, keywords] of Object.entries(QUERIES)) {
    if (flags.category && cat.toLowerCase() !== flags.category.toLowerCase()) continue;
    for (const kw of keywords) queries.push({ keyword: kw, category: cat });
  }
  if (flags.limit) queries.splice(flags.limit);

  console.log(`Plan: ${queries.length} queries across ${new Set(queries.map(q=>q.category)).size} categories`);
  console.log(`Estimated cost: $${(queries.length * 0.002).toFixed(3)}\n`);

  if (flags.dryRun) {
    console.log('DRY RUN — query plan:\n');
    let lastCat = '';
    for (const q of queries) {
      if (q.category !== lastCat) { console.log(`\n  ${q.category}:`); lastCat = q.category; }
      console.log(`    - "${q.keyword}"`);
    }
    console.log('\n(no API calls made, no money spent)');
    return;
  }

  // Phase 1: submit all tasks
  console.log('Phase 1: Submitting tasks...');
  const tasks = await submitTasks(queries);
  console.log(`   ✓ ${tasks.length} tasks submitted`);
  writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));

  // Phase 2: wait for completion
  console.log('\nPhase 2: Waiting for completion...');
  const { ready, stillPending } = await waitForCompletion(tasks.map(t => t.id));
  console.log(`   ✓ ${ready.length} ready, ${stillPending.length} timed out`);

  // Phase 3: fetch all results
  console.log('\nPhase 3: Fetching results...');
  const resultsByTask = await fetchAllResults(ready, tasks);

  // Phase 4: classify and dedup
  console.log('\nPhase 4: Classifying and deduping...');
  const perCategory = new Map(); // category -> Map<asin, item>
  let totalRaw = 0;
  let totalKept = 0;

  for (const [taskId, { items, category, keyword }] of resultsByTask) {
    totalRaw += items.length;
    if (!perCategory.has(category)) perCategory.set(category, new Map());
    const catMap = perCategory.get(category);
    let added = 0;
    for (const raw of items) {
      const normalized = normalizeItem(raw, category, keyword);
      if (!normalized) continue;
      if (catMap.has(normalized.asin)) continue;
      catMap.set(normalized.asin, normalized);
      added++;
      totalKept++;
    }
  }

  // Phase 5: write per-category files
  console.log('\nPhase 5: Writing output files...');
  const summary = {};
  for (const [cat, m] of perCategory) {
    const arr = [...m.values()];
    const path = join(OUTPUT_DIR, `${cat.toLowerCase()}.json`);
    writeFileSync(path, JSON.stringify(arr, null, 2));
    summary[cat] = arr.length;
    console.log(`   ${cat.padEnd(15)} ${arr.length} products → ${path}`);
  }

  writeFileSync(SUMMARY_PATH, JSON.stringify({
    completedAt: new Date().toISOString(),
    queriesSubmitted: tasks.length,
    queriesCompleted: ready.length,
    queriesTimedOut: stillPending.length,
    rawItemsTotal: totalRaw,
    keptAfterFilters: totalKept,
    perCategory: summary,
  }, null, 2));

  console.log('\n── Discovery Complete ──');
  console.log(`Total raw items: ${totalRaw}`);
  console.log(`Kept after quality filters: ${totalKept}`);
  console.log(`Timed out tasks: ${stillPending.length}`);
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
