// fetch-internal-displays.cjs
// Searches Amazon via DataForSEO for case-mounted internal displays
// Filters out monitors, tablets, screen replacements, etc.
// Adds verified products with real ASINs to parts.js

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

// Search queries targeting internal/case-mounted displays
const SEARCH_QUERIES = [
  'PC case lcd display',
  'AIDA64 sensor panel ips',
  'mini hdmi monitor 5 inch',
  'mini hdmi monitor 7 inch',
  'mini hdmi monitor 8 inch',
  'usb c portable display 5 inch',
  'stretched bar display ips',
  'aoostar case display',
  'waveshare 7 inch ips touch',
  'computer case secondary screen',
];

// Filter rules - INCLUDE
function shouldInclude(title) {
  const t = title.toLowerCase();
  // Must mention display/screen/monitor/lcd/ips
  if (!/display|screen|monitor|lcd|ips|panel/i.test(t)) return false;
  // Must be small enough for case use (under 15 inches)
  const sizeMatch = t.match(/(\d{1,2}(?:\.\d)?)[ \-]?inch/i);
  if (sizeMatch) {
    const size = parseFloat(sizeMatch[1]);
    if (size > 15) return false; // too big for case
    if (size < 3) return false;  // too small to be useful
  }
  // EXCLUDE patterns
  if (/replacement|laptop screen|phone screen|tablet|ipad|samsung galaxy|lg gram|dell precision|macbook|smartphone/i.test(t)) return false;
  if (/digitizer|repair part|broken|cracked|spare/i.test(t)) return false;
  if (/projector|tv |television|smart tv/i.test(t)) return false;
  if (/dashboard|car|vehicle|automotive|head unit/i.test(t)) return false;
  if (/microscope|magnifier|babycare/i.test(t)) return false;
  if (/gaming monitor 24|gaming monitor 27|gaming monitor 32/i.test(t)) return false;
  if (/curved monitor|ultrawide monitor/i.test(t)) return false;
  return true;
}

