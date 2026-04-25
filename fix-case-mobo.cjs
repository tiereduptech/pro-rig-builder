const fs = require('fs');
const p = 'score-case-bench.cjs';
let s = fs.readFileSync(p, 'utf8');

const old = `const mobo = (p.mobo || '').toLowerCase();`;
const neu = `const mobo = (Array.isArray(p.mobo) ? p.mobo.join(',') : (p.mobo || '')).toLowerCase();`;

if (!s.includes(old)) { console.log('FATAL'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Fixed scoreCase to handle array mobo values');
