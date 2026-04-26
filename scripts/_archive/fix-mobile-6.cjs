const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');

// Remove display:"grid" from the home-main-grid div's inline style — let CSS own layout
const oldLine = '<div className="home-main-grid" style={{maxWidth:1200,margin:"0 auto",padding:"56px 32px 48px",display:"grid",gap:32,alignItems:"start"}}>';
const newLine = '<div className="home-main-grid" style={{maxWidth:1200,margin:"0 auto",gap:32,alignItems:"start"}}>';

if (!s.includes(oldLine)) { console.log('ANCHOR MISS'); process.exit(1); }
s = s.replace(oldLine, newLine);
console.log('OK: stripped inline display+padding from home-main-grid');

// Now make the CSS class own the desktop layout too
s = s.replace(/\r\n/g, '\n');
const oldCSS = `.home-main-grid {
  grid-template-columns: 1fr 340px;
}`;
const newCSS = `.home-main-grid {
  display: grid;
  grid-template-columns: 1fr 340px;
  padding: 56px 32px 48px;
}`;
if (!s.includes(oldCSS)) { console.log('CSS ANCHOR MISS'); process.exit(1); }
s = s.replace(oldCSS, newCSS);
console.log('OK: CSS now owns display + padding');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
