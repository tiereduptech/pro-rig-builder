const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// find the MSRP bar line
let barIdx = -1;
for (let i = 3415; i <= 3445 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (L.includes('p.msrp&&p.msrp>$(p)&&<div') && L.includes('Below MSRP')) { barIdx = i + 1; break; }
}
if (barIdx === -1) { console.log('FAIL: MSRP bar line not found'); process.exit(1); }

let bar = lines[barIdx - 1];

// the exact stars element appended by the previous patch
const starsForBar =
  '<div style={{flexShrink:0,display:"flex",alignItems:"center",paddingLeft:4}}>' +
  '{(p.r||p.reviews)&&<ReviewStars rating={p.r} reviews={p.reviews} size="md"/>}' +
  '</div>';

if (!bar.includes(starsForBar)) {
  console.log('FAIL: stars element not found on MSRP bar — nothing to remove.');
  console.log('  bar tail: ' + JSON.stringify(bar.slice(-120)));
  process.exit(1);
}

bar = bar.replace(starsForBar, '');
lines[barIdx - 1] = bar;

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ Removed ReviewStars from MSRP bar (line ' + barIdx + '). Bar is back to 3 sections.');
