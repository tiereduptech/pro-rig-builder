/**
 * expand-catalog-amazon.cjs
 *
 * Discovers Amazon products NOT in our catalog using DataForSEO Amazon search.
 *
 * Strategy:
 *   1. For each category (CPU, GPU, Motherboard, RAM, Storage, PSU, Case, CPUCooler),
 *      generate targeted search queries.
 *   2. Submit all queries as DataForSEO Amazon Products tasks (async, much faster than serial).
 *   3. Poll tasks_ready until all complete.
 *   4. Filter out ASINs we already have.
 *   5. Save new candidates to staging file: catalog-build/_amazon-discoveries.json
 *   6. (Separate apply step writes to parts.js with needsReview: true)
 *
 * USAGE:
 *   railway run node expand-catalog-amazon.cjs                 # all categories
 *   railway run node expand-catalog-amazon.cjs --cats PSU,Case # specific cats
 *   railway run node expand-catalog-amazon.cjs --dry-run       # show queries without submitting
 *
 * COST: ~$0.0006 per query × ~80 queries = ~$0.05 per run
 */

const fs = require('fs');
const path = require('path');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing DataForSEO credentials'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const DRY_RUN = process.argv.includes('--dry-run');
const CAT_ARG = process.argv.find(a => a.startsWith('--cats='));
const REQUESTED_CATS = CAT_ARG ? CAT_ARG.replace('--cats=', '').split(',') : null;

// Search query plan: 5-10 queries per category, designed to cover top sellers + niche
const SEARCH_QUERIES = {
  CPU: [
    'AMD Ryzen 9 processor',
    'AMD Ryzen 7 processor',
    'AMD Ryzen 5 processor',
    'Intel Core i9 processor',
    'Intel Core i7 processor',
    'Intel Core i5 processor',
    'Intel Core Ultra processor',
    'AMD Ryzen X3D',
  ],
  GPU: [
    'NVIDIA RTX 5090 graphics card',
    'NVIDIA RTX 5080 graphics card',
    'NVIDIA RTX 5070 graphics card',
    'NVIDIA RTX 5060 graphics card',
    'NVIDIA RTX 4070 graphics card',
    'AMD Radeon RX 9070 graphics card',
    'AMD Radeon RX 7900 graphics card',
    'Intel Arc graphics card',
  ],
  Motherboard: [
    'X870E motherboard AM5',
    'X870 motherboard AM5',
    'B850 motherboard AM5',
    'B650 motherboard AM5',
    'Z890 motherboard LGA1851',
    'Z790 motherboard LGA1700',
    'B760 motherboard LGA1700',
    'mini-ITX motherboard AM5',
  ],
  RAM: [
    'DDR5 6000 32GB kit',
    'DDR5 6400 32GB kit',
    'DDR5 7200 32GB kit',
    'DDR5 64GB kit',
    'DDR4 3200 32GB kit',
    'DDR4 3600 32GB kit',
    'Corsair Vengeance DDR5',
    'G.Skill Trident Z5',
  ],
  Storage: [
    'NVMe SSD 2TB PCIe Gen4',
    'NVMe SSD 4TB PCIe Gen5',
    'NVMe SSD 1TB',
    'Samsung 990 Pro',
    'WD Black SN850X',
    'Crucial T705',
    'SATA SSD 2TB',
    'HDD 8TB NAS',
  ],
  PSU: [
    'PSU 850W 80 Plus Gold modular',
    'PSU 1000W 80 Plus Gold',
    'PSU 1200W 80 Plus Platinum',
    'PSU 750W ATX 3.0',
    'Corsair RM power supply',
    'EVGA SuperNOVA power supply',
    'Seasonic Focus power supply',
    'be quiet power supply',
  ],
  Case: [
    'PC case ATX mid tower',
    'PC case mini ITX',
    'PC case airflow mesh',
    'PC case tempered glass dual chamber',
    'Lian Li PC case',
    'Fractal Design PC case',
    'NZXT H7 case',
    'Corsair iCUE case',
  ],
  CPUCooler: [
    'AIO liquid CPU cooler 360mm',
    'AIO liquid CPU cooler 240mm',
    'Noctua air cooler',
    'be quiet Dark Rock',
    'Thermalright Peerless Assassin',
    'Arctic Liquid Freezer',
    'NZXT Kraken cooler',
    'Corsair iCUE cooler',
  ],
};

