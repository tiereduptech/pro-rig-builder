const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = 'const filtered=query?options.filter(o=>{const tokens=query.toLowerCase().split(/[\\s\\-,\\/\\(\\)]+/).filter(Boolean);const blob=(o.label+" "+(o.detail||"")).toLowerCase();return tokens.every(t=>blob.includes(t));}):options;';

const neu = 'const filtered=query?options.filter(o=>{const q=query.toLowerCase();const blob=(o.label+" "+(o.detail||"")).toLowerCase();const blobNoSpace=blob.replace(/\\s+/g,"");const tokens=q.split(/[\\s\\-,\\/\\(\\)]+/).filter(Boolean);if(tokens.every(t=>blob.includes(t)||blobNoSpace.includes(t)))return true;const qNoSpace=q.replace(/[\\s\\-,\\/\\(\\)]+/g,"");return qNoSpace.length>=3&&blobNoSpace.includes(qNoSpace);}):options;';

if (!s.includes(old)) {
  console.log('MISS - filter anchor not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('Fixed: SearchSelect now matches space-stripped queries');
console.log('  "rtx4070ti" matches "RTX 4070 Ti" via blobNoSpace fallback');
console.log('  "rtx 4070ti" matches via per-token blob.includes OR blobNoSpace.includes');
