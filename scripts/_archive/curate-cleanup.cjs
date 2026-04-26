// curate-cleanup.cjs - second pass: extract brand from title, fix categorization, tighter dedupe

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/amazon-discovery';

// Known brands by category (helps both detection and categorization)
const BRAND_LIST = [
  'Logitech', 'Razer', 'SteelSeries', 'Corsair', 'HyperX', 'Glorious', 'Pulsar',
  'Endgame Gear', 'Endgame', 'Zowie', 'BenQ', 'Roccat', 'Cooler Master', 'ASUS',
  'ASUS ROG', 'Razer', 'Keychron', 'Akko', 'Drop', 'GMMK', 'Ducky',
  'Sennheiser', 'Audio-Technica', 'Beyerdynamic', 'Blue', 'Shure', 'Rode',
  'Elgato', 'Astro', 'Astro Gaming', 'Turtle Beach', 'Bose', 'Sony',
  'Insta360', 'Anker', 'Opal', 'Aukey', 'Microsoft', 'AVerMedia', 'OBSBOT',
  'CableMod', 'Lian Li', 'Thermaltake', 'Phanteks', 'be quiet!', 'NZXT',
  'Razer Kiyo', 'Lyra', 'XTRFY', 'Pwnage', 'Finalmouse', 'NinjaTrail',
  'Artisan', 'Inland', 'Generic', 'WD', 'Samsung', 'Kingston', 'Crucial',
];

// Keywords that indicate a product is NOT actually in the claimed category
const CATEGORY_BAD_KEYWORDS = {
  mouse: [/mouse\s*pad/i, /mousepad/i, /desk\s*mat/i, /\bpad\b/i, /\bmat\b/i],
  keyboard: [/key cap/i, /keycap/i, /switch tester/i],
  headset: [/headset stand/i, /\bstand\s+for\b/i, /\bholder\b/i],
  microphone: [/mic stand/i, /mic\s+arm/i, /pop filter/i, /\bshock\s*mount\b/i, /windscreen/i],
  webcam: [/webcam cover/i, /privacy cover/i, /\bring light\b/i, /\bmount\b/i, /\btripod\b/i],
  mousepad: [/keyboard/i, /wrist\s+rest/i, /\bbungee\b/i],
  extensioncables: [/usb cable/i, /charging cable/i, /\bhdmi\b/i, /\bdisplayport\b/i],
};

function extractBrand(title) {
  if (!title) return null;
  for (const brand of BRAND_LIST) {
    const re = new RegExp('\\b' + brand.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&') + '\\b', 'i');
    if (re.test(title)) return brand;
  }
  // Fallback: first word
  const firstWord = title.split(/\s+/)[0];
  if (firstWord && firstWord.length > 1 && /^[A-Z]/.test(firstWord)) {
    return firstWord;
  }
  return null;
}

function isMiscategorized(item, category) {
  const bads = CATEGORY_BAD_KEYWORDS[category] || [];
  for (const re of bads) {
    if (re.test(item.title)) return true;
  }
  return false;
}

function makeAggressiveDedupKey(item) {
  // Brand + first 3 model words, after stripping all formatting
  const brand = (item.brand || '').toLowerCase();
  const cleanTitle = (item.title || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '')
    .replace(/[,\-:|—–_]/g, ' ')
    .replace(/\d+\s*(dpi|hz|mm|hours|gb|mb|inch|oz|g\b|grams)/gi, '')
    .replace(/\b(gaming|wireless|wired|usb|rgb|black|white|red|blue|with|the|new|2024|2025|2026|edition|bluetooth|optical|laser|mechanical|membrane|switches|keys|matte|brand|premium|pro|elite|tournament|esports|essential|low\s+profile|programmable|customizable|tactile|linear|hot\s*swappable)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w))
    .slice(0, 3)
    .join(' ');
  return brand + '|' + cleanTitle;
}

const categories = ['mouse', 'keyboard', 'headset', 'microphone', 'webcam', 'mousepad', 'extensioncables'];

console.log('═══ CLEANUP PASS ═══');

for (const cat of categories) {
  const inputPath = path.join(INPUT_DIR, 'curated-' + cat + '.json');
  if (!fs.existsSync(inputPath)) continue;

  let items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const initial = items.length;

  // Stage 1: extract brand if missing
  for (const item of items) {
    if (!item.brand) item.brand = extractBrand(item.title);
  }

  // Stage 2: filter out miscategorized
  items = items.filter(i => !isMiscategorized(i, cat));
  const afterMiscat = items.length;

  // Stage 3: aggressive dedupe
  const seen = new Map();
  for (const item of items) {
    const key = makeAggressiveDedupKey(item);
    const existing = seen.get(key);
    if (!existing || (item._score || 0) > (existing._score || 0)) {
      seen.set(key, item);
    }
  }
  items = [...seen.values()];
  const afterDedup = items.length;

  fs.writeFileSync(inputPath, JSON.stringify(items, null, 2));

  console.log('\n' + cat.toUpperCase());
  console.log('  initial: ' + initial + ' → after miscategorization filter: ' + afterMiscat + ' → after aggressive dedupe: ' + afterDedup);
  // Show first 5
  console.log('  Top 5:');
  items.slice(0, 5).forEach((p, i) => {
    console.log('    ' + (i+1) + '. ' + (p.brand || '???').padEnd(15) + ' | $' + (p.price+'').padEnd(7) + ' | ' + p.rating + '★ ' + (p.reviews+'').padEnd(7) + ' | ' + p.title.substring(0, 60));
  });
}

console.log('\nDONE - cleaned curated-*.json files');
