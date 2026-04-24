const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');

const oldLine = '<div className="browse-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>';
const newLine = '<div className="browse-layout" style={{gap:16,alignItems:"start"}}>';
if (!s.includes(oldLine)) { console.log('JSX ANCHOR MISS'); process.exit(1); }
s = s.replace(oldLine, newLine);
console.log('JSX OK: stripped display+grid from inline');

s = s.replace(/\r\n/g, '\n');
const oldCSS = `/* === MOBILE FIX 5: browse page mobile layout === */
@media (max-width: 900px) {
  .browse-layout {`;
const newCSS = `/* === MOBILE FIX 5: browse page mobile layout === */
.browse-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
}
@media (max-width: 900px) {
  .browse-layout {`;
if (!s.includes(oldCSS)) { console.log('CSS ANCHOR MISS'); process.exit(1); }
s = s.replace(oldCSS, newCSS);
console.log('CSS OK: desktop layout now owned by class');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
