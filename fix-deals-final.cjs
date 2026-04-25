const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// ============================================================
// 1. Fix Best Deals filter - use isDeal() not p.cp
// ============================================================
const oldFilter = 'const deals=P.filter(p=>p.cp).sort((a,b)=>(b.off||0)-(a.off||0)).slice(0,6);';
const newFilter = 'const deals=P.filter(p=>isDeal(p)).sort((a,b)=>dealSavings(b)-dealSavings(a)).slice(0,6);';
if (s.includes(oldFilter)) {
  s = s.replace(oldFilter, newFilter);
  fixes++;
  console.log('✓ Best Deals: filter uses isDeal()');
}

// ============================================================
// 2. Fix totalDeals counter same way
// ============================================================
const oldCount = 'const totalDeals=P.filter(p=>p.cp).length;';
const newCount = 'const totalDeals=P.filter(p=>isDeal(p)).length;';
if (s.includes(oldCount)) {
  s = s.replace(oldCount, newCount);
  fixes++;
  console.log('✓ Total deals counter uses isDeal()');
}

// ============================================================
// 3. Move Top Performers DEAL badge from price column to under product name
// Currently right-side has: DEAL badge + price + strikethrough MSRP
// New: name area has stars + (DEAL + Save $X) below | price area has price + MSRP only
// ============================================================
const oldTpName = `<div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>
                <Stars r={p.r} s={9}/>
              </div>`;

const newTpName = `<div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>
                <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
                  <Stars r={p.r} s={9}/>
                  {isDeal(p)&&<>
                    <span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--amber)",fontWeight:700}}>Save \${dealSavings(p)}</span>
                  </>}
                </div>
              </div>`;

if (s.includes(oldTpName)) {
  s = s.replace(oldTpName, newTpName);
  fixes++;
  console.log('✓ Top Performers: DEAL badge moved under product name');
}

// ============================================================
// 4. Remove DEAL badge from Top Performers price column
// (still keep strikethrough MSRP there)
// ============================================================
const oldTpPrice = `<div style={{textAlign:"right",flexShrink:0,minWidth:80,display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                {isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL</span>}
                <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;

const newTpPrice = `<div style={{textAlign:"right",flexShrink:0,minWidth:80}}>
                <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color:"var(--accent)"}}>\${fmtPrice($(p))}</div>
                {isDeal(p)&&<div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(msrp(p))}</div>}
              </div>`;

if (s.includes(oldTpPrice)) {
  s = s.replace(oldTpPrice, newTpPrice);
  fixes++;
  console.log('✓ Top Performers: removed DEAL badge from price column');
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
