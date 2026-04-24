const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

const oldCSS = `/* === MOBILE FIX 3: home main grid === */
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

const newCSS = `/* === MOBILE FIX 3: home main grid === */
.home-main-grid {
  grid-template-columns: 1fr 340px;
}
@media (max-width: 900px) {
  .home-main-grid {
    grid-template-columns: 1fr !important;
    padding: 32px 12px 32px !important;
  }
  .home-main-grid > * {
    min-width: 0;
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  .home-main-grid > div:last-child {
    position: static !important;
    width: 100% !important;
  }
  .home-cat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .home-cat-grid > * {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  /* Long product names in sidebar cards must not push width */
  .home-main-grid button {
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
}
/* Global safety: never allow horizontal scroll */
html, body { overflow-x: hidden; max-width: 100vw; }
body * { max-width: 100vw; }`;

if (!s.includes(oldCSS)) { console.log('ANCHOR MISS'); process.exit(1); }
s = s.replace(oldCSS, newCSS);
fs.writeFileSync('src/App.jsx', s);
console.log('DONE: added minmax(0,1fr), min-width:0, global max-width safety');
