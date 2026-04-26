const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

// Find all "driver": "50mm" patterns and convert to "driver": 50
const before = s.length;
s = s.replace(/"driver":\s*"(\d+)mm"/g, '"driver": $1');
console.log('Length change:', s.length - before);

const remaining = s.match(/"driver":\s*"\d+mm"/g);
console.log('Remaining string drivers:', remaining ? remaining.length : 0);

const numeric = s.match(/"driver":\s*\d+/g);
console.log('Numeric drivers:', numeric ? numeric.length : 0);

fs.writeFileSync(PARTS_PATH, s);
console.log('✓ Fixed driver values to numeric');