// Categorization rules (matches existing patterns in catalog)
function categorize(title) {
  const t = (title || '').toLowerCase();
  if (/\b(ryzen|core\s*i[3579]|core\s*ultra|threadripper|epyc)\b/.test(t) && !/(cooler|fan|motherboard|case|bundle)/.test(t)) return 'CPU';
  if (/\b(rtx|gtx|radeon|arc)\b.*\b(graphics|video card|gpu)\b/.test(t) || /\b(rtx|gtx|radeon)\s*\d{4}/.test(t)) return 'GPU';
  if (/\bmotherboard\b/.test(t) || /\b(x870|b850|b650|z890|z790|b760|a620|x670)/.test(t)) return 'Motherboard';
  if (/\b(ddr[45]|memory|ram\b).*?(kit|dimm|sodimm)/.test(t) || /\b\d+gb\s*\(\d+x\d+gb\)/i.test(title)) return 'RAM';
  if (/\b(ssd|nvme|hard drive|hdd)\b/.test(t) && !/cooler|case|fan/.test(t)) return 'Storage';
  if (/\bpower supply|psu\b/.test(t) || /\b\d+w\s+(80.?plus|gold|platinum|atx)/i.test(title)) return 'PSU';
  if (/\bpc case\b|\b(mid|full|mini).?tower\b|\bchassis\b/.test(t)) return 'Case';
  if (/\b(cpu cooler|aio|liquid cooler|air cooler|tower cooler|heatsink)\b/.test(t)) return 'CPUCooler';
  return null;
}

function detectBrand(title) {
  const brands = ['AMD','Intel','NVIDIA','ASUS','MSI','Gigabyte','ASRock','Corsair','G.Skill','Kingston','Crucial','Samsung','Western Digital','WD','Seagate','SanDisk','Lexar','TeamGroup','Patriot','EVGA','Seasonic','be quiet!','Cooler Master','NZXT','Lian Li','Fractal Design','Thermaltake','Phanteks','Noctua','Arctic','Thermalright','Scythe','DeepCool','Hyte','Antec'];
  const t = (title || '').toLowerCase();
  for (const b of brands) {
    if (t.includes(b.toLowerCase())) return b;
  }
  return null;
}

