const fs = require('fs');
const s = fs.readFileSync('src/data/parts.js', 'utf8');

const allBestbuy = (s.match(/"bestbuy":\s*\{/g) || []).length;
console.log('Total "bestbuy": { occurrences:', allBestbuy);

const insideDeals = (s.match(/"deals":\s*\{[^}]*"bestbuy":/g) || []).length;
console.log('Inside deals object (correct):', insideDeals);

const topLevel = allBestbuy - insideDeals;
console.log('Top-level (incorrect):', topLevel);

// Find one example
const idx = s.search(/\}\s*,?\s*\n?\s*"bestbuy":/);
if (idx > 0) {
  console.log('\n=== Example unfixed placement ===');
  console.log(s.substring(Math.max(0, idx - 200), idx + 300));
}
