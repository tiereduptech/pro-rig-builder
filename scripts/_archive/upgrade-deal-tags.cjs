const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const oldTag = '{isDeal(p)&&<Tag color="var(--amber)">-$' + '{dealSavings(p)}</Tag>}';
const newTag = '{isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:11,fontWeight:800,padding:"3px 10px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL -$' + '{dealSavings(p)}</span>}';

const cnt = s.split(oldTag).length - 1;
console.log('Found ' + cnt + ' instances');

while (s.includes(oldTag)) {
  s = s.replace(oldTag, newTag);
}

fs.writeFileSync(p, s);
console.log('Done. Replaced ' + cnt + ' DEAL tag(s) with gradient badge.');
