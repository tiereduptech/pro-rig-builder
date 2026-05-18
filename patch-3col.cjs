const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// ---- safety checks: confirm the anchor lines are what we expect ----
function need(idx1, contains, label) {
  const L = lines[idx1 - 1] || '';
  if (!L.includes(contains)) {
    console.log('FAIL: line ' + idx1 + ' (' + label + ') does not contain "' + contains + '"');
    console.log('  actual: ' + L.trim().slice(0, 90));
    process.exit(1);
  }
}
need(3368, 'ReviewStars rating', 'star row');
// The "Value + Future-Proofing" comment is near line 3380 — search a small window.
let commentLine = -1;
for (let i = 3375; i <= 3388; i++) {
  if ((lines[i - 1] || '').includes('Value + Future-Proofing')) { commentLine = i; break; }
}
if (commentLine === -1) { console.log('FAIL: cannot find "Value + Future-Proofing" comment near 3380'); process.exit(1); }
const gridLine = commentLine + 1; // the <div grid 1fr 1fr ...>
if (!lines[gridLine - 1].includes('gridTemplateColumns:"1fr 1fr"')) {
  console.log('FAIL: expected grid 1fr 1fr at line ' + gridLine + ', got: ' + lines[gridLine-1].trim().slice(0,90));
  process.exit(1);
}

// The grid's closing </div> is immediately above the "{/* Consider Instead */}"
// comment. That comment is a unique, reliable anchor — use it.
let considerLine = -1;
for (let i = gridLine; i < gridLine + 120; i++) {
  if ((lines[i] || '').includes('Consider Instead')) { considerLine = i + 1; break; }
}
if (considerLine === -1) { console.log('FAIL: could not find "Consider Instead" anchor'); process.exit(1); }
// walk back from the comment to the nearest line that is exactly </div>
let gridClose = -1;
for (let i = considerLine - 2; i > gridLine; i--) {
  if ((lines[i] || '').trim() === '</div>') { gridClose = i + 1; break; }
}
if (gridClose === -1) { console.log('FAIL: could not find grid closing </div> above Consider Instead'); process.exit(1); }

console.log('Anchors: starRow=3368  comment=' + commentLine + '  grid=' + gridLine + '  gridClose=' + gridClose);

// ---- capture the two card JSX blocks verbatim ----
// Value card: from gridLine+1 up to the line before the Future-Proofing card.
// Future card starts at the line containing FUTURE-PROOFING's wrapper:
let futureStart = -1;
for (let i = gridLine; i < gridClose; i++) {
  if ((lines[i] || '').includes('(p.c==="CPU"||p.c==="GPU"||p.c==="Motherboard")&&<div')) { futureStart = i + 1; break; }
}
if (futureStart === -1) { console.log('FAIL: could not find Future-Proofing card start'); process.exit(1); }

// Value card block = gridLine+1 .. futureStart-1   (1-indexed inclusive)
let valueBlock  = lines.slice(gridLine, futureStart - 1).join('\n');
// Future card block = futureStart .. gridClose-1
let futureBlock = lines.slice(futureStart - 1, gridClose - 1).join('\n');

// Each block is a JSX conditional wrapped in { }: "{p.bench!=null&&<div>...</div>}".
// Inside `const _v = ( ... )` we need a bare expression, so strip the outer
// braces. Strip the FIRST "{" and the LAST "}" only.
function stripOuterBraces(s, label) {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) {
    console.log('FAIL: could not strip braces from ' + label);
    process.exit(1);
  }
  return s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1);
}
valueBlock  = stripOuterBraces(valueBlock, 'valueBlock');
futureBlock = stripOuterBraces(futureBlock, 'futureBlock');

// the original star row line (1-indexed 3368)
const starRowLine = lines[3367];
// extract just the <ReviewStars .../> portion and the (p.r||p.reviews) guard
// original: {(p.r||p.reviews)&&<div style={{...}}><ReviewStars rating={p.r} reviews={p.reviews} size="md"/></div>}

// ---- build the new three-column row ----
// Column wrappers: Value (flex 1) | Stars (auto, centered) | Future (flex 1)
const newRow = [
  '              {/* Value · Ratings · Future-Proofing */}',
  '              <div style={{display:"flex",alignItems:"center",gap:14,marginTop:20,paddingTop:20,borderTop:"1px solid var(--bdr)"}}>',
  '                <div style={{flex:1,minWidth:0,display:"flex"}}>',
  '                  {(()=>{ const _v = (',
  valueBlock,
  '                  ); return _v || <div style={{flex:1}}/>; })()}',
  '                </div>',
  '                {(p.r||p.reviews)&&<div style={{flexShrink:0,display:"flex",justifyContent:"center",padding:"0 8px"}}><ReviewStars rating={p.r} reviews={p.reviews} size="md"/></div>}',
  '                <div style={{flex:1,minWidth:0,display:"flex"}}>',
  '                  {(()=>{ const _f = (',
  futureBlock,
  '                  ); return _f || <div style={{flex:1}}/>; })()}',
  '                </div>',
  '              </div>',
].join('\n');

// ---- splice ----
// 1. Remove the old standalone star row at line 3368 (index 3367).
// 2. Replace the old cards block (commentLine .. gridClose) with newRow.
// Do the LATER edit first so indices for the earlier edit stay valid.

// remove cards block: from commentLine-1 .. gridClose-1 (inclusive, 0-indexed)
lines.splice(commentLine - 1, (gridClose) - (commentLine - 1), newRow);

// now remove the old star row (index 3367) — still valid since 3367 < commentLine
lines.splice(3367, 1);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ Star row + cards restructured into 3-column row.');
console.log('  Old standalone star row removed; cards now flank the stars.');
