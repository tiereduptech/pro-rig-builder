const fs = require('fs');
const path = 'src/App.jsx';
let src = fs.readFileSync(path, 'utf8');

let changes = 0;

// 1. Row container: center -> stretch (equal-height columns)
const rowOld = '<div style={{display:"flex",alignItems:"center",gap:14,marginTop:10}}>';
const rowNew = '<div style={{display:"flex",alignItems:"stretch",gap:14,marginTop:10}}>';
if (src.includes(rowOld)) { src = src.replace(rowOld, rowNew); changes++; }
else { console.log('WARN: row container not found (already changed?)'); }

// 2 & 3. Both card divs use the SAME style string — make them fill their column.
//    style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px"}}
const cardOld = 'style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px"}}>';
const cardNew = 'style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px",width:"100%",boxSizing:"border-box"}}>';
// there are exactly TWO of these (Value Score + Future-Proofing). Replace both.
let count = 0;
while (src.includes(cardOld)) {
  src = src.replace(cardOld, cardNew);
  count++;
  if (count > 10) { console.log('FAIL: runaway replace'); process.exit(1); }
}
changes += count;
console.log('Card-div replacements: ' + count + ' (expected 2)');
if (count !== 2) {
  console.log('WARN: expected exactly 2 card divs, got ' + count + ' — review before building.');
}

fs.writeFileSync(path, src, 'utf8');
console.log('✓ Done. Total changes: ' + changes + '. Cards now stretch to equal height.');
