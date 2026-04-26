// fix-deal-badge-overflow.cjs
const fs = require('fs');
const PATH = 'src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

// Add flexWrap:"wrap" to the brand+rating+badge row so DEAL badge wraps to next line if needed
const old = `<div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}><span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span><Stars r={p.r} s={10}/>{isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:11,fontWeight:800,padding:"3px 10px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL -\${dealSavings(p)}</span>}`;

const neu = `<div style={{display:"flex",alignItems:"center",gap:4,marginTop:2,flexWrap:"wrap"}}><span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span><Stars r={p.r} s={10}/>{isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)",whiteSpace:"nowrap",flexShrink:0}}>🔥 DEAL -\${dealSavings(p)}</span>}`;

if (!s.includes(old)) {
  console.log('FATAL: anchor not found - exact pattern mismatch');
  // Try a partial match to find the issue
  const partial = `display:"flex",alignItems:"center",gap:4,marginTop:2}}>`;
  const occurrences = (s.match(new RegExp(partial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  console.log('Partial pattern occurrences:', occurrences);
  process.exit(1);
}
s = s.replace(old, neu);
fs.writeFileSync(PATH, s);
console.log('✓ Fixed DEAL badge:');
console.log('  - Added flexWrap:"wrap" so badge wraps to next line if too tight');
console.log('  - Reduced badge padding/font slightly (3px 10px → 2px 8px, 11 → 10)');
console.log('  - Added whiteSpace:"nowrap" + flexShrink:0 so badge stays intact');
