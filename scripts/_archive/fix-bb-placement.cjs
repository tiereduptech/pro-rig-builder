// fix-bb-placement.cjs
// Bug: previous apply added "bestbuy": {...} as top-level field instead of inside deals.{}
// This script moves them into deals.bestbuy

const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

// Find every entry that has both `"deals":` and a top-level `"bestbuy":`
// Pattern: starts at the entry's opening `{`, ends at the closing `}`

let count = 0;

// Use a more careful approach: walk entries one at a time
// parts.js is structured as: [\n  { entry1 },\n  { entry2 },\n ... ];

// Find all entries and process them
// Iterate until no more fixes needed
let iterations = 0;
while (iterations < 1000) {
  iterations++;

  // Find a top-level "bestbuy": { in entries that also have "deals":
  // We look for the pattern: deals: {amazon: {...}}, "bestbuy": {...}
  // OR: deals: {}, "bestbuy": {...}
  // After deals object closes, before entry closes

  // Match: "deals": {...},\n  "bestbuy": {...}
  // We need a regex that doesn't run away to other entries

  const re = /("deals":\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*,?\s*\n?\s*"bestbuy":\s*(\{[^{}]*\})/;
  const m = s.match(re);
  if (!m) break;

  const dealsBlock = m[1];
  const bestbuyValue = m[2];

  // Insert bestbuy into deals: replace the closing } of deals with ", "bestbuy": {...}}"
  // Find last } of dealsBlock
  const newDeals = dealsBlock.replace(/\}$/, ', "bestbuy": ' + bestbuyValue + '}');

  // Replace in s: dealsBlock, ?, bestbuy: ... → newDeals
  const fullMatch = m[0];
  s = s.replace(fullMatch, newDeals);
  count++;
}

console.log('Iterations: ' + iterations);
console.log('Fixes applied: ' + count);

if (count > 0) {
  fs.writeFileSync(PARTS_PATH, s);
  console.log('✓ parts.js updated');
} else {
  console.log('Nothing to fix');
}
