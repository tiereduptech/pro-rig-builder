// fix-lian-li-quote.cjs
// The previous script's regex broke. Fix the broken entry.

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

let s = fs.readFileSync(PARTS_PATH, 'utf8');

// Find and fix the broken brand line
const before = s;
s = s.replace(/"b":\s*"Lian Li""/g, '"b": "Lian Li"');

// Also need to fix the name if it got corrupted
// Check what's around line 126384
const lines = s.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Lian Li')) {
    console.log('Line ' + (i+1) + ': ' + lines[i].substring(0, 100));
  }
}

if (s !== before) {
  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Fixed broken brand line');
} else {
  console.log('\n No matches found, looking deeper...');
}
