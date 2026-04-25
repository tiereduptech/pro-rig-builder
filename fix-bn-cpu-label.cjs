const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = 'map(p=>({value:p.n,label:p.n,detail:p.cores+"C/"+( p.threads||p.cores*2)+"T"}))';
const neu = 'map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.cores+"C/"+( p.threads||p.cores*2)+"T"}))';

if (!s.includes(old)) {
  console.log('MISS - pattern not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('Fixed Bottleneck CPU dropdown');
