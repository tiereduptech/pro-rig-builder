const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

// STEP 1: Add className to browse page layout wrapper (line ~2018)
const oldLayout = '<div style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>';
const newLayout = '<div className="browse-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>';

// Only replace the FIRST occurrence (browse page, not builder)
const idx = s.indexOf(oldLayout);
if (idx < 0) { console.log('STEP 1 ANCHOR MISS'); process.exit(1); }
s = s.substring(0, idx) + newLayout + s.substring(idx + oldLayout.length);
console.log('STEP 1 OK: browse-layout class added');

// STEP 2: Append CSS rules before MOBILE FIX 4 block
const marker = '/* === MOBILE FIX 4: repeat(4,...) grids collapse to 2-col on mobile === */';
const markerIdx = s.indexOf(marker);
if (markerIdx < 0) { console.log('STEP 2 MARKER MISS'); process.exit(1); }

const mobileCSS = `/* === MOBILE FIX 5: browse page mobile layout === */
@media (max-width: 900px) {
  .browse-layout {
    grid-template-columns: 1fr !important;
    padding: 8px 12px !important;
    max-width: 100vw !important;
  }
  .browse-layout > div:first-of-type {
    display: none !important;
  }
  .browse-layout > div:last-of-type {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }
  /* Product table rows and header - stack as vertical cards */
  [style*="60px 80px 70px"] {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    padding: 12px !important;
    gap: 4px !important;
  }
  [style*="60px 80px 70px"] > * {
    width: 100% !important;
    text-align: left !important;
    min-width: 0;
  }
  /* Hide the spec column headers on mobile (the 4fr 1fr 1fr... bar) */
  [style*="border-bottom: 2px solid"][style*="60px 80px 70px"] {
    display: none !important;
  }
}

`;

s = s.substring(0, markerIdx) + mobileCSS + s.substring(markerIdx);
console.log('STEP 2 OK: browse mobile CSS added');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
