const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// locate the two lines (search a window so it survives small shifts)
let saveIdx = -1, barIdx = -1;
for (let i = 3420; i <= 3445 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (saveIdx === -1 && L.includes('rr.length>1&&<div') && L.includes('Save <span')) saveIdx = i + 1;
  if (barIdx === -1 && L.includes('p.msrp&&p.msrp>$(p)&&<div') && L.includes('Below MSRP')) barIdx = i + 1;
}
if (saveIdx === -1) { console.log('FAIL: Save line not found'); process.exit(1); }
if (barIdx === -1) { console.log('FAIL: MSRP bar line not found'); process.exit(1); }
if (barIdx !== saveIdx + 1) {
  console.log('FAIL: expected MSRP bar immediately after Save line (save=' + saveIdx + ' bar=' + barIdx + ')');
  process.exit(1);
}
console.log('Found: Save line=' + saveIdx + '  MSRP bar=' + barIdx);

// indentation of the Save line, to keep things tidy
const indent = (lines[saveIdx - 1].match(/^\s*/) || [''])[0];

// The reusable Save expression (the JSX value, no outer braces).
const saveExpr =
  'rr.length>1&&<span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",textAlign:"center",whiteSpace:"nowrap"}}>' +
  'Save <span style={{color:"var(--mint)",fontWeight:600}}>${(rr[rr.length-1].price-rr[0].price).toFixed(2)}</span>' +
  ' at {rr[0].name} vs {rr[rr.length-1].name}</span>';

// New MSRP bar: 4-part flex — 💰 | [Below MSRP / Was] | Save (centered) | 13% off.
// The Save element only appears when rr.length>1.
const newBar =
  indent + '{p.msrp&&p.msrp>$(p)&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:6,background:"var(--bg4)",border:"1px solid var(--bdr)",marginTop:8}}>' +
  '<span style={{fontSize:17}}>💰</span>' +
  '<div style={{flex:1}}><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Below MSRP</div>' +
  '<div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>Was <span style={{textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span> → ${fmtPrice($(p))}</div></div>' +
  '<div style={{flex:1,display:"flex",justifyContent:"center"}}>{' + saveExpr + '}</div>' +
  '<span style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--mint)"}}>{Math.round((1-$(p)/p.msrp)*100)}% off</span></div>}';

// Fallback Save line: shown ONLY when there's no MSRP bar, so a product with
// a multi-retailer saving but no below-MSRP deal doesn't lose its Save text.
const fallbackSave =
  indent + '{!(p.msrp&&p.msrp>$(p))&&rr.length>1&&<div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",textAlign:"center",marginTop:8}}>' +
  'Save <span style={{color:"var(--mint)",fontWeight:600}}>${(rr[rr.length-1].price-rr[0].price).toFixed(2)}</span>' +
  ' at {rr[0].name} vs {rr[rr.length-1].name}</div>}';

// Replace the two original lines (saveIdx, barIdx) with: fallbackSave + newBar.
lines.splice(saveIdx - 1, 2, fallbackSave, newBar);

fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ Save text moved into MSRP bar middle; standalone fallback kept for no-bar case.');
