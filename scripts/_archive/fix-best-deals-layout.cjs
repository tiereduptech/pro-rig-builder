const fs = require('fs');
const PATH = './src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

// Find the Best Deals price div - the wide $2699.99 is using fontSize:18
// Drop to fontSize:16 and keep the entire price/msrp column aligned right
const before = s;

// Match the Best Deals price block specifically
const oldBlock = '<div style={{textAlign:"right",flexShrink:0}}>\n                <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color:"var(--accent)"}}>${fmtPrice($(p))}</div>\n                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(msrp(p))}</div>}\n              </div>';

const newBlock = '<div style={{textAlign:"right",flexShrink:0,minWidth:0}}>\n                <div style={{fontFamily:"var(--mono)",fontSize:15,fontWeight:700,color:"var(--accent)",whiteSpace:"nowrap"}}>${fmtPrice($(p))}</div>\n                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through",whiteSpace:"nowrap"}}>${fmtPrice(msrp(p))}</div>}\n              </div>';

if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  console.log('✓ Block 1 found and replaced (price font 18→15)');
} else {
  console.log('⚠ Block 1 not found - trying single-line match');
}

// Also fix the middle column - make DEAL+Save not wrap by reducing gap and letting parent handle overflow
// Original: <div style={{flex:1,minWidth:0}}>
// Need to also make the inner DEAL+Save row use whitespace:nowrap on items
const oldMiddle = '<div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>{dealSavings(p)>0&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL</span>}<span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--amber)",fontWeight:700}}>Save ${dealSavings(p)}</span></div>';

const newMiddle = '<div style={{display:"flex",alignItems:"center",gap:6,marginTop:3,flexWrap:"nowrap",overflow:"hidden"}}>{dealSavings(p)>0&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)",flexShrink:0,whiteSpace:"nowrap"}}>🔥 DEAL</span>}<span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--amber)",fontWeight:700,whiteSpace:"nowrap"}}>Save ${dealSavings(p)}</span></div>';

if (s.includes(oldMiddle)) {
  s = s.replace(oldMiddle, newMiddle);
  console.log('✓ Block 2 found and replaced (DEAL+Save no-wrap)');
} else {
  console.log('⚠ Block 2 not found');
}

if (s !== before) {
  fs.writeFileSync(PATH, s);
  console.log('\n✓ Best Deals layout fixed');
} else {
  console.log('\n⚠ No changes made');
}
