const fs = require('fs');
const path = 'src/App.jsx';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);

// find the MSRP bar line
let barIdx = -1;
for (let i = 3410; i <= 3445 && i < lines.length; i++) {
  const L = lines[i] || '';
  if (L.includes('p.msrp&&p.msrp>$(p)&&<div') && L.includes('Below MSRP')) { barIdx = i + 1; break; }
}
if (barIdx === -1) { console.log('FAIL: MSRP bar line not found'); process.exit(1); }
let bar = lines[barIdx - 1];

// 1. give the bar's outer div position:relative (anchor for the absolute child)
const barOuterOld = 'display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:6,background:"var(--bg4)",border:"1px solid var(--bdr)",marginTop:8}}>';
const barOuterNew = 'display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:6,background:"var(--bg4)",border:"1px solid var(--bdr)",marginTop:8,position:"relative"}}>';
if (!bar.includes(barOuterOld)) {
  console.log('FAIL: MSRP bar outer div style not found as expected.');
  console.log('  line: ' + bar.slice(0, 160));
  process.exit(1);
}
bar = bar.replace(barOuterOld, barOuterNew);

// 2. replace the Save wrapper div (flex:1, justify center) with an absolutely-
//    centered one. The previous patch wrote it as:
//    <div style={{flex:1,display:"flex",justifyContent:"center"}}>{...saveExpr...}</div>
const saveWrapOld = '<div style={{flex:1,display:"flex",justifyContent:"center"}}>{';
const saveWrapNew = '<div style={{position:"absolute",left:"50%",transform:"translateX(-50%)",display:"flex",justifyContent:"center",pointerEvents:"none"}}>{';
if (!bar.includes(saveWrapOld)) {
  console.log('FAIL: Save wrapper div not found as expected.');
  console.log('  bar: ' + bar.slice(0, 400));
  process.exit(1);
}
bar = bar.replace(saveWrapOld, saveWrapNew);

lines[barIdx - 1] = bar;
fs.writeFileSync(path, lines.join('\n'), 'utf8');
console.log('✓ Save text now absolutely centered on the MSRP bar (line ' + barIdx + ').');
