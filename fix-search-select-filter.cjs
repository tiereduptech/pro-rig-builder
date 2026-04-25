const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const oldFilter = 'const filtered=query?options.filter(o=>o.label.toLowerCase().includes(query.toLowerCase())):options;';
const newFilter = 'const filtered=query?options.filter(o=>{const tokens=query.toLowerCase().split(/[\\s\\-,\\/\\(\\)]+/).filter(Boolean);const blob=(o.label+" "+(o.detail||"")).toLowerCase();return tokens.every(t=>blob.includes(t));}):options;';

if (!s.includes(oldFilter)) {
  console.log('ANCHOR MISS - searching for old filter pattern');
  process.exit(1);
}

s = s.replace(oldFilter, newFilter);
fs.writeFileSync(p, s);
console.log('FIXED: SearchSelect now uses token-based filter');
