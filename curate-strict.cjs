// curate-strict.cjs
// Strict automated cleanup:
// - Rating must be 4.0+
// - Brand must match an allowlist OR get labeled "Budget" or "Misc"
// - Category: title must contain category-defining keywords
// - Sub-accessories filtered out (boom arms, stands, mounts, replacement parts)

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/amazon-discovery';

// Brand allowlist per category (case-insensitive, word boundary match)
const BRANDS = {
  mouse: ['Logitech', 'Razer', 'SteelSeries', 'Corsair', 'HyperX', 'Glorious', 'Pulsar',
          'Endgame Gear', 'Zowie', 'BenQ', 'Roccat', 'Cooler Master', 'ASUS', 'ROG',
          'Keychron', 'Pwnage', 'Finalmouse', 'XTRFY', 'Lamzu', 'Redragon', 'VAXEE',
          'NinjaTrail', 'Microsoft', 'Apple'],
  keyboard: ['Logitech', 'Razer', 'Corsair', 'HyperX', 'SteelSeries', 'ASUS', 'ROG',
             'Keychron', 'Akko', 'GMMK', 'Drop', 'Ducky', 'Glorious', 'Redragon',
             'Cooler Master', 'Roccat', 'NuPhy', 'Epomaker', 'Wooting', 'Microsoft',
             'Apple', 'Logi'],
  headset: ['Logitech', 'Razer', 'SteelSeries', 'HyperX', 'Corsair', 'Sennheiser',
            'Audio-Technica', 'Beyerdynamic', 'Astro', 'Astro Gaming', 'Turtle Beach',
            'Bose', 'Sony', 'Drop', 'Cooler Master', 'EPOS', 'JBL', 'Apple'],
  microphone: ['Blue', 'Shure', 'Rode', 'RØDE', 'Elgato', 'Audio-Technica', 'HyperX',
               'Razer', 'Logitech', 'Beyerdynamic', 'Sennheiser', 'AKG', 'Samson',
               'MAONO', 'FIFINE', 'TONOR', 'Yamaha'],
  webcam: ['Logitech', 'Razer', 'Microsoft', 'Elgato', 'Insta360', 'Anker', 'Opal',
           'Aukey', 'AVerMedia', 'OBSBOT', 'EMEET', 'Papalook', 'NexiGo'],
  mousepad: ['SteelSeries', 'Logitech', 'Razer', 'Corsair', 'Glorious', 'HyperX',
             'Pulsar', 'Artisan', 'Cooler Master', 'BenQ', 'Zowie', 'Endgame Gear',
             'Roccat', 'Lethal Gaming', 'XTRFY'],
  extensioncables: ['CableMod', 'Corsair', 'EVGA', 'Lian Li', 'Thermaltake', 'AsiaHorse',
                    'StarTech.com', 'Cable Matters', 'Phanteks', 'NZXT', 'be quiet!',
                    'Antec', 'Seasonic', 'Cooler Master'],
};

// Category keyword requirements - title MUST contain at least one
const CATEGORY_KEYWORDS = {
  mouse: [/\bmouse\b/i, /\bdeathadder\b/i, /\bbasilisk\b/i, /\bviper\b/i],
  keyboard: [/\bkeyboard\b/i, /\bkeypad\b/i],
  headset: [/\bheadset\b/i, /\bheadphone/i, /\bgaming\s+audio\b/i],
  microphone: [/\bmicrophone\b/i, /\bmic\b/i, /\byeti\b/i, /\bsm7b\b/i, /\bsm58\b/i, /\bsnowball\b/i, /\bquadcast\b/i],
  webcam: [/\bwebcam\b/i, /\bweb\s*camera\b/i],
  mousepad: [/\bmouse\s*pad\b/i, /\bmousepad\b/i, /\bdesk\s*mat\b/i, /\bgaming\s*surface\b/i, /\bqck\b/i],
  extensioncables: [/\bcable\b/i, /\briser\b/i, /\bextension\b/i, /\badapter\b/i, /\b12vhpwr\b/i],
};

// Disqualifying keywords - any of these in the title rejects the product
const NEGATIVE_KEYWORDS = {
  mouse: [/mouse\s*pad/i, /mousepad/i, /\bmat\b/i, /bungee/i, /trap/i, /\btrap\b/i, /\bglue\b/i],
  keyboard: [/keycap/i, /key\s*cap/i, /switch tester/i, /\blube\b/i, /stabilizer/i, /\bcase only\b/i, /palm\s*rest/i],
  headset: [/headset stand/i, /\bstand for\b/i, /\bholder\b/i, /\breplacement\b/i, /ear pads?$/i, /cushion/i, /splitter/i],
  microphone: [/mic stand/i, /mic\s+arm/i, /pop\s+filter/i, /shock\s*mount/i, /windscreen/i, /\bboom\s+arm\b/i, /\bisolation\s+shield\b/i, /xlr\s+cable/i],
  webcam: [/webcam cover/i, /privacy cover/i, /ring light/i, /\bmount\b/i, /\btripod\b/i],
  mousepad: [/keyboard/i, /wrist\s*rest/i, /\bbungee\b/i, /coaster/i],
  extensioncables: [/usb\s*cable/i, /charging cable/i, /\bhdmi\b/i, /\bdisplayport\b/i, /\bethernet\b/i, /audio cable/i, /aux cable/i],
};

