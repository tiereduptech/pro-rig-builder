const fs = require('fs');
const p = 'enrich-from-dataforseo.cjs';
let s = fs.readFileSync(p, 'utf8');

const before = s.length;
s = s.replace(/\/merchant\/amazon\/asin_info\//g, '/merchant/amazon/asin/');

console.log('Length change:', s.length - before);
console.log('Replaced asin_info → asin in endpoint URLs');

fs.writeFileSync(p, s);
console.log('✓ Fixed');
