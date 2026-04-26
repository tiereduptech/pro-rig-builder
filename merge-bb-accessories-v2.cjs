// merge-bb-accessories-v2.cjs
// Improved matching: extract model number (G305, ATH-M50X, K70, C920) instead of fuzzy-token match
// Lowest BB price wins for matched products. Dedupe new entries.

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/bestbuy-discovery';
const OUTPUT_DIR = './catalog-build/bestbuy-discovery';

const BB_CATEGORIES = ['Mouse', 'Keyboard', 'Headset', 'Microphone', 'Webcam', 'MousePad'];

const MIN_REVIEWS = {
  Mouse: 30, Keyboard: 30, Headset: 30, Microphone: 20, Webcam: 20, MousePad: 30,
};

const BRANDS_BY_CAT = {
  Mouse: ['Logitech', 'Razer', 'SteelSeries', 'Corsair', 'HyperX', 'Glorious', 'Pulsar',
          'Endgame Gear', 'Zowie', 'Roccat', 'Cooler Master', 'ASUS', 'Microsoft', 'Apple',
          'Redragon', 'Pwnage', 'XTRFY', 'Lamzu'],
  Keyboard: ['Logitech', 'Razer', 'Corsair', 'HyperX', 'SteelSeries', 'ASUS',
             'Keychron', 'Akko', 'GMMK', 'Drop', 'Ducky', 'Glorious', 'Redragon',
             'Cooler Master', 'Roccat', 'NuPhy', 'Epomaker', 'Wooting', 'Microsoft', 'Apple'],
  Headset: ['Logitech', 'Razer', 'SteelSeries', 'HyperX', 'Corsair', 'Sennheiser',
            'Audio-Technica', 'Beyerdynamic', 'Astro', 'Astro Gaming', 'Turtle Beach',
            'Bose', 'Sony', 'Drop', 'Cooler Master', 'EPOS', 'JBL', 'Apple'],
  Microphone: ['Blue', 'Shure', 'Rode', 'RØDE', 'Elgato', 'Audio-Technica', 'HyperX',
               'Razer', 'Logitech', 'Beyerdynamic', 'Sennheiser', 'AKG', 'Samson',
               'MAONO', 'FIFINE', 'TONOR', 'Yamaha'],
  Webcam: ['Logitech', 'Razer', 'Microsoft', 'Elgato', 'Insta360', 'Anker', 'Opal',
           'Aukey', 'AVerMedia', 'OBSBOT', 'EMEET', 'Papalook', 'NexiGo'],
  MousePad: ['SteelSeries', 'Logitech', 'Razer', 'Corsair', 'Glorious', 'HyperX',
             'Pulsar', 'Artisan', 'Cooler Master', 'BenQ', 'Zowie', 'Endgame Gear',
             'Roccat', 'XTRFY'],
};

// Model number patterns - capture the unique product identifier
const MODEL_PATTERNS = [
  /\b(G\s*\d{3,4})\b/i,           // Logitech G203, G305, G502, G915, etc.
  /\b(M\s*\d{3,4})\b/i,           // Logitech M510, M325
  /\b(MX\s*\w+)\b/i,              // Logitech MX Master, MX Anywhere, MX Keys
  /\b(K\s*\d{2,3})\b/i,           // Corsair K70, K100; Logitech K480
  /\b(H\s*\d{3,4})\b/i,           // Logitech H600, H800
  /\b(C\s*\d{3,4}[a-z]?)\b/i,     // Logitech C920, C922, C925e
  /\b(ATH-?\w+)\b/i,              // Audio-Technica ATH-M50X
  /\b(DT\s*\d{3,4})\b/i,          // Beyerdynamic DT 770, DT 990
  /\b(MDR-?\w+)\b/i,              // Sony MDR-7506
  /\b(HD\s*\d{3,4})\b/i,          // Sennheiser HD 600, HD 560S
  /\b(WH-\w+)\b/i,                // Sony WH-1000XM5
  /\b(SM-?\d{2,3})\b/i,           // Shure SM7B, SM58
  /\b(MV\s*\d)\b/i,               // Shure MV7
  /\b(AT\s*\d{4})\b/i,            // Audio-Technica AT2020
  /\b(NT-?\w+)\b/i,                // Rode NT-USB
  /\b(Cloud\s*(?:I{1,3}|\d|Stinger|Flight|Mix|Alpha|Revolver|Core|Earbuds))\b/i,
  /\b(Arctis\s*\w+)\b/i,
  /\b(BlackShark\s*\w+)\b/i,
  /\b(Kraken\s*\w+)\b/i,
  /\b(BlackWidow\s*\w+)\b/i,
  /\b(Huntsman\s*\w*)\b/i,
  /\b(DeathAdder\s*\w*)\b/i,
  /\b(Basilisk\s*\w*)\b/i,
  /\b(Viper\s*\w*)\b/i,
  /\b(Naga\s*\w*)\b/i,
  /\b(Apex\s*\w+)\b/i,
  /\b(QcK\s*\w*)\b/i,
  /\b(Goliathus\s*\w*)\b/i,
  /\b(Yeti\s*\w*)\b/i,
  /\b(Snowball\s*\w*)\b/i,
  /\b(QuadCast\s*\w*)\b/i,
  /\b(Brio\s*\w*)\b/i,
  /\b(Kiyo\s*\w*)\b/i,
  /\b(Facecam)\b/i,
  /\b(Aerox\s*\d?)\b/i,
  /\b(Rival\s*\d+)\b/i,
];

function extractModel(name) {
  if (!name) return null;
  for (const pattern of MODEL_PATTERNS) {
    const m = name.match(pattern);
    if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  }
  return null;
}

