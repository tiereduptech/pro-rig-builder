const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

function need(idx1, contains, label) {
  const L = lines[idx1 - 1] || '';
  if (!L.includes(contains)) {
    console.log('FAIL: line ' + idx1 + ' (' + label + ') missing "' + contains + '"');
    console.log('  actual: ' + L.trim().slice(0, 90));
    process.exit(1);
  }
}

// --- anchor 1: the star row (stays put — the new row replaces it in place) ---
need(3368, 'ReviewStars rating', 'star row');
const starRowIdx = 3368; // 1-indexed

// --- anchor 2: the "Value + Future-Proofing" comment near 3380 ---
let commentLine = -1;
for (let i = 3375; i <= 3388; i++) {
  if ((lines[i - 1] || '').includes('Value + Future-Proofing')) { commentLine = i; break; }
}
if (commentLine === -1) { console.log('FAIL: cannot find "Value + Future-Proofing" comment'); process.exit(1); }
const gridLine = commentLine + 1;
if (!lines[gridLine - 1].includes('gridTemplateColumns:"1fr 1fr"')) {
  console.log('FAIL: expected grid 1fr 1fr at ' + gridLine + ', got: ' + lines[gridLine-1].trim().slice(0,90));
  process.exit(1);
}

// --- anchor 3: grid close = the </div> just above "Consider Instead" ---
let considerLine = -1;
for (let i = gridLine; i < gridLine + 120; i++) {
  if ((lines[i] || '').includes('Consider Instead')) { considerLine = i + 1; break; }
}
if (considerLine === -1) { console.log('FAIL: no "Consider Instead" anchor'); process.exit(1); }
let gridClose = -1;
for (let i = considerLine - 2; i > gridLine; i--) {
  if ((lines[i] || '').trim() === '</div>') { gridClose = i + 1; break; }
}
if (gridClose === -1) { console.log('FAIL: no grid closing </div>'); process.exit(1); }

// --- find the Future-Proofing card start within the grid ---
let futureStart = -1;
for (let i = gridLine; i < gridClose; i++) {
  if ((lines[i] || '').includes('(p.c==="CPU"||p.c==="GPU"||p.c==="Motherboard")&&<div')) { futureStart = i + 1; break; }
}
if (futureStart === -1) { console.log('FAIL: no Future-Proofing card start'); process.exit(1); }

console.log('Anchors: starRow=' + starRowIdx + '  comment=' + commentLine +
  '  grid=' + gridLine + '  futureStart=' + futureStart + '  gridClose=' + gridClose);

// --- capture the two card blocks ---
let valueBlock  = lines.slice(gridLine, futureStart - 1).join('\n');
let futureBlock = lines.slice(futureStart - 1, gridClose - 1).join('\n');

// strip outer { } so each becomes a bare expression usable inside ( ... )
function stripOuterBraces(s, label) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) { console.log('FAIL: brace strip ' + label); process.exit(1); }
  return s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1);
}
valueBlock  = stripOuterBraces(valueBlock, 'valueBlock');
futureBlock = stripOuterBraces(futureBlock, 'futureBlock');

// --- the new 3-column row (Value | stars | Future-Proofing) ---
// Placed where the star row currently is. The original star row markup:
//   {(p.r||p.reviews)&&<div ...><ReviewStars rating={p.r} reviews={p.reviews} size="md"/></div>}
const newRow = [
  '                  {/* Value · Ratings · Future-Proofing */}',
  '                  <div style={{display:"flex",alignItems:"center",gap:14,marginTop:10}}>',
  '                    <div style={{flex:1,minWidth:0,display:"flex"}}>',
  '                      {(()=>{ const _v = (',
  valueBlock,
  '                      ); return _v || <div style={{flex:1}}/>; })()}',
  '                    </div>',
  '                    {(p.r||p.reviews)&&<div style={{flexShrink:0,display:"flex",justifyContent:"center",padding:"0 8px"}}><ReviewStars rating={p.r} reviews={p.reviews} size="md"/></div>}',
  '                    <div style={{flex:1,minWidth:0,display:"flex"}}>',
  '                      {(()=>{ const _f = (',
  futureBlock,
  '                      ); return _f || <div style={{flex:1}}/>; })()}',
  '                    </div>',
  '                  </div>',
].join('\n');

// --- splice ---
// Do the LATER edit first (delete cards grid) so earlier indices stay valid.
// 1. Delete the cards block: commentLine .. gridClose (0-indexed commentLine-1 .. gridClose-1).
lines.splice(commentLine - 1, gridClose - (commentLine - 1));
// 2. Replace the original star row (index starRowIdx-1) with the new 3-col row.
lines.splice(starRowIdx - 1, 1, newRow);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ 3-column row placed at star location; old cards grid removed.');
