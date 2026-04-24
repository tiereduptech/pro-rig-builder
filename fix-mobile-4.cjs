const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

// Find MOBILE FIX 3 block (could be either version — use marker search)
const startMark = '/* === MOBILE FIX 3: home main grid === */';
const endMark = '/* === MOBILE FIX 2 ===';
const startIdx = s.indexOf(startMark);
const endIdx = s.indexOf(endMark, startIdx);
if (startIdx < 0 || endIdx < 0) { console.log('MARKER MISS'); process.exit(1); }

const newCSS = `/* === MOBILE FIX 3: home main grid === */
.home-main-grid {
  grid-template-columns: 1fr 340px;
}
@media (max-width: 900px) {
  .home-main-grid {
    display: block !important;
    padding: 24px 12px !important;
    max-width: 100vw !important;
    box-sizing: border-box !important;
  }
  .home-main-grid > div {
    width: 100% !important;
    max-width: 100% !important;
    margin-bottom: 24px !important;
    box-sizing: border-box !important;
    min-width: 0 !important;
  }
  .home-main-grid > div:last-child {
    position: static !important;
    top: auto !important;
  }
  .home-cat-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 8px !important;
    width: 100% !important;
    max-width: 100% !important;
  }
  .home-cat-grid > button,
  .home-main-grid button {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    overflow: hidden !important;
  }
  .home-main-grid img {
    max-width: 100% !important;
    height: auto !important;
  }
}
html, body, #root {
  overflow-x: hidden !important;
  max-width: 100vw !important;
  box-sizing: border-box !important;
}

`;

const oldBlock = s.substring(startIdx, endIdx);
s = s.replace(oldBlock, newCSS);
fs.writeFileSync('src/App.jsx', s);
console.log('DONE: nuclear mobile CSS applied (block layout, forced widths)');