// Extract basic specs from title
function extractSpecs(title, category) {
  const specs = {};
  const t = title || '';

  if (category === 'CPU') {
    const cores = t.match(/(\d+)[\s-]*core/i);
    if (cores) specs.cores = parseInt(cores[1]);
    const socket = t.match(/\b(LGA\s?\d+|AM[45]|sTRX\d|sWRX\d|TR\d)\b/i);
    if (socket) specs.socket = socket[1].replace(/\s/g, '').toUpperCase();
    const tdp = t.match(/(\d+)\s*W\b/i);
    if (tdp) specs.tdp = parseInt(tdp[1]);
  } else if (category === 'GPU') {
    const vram = t.match(/(\d+)\s*GB\s*(GDDR|VRAM)/i);
    if (vram) specs.vram = parseInt(vram[1]);
  } else if (category === 'PSU') {
    const watts = t.match(/\b(\d{3,4})\s*W\b/);
    if (watts) specs.watts = parseInt(watts[1]);
    if (/80\+?\s*platinum/i.test(t)) specs.eff = '80+ Platinum';
    else if (/80\+?\s*gold/i.test(t)) specs.eff = '80+ Gold';
    else if (/80\+?\s*bronze/i.test(t)) specs.eff = '80+ Bronze';
    if (/fully modular/i.test(t)) specs.modular = 'Full';
    else if (/semi.?modular/i.test(t)) specs.modular = 'Semi';
    if (/atx\s*3\.[01]/i.test(t)) specs.atx3 = true;
  } else if (category === 'RAM') {
    const speed = t.match(/(\d{4})\s*(MHz|MT)/i);
    if (speed) specs.speed = parseInt(speed[1]);
    const cap = t.match(/(\d+)\s*GB\s*\(/i) || t.match(/(\d+)\s*GB\s+kit/i);
    if (cap) specs.cap = parseInt(cap[1]);
    const sticks = t.match(/\((\d+)\s*x\s*\d+gb\)/i);
    if (sticks) specs.sticks = parseInt(sticks[1]);
    const cl = t.match(/\bCL\s?(\d+)/i);
    if (cl) specs.cl = parseInt(cl[1]);
    if (/ddr5/i.test(t)) specs.memType = 'DDR5';
    else if (/ddr4/i.test(t)) specs.memType = 'DDR4';
  } else if (category === 'Storage') {
    const cap = t.match(/(\d+)\s*(TB|GB)/i);
    if (cap) {
      const size = parseInt(cap[1]);
      specs.cap = cap[2].toLowerCase() === 'tb' ? size * 1000 : size;
    }
    if (/\bnvme\b/i.test(t)) specs.storageType = 'NVMe';
    else if (/\bhdd\b|hard drive|hard disk/i.test(t)) specs.storageType = 'HDD';
    else if (/\bssd\b/i.test(t)) specs.storageType = 'SSD';
  }
  return specs;
}

// ─── DataForSEO Amazon products search ───
async function submitSearchTask(keyword) {
  const body = [{
    keyword,
    location_code: 2840,    // United States
    language_code: 'en_US',
    priority: 1,
    se_domain: 'amazon.com',
    depth: 20, // up to 20 results
  }];
  const res = await fetch(BASE + '/merchant/amazon/products/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error('task_post failed: ' + JSON.stringify(data));
  return data.tasks[0].id;
}

async function getTaskResult(taskId) {
  const res = await fetch(BASE + '/merchant/amazon/products/task_get/advanced/' + taskId, {
    headers: { 'Authorization': AUTH },
  });
  const data = await res.json();
  if (data.status_code !== 20000) return null;
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0];
}

async function waitForTasks(taskIds, timeoutMs = 180000) {
  const start = Date.now();
  const results = new Map();
  const remaining = new Set(taskIds);

  while (remaining.size > 0 && (Date.now() - start) < timeoutMs) {
    for (const id of [...remaining]) {
      try {
        const result = await getTaskResult(id);
        if (result) {
          results.set(id, result);
          remaining.delete(id);
        }
      } catch (e) { /* keep polling */ }
    }
    if (remaining.size > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return results;
}

(async () => {
  // Load current catalog
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const existing = new Set();
  for (const p of m.PARTS) {
    if (p.asin) existing.add(p.asin.toUpperCase());
    if (p.deals?.amazon?.asin) existing.add(p.deals.amazon.asin.toUpperCase());
    // Also try to extract ASIN from amazon URLs
    const url = p.deals?.amazon?.url;
    if (url) {
      const asinMatch = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
      if (asinMatch) existing.add(asinMatch[1]);
    }
  }
  console.log('Catalog ASINs known:', existing.size);

  // Build query plan
  const cats = REQUESTED_CATS || Object.keys(SEARCH_QUERIES);
  const queries = [];
  for (const cat of cats) {
    if (!SEARCH_QUERIES[cat]) { console.warn('No queries for category:', cat); continue; }
    for (const q of SEARCH_QUERIES[cat]) queries.push({ cat, keyword: q });
  }
  console.log('Total queries:', queries.length);
  console.log('Estimated cost: $' + (queries.length * 0.0006).toFixed(3));

  if (DRY_RUN) {
    console.log('\nDRY RUN — queries that would run:');
    queries.forEach((q, i) => console.log((i+1) + '. [' + q.cat + '] ' + q.keyword));
    return;
  }

  // Submit all tasks
  console.log('\nSubmitting tasks...');
  const taskIds = [];
  for (const q of queries) {
    try {
      const id = await submitSearchTask(q.keyword);
      taskIds.push({ id, cat: q.cat, keyword: q.keyword });
      process.stdout.write('.');
    } catch (e) {
      console.error('\n  FAILED to submit:', q.keyword, '-', e.message);
    }
  }
  console.log('\nSubmitted:', taskIds.length, 'tasks');

  // Wait for completion
  console.log('\nWaiting for results (3s poll interval, 3min timeout)...');
  const results = await waitForTasks(taskIds.map(t => t.id));
  console.log('Got results for:', results.size, '/', taskIds.length);

  // Process results
  const discoveries = {};   // cat -> [{ asin, title, brand, price, image, url, specs }]
  let totalSeen = 0;
  let totalNew = 0;

  for (const taskMeta of taskIds) {
    const result = results.get(taskMeta.id);
    if (!result || !result.items) continue;
    for (const item of result.items) {
      if (item.type !== 'amazon_serp' && item.type !== 'amazon_product') continue;
      const asin = (item.data_asin || '').toUpperCase();
      if (!asin || asin.length !== 10) continue;
      totalSeen++;
      if (existing.has(asin)) continue;
      // It's a new candidate
      const title = item.title || '';
      const cat = categorize(title) || taskMeta.cat;
      const brand = detectBrand(title);
      const price = item.price_from || item.price || null;
      const image = item.image_url || null;
      const url = item.url || ('https://www.amazon.com/dp/' + asin);
      const specs = extractSpecs(title, cat);
      const rating = item.rating?.value || null;
      const ratingCount = item.rating?.votes_count || null;

      discoveries[cat] = discoveries[cat] || [];
      discoveries[cat].push({
        asin, title, brand, price, image, url, specs,
        rating, ratingCount,
        searchQuery: taskMeta.keyword,
      });
      existing.add(asin); // dedupe within this run too
      totalNew++;
    }
  }

  console.log('\n--- DISCOVERY RESULTS ---');
  console.log('Total results seen:', totalSeen);
  console.log('Already in catalog (dedup):', totalSeen - totalNew);
  console.log('NEW discoveries:', totalNew);
  console.log('\nBy category:');
  Object.entries(discoveries).sort((a,b) => b[1].length - a[1].length).forEach(([cat, list]) => {
    console.log('  ' + cat + ': ' + list.length);
  });

  // Save staging file
  const outDir = path.join(process.cwd(), 'catalog-build');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, '_amazon-discoveries.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDiscoveries: totalNew,
    byCategory: Object.fromEntries(Object.entries(discoveries).map(([c, l]) => [c, l.length])),
    discoveries,
  }, null, 2));
  console.log('\nSaved staging file:', outFile);
  console.log('\nNext step: review the file, then run apply-amazon-discoveries.cjs');
})();
