// merge-bb-accessories-v3.cjs
// Hybrid matching: try model number first, fall back to first 3 distinctive tokens
// Lowest BB price wins. Dedupe new entries.

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

const MODEL_PATTERNS = [
  /\b(G\s*\d{3,4}[A-Z]*)\b/,
  /\b(M\s*\d{3,4})\b/,
  /\b(MX\s*\w+)\b/i,
  /\b(K\s*\d{2,3})\b/,
  /\b(H\s*\d{3,4})\b/,
  /\b(C\s*\d{3,4}[a-z]?)\b/,
  /\b(ATH-?\w+)\b/i,
  /\b(DT\s*\d{3,4})\b/i,
  /\b(MDR-?\w+)\b/i,
  /\b(HD\s*\d{3,4})\b/i,
  /\b(WH-\w+)\b/i,
  /\b(SM-?\d{2,3}[A-Z]?)\b/i,
  /\b(MV\s*\d)\b/i,
  /\b(AT\s*\d{4})\b/i,
  /\b(NT-?\w+)\b/i,
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
  /\b(Cynosa\s*\w*)\b/i,
  /\b(Ornata\s*\w*)\b/i,
  /\b(Tartarus\s*\w*)\b/i,
  /\b(Mamba\s*\w*)\b/i,
  /\b(Stealth\s*\d+)\b/i,
  /\b(Recon\s*\d+)\b/i,
  /\b(Strider\s*\w*)\b/i,
  /\b(Gigantus\s*\w*)\b/i,
  /\b(Sphex\s*\w*)\b/i,
  /\b(MM\s*\d{3,4})\b/i,
  /\b(HS\s*\d+)\b/i,
  /\b(Void\s*\w*)\b/i,
  /\b(Virtuoso\s*\w*)\b/i,
  /\b(Wave\s*\d?)\b/i,
];

function extractModel(name) {
  if (!name) return null;
  for (const pattern of MODEL_PATTERNS) {
    const m = name.match(pattern);
    if (m) return m[1].replace(/\s+/g, '').toUpperCase();
  }
  return null;
}

// Token-based fallback: get 3 most distinctive tokens after stripping noise
function tokenFallbackKey(name) {
  const cleaned = (name || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '')
    .replace(/[,\-:|—–_]/g, ' ')
    .replace(/\d+\s*(dpi|hz|mm|hours|gb|mb|inch|oz|g\b|grams|w\b|watts|ohm|khz|button|buttons|programmable)/gi, ' ')
    .replace(/\b(gaming|wireless|wired|usb|usb-c|rgb|black|white|red|blue|silver|gray|grey|with|the|new|2024|2025|2026|edition|bluetooth|optical|laser|mechanical|membrane|switches|keys|premium|pro|elite|essential|programmable|tactile|linear|ergonomic|customizable|ultra|ultralight|ultra-light|button|buttons|key|keys|hot-swappable|by|for|sensor|hero|chroma|backlit|backlighting|aimo|omron)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w)).slice(0, 3);
  return tokens.join(' ');
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

function makeMatchKeys(brand, name) {
  const keys = [];
  const model = extractModel(name);
  if (model) keys.push('m:' + brand.toLowerCase() + '|' + model);
  const tokenKey = tokenFallbackKey(name);
  if (tokenKey.length > 3) keys.push('t:' + brand.toLowerCase() + '|' + tokenKey);
  return keys;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  console.log('Loaded ' + parts.length + ' existing parts');

  const accessoryParts = parts.filter(p => BB_CATEGORIES.includes(p.c));
  console.log('Existing accessories: ' + accessoryParts.length);

  // Index existing accessories by ALL their keys (model + token fallback)
  const matchIndex = new Map();
  for (const p of accessoryParts) {
    const keys = makeMatchKeys(p.b || '', p.n || '');
    for (const k of keys) {
      if (!matchIndex.has(k)) matchIndex.set(k, p);
    }
  }
  console.log('Index size: ' + matchIndex.size);

  const matchedBbByPartId = new Map(); // id → best BB (lowest price)
  const newEntriesByKey = new Map();   // key → best BB (lowest price)

  for (const cat of BB_CATEGORIES) {
    const inputPath = path.join(INPUT_DIR, cat + '.json');
    if (!fs.existsSync(inputPath)) continue;

    const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    let stats = { total: items.length, eligible: 0, matched: 0, newBranded: 0, skipped: 0 };

    const allowed = BRANDS_BY_CAT[cat] || [];
    const minReviews = MIN_REVIEWS[cat] || 30;

    for (const bb of items) {
      if (!bb.rating || bb.rating < 4.0) { stats.skipped++; continue; }
      if (!bb.reviews || bb.reviews < minReviews) { stats.skipped++; continue; }
      if (!bb.url || !bb.price) { stats.skipped++; continue; }
      if (bb.condition && bb.condition !== 'new') { stats.skipped++; continue; }

      stats.eligible++;

      const detectedBrand = detectBrand(bb.name, bb.manufacturer, allowed);
      if (!detectedBrand) { stats.skipped++; continue; }

      const bbKeys = makeMatchKeys(detectedBrand, bb.name);
      if (bbKeys.length === 0) { stats.skipped++; continue; }

      // Try each key in order (model match > token match)
      let matched = null;
      for (const k of bbKeys) {
        if (matchIndex.has(k)) { matched = matchIndex.get(k); break; }
      }

      if (matched) {
        const existing = matchedBbByPartId.get(matched.id);
        if (!existing || bb.price < existing.bb.price) {
          matchedBbByPartId.set(matched.id, { matched, bb });
        }
        stats.matched++;
      } else {
        // No match → new entry; key by primary (model-first) so we don't dupe
        const primaryKey = bbKeys[0];
        const ne = newEntriesByKey.get(primaryKey);
        if (!ne || bb.price < ne.bb.price) {
          newEntriesByKey.set(primaryKey, { bb, brand: detectedBrand, cat });
        }
        stats.newBranded++;
      }
    }

    console.log(cat.padEnd(12) + ' BB:' + stats.total + ' eligible:' + stats.eligible + ' matched:' + stats.matched + ' newBranded:' + stats.newBranded + ' skipped:' + stats.skipped);
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
  console.log('Unique matches:     ' + updates.length);
  console.log('Unique new entries: ' + newEntries.length);

  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-merge-bb.json'), JSON.stringify(updates, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-import-bb.json'), JSON.stringify(newEntries, null, 2));
  console.log('\nFiles updated. Review then run apply step.');
})();
