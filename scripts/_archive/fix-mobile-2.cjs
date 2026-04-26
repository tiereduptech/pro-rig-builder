const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');

// Add className to the Core Components 3-col grid so we can target it in CSS
const oldGrid = 'e.jsx("div",{style:{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}';
// we want to match the JSX source, not the built bundle. Look for the JSX pattern:
const jsxOld = '<div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>';
const jsxNew = '<div className="home-cat-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>';

if (!s.includes(jsxOld)) {
  console.log('STEP A ANCHOR MISS');
  process.exit(1);
}
s = s.replace(jsxOld, jsxNew);
console.log('STEP A OK: added home-cat-grid className');

// Extend MOBILE FIX 3 block to also handle padding + inner category grid
const oldCSS = `/* === MOBILE FIX 3: home main grid === */
.home-main-grid {
  grid-template-columns: 1fr 340px;
}
@media (max-width: 900px) {
  .home-main-grid {
    grid-template-columns: 1fr !important;
  }
  .home-main-grid > div:last-child {
    position: static !important;
  }
}`;

const newCSS = `/* === MOBILE FIX 3: home main grid === */
.home-main-grid {
  grid-template-columns: 1fr 340px;
}
@media (max-width: 900px) {
  .home-main-grid {
    grid-template-columns: 1fr !important;
    padding: 32px 16px 32px !important;
  }
  .home-main-grid > div:last-child {
    position: static !important;
  }
  .home-cat-grid {
    grid-template-columns: repeat(2, 1fr) !important;
  }
}
/* Global safety: never allow horizontal scroll */
html, body { overflow-x: hidden; max-width: 100vw; }`;

if (!s.includes(oldCSS)) {
  console.log('STEP B ANCHOR MISS');
  process.exit(1);
}
s = s.replace(oldCSS, newCSS);
console.log('STEP B OK: responsive padding + 2-col mobile grid + overflow safety');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
