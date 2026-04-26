// curate-accessories.js
// Reads catalog-build/amazon-discovery/*.json
// Filters + ranks + dedupes
// Outputs catalog-build/amazon-discovery/curated-{category}.json

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/amazon-discovery';

// Per-category settings: how many to keep, min rating, min reviews
const CATEGORY_RULES = {
  mouse:           { keep: 40, minRating: 4.0, minReviews: 200, minPrice: 15, maxPrice: 250 },
  keyboard:        { keep: 40, minRating: 4.0, minReviews: 100, minPrice: 25, maxPrice: 400 },
  headset:         { keep: 40, minRating: 4.0, minReviews: 100, minPrice: 30, maxPrice: 700 },
  microphone:      { keep: 30, minRating: 4.2, minReviews: 100, minPrice: 30, maxPrice: 500 },
  webcam:          { keep: 25, minRating: 4.0, minReviews: 100, minPrice: 25, maxPrice: 500 },
  mousepad:        { keep: 25, minRating: 4.3, minReviews: 200, minPrice: 8,  maxPrice: 100 },
  extensioncables: { keep: 25, minRating: 4.2, minReviews: 50,  minPrice: 5,  maxPrice: 200 },
};

// Score function: balances rating, review volume, and signals
function scoreItem(item) {
  let score = 0;
  // Rating impact (max ~100 for 5.0 rating)
  score += (item.rating || 0) * 20;
  // Review volume (log scale - 1000 reviews = ~30 pts, 10000 = ~40 pts)
  score += Math.log10(Math.max(1, item.reviews || 0)) * 10;
  // Best Seller / Amazon's Choice bonuses
  if (item.isBestSeller) score += 25;
  if (item.isAmazonChoice) score += 15;
  // Recent purchase volume
  if (item.boughtPastMonth) score += Math.min(20, (item.boughtPastMonth || 0) / 50);
  return score;
}

// Detect very-similar duplicates (same brand + similar title)
function makeDedupKey(item) {
  // Use first 4 substantive title words + brand
  const cleanTitle = (item.title || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '') // strip parenthetical content
    .replace(/[,\-:|—–]/g, ' ')
    .replace(/\b(gaming|wireless|wired|usb|rgb|black|white|red|blue|with|the|new|2024|2025|2026|edition|bluetooth)\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .slice(0, 4)
    .join(' ');
  return ((item.brand || '') + '|' + cleanTitle).toLowerCase();
}

function curateCategory(category, rules) {
  const inputPath = path.join(INPUT_DIR, category + '.json');
  if (!fs.existsSync(inputPath)) {
    console.log('  SKIP ' + category + ' (file missing)');
    return null;
  }

  const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  console.log('\n' + category.toUpperCase() + ':');
  console.log('  Raw: ' + items.length);

  // Stage 1: hard filters
  let filtered = items.filter(i => {
    if (!i.asin || !i.title || !i.amazonUrl) return false;
    if ((i.rating || 0) < rules.minRating) return false;
    if ((i.reviews || 0) < rules.minReviews) return false;
    const price = Number(i.price);
    if (!price || price < rules.minPrice || price > rules.maxPrice) return false;
    return true;
  });
  console.log('  After hard filters: ' + filtered.length);

  // Stage 2: dedupe by asin (paranoid, shouldn't be needed)
  const byAsin = new Map();
  for (const i of filtered) {
    if (!byAsin.has(i.asin)) byAsin.set(i.asin, i);
  }
  filtered = [...byAsin.values()];
  console.log('  After ASIN dedupe: ' + filtered.length);

  // Stage 3: dedupe by brand + similar title
  const byTitleKey = new Map();
  for (const i of filtered) {
    const key = makeDedupKey(i);
    const existing = byTitleKey.get(key);
    if (!existing || scoreItem(i) > scoreItem(existing)) {
      byTitleKey.set(key, i);
    }
  }
  filtered = [...byTitleKey.values()];
  console.log('  After title dedupe: ' + filtered.length);

  // Stage 4: rank by score, take top N
  filtered.sort((a, b) => scoreItem(b) - scoreItem(a));
  const top = filtered.slice(0, rules.keep);
  console.log('  Final (top ' + rules.keep + '): ' + top.length);

  // Add score for visibility in output
  for (const i of top) i._score = Math.round(scoreItem(i));

  // Write curated file
  const outputPath = path.join(INPUT_DIR, 'curated-' + category + '.json');
  fs.writeFileSync(outputPath, JSON.stringify(top, null, 2));
  console.log('  → ' + outputPath);

  return { category, count: top.length, sample: top.slice(0, 3).map(i => i.title.substring(0, 80)) };
}

// Run
console.log('═══ ACCESSORY CURATION ═══');
const results = [];
for (const [cat, rules] of Object.entries(CATEGORY_RULES)) {
  const r = curateCategory(cat, rules);
  if (r) results.push(r);
}

console.log('\n═══ SUMMARY ═══');
let total = 0;
for (const r of results) {
  console.log('  ' + r.category.padEnd(20) + ' ' + r.count + ' products');
  total += r.count;
}
console.log('  TOTAL: ' + total + ' curated products');
console.log('\nReview each curated-*.json file before importing into parts.js');
