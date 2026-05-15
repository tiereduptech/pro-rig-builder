// expand-catalog-budget.cjs - second pass for budget brands and missing wattages/sizes
const fs = require('fs');
const path = require('path');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const DRY_RUN = process.argv.includes('--dry-run');

// Budget-focused + gap-filling queries
const SEARCH_QUERIES = {
  PSU: [
    'PSU 500W ATX',
    'PSU 550W ATX',
    'PSU 600W 80 Plus',
    'PSU 650W 80 Plus Gold',
    'PSU 700W modular',
    'Apevia power supply',
    'Thermaltake power supply',
    'Rosewill power supply',
    'Cooler Master MWE power supply',
    'EVGA 500W power supply',
    'SFX power supply 600W',
    'Apevia ATX',
    'budget PSU 80 plus',
    'PSU 80 plus bronze 500W',
    'PSU 80 plus bronze 600W',
    'PSU SFX 750W',
  ],
  CPU: [
    'AMD Ryzen 3',
    'AMD Athlon',
    'AMD Ryzen budget',
    'Intel Pentium',
    'Intel Celeron',
    'Intel Core i3',
    'AMD Ryzen 5 5600',
    'AMD Ryzen 5 7500F',
    'AMD Ryzen 5 8500G',
    'Intel Core i5-12400',
    'Intel Core i5-13400',
    'Intel Xeon W',
    'AMD Threadripper',
  ],
  GPU: [
    'NVIDIA RTX 3050 graphics card',
    'NVIDIA RTX 3060 graphics card',
    'NVIDIA GTX 1660',
    'AMD Radeon RX 6600',
    'AMD Radeon RX 6700',
    'AMD Radeon RX 7600',
    'AMD Radeon RX 6800',
    'Intel Arc A380',
    'Intel Arc A580',
    'GeForce RTX 4060',
    'GeForce RTX 4080 Super',
    'low profile graphics card',
  ],
  Motherboard: [
    'A520 motherboard AM4',
    'A620 motherboard AM5',
    'B450 motherboard AM4',
    'B550 motherboard AM4',
    'H610 motherboard LGA1700',
    'H510 motherboard LGA1200',
    'B660 motherboard LGA1700',
    'mini-ITX motherboard LGA1700',
    'mATX motherboard B650',
    'mATX motherboard B760',
    'motherboard Wi-Fi 7 AM5',
    'motherboard ATX server',
  ],
  RAM: [
    'DDR4 16GB kit',
    'DDR4 8GB',
    'DDR5 16GB kit',
    'DDR5 24GB kit',
    'DDR5 48GB kit',
    'DDR5 32GB single stick',
    'ECC DDR5 RAM',
    'SODIMM DDR5 32GB',
    'SODIMM DDR4 16GB',
    'Crucial DDR5',
    'Kingston Fury DDR5',
    'PNY DDR5 RAM',
    'Patriot Viper DDR5',
  ],
  Storage: [
    'SATA SSD 1TB',
    'SATA SSD 500GB',
    'SATA SSD 4TB',
    'NVMe SSD 500GB',
    'NVMe SSD 8TB',
    'WD Blue SSD',
    'Crucial MX SSD',
    'Kingston SSD',
    'TeamGroup SSD',
    'HDD 4TB',
    'HDD 16TB',
    'HDD 20TB NAS',
    'Seagate IronWolf',
    'WD Red NAS',
    'external SSD USB',
    'Inland SSD',
    'Lexar NVMe',
  ],
  Case: [
    'PC case under 50',
    'PC case under 100',
    'PC case full tower',
    'PC case M-ATX',
    'PC case ITX',
    'NZXT H5 case',
    'NZXT H7 case',
    'Phanteks Eclipse',
    'Antec case',
    'Thermaltake case',
    'Cooler Master HAF',
    'be quiet Pure Base',
    'Montech case',
    'Jonsbo case',
    'Hyte case',
    'Lian Li O11',
    'DeepCool case',
    'Corsair 4000D',
    'Fractal Pop',
    'PC case showcase glass',
  ],
  CPUCooler: [
    'CPU air cooler under 50',
    'CPU air cooler tower',
    'AIO 280mm CPU cooler',
    'AIO 420mm CPU cooler',
    'low profile CPU cooler',
    'Cooler Master Hyper',
    'Deepcool AK',
    'ID-COOLING cooler',
    'be quiet Pure Rock',
    'Corsair iCUE H',
    'NZXT Kraken Elite',
    'Lian Li Galahad',
    'EK AIO',
    'Cooler Master MasterLiquid',
    'AIO CPU cooler RGB',
  ],
  // ADD: Monitor (was Tier 2)
  Monitor: [
    '4K monitor 27 inch',
    '4K monitor 32 inch',
    '1440p monitor 27 inch',
    '1440p monitor 32 inch',
    '240Hz monitor',
    '360Hz monitor',
    'OLED monitor gaming',
    'portable monitor 15 inch',
    'ultrawide monitor 34 inch',
    'budget gaming monitor 144Hz',
    'LG UltraGear monitor',
    'ASUS ROG monitor',
    'Samsung Odyssey monitor',
    'Gigabyte M monitor',
    'MSI MAG monitor',
  ],
  CaseFan: [
    '120mm case fan',
    '140mm case fan',
    'ARGB case fan 3 pack',
    'PWM case fan',
    'Noctua fan',
    'Arctic P12 fan',
    'be quiet Silent Wings',
    'Corsair LL fan',
    'Lian Li UniFan',
    'Phanteks fan',
    'Thermaltake fan RGB',
  ],
};

