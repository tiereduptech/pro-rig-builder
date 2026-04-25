const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// ============================================================
// 1. BEST DEALS — fix "Save $X" to use dealSavings + bump font
// ============================================================

// Old: <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>Save ${p.off}</div>
const bdSavings_old = '<div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>Save ${p.off}</div>';
const bdSavings_new = '<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--amber)",fontWeight:600,marginTop:2}}>Save ${dealSavings(p)}</div>';
if (s.includes(bdSavings_old)) {
  s = s.replace(bdSavings_old, bdSavings_new);
  fixes++;
  console.log('✓ Best Deals: Save amount now uses dealSavings, font 9→11');
} else console.log('WARN: Best Deals savings anchor missing');

// Bump Best Deals product name font 11 → 13
const bdName_old = '<div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>';
const bdName_new = '<div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>';
if (s.includes(bdName_old)) {
  s = s.replace(bdName_old, bdName_new);
  fixes++;
  console.log('✓ Best Deals: product name font 11→13');
} else console.log('WARN: Best Deals product name anchor missing');

// Bump Best Deals price font 13 → 16, MSRP strikethrough 8 → 11
const bdPrice_old = `<div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(p.msrp||p.pr)}</div>
              </div>`;
const bdPrice_new = `<div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
if (s.includes(bdPrice_old)) {
  s = s.replace(bdPrice_old, bdPrice_new);
  fixes++;
  console.log('✓ Best Deals: price font 13→16, strikethrough conditional on isDeal');
} else console.log('WARN: Best Deals price anchor missing');

// ============================================================
// 2. TOP PERFORMERS — add deal flag display + bump fonts
// ============================================================

// The Top Performers price line (single line, no MSRP currently):
const tpPrice_old = '<div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--accent)",minWidth:40,textAlign:"right",flexShrink:0}}>${fmtPrice($(p))}</div>';
const tpPrice_new = `<div style={{textAlign:"right",flexShrink:0,minWidth:60}}>
                <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
if (s.includes(tpPrice_old)) {
  s = s.replace(tpPrice_old, tpPrice_new);
  fixes++;
  console.log('✓ Top Performers: added MSRP strikethrough, font 13→16');
} else console.log('WARN: Top Performers price anchor missing');

// Top Performers also needs Save badge added next to product name
// Look at the product name div - all Top Performers names use this same style
// Pattern (used in Top Performers, line ~2104):
//   <div style={{flex:1,minWidth:0}}>
//     <div style={{fontFamily:"var(--ff)",...}}>{p.n}</div>
// We add an "isDeal Save $X" line below, similar to Best Deals
// But wait - Top Performers names are wider, can't easily add another line without restructuring
// Skip the Save badge in Top Performers for now - the strikethrough MSRP serves the purpose

// ============================================================
// 3. Section headers - bump from 17 to 18, "by benchmark" 9 to 11
// ============================================================
const tpHeader_old = '<h2 style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>Top Performers</h2>';
const tpHeader_new = '<h2 style={{fontFamily:"var(--ff)",fontSize:19,fontWeight:700,color:"var(--txt)"}}>Top Performers</h2>';
if (s.includes(tpHeader_old)) {
  s = s.replace(tpHeader_old, tpHeader_new);
  fixes++;
  console.log('✓ Top Performers: header font 17→19');
}

const benchLabel_old = '<span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",fontWeight:600}}>by benchmark</span>';
const benchLabel_new = '<span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--sky)",fontWeight:600}}>by benchmark</span>';
if (s.includes(benchLabel_old)) {
  s = s.replace(benchLabel_old, benchLabel_new);
  fixes++;
  console.log('✓ Top Performers: "by benchmark" label font 9→11');
}

// Find Best Deals header similarly
const bdHeader_pattern = /<h2 style=\{\{fontFamily:"var\(--ff\)",fontSize:17,fontWeight:700,color:"var\(--txt\)"\}\}>Best Deals<\/h2>/;
if (bdHeader_pattern.test(s)) {
  s = s.replace(bdHeader_pattern, '<h2 style={{fontFamily:"var(--ff)",fontSize:19,fontWeight:700,color:"var(--txt)"}}>Best Deals</h2>');
  fixes++;
  console.log('✓ Best Deals: header font 17→19');
}

// "12 active" badge font in Best Deals - find and bump
// Pattern: fontSize:9 + "active" nearby
const activeBadge_old = /fontSize:9,color:"var\(--accent\)",fontWeight:600\}\}>\{[^}]+\} active</;
if (activeBadge_old.test(s)) {
  s = s.replace(activeBadge_old, m => m.replace('fontSize:9', 'fontSize:11'));
  fixes++;
  console.log('✓ Best Deals: "X active" badge font 9→11');
}

// Bump Top Performer name font 11→13 (find pattern that's specifically in Top Performers context)
// The Top Performers product name is also fontSize:11 with whiteSpace:nowrap. Same selector as Best Deals.
// Both got bumped by the bdName replacement. But we need to verify.
const tpNameRemains = (s.match(/fontSize:11,fontWeight:600,color:"var\(--txt\)",whiteSpace:"nowrap"/g) || []).length;
console.log(`  (${tpNameRemains} remaining 11px-name patterns - 0 expected after bdName fix)`);

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
