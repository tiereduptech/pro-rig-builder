const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// ============================================================
// 1. BEST DEALS - bigger product name (13 → 15)
// ============================================================
const bdName_old = '<div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>';
const bdName_new = '<div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>';
if (s.includes(bdName_old)) {
  s = s.replace(bdName_old, bdName_new);
  fixes++;
  console.log('✓ Best Deals: name 13→15');
}

// ============================================================
// 2. BEST DEALS - replace "Save $X" with DEAL badge + savings text
// Filter out $0 savings (legitimate deals only)
// ============================================================
const bdSavings_old = '<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--amber)",fontWeight:600,marginTop:2}}>Save ${dealSavings(p)}</div>';
const bdSavings_new = `<div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>{dealSavings(p)>0&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL</span>}<span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--amber)",fontWeight:700}}>Save \${dealSavings(p)}</span></div>`;
if (s.includes(bdSavings_old)) {
  s = s.replace(bdSavings_old, bdSavings_new);
  fixes++;
  console.log('✓ Best Deals: added DEAL badge, savings 11→12');
}

// ============================================================
// 3. TOP PERFORMERS - bump product name (the second 11px instance)
// ============================================================
// There's a second 11px name in Top Performers - same selector pattern, but in TP context.
// Let me find and bump it directly. Both BD and TP names use same style, but BD got patched once.
// One should remain. Let's scan for it.
const tpNameMatches = [...s.matchAll(/<div style=\{\{fontFamily:"var\(--ff\)",fontSize:11,fontWeight:600,color:"var\(--txt\)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"\}\}>\{p\.n\}<\/div>/g)];
console.log('  Found ' + tpNameMatches.length + ' remaining 11px name patterns');
// Bump them all to 15
for (const m of tpNameMatches) {
  const fixed = m[0].replace('fontSize:11', 'fontSize:15');
  s = s.replace(m[0], fixed);
  fixes++;
}
if (tpNameMatches.length > 0) console.log('✓ Top Performers: name 11→15');

// ============================================================
// 4. TOP PERFORMERS - add DEAL badge above price for items on deal
// Currently shows: price + strikethrough MSRP
// Add: DEAL badge above price when isDeal(p)
// ============================================================
const tpPrice_old = `<div style={{textAlign:"right",flexShrink:0,minWidth:60}}>
                <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
const tpPrice_new = `<div style={{textAlign:"right",flexShrink:0,minWidth:80,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                {isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL</span>}
                <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
if (s.includes(tpPrice_old)) {
  s = s.replace(tpPrice_old, tpPrice_new);
  fixes++;
  console.log('✓ Top Performers: added DEAL badge, price 16→18');
}

// ============================================================
// 5. BEST DEALS - bump price 16 → 18 to match Top Performers
// ============================================================
const bdPrice_old = `<div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
const bdPrice_new = `<div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;
if (s.includes(bdPrice_old)) {
  s = s.replace(bdPrice_old, bdPrice_new);
  fixes++;
  console.log('✓ Best Deals: price 16→18');
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