async function submitTask(keyword) {
  const body = [{
    keyword,
    location_code: 2840,
    language_code: 'en_US',
    priority: 1,
    se_domain: 'amazon.com',
    depth: 20,
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

async function getResult(taskId) {
  const res = await fetch(BASE + '/merchant/amazon/products/task_get/advanced/' + taskId, {
    headers: { 'Authorization': AUTH },
  });
  const data = await res.json();
  if (data.status_code !== 20000) return null;
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0];
}

async function waitForTasks(taskIds, timeoutMs = 240000) {
  const start = Date.now();
  const results = new Map();
  const remaining = new Set(taskIds);
  while (remaining.size > 0 && (Date.now() - start) < timeoutMs) {
    for (const id of [...remaining]) {
      try {
        const result = await getResult(id);
        if (result) { results.set(id, result); remaining.delete(id); }
      } catch (e) {}
    }
    if (remaining.size > 0) await new Promise(r => setTimeout(r, 3000));
  }
  return results;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const existing = new Set();
  for (const p of m.PARTS) {
    if (p.asin) existing.add(p.asin.toUpperCase());
    if (p.deals?.amazon?.asin) existing.add(p.deals.amazon.asin.toUpperCase());
    const url = p.deals?.amazon?.url;
    if (url) {
      const am = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
      if (am) existing.add(am[1]);
    }
  }
  console.log('Catalog ASINs known:', existing.size);

  const queries = [];
  for (const cat of Object.keys(SEARCH_QUERIES)) {
    for (const q of SEARCH_QUERIES[cat]) queries.push({ cat, keyword: q });
  }
  console.log('Total queries:', queries.length);
  console.log('Estimated cost: $' + (queries.length * 0.0006).toFixed(3));

  if (DRY_RUN) {
    console.log('\nDRY RUN — queries that would run:');
    const byCat = {};
    queries.forEach(q => { byCat[q.cat] = (byCat[q.cat]||0) + 1; });
    console.log(byCat);
    return;
  }

  console.log('\nSubmitting tasks...');
  const taskIds = [];
  for (const q of queries) {
    try {
      const id = await submitTask(q.keyword);
      taskIds.push({ id, cat: q.cat, keyword: q.keyword });
      process.stdout.write('.');
    } catch (e) {
      console.error('\nFailed:', q.keyword);
    }
  }
  console.log('\nSubmitted:', taskIds.length);

  console.log('Polling...');
  const results = await waitForTasks(taskIds.map(t => t.id));
  console.log('Got:', results.size, '/', taskIds.length);

  const discoveries = {};
  let totalSeen = 0, totalNew = 0;
  for (const t of taskIds) {
    const result = results.get(t.id);
    if (!result?.items) continue;
    for (const item of result.items) {
      const asin = (item.data_asin || '').toUpperCase();
      if (!asin || asin.length !== 10) continue;
      totalSeen++;
      if (existing.has(asin)) continue;
      const title = item.title || '';
      const price = item.price_from || item.price || null;
      const image = item.image_url || null;
      const rating = item.rating?.value || null;

      discoveries[t.cat] = discoveries[t.cat] || [];
      discoveries[t.cat].push({
        asin, title, brand: null, price, image,
        url: item.url || ('https://www.amazon.com/dp/' + asin),
        rating, ratingCount: item.rating?.votes_count || null,
        specs: {}, searchQuery: t.keyword,
      });
      existing.add(asin);
      totalNew++;
    }
  }

  console.log('\n--- DISCOVERIES ---');
  console.log('Seen:', totalSeen, '| Already in catalog:', totalSeen - totalNew, '| NEW:', totalNew);
  console.log('\nBy category:');
  Object.entries(discoveries).sort((a,b) => b[1].length - a[1].length).forEach(([c,l]) => console.log('  '+c+': '+l.length));

  const outFile = path.join(process.cwd(), 'catalog-build', '_amazon-discoveries.json');
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalDiscoveries: totalNew,
    byCategory: Object.fromEntries(Object.entries(discoveries).map(([c,l]) => [c,l.length])),
    discoveries,
  }, null, 2));
  console.log('\nSaved:', outFile);
})();