function detectBrand(title, allowedBrands) {
  if (!title) return null;
  // Try each allowed brand, longest first to prefer "Endgame Gear" over "Endgame"
  const sorted = [...allowedBrands].sort((a, b) => b.length - a.length);
  for (const brand of sorted) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(title)) {
      // Normalize: return brand exactly as in allowlist
      return brand;
    }
  }
  return null;
}

function passesCategory(title, category) {
  const required = CATEGORY_KEYWORDS[category] || [];
  if (required.length === 0) return true;
  return required.some(re => re.test(title));
}

function isNegative(title, category) {
  const negs = NEGATIVE_KEYWORDS[category] || [];
  return negs.some(re => re.test(title));
}

// Determine "Budget" vs "Misc" for unbranded products
function fallbackBrand(price) {
  if (price && price < 30) return 'Budget';
  return 'Misc';
}

function aggressiveDedupKey(item) {
  const brand = (item.brand || '').toLowerCase();
  const cleanTitle = (item.title || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '')
    .replace(/[,\-:|—–_]/g, ' ')
    .replace(/\d+\s*(dpi|hz|mm|hours|gb|mb|inch|oz|g\b|grams|w\b|watts)/gi, '')
    .replace(/\b(gaming|wireless|wired|usb|rgb|black|white|red|blue|with|the|new|2024|2025|2026|edition|bluetooth|optical|laser|mechanical|membrane|switches|keys|premium|pro|elite|essential|programmable|tactile|linear|ergonomic|customizable|low\s+profile|ultralight|ultra\s*lightweight|hot\s*swappable|by)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w))
    .slice(0, 4)
    .join(' ');
  return brand + '|' + cleanTitle;
}

const categories = ['mouse', 'keyboard', 'headset', 'microphone', 'webcam', 'mousepad', 'extensioncables'];

console.log('═══ STRICT CLEANUP ═══\n');

let grandTotal = 0;
for (const cat of categories) {
  const inputPath = path.join(INPUT_DIR, 'curated-' + cat + '.json');
  if (!fs.existsSync(inputPath)) {
    console.log(cat + ': SKIP (file missing)');
    continue;
  }

  const initial = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const allowedBrands = BRANDS[cat] || [];

  const stats = { initial: initial.length, rating: 0, category: 0, negative: 0, dupes: 0, kept: 0, branded: 0, budget: 0, misc: 0 };

  // Stage 1: rating + category + negative filter
  let items = initial.filter(item => {
    if ((item.rating || 0) < 4.0) { stats.rating++; return false; }
    if (!passesCategory(item.title, cat)) { stats.category++; return false; }
    if (isNegative(item.title, cat)) { stats.negative++; return false; }
    return true;
  });

  // Stage 2: brand assignment (allowlist first, fallback to Budget/Misc)
  for (const item of items) {
    const detected = detectBrand(item.title, allowedBrands);
    if (detected) {
      item.brand = detected;
      stats.branded++;
    } else {
      item.brand = fallbackBrand(item.price);
      if (item.brand === 'Budget') stats.budget++;
      else stats.misc++;
    }
  }

  // Stage 3: aggressive dedupe
  const seen = new Map();
  for (const item of items) {
    const key = aggressiveDedupKey(item);
    const existing = seen.get(key);
    if (!existing || (item._score || 0) > (existing._score || 0)) {
      if (existing) stats.dupes++;
      seen.set(key, item);
    } else {
      stats.dupes++;
    }
  }
  items = [...seen.values()];

  stats.kept = items.length;
  grandTotal += items.length;

  // Write back
  fs.writeFileSync(inputPath, JSON.stringify(items, null, 2));

  console.log(cat.toUpperCase());
  console.log('  initial:' + stats.initial + ' | rejected: rating=' + stats.rating + ' wrong-cat=' + stats.category + ' negative=' + stats.negative + ' dupes=' + stats.dupes);
  console.log('  kept: ' + stats.kept + ' (branded=' + stats.branded + ', Budget=' + stats.budget + ', Misc=' + stats.misc + ')');
  console.log('  Top 5 with brand:');
  items.slice(0, 5).forEach((p, i) => {
    console.log('    ' + (i+1) + '. ' + p.brand.padEnd(15) + ' | $' + (p.price+'').padEnd(7) + ' | ' + p.rating + '★ ' + (p.reviews+'').padEnd(7) + ' | ' + p.title.substring(0, 60));
  });
  console.log('');
}

console.log('═══ TOTAL: ' + grandTotal + ' curated products ═══');
