// merge-bb-accessories.cjs
// 1. Reads BB accessory discovery files
// 2. For each BB product (4+ stars only), tries to match existing parts.js entry by manufacturer + model
// 3. Match: adds deals.bestbuy.{url, price, inStock} to existing entry
// 4. No match: adds as new BB-only entry (with strict curation: brand allowlist, dedupe, etc.)
// 5. Outputs _to-import-bb.json + _to-merge-bb.json for review

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/bestbuy-discovery';
const OUTPUT_DIR = './catalog-build/bestbuy-discovery';

const BB_CATEGORIES = ['Mouse', 'Keyboard', 'Headset', 'Microphone', 'Webcam', 'MousePad'];

// Min reviews per category - filter out low-volume noise
const MIN_REVIEWS = {
  Mouse: 30, Keyboard: 30, Headset: 30, Microphone: 20, Webcam: 20, MousePad: 30,
};

// Brand allowlist (for unmatched products only)
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

function fallbackBrand(price) {
  return (price && price < 30) ? 'Budget' : 'Misc';
}

function detectBrand(name, manufacturer, allowed) {
  // First try BB's manufacturer field (already pre-cleaned)
  if (manufacturer) {
    for (const b of allowed) {
      if (manufacturer.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(manufacturer.toLowerCase())) {
        return b;
      }
    }
  }
  // Then try name
  const sorted = [...allowed].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&') + '\\b', 'i');
    if (re.test(name)) return b;
  }
  return null;
}

// Normalize a product name for matching - strip punctuation, brand, common adjectives
function normalizeForMatch(name) {
  return (name || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '') // parenthetical
    .replace(/[,\-:|—–_]/g, ' ')
    .replace(/\d+\s*(dpi|hz|mm|hours|gb|mb|inch|oz|g\b|grams|w\b|watts|ohm|khz)/gi, ' ')
    .replace(/\b(gaming|wireless|wired|usb|usb-c|rgb|black|white|red|blue|silver|gray|grey|with|the|new|2024|2025|2026|edition|bluetooth|optical|laser|mechanical|membrane|switches|keys|premium|pro|elite|essential|programmable|tactile|linear|ergonomic|customizable|low\s+profile|ultralight|ultra\s*lightweight|hot\s*swappable|by|for)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a match key from manufacturer + the 3-4 most distinctive words of the name
function makeMatchKey(item) {
  const brand = (item.brand || item.manufacturer || '').toLowerCase().trim();
  const tokens = normalizeForMatch(item.name || item.n || '').split(/\s+/).filter(w => w.length > 1 && !/^\d+$/.test(w)).slice(0, 4);
  return brand + '|' + tokens.join(' ');
}

(async () => {
  // Load existing parts.js
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  console.log('Loaded ' + parts.length + ' existing parts');

  // Build match index from existing accessories
  const accessoryParts = parts.filter(p => BB_CATEGORIES.includes(p.c));
  console.log('Existing accessories: ' + accessoryParts.length);

  const matchIndex = new Map();
  for (const p of accessoryParts) {
    const key = makeMatchKey(p);
    if (key.length > 5) matchIndex.set(key, p);
  }
  console.log('Built match index: ' + matchIndex.size + ' keys\n');

  // Track existing parts.js entries by id so we can update them
  const partsById = new Map(parts.map(p => [p.id, p]));
  let maxId = Math.max(...parts.map(p => p.id || 0));

  const updates = []; // {id, deals.bestbuy added}
  const newEntries = []; // products to add to parts.js

  let totalBb = 0, totalEligible = 0, totalMatched = 0, totalNewBranded = 0, totalNewBudget = 0, totalSkipped = 0;

  for (const cat of BB_CATEGORIES) {
    const inputPath = path.join(INPUT_DIR, cat + '.json');
    if (!fs.existsSync(inputPath)) { console.log('SKIP ' + cat + ' (file missing)'); continue; }

    const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    let bbStats = { total: items.length, eligible: 0, matched: 0, newBranded: 0, newBudget: 0, skipped: 0 };

    const allowed = BRANDS_BY_CAT[cat] || [];
    const minReviews = MIN_REVIEWS[cat] || 30;

    for (const bb of items) {
      // Filter: 4+ stars, min reviews
      if (!bb.rating || bb.rating < 4.0) { bbStats.skipped++; continue; }
      if (!bb.reviews || bb.reviews < minReviews) { bbStats.skipped++; continue; }
      if (!bb.url || !bb.price) { bbStats.skipped++; continue; }
      if (bb.condition && bb.condition !== 'new') { bbStats.skipped++; continue; }

      bbStats.eligible++;

      // Try to match existing parts.js entry
      const bbKey = makeMatchKey(bb);
      const matched = matchIndex.get(bbKey);

      if (matched) {
        // Update existing entry: add deals.bestbuy
        if (!matched.deals) matched.deals = {};
        matched.deals.bestbuy = {
          url: bb.url,
          price: bb.price,
          inStock: bb.stockAvailability === 'InStock',
        };
        updates.push({ id: matched.id, name: matched.n.substring(0, 60), bbPrice: bb.price });
        bbStats.matched++;
      } else {
        // No match - decide if we add it
        const detectedBrand = detectBrand(bb.name, bb.manufacturer, allowed);
        if (detectedBrand) {
          // Branded - add as new entry
          newEntries.push({
            id: ++maxId,
            n: (bb.name || '').substring(0, 200),
            img: bb.imageUrl || '',
            c: cat,
            b: detectedBrand,
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
          // Add to match index so we don't dupe in same run
          matchIndex.set(makeMatchKey({ ...bb, brand: detectedBrand, n: bb.name }), newEntries[newEntries.length - 1]);
          bbStats.newBranded++;
        } else {
          // No allowlisted brand - skip (don't pollute catalog with Budget/Misc from BB)
          bbStats.skipped++;
        }
      }
    }

    console.log(cat.padEnd(12) + ' BB:' + bbStats.total + ' eligible(4★+):' + bbStats.eligible + ' → matched:' + bbStats.matched + ' new(branded):' + bbStats.newBranded + ' skipped:' + bbStats.skipped);
    totalBb += bbStats.total;
    totalEligible += bbStats.eligible;
    totalMatched += bbStats.matched;
    totalNewBranded += bbStats.newBranded;
    totalSkipped += bbStats.skipped;
  }

  console.log('\n═══ SUMMARY ═══');
  console.log('Total BB products:    ' + totalBb);
  console.log('Eligible (4+ stars):  ' + totalEligible);
  console.log('Matched (dual-price): ' + totalMatched);
  console.log('New branded entries:  ' + totalNewBranded);
  console.log('Skipped:              ' + totalSkipped);

  // Write outputs
  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-merge-bb.json'), JSON.stringify(updates, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, '_to-import-bb.json'), JSON.stringify(newEntries, null, 2));

  console.log('\nFiles written:');
  console.log('  _to-merge-bb.json   (' + updates.length + ' existing entries to add deals.bestbuy)');
  console.log('  _to-import-bb.json  (' + newEntries.length + ' new BB-only entries to add)');
  console.log('\nReview before running merge step.');
})();
