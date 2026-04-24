const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// The bare sidebar div in BuilerPartPicker is preceded by the comment "{/* Sidebar filters */}"
// Unique anchor:
const oldAnchor = `      {/* Sidebar filters */}
      <div>
        <FG label="PRICE RANGE" open={true}>`;

const newAnchor = `      {/* Sidebar filters */}
      <div className="builder-picker-sidebar">
        <FG label="PRICE RANGE" open={true}>`;

if (!s.includes(oldAnchor)) {
  console.log('ANCHOR MISS');
  process.exit(1);
}

const cnt = s.split(oldAnchor).length - 1;
console.log('Found ' + cnt + ' match(es)');

s = s.replace(oldAnchor, newAnchor);
console.log('✓ Added className to sidebar div');

// Also add simpler CSS rule
const marker = '/* === MOBILE FIX 6: builder part picker mobile layout === */';
const markerIdx = s.indexOf(marker);
if (markerIdx < 0) {
  console.log('CSS marker not found');
  process.exit(1);
}

// Append a new stronger rule right before MOBILE FIX 6 block
const newCSS = `/* === MOBILE FIX 8: direct sidebar hide === */
@media (max-width: 900px) {
  .builder-picker-sidebar {
    display: none !important;
  }
}

`;

if (!s.includes('/* === MOBILE FIX 8:')) {
  s = s.substring(0, markerIdx) + newCSS + s.substring(markerIdx);
  console.log('✓ Added MOBILE FIX 8 CSS');
} else {
  console.log('MOBILE FIX 8 already present');
}

fs.writeFileSync(p, s);
console.log('DONE');
