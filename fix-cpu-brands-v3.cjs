const fs = require('fs');

const p = 'src/data/parts.js';
let s = fs.readFileSync(p, 'utf8');

// The 3 non-CPU items (bundles/PCs) that showed as brands on /browse CPU filter
const ids = [10140, 10142, 10152];

let count = 0;
const missed = [];

for (const id of ids) {
  const marker = `"id": ${id},`;
  const idx = s.indexOf(marker);
  if (idx < 0) {
    missed.push(id);
    continue;
  }

  // Find the newline right after this id line
  const lineEnd = s.indexOf('\n', idx);
  if (lineEnd < 0) {
    missed.push(id);
    continue;
  }

  // Insert new fields on separate lines right after the id line
  // Leading 4 spaces to match file indentation
  const insertion = '    "needsReview": true,\n    "bundle": true,\n';

  // Check if already patched (idempotent)
  const after = s.substring(lineEnd, lineEnd + 200);
  if (after.includes('"needsReview": true')) {
    console.log(`id ${id}: already patched, skipping`);
    continue;
  }

  // Insert right after the newline that follows the id line
  s = s.substring(0, lineEnd + 1) + insertion + s.substring(lineEnd + 1);
  count++;
  console.log(`id ${id}: patched`);
}

if (missed.length > 0) {
  console.log('MISSED ids:', missed);
}

fs.writeFileSync(p, s);
console.log(`\nTotal patched: ${count}`);
