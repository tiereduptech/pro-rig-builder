const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// --- locate the ProductReviews line (search a window) ---
let prIdx = -1;
for (let i = 3425; i <= 3450 && i < lines.length; i++) {
  if ((lines[i] || '').trim() === '<ProductReviews product={p}/>') { prIdx = i + 1; break; }
}
if (prIdx === -1) { console.log('FAIL: <ProductReviews product={p}/> line not found'); process.exit(1); }

// --- locate the PERFORMANCE bar line in the left column ---
let perfIdx = -1;
for (let i = 3325; i <= 3340 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (L.includes('p.bench!=null&&<div style={{marginTop:14}}>') && L.includes('PERFORMANCE') && L.includes('<SBar')) {
    perfIdx = i + 1; break;
  }
}
if (perfIdx === -1) { console.log('FAIL: PERFORMANCE bar line not found'); process.exit(1); }

// sanity: the line right after the perf bar should be the left column's </div>
const afterPerf = (lines[perfIdx] || '').trim();
if (afterPerf !== '</div>') {
  console.log('FAIL: expected </div> right after PERFORMANCE bar (line ' + (perfIdx+1) + '), got: ' + afterPerf.slice(0,60));
  process.exit(1);
}
console.log('Anchors: ProductReviews=' + prIdx + '  PERFORMANCE bar=' + perfIdx);

// capture the exact ProductReviews line (preserve its indentation? re-indent for left column)
// left-column children at perfIdx are indented 18 spaces (see "                  {p.bench...").
const reviewsLine = '                  <ProductReviews product={p}/>';

// --- splice: later edit first ---
// 1. delete the original ProductReviews line (prIdx)
lines.splice(prIdx - 1, 1);
// 2. insert reviews right AFTER the perf bar line (perfIdx), i.e. before the left col </div>
//    prIdx > perfIdx, so deleting prIdx first leaves perfIdx valid.
lines.splice(perfIdx, 0, reviewsLine);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ ProductReviews moved into left column, directly under the PERFORMANCE bar.');
