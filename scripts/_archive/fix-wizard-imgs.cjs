const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = '<span style={{fontSize:14}}>{CAT[cat]?.icon}</span>\n              <div><div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)"}}>{p.n}</div><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{CAT[cat]?.singular}</div></div>';

const neu = '<div style={{width:36,height:36,borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0,overflow:"hidden"}}>{p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:"100%",height:"100%",objectFit:"contain"}}/>:CAT[cat]?.icon}</div>\n              <div style={{minWidth:0}}><div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.n}</div><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{CAT[cat]?.singular}</div></div>';

if (!s.includes(old)) {
  console.log('MISS - anchor not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('Fixed: Wizard now shows product images');