function detectBrand(name, manufacturer, allowed) {
  if (manufacturer) {
    const sortedManu = [...allowed].sort((a, b) => b.length - a.length);
    for (const b of sortedManu) {
      if (manufacturer.toLowerCase() === b.toLowerCase()) return b;
    }
    for (const b of sortedManu) {
      if (manufacturer.toLowerCase().includes(b.toLowerCase())) return b;
    }
  }
  const sorted = [...allowed].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&') + '\\b', 'i');
    if (re.test(name)) return b;
  }
  return null;
}

// Match key: brand + model (e.g. "logitech|G305")
function makeMatchKey(brand, name) {
  const model = extractModel(name);
  if (!model) return null; // No model = can't reliably match
  return brand.toLowerCase() + '|' + model;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  console.log('Loaded ' + parts.length + ' existing parts');

  const accessoryParts = parts.filter(p => BB_CATEGORIES.includes(p.c));
  console.log('Existing accessories: ' + accessoryParts.length);

  // Build match index from existing accessories: brand|model → part
  const matchIndex = new Map();
  let indexedAccessories = 0;
  for (const p of accessoryParts) {
    const key = makeMatchKey(p.b || '', p.n || '');
    if (key) {
      // First-write wins; collisions get logged
      if (!matchIndex.has(key)) {
        matchIndex.set(key, p);
        indexedAccessories++;
      }
    }
  }
  console.log('Indexed accessories with model: ' + indexedAccessories + ' (rest unmatchable)');

  // Track BB matches per existing part - keep lowest price
  const matchedBbByPartId = new Map(); // id → best BB candidate

  // Track new entries per match key to dedupe within new set
  const newEntriesByKey = new Map();

  let totalBb = 0, totalEligible = 0, totalNoModel = 0;

  for (const cat of BB_CATEGORIES) {
    const inputPath = path.join(INPUT_DIR, cat + '.json');
    if (!fs.existsSync(inputPath)) continue;

    const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    let bbStats = { total: items.length, eligible: 0, matched: 0, newBranded: 0, newBudget: 0, skipped: 0, noModel: 0 };

    const allowed = BRANDS_BY_CAT[cat] || [];
    const minReviews = MIN_REVIEWS[cat] || 30;

    for (const bb of items) {
      if (!bb.rating || bb.rating < 4.0) { bbStats.skipped++; continue; }
      if (!bb.reviews || bb.reviews < minReviews) { bbStats.skipped++; continue; }
      if (!bb.url || !bb.price) { bbStats.skipped++; continue; }
      if (bb.condition && bb.condition !== 'new') { bbStats.skipped++; continue; }

      bbStats.eligible++;

      const detectedBrand = detectBrand(bb.name, bb.manufacturer, allowed);
      if (!detectedBrand) { bbStats.skipped++; continue; }

      const key = makeMatchKey(detectedBrand, bb.name);
      if (!key) { bbStats.noModel++; bbStats.skipped++; continue; }

      const matched = matchIndex.get(key);
      if (matched) {
        // Match - track lowest price
        const existing = matchedBbByPartId.get(matched.id);
        if (!existing || bb.price < existing.bb.price) {
          matchedBbByPartId.set(matched.id, { matched, bb });
        }
        bbStats.matched++;
      } else {
        // No match in existing parts.js - track for new entry
        const ne = newEntriesByKey.get(key);
        if (!ne || bb.price < ne.bb.price) {
          newEntriesByKey.set(key, { bb, brand: detectedBrand, cat });
        }
        bbStats.newBranded++;
      }
    }

    console.log(cat.padEnd(12) + ' BB:' + bbStats.total + ' eligible:' + bbStats.eligible + ' matched:' + bbStats.matched + ' newBranded:' + bbStats.newBranded + ' skipped:' + bbStats.skipped + ' (noModel:' + bbStats.noModel + ')');
    totalBb += bbStats.total;
    totalEligible += bbStats.eligible;
    totalNoModel += bbStats.noModel;
  }

  // Build final outputs
  const updates = [];
  for (const [id, { matched, bb }] of matchedBbByPartId) {
    updates.push({
      id,
      name: matched.n.substring(0, 60),
      bbPrice: bb.price,
      bbUrl: bb.url,
      bbInStock: bb.stockAvailability === 'InStock',
    });
  }

  let maxId = Math.max(...parts.map(p => p.id || 0));
  const newEntries = [];
  for (const [key, { bb, brand, cat }] of newEntriesByKey) {
    newEntries.push({
      id: ++maxId,
      n: (bb.name || '').substring(0, 200),
      img: bb.imageUrl || '',
      c: cat,
      b: brand,
      pr: Math.round(bb.price || 0),
      msrp: Math.round(bb.originalPrice || bb.price || 0),
      r: bb.rating,
      deals: {
        bestbuy: {
          url: bb.url,
          price: bb.price,
          inStock: bb.stockAvailability === 'InStock',
        },
      },
    });
  }

  console.log('\n═══ SUMMARY ═══');
  console.log('Total BB products:    ' + totalBb);
  console.log('Eligible:             ' + totalEligible);
  console.log('No-model skips:       ' + totalNoModel);
  console.log('Unique matches:       ' + updates.length + '  (existing parts.js entries getting deals.bestbuy)');
  console.log('Unique new entries:   ' + newEntries.length + '  (BB-only branded products to add)');

  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-merge-bb.json'), JSON.stringify(updates, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-import-bb.json'), JSON.stringify(newEntries, null, 2));
  console.log('\n_to-merge-bb.json + _to-import-bb.json written. Review then run apply step.');
})();
