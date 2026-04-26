const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = 'sampleRate:v=>v+"kHz"';
const neu = 'sampleRate:v=>v===0?"Analog":v+"kHz"';

if (!s.includes(old)) { console.log('FATAL: anchor missing'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Fixed: XLR mics (sampleRate=0) now display "Analog" instead of "0kHz"');
