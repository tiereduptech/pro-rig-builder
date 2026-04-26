const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

const before = s;
s = s.replace(
  '"n": "8.8\\" Universal Screen for PC',
  '"n": "Lian Li 8.8\\" Universal Screen for PC'
);

if (s === before) {
  console.log('No match found - try alternate pattern');
  s = s.replace(
    '"n": "8.8" Universal Screen',
    '"n": "Lian Li 8.8" Universal Screen'
  );
}

if (s !== before) {
  fs.writeFileSync(PARTS_PATH, s);
  console.log('✓ Updated name to prefix "Lian Li"');
} else {
  console.log('⚠ No replacement made');
}
