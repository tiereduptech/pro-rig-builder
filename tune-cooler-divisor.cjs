const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `else if(MID_VALUE_CATS.has(p.c))divisor=Math.max(pr/25,1);`;
const neu = `else if(MID_VALUE_CATS.has(p.c))divisor=Math.max(pr/18,1);`;

if (!s.includes(old)) { console.log('FATAL: anchor missing'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ CPUCooler divisor /25 → /18 (stronger price weighting)');
