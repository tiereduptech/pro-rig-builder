// patch-value-formula.cjs
// Update the value/ratio formula in App.jsx to use category-aware price scale
// Accessories ($20-200) use a different divisor than CPUs/GPUs ($200-2000)

const fs = require('fs');
const PATH = 'src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

// Add a helper function near the existing helpers for category-aware value ratio
// Place it BEFORE line ~2559 where the formula is used

// First check what the current sort formula looks like
const sortFormula1 = `sk==="value"?(a.value!=null?a.value:(a.bench||0)/Math.max($(a)/100,1)):(a.bench||0)`;
const sortFormula2 = `sk==="value"?(b.value!=null?b.value:(b.bench||0)/Math.max($(b)/100,1)):(b.bench||0)`;

// New formula: divisor scales with typical price for the category
// Accessories: divide by max(price/15, 1) - so $30 mouse = price factor 2, $300 mouse = factor 20
// Components: keep existing /100 logic
const newSort1 = `sk==="value"?(a.value!=null?a.value:valueRatio(a)):(a.bench||0)`;
const newSort2 = `sk==="value"?(b.value!=null?b.value:valueRatio(b)):(b.bench||0)`;

if (!s.includes(sortFormula1)) { console.log('FATAL: sort formula 1 not found'); process.exit(1); }
if (!s.includes(sortFormula2)) { console.log('FATAL: sort formula 2 not found'); process.exit(1); }

s = s.replace(sortFormula1, newSort1);
s = s.replace(sortFormula2, newSort2);
console.log('✓ Updated sort formula (2 occurrences)');

// Update the table cell ratio formula
const cellOld = `const ratio=Math.round((p.bench/Math.max($(p)/100,1))*10)/10`;
const cellNew = `const ratio=Math.round(valueRatio(p)*10)/10`;
const cellOccurrences = (s.match(new RegExp(cellOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
console.log('Cell formula occurrences:', cellOccurrences);
s = s.split(cellOld).join(cellNew);
console.log('✓ Updated cell ratio formula (' + cellOccurrences + ' occurrences)');

// Now inject the valueRatio helper function. Place it right after the $ helper definition.
const anchorLine = `const $=p=>bestPrice(p);`;
const helperFn = `
const ACCESSORY_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CPUCooler","CaseFan","Monitor"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  // Accessories: smaller divisor since prices are lower ($20-200 typical)
  const divisor=ACCESSORY_CATS.has(p.c)?Math.max(pr/15,1):Math.max(pr/100,1);
  return b/divisor;
};
`;

if (!s.includes(anchorLine)) {
  // Try alt anchor
  const altAnchor = `const $ = p => bestPrice(p);`;
  if (!s.includes(altAnchor)) {
    console.log('FATAL: $ helper not found');
    console.log('Searching for bestPrice...');
    const idx = s.indexOf('bestPrice');
    if (idx > 0) console.log('Found bestPrice at index', idx, 'context:', s.substring(idx-100, idx+100));
    process.exit(1);
  }
  s = s.replace(altAnchor, altAnchor + helperFn);
} else {
  s = s.replace(anchorLine, anchorLine + helperFn);
}
console.log('✓ Injected valueRatio helper');

fs.writeFileSync(PATH, s);
console.log('\nDone. Run npm run build');
