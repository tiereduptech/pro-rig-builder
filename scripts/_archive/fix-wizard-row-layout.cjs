const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

// Inner div containing icon + name needs flex:1, minWidth:0
const old = '<div style={{display:"flex",alignItems:"center",gap:8}}>\n              <div style={{width:36,height:36,borderRadius:6,background:"#fff"';
const neu = '<div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0,overflow:"hidden"}}>\n              <div style={{width:36,height:36,borderRadius:6,background:"#fff"';

if (!s.includes(old)) {
  console.log('MISS - inner row anchor not found');
  process.exit(1);
}
s = s.replace(old, neu);

// Price span needs flexShrink:0 to never compress
const oldPrice = '<span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</span>';
const newPrice = '<span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)",flexShrink:0,marginLeft:12}}>${fmtPrice($(p))}</span>';

if (s.includes(oldPrice)) {
  s = s.replace(oldPrice, newPrice);
}

fs.writeFileSync(p, s);
console.log('Fixed: wizard row layout - name truncates, price stays put');