function extractSize(title) {
  const m = title.match(/(\d{1,2}(?:\.\d)?)[ \-]?inch|(\d{1,2}(?:\.\d)?)["]/i);
  if (m) return (m[1] || m[2]) + '"';
  return null;
}

function extractResolution(title) {
  // Look for common resolutions: 1920x1080, 1024x600, 800x480, 480x320, etc.
  const m = title.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);
  if (m) return m[1] + 'x' + m[2];
  // Common patterns
  if (/1080p|full hd|fhd/i.test(title)) return '1920x1080';
  if (/720p|hd ready/i.test(title)) return '1280x720';
  return null;
}

function extractConnection(title) {
  const t = title.toLowerCase();
  if (/usb[ \-]?c/i.test(t) && /hdmi/i.test(t)) return 'USB-C/HDMI';
  if (/usb[ \-]?c/i.test(t)) return 'USB-C';
  if (/hdmi/i.test(t)) return 'HDMI';
  if (/displayport|dp port/i.test(t)) return 'DisplayPort';
  if (/usb/i.test(t)) return 'USB';
  return null;
}

function extractPanelType(title) {
  const t = title.toLowerCase();
  if (/ips/i.test(t)) return 'IPS';
  if (/oled/i.test(t)) return 'OLED';
  if (/tn/i.test(t) && /panel/i.test(t)) return 'TN';
  if (/va panel|va display/i.test(t)) return 'VA';
  return 'IPS'; // default for small displays (most common)
}

function extractTouch(title) {
  return /touch|capacitive/i.test(title);
}

function extractBrand(title) {
  // Common brand patterns at start of title
  const brands = ['HYTE', 'Aoostar', 'AOOSTAR', 'WIMAXIT', 'wimaxit', 'Eyoyo', 'EYOYO', 'INNOCN', 'Innocn',
    'Waveshare', 'WAVESHARE', 'ELECROW', 'Elecrow', 'MINISFORUM', 'Minisforum',
    'GeChic', 'Lepow', 'KYY', 'ASUS', 'LG', 'AOC', 'Dell',
    'Pimoroni', 'Adafruit', 'SunFounder', 'Raspberry Pi', 'UPERFECT',
    'KENOWA', 'GAEMS', 'Kuman', 'OSOYOO', 'XGODY', 'AURRA', 'Pluxxo'];
  for (const b of brands) {
    if (title.toUpperCase().startsWith(b.toUpperCase())) return b.replace('AOOSTAR', 'Aoostar').replace('WIMAXIT', 'WIMAXIT');
  }
  // Fallback - take first word if it's capitalized
  const firstWord = title.split(/[\s,]/)[0];
  if (/^[A-Z]/.test(firstWord) && firstWord.length >= 3) return firstWord;
  return 'Generic';
}

(async () => {
  console.log('Searching Amazon for internal displays via DataForSEO...\n');

  // Submit all search queries
  const tasks = [];
  for (const q of SEARCH_QUERIES) {
    const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
      method: 'POST',
      headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword: q,
        location_code: 2840,
        language_code: 'en_US',
        depth: 30,
      }])
    });
    const d = await post.json();
    const id = d.tasks?.[0]?.id;
    if (id) {
      tasks.push({ id, query: q });
      console.log('  Submitted: ' + q);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('\nSubmitted ' + tasks.length + ' searches. Waiting 60s...');
  await new Promise(r => setTimeout(r, 60000));

  // Fetch results - poll up to 5 min
  const allResults = [];
  const pendingTasks = [...tasks];
  let attempt = 0;
  while (pendingTasks.length > 0 && attempt < 20) {
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
            if (item.type === 'amazon_product' || item.title) {
              allResults.push({
                title: item.title || '',
                asin: item.data_asin || item.asin,
                price: item.price?.current || item.price_from || null,
                rating: item.rating?.value || item.rating_value || null,
                reviewsCount: item.rating?.votes_count || item.rating_count || 0,
                image: item.image_url || (item.images && item.images[0]) || null,
                query: t.query
              });
            }
          }
        } else if (d?.tasks?.[0]?.status_code === 20000) {
          // No results
        } else {
          stillPending.push(t);
        }
      } catch (e) { stillPending.push(t); }
    }
    console.log('  attempt ' + attempt + ': ready=' + (pendingTasks.length - stillPending.length) + ' / pending=' + stillPending.length);
    pendingTasks.length = 0;
    pendingTasks.push(...stillPending);
    if (pendingTasks.length > 0) await new Promise(r => setTimeout(r, 20000));
  }

  console.log('\nTotal raw results: ' + allResults.length);

  // Dedupe by ASIN
  const seenAsins = new Set();
  const dedup = [];
  for (const r of allResults) {
    if (!r.asin || seenAsins.has(r.asin)) continue;
    seenAsins.add(r.asin);
    dedup.push(r);
  }
  console.log('After dedup: ' + dedup.length);

  // Filter
  const filtered = dedup.filter(r => shouldInclude(r.title));
  console.log('After include filter: ' + filtered.length);

  // Filter again - require minimum quality (50+ reviews, 4.0+ rating)
  const quality = filtered.filter(r =>
    r.rating && r.rating >= 3.8 &&
    r.reviewsCount >= 30 &&
    r.price && r.price >= 20 && r.price <= 500 &&
    r.image
  );
  console.log('After quality filter: ' + quality.length);

  // Sort by review count desc to get most popular first
  quality.sort((a, b) => b.reviewsCount - a.reviewsCount);

  // Take top 20
  const final = quality.slice(0, 20);

  console.log('\n═══ FINAL SELECTION (' + final.length + ' products) ═══\n');
  final.forEach((r, i) => {
    console.log((i + 1) + '. [' + r.asin + '] $' + r.price + ' ★' + r.rating + ' (' + r.reviewsCount + ')');
    console.log('   ' + r.title.substring(0, 80));
  });

  // Convert to catalog entries
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));
  let nextId = 95000;
  while (existingIds.has(nextId)) nextId++;

  const newEntries = [];
  for (const r of final) {
    const id = nextId++;
    while (existingIds.has(nextId)) nextId++;

    const entry = {
      id,
      n: r.title.substring(0, 100), // truncate long titles
      img: r.image,
      c: 'InternalDisplay',
      b: extractBrand(r.title),
      pr: Math.round(r.price),
      msrp: Math.round(r.price * 1.15),
      r: r.rating,
      reviews: r.reviewsCount,
      asin: r.asin,
      size: extractSize(r.title) || '5"',
      resolution: extractResolution(r.title) || '800x480',
      connection: extractConnection(r.title) || 'HDMI',
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
    newEntries.push(entry);
  }

  if (newEntries.length === 0) {
    console.log('\nNo products to add.');
    return;
  }

  // Insert into parts.js
  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  const lastBracket = s.lastIndexOf(']');
  let pos = lastBracket - 1;
  while (pos > 0 && s[pos] !== '}') pos--;
  const insertPos = pos + 1;
  const insertText = ',\n' + newEntries.map(e =>
    '  ' + JSON.stringify(e, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')
  ).join(',\n');
  s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
  fs.writeFileSync(PARTS_PATH, s);

  console.log('\n✓ Added ' + newEntries.length + ' Internal Display products to parts.js');
  console.log('  ID range: ' + newEntries[0].id + ' - ' + newEntries[newEntries.length - 1].id);
  console.log('\nNext: npm run build, then test on /search?cat=InternalDisplay');
})();
