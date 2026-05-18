const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// --- locate the two lines (search windows survive small shifts) ---
let starIdx = -1, barIdx = -1;
for (let i = 3375; i <= 3400 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (L.includes('(p.r||p.reviews)&&<div') && L.includes('flexShrink:0') && L.includes('ReviewStars rating')) {
    starIdx = i + 1; break;
  }
}
for (let i = 3420; i <= 3445 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (L.includes('p.msrp&&p.msrp>$(p)&&<div') && L.includes('Below MSRP')) { barIdx = i + 1; break; }
}
if (starIdx === -1) { console.log('FAIL: stars-in-row line not found'); process.exit(1); }
if (barIdx === -1) { console.log('FAIL: MSRP bar line not found'); process.exit(1); }
console.log('Found: stars-in-row=' + starIdx + '  MSRP bar=' + barIdx);

// --- 1. insert the stars into the MSRP bar, just before its final "</div>}" ---
let bar = lines[barIdx - 1];
// the bar line ends with the bar div close + JSX brace: "...% off</span></div>}"
const tail = '</div>}';
if (!bar.endsWith(tail)) {
  console.log('FAIL: MSRP bar line does not end with expected "</div>}"');
  console.log('  ends with: ' + JSON.stringify(bar.slice(-40)));
  process.exit(1);
}
// stars element for the bar — shown only when the product has a rating/reviews
const starsForBar =
  '<div style={{flexShrink:0,display:"flex",alignItems:"center",paddingLeft:4}}>' +
  '{(p.r||p.reviews)&&<ReviewStars rating={p.r} reviews={p.reviews} size="md"/>}' +
  '</div>';
// insert before the closing </div>}  →  "...% off</span>" + stars + "</div>}"
bar = bar.slice(0, bar.length - tail.length) + starsForBar + tail;
lines[barIdx - 1] = bar;

// --- 2. remove the stars line from the 3-column row ---
// (do this AFTER editing the bar; starIdx < barIdx so bar index unaffected by
//  this splice only if we splice the later line... but we already edited bar
//  in place above — no index shift. Now delete the earlier star line.)
lines.splice(starIdx - 1, 1);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ Stars moved: removed from 3-col row, appended to right of MSRP bar.');
