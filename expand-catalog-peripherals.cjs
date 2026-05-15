// expand-catalog-peripherals.cjs - third pass focusing on peripherals + remaining gaps
const fs = require('fs');
const path = require('path');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const DRY_RUN = process.argv.includes('--dry-run');

const SEARCH_QUERIES = {
  Mouse: [
    'wireless gaming mouse',
    'Logitech G Pro mouse',
    'Razer DeathAdder mouse',
    'Razer Viper mouse',
    'SteelSeries Aerox mouse',
    'Corsair Scimitar mouse',
    'gaming mouse ergonomic',
    'lightweight gaming mouse',
    'MMO gaming mouse',
    'wireless mouse Logitech',
    'Glorious Model O mouse',
    'Endgame Gear mouse',
    'gaming mouse 26000 dpi',
    'left handed mouse',
    'budget gaming mouse',
  ],
  Keyboard: [
    'mechanical gaming keyboard',
    'wireless mechanical keyboard',
    'TKL keyboard',
    '60% keyboard',
    '65% keyboard',
    '75% keyboard',
    'Keychron keyboard',
    'Logitech G915 keyboard',
    'Razer BlackWidow keyboard',
    'Corsair K70 keyboard',
    'SteelSeries Apex keyboard',
    'HyperX Alloy keyboard',
    'Glorious GMMK keyboard',
    'low profile keyboard mechanical',
    'gaming keyboard cherry MX',
    'optical switch keyboard',
  ],
  Headset: [
    'wireless gaming headset',
    'Logitech G Pro headset',
    'SteelSeries Arctis headset',
    'HyperX Cloud headset',
    'Razer BlackShark headset',
    'Corsair HS headset',
    'Astro A50 headset',
    'gaming headset 7.1 surround',
    'open back headphones gaming',
    'closed back gaming headset',
    'wired gaming headset',
    'noise cancelling gaming headset',
    'Audeze gaming headset',
    'EPOS headset',
  ],
  Microphone: [
    'USB microphone podcast',
    'Blue Yeti microphone',
    'HyperX QuadCast microphone',
    'Shure MV7 microphone',
    'Rode NT-USB microphone',
    'XLR microphone',
    'condenser microphone',
    'dynamic microphone podcast',
    'wireless microphone',
    'lavalier microphone',
    'Elgato Wave microphone',
  ],
  Webcam: [
    '4K webcam',
    '1080p webcam',
    'Logitech webcam',
    'streaming webcam',
    'Razer Kiyo webcam',
    'Elgato Facecam',
    'Insta360 webcam',
    'webcam with ring light',
    'autofocus webcam',
  ],
  MousePad: [
    'large gaming mousepad',
    'XXL mousepad',
    'RGB mousepad',
    'Logitech G mousepad',
    'SteelSeries QcK mousepad',
    'Corsair MM mousepad',
    'glass mousepad gaming',
    'cloth mousepad gaming',
  ],
  // Fill remaining gaps in components
  PSU: [
    'PSU 1000W modular',
    'PSU 1300W',
    'PSU 1500W',
    'Cooler Master MWE 750W',
    'EVGA 750W power supply',
    'Thermaltake Toughpower',
    'XPG Core Reactor power supply',
    'Phanteks PSU',
    'EVGA G+ power supply',
    'SilverStone power supply',
  ],
  Case: [
    'Phanteks NV9 case',
    'Phanteks Eclipse case',
    'Cooler Master MasterBox',
    'NZXT H6 case',
    'NZXT H9 case',
    'BeQuiet Pure Base 500DX',
    'iCUE 5000 case',
    'Hyte Y60 Y70',
    'O11 dynamic case',
    'small form factor case sff',
    'showcase glass case',
  ],
  CPUCooler: [
    'Thermalright Phantom Spirit',
    'Cooler Master MasterLiquid 360',
    'Lian Li Galahad II',
    'NZXT Kraken Elite 360',
    'Corsair Nautilus',
    'EK Nucleus AIO',
    'Phanteks Glacier AIO',
    'budget air cooler AM5',
    'budget air cooler LGA1700',
  ],
  // Add Storage gaps
  Storage: [
    'NVMe SSD 8TB',
    'Samsung 9100 Pro',
    'Crucial T705 NVMe',
    'Solidigm SSD',
    'TeamGroup MP44 SSD',
    'Sabrent Rocket 4 NVMe',
    'M.2 2230 SSD Steam Deck',
    'external NVMe SSD',
    'PCIe Gen 5 SSD',
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

async function waitForTasks(taskIds, timeoutMs = 300000) {
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
    const byCat = {};
    queries.forEach(q => { byCat[q.cat] = (byCat[q.cat]||0) + 1; });
    console.log('\nQueries by category:', byCat);
    return;
  }

  console.log('\nSubmitting tasks...');
  const taskIds = [];
  for (const q of queries) {
    try {
      const id = await submitTask(q.keyword);
      taskIds.push({ id, cat: q.cat, keyword: q.keyword });
      process.stdout.write('.');
    } catch (e) { console.error('\nFailed:', q.keyword); }
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
