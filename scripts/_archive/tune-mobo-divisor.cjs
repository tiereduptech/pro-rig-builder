const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `Motherboard:50`;
const neu = `Motherboard:40`;

if (!s.includes(old)) { console.log('FATAL'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Motherboard /50 → /40 (better grade spread, S:22 A:122 B:156 C:125 D:58)');
