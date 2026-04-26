// fetch-pc-internal-displays.cjs
// Targeted searches for actual PC case-mounted displays (Lian Li, Thermalright, AsiaHorse type)
// Strict filter: must mention PC/case/mount + reasonable size (3-15 inches)

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

// Targeted PC-display searches
const SEARCH_QUERIES = [
  'lian li universal screen pc',
  'thermalright lcd sub-display pc',
  'asus rog secondary display pc',
  'gpu screen lcd pc case',
  'pc case sensor panel argb',
  'computer case lcd usb monitor',
  '8.8 inch lcd usb pc',
  'aida64 sensor panel display pc',
  'cpu temp monitor display pc usb',
  'asiahorse pc lcd display',
  'mini pc display 5 inch usb-c sensor',
  'gaming pc internal lcd screen'
];

// MUST include PC-context keywords
function shouldInclude(title) {
  const t = title.toLowerCase();

  // Must mention PC/case context
  const pcContext = /(pc|computer|case|gaming|argb|rgb|gpu|cpu temp|sensor|aida|aio|cooler|chassis)/i.test(t);
  if (!pcContext) return false;

  // Must mention display/screen/lcd
  if (!/display|screen|lcd|monitor|panel/i.test(t)) return false;

  // Reasonable size for PC case (3-15 inch)
  const sizeMatch = t.match(/(\d{1,2}(?:\.\d)?)\s*(?:inch|"|in)/i);
  if (sizeMatch) {
    const size = parseFloat(sizeMatch[1]);
    if (size > 15 || size < 3) return false;
  }

  return true;
}

function shouldExclude(title) {
  const t = title.toLowerCase();
  // Standalone portable monitors for laptops
  if (/portable monitor.*laptop|travel monitor|portable laptop monitor/i.test(t)) return true;
  // Phones/tablets/iPads
  if (/iphone|ipad|tablet|smartphone|samsung galaxy|surface pro/i.test(t)) return true;
  // Repair parts
  if (/replacement|digitizer|repair|spare part|broken|cracked/i.test(t)) return true;
  // Cars and embedded
  if (/dashboard|car |automotive|head unit|raspberry pi only/i.test(t)) return true;
  // Display cases (furniture)
  if (/display cabinet|adjustable shelves|bookcase|acrylic display case|collectibles/i.test(t)) return true;
  // Gaming MONITORS (separate category from internal)
  if (/curved monitor|ultrawide monitor|gaming monitor 24|gaming monitor 27/i.test(t)) return true;
  // Drawing tablets
  if (/drawing tablet|wacom|graphics tablet/i.test(t)) return true;
  return false;
}

function extractSize(title) {
  const m = title.match(/(\d{1,2}(?:\.\d)?)\s*[\-]?(?:inch|"|in)/i);
  if (m) return m[1] + '"';
  return null;
}

function extractResolution(title) {
  const m = title.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (m) return m[1] + 'x' + m[2];
  if (/1080p|full hd|fhd/i.test(title)) return '1920x1080';
  if (/720p|hd ready/i.test(title)) return '1280x720';
  return null;
}

function extractConnection(title) {
  const t = title.toLowerCase();
  if (/usb[ \-]?c/i.test(t) && /hdmi/i.test(t)) return 'USB-C/HDMI';
  if (/usb[ \-]?c/i.test(t)) return 'USB-C';
  if (/hdmi/i.test(t)) return 'HDMI';
  if (/usb/i.test(t)) return 'USB';
  return 'USB';
}

function extractPanelType(title) {
  if (/ips/i.test(title)) return 'IPS';
  if (/oled/i.test(title)) return 'OLED';
  if (/va\s/i.test(title)) return 'VA';
  return 'IPS';
}

function extractTouch(title) {
  return /touch|capacitive/i.test(title);
}

function extractBrand(title) {
  const brands = ['Lian Li','LIAN LI','Thermalright','THERMALRIGHT','ASUS','ROG','AsiaHorse','Asiahorse',
    'NZXT','Corsair','HYTE','Phanteks','MSI','Gigabyte','AORUS','DeepCool','Cooler Master',
    'WOWNOVA','Aoostar','AOOSTAR','UPERFECT','Hosyond','ELECROW','Waveshare','Eyoyo'];
  for (const b of brands) {
    if (title.toLowerCase().includes(b.toLowerCase())) return b.replace('LIAN LI', 'Lian Li').replace('THERMALRIGHT', 'Thermalright').replace('Asiahorse', 'AsiaHorse').replace('AOOSTAR', 'Aoostar');
  }
  return title.split(/[\s,]/)[0];
}

(async () => {
  console.log('Searching for PC-specific internal displays...\n');

  const tasks = [];
  for (const q of SEARCH_QUERIES) {
    const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
      method: 'POST',
      headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword: q, location_code: 2840, language_code: 'en_US', depth: 30 }])
    });
    const d = await post.json();
    const id = d.tasks?.[0]?.id;
    if (id) {
      tasks.push({ id, query: q });
      console.log('  Submitted: ' + q);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\nWaiting 60s for results...');
  await new Promise(r => setTimeout(r, 60000));

  const allResults = [];
  const pendingTasks = [...tasks];
  let attempt = 0;
  while (pendingTasks.length > 0 && attempt < 15) {
    attempt++;
    const stillPending = [];
    for (const t of pendingTasks) {
      try {
        const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_get/advanced/' + t.id, {
          headers: { 'Authorization': KEY }
        });
        const d = await res.json();
        const result = d?.tasks?.[0]?.result?.[0];
        if (result?.items) {
          for (const item of result.items) {
            if (item.title && item.data_asin) {
              allResults.push({
                title: item.title, asin: item.data_asin,
                price: item.price?.current || item.price_from || null,
                rating: item.rating?.value || null,
                reviewsCount: item.rating?.votes_count || 0,
                image: item.image_url || null,
              });
            }
          }
        } else if (d?.tasks?.[0]?.status_code === 20100) {
          stillPending.push(t);
        }
      } catch (e) { stillPending.push(t); }
    }
    pendingTasks.length = 0;
    pendingTasks.push(...stillPending);
    if (pendingTasks.length > 0) await new Promise(r => setTimeout(r, 20000));
  }

  // Get existing internal display ASINs to avoid dupes
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const existingAsins = new Set();
  (m.PARTS || m.default).forEach(p => {
    const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (asin) existingAsins.add(asin);
  });
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));

  // Dedupe + filter
  const seen = new Set();
  const dedup = allResults.filter(r => {
    if (!r.asin || seen.has(r.asin) || existingAsins.has(r.asin)) return false;
    seen.add(r.asin);
    return true;
  });

  const filtered = dedup.filter(r =>
    r.title && r.price && r.image && r.rating &&
    r.rating >= 4.0 && r.reviewsCount >= 10 &&
    r.price >= 25 && r.price <= 600 &&
    shouldInclude(r.title) && !shouldExclude(r.title)
  );

  console.log('\nRaw: ' + allResults.length + ', Dedup: ' + dedup.length + ', Filtered: ' + filtered.length);

  filtered.sort((a, b) => b.reviewsCount - a.reviewsCount);
  const top = filtered.slice(0, 15);

  console.log('\n═══ FINAL SELECTION ═══');
  top.forEach((r, i) => {
    console.log((i+1) + '. [' + r.asin + '] $' + r.price + ' ★' + r.rating + ' (' + r.reviewsCount + ')');
    console.log('   ' + r.title.substring(0, 80));
  });

  // Add to parts.js
  let nextId = 95040;
  while (existingIds.has(nextId)) nextId++;

  const entries = [];
  for (const r of top) {
    const id = nextId++;
    while (existingIds.has(nextId)) nextId++;
    const entry = {
      id,
      n: r.title.substring(0, 100),
      img: r.image,
      c: 'InternalDisplay',
      b: extractBrand(r.title),
      pr: Math.round(r.price),
      msrp: Math.round(r.price * 1.15),
      r: r.rating,
      reviews: r.reviewsCount,
      asin: r.asin,
      size: extractSize(r.title) || '5"',
      resolution: extractResolution(r.title) || '480x480',
      connection: extractConnection(r.title),
      panelType: extractPanelType(r.title),
      touch: extractTouch(r.title),
      deals: {
        amazon: {
          price: Math.round(r.price),
          url: 'https://www.amazon.com/dp/' + r.asin + '?tag=tiereduptech-20',
          inStock: true
        }
      }
    };
    entries.push(entry);
  }

  if (entries.length === 0) {
    console.log('\nNothing to add.');
    return;
  }

  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  const lastBracket = s.lastIndexOf(']');
  let pos = lastBracket - 1;
  while (pos > 0 && s[pos] !== '}') pos--;
  const insertPos = pos + 1;
  const insertText = ',\n' + entries.map(e =>
    '  ' + JSON.stringify(e, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')
  ).join(',\n');
  s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
  fs.writeFileSync(PARTS_PATH, s);

  console.log('\n✓ Added ' + entries.length + ' PC-specific internal displays');
})();
