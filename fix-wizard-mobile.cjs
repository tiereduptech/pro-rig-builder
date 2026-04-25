const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// =====================================================================
// 1. Add CSS for wizard mobile responsiveness
// Insert after the existing tools-layout media query
// =====================================================================
if (s.includes('/* === MOBILE FIX: wizard ===')) {
  console.log('Stripping prior version');
  const start = s.indexOf('/* === MOBILE FIX: wizard ===');
  const end = s.indexOf('/* === END MOBILE FIX: wizard ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end + '/* === END MOBILE FIX: wizard ==='.length) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

const cssBlock = `/* === MOBILE FIX: wizard === */
.wizard-container {
  max-width: 600px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.wizard-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg3);
  margin-bottom: 4px;
  border: 1px solid var(--bdr);
  gap: 8px;
}
.wizard-row-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.wizard-row-img {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  overflow: hidden;
}
.wizard-row-img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.wizard-row-text {
  min-width: 0;
  flex: 1;
}
.wizard-row-name {
  font-family: var(--ff);
  font-size: 12px;
  font-weight: 600;
  color: var(--txt);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wizard-row-cat {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--dim);
}
.wizard-row-price {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--mint);
  flex-shrink: 0;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .wizard-container {
    padding: 0 8px;
  }
  .wizard-container > div {
    padding: 14px !important;
  }
  .wizard-row {
    padding: 6px 8px;
    gap: 6px;
  }
  .wizard-row-img {
    width: 30px;
    height: 30px;
  }
  .wizard-row-name {
    font-size: 11px;
  }
  .wizard-row-cat {
    font-size: 8px;
  }
  .wizard-row-price {
    font-size: 12px;
  }
}
/* === END MOBILE FIX: wizard === */
`;

const cssAnchor = `/* === MOBILE FIX 5: browse page mobile layout === */`;
const cssIdx = s.indexOf(cssAnchor);
if (cssIdx < 0) { console.log('CSS anchor missing'); process.exit(1); }
s = s.substring(0, cssIdx) + cssBlock + s.substring(cssIdx);
console.log('✓ Inserted wizard mobile CSS');
fixes++;

// =====================================================================
// 2. Refactor wizard JSX to use the new CSS classes
// =====================================================================
// Wizard outer container: maxWidth:600,margin:"0 auto"
const oldOuter = '{tool==="wizard"&&<div style={{maxWidth:600,margin:"0 auto"}}>';
const newOuter = '{tool==="wizard"&&<div className="wizard-container">';
if (s.includes(oldOuter)) {
  s = s.replace(oldOuter, newOuter);
  fixes++;
  console.log('✓ Wizard container uses class');
}

// Wizard product row: replace inline-styled row with class-based row
const oldRow = `{Object.entries(wizResult).map(([cat,p])=><div key={cat} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 10px",borderRadius:6,background:"var(--bg3)",marginBottom:4,border:"1px solid var(--bdr)"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0,overflow:"hidden"}}>
              <div style={{width:36,height:36,borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0,overflow:"hidden"}}>{p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:"100%",height:"100%",objectFit:"contain"}}/>:CAT[cat]?.icon}</div>
              <div style={{minWidth:0}}><div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.n}</div><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{CAT[cat]?.singular}</div></div>
            </div>
            <span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)",flexShrink:0,marginLeft:12}}>\${fmtPrice($(p))}</span>
          </div>)}`;

const newRow = `{Object.entries(wizResult).map(([cat,p])=><div key={cat} className="wizard-row">
            <div className="wizard-row-info">
              <div className="wizard-row-img">{p.img?<img loading="lazy" decoding="async" src={p.img} alt=""/>:CAT[cat]?.icon}</div>
              <div className="wizard-row-text"><div className="wizard-row-name">{p.n}</div><div className="wizard-row-cat">{CAT[cat]?.singular}</div></div>
            </div>
            <span className="wizard-row-price">\${fmtPrice($(p))}</span>
          </div>)}`;

if (s.includes(oldRow)) {
  s = s.replace(oldRow, newRow);
  fixes++;
  console.log('✓ Wizard rows refactored to class-based');
} else {
  console.log('WARN: wizard row anchor missing');
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
