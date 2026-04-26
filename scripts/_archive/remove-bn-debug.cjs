const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = 'console.log("[BOTTLENECK DEBUG]",{gpuKey,cpuKey,cpuMarkRaw:cpuProd?.cpuMark,g3dMarkRaw:gpuProd?.g3dMark,who,severity,cpuPct,gpuPct,ratio,bnRes});';

if (!s.includes(old)) {
  console.log('MISS - debug line not found (may already be removed)');
  process.exit(0);
}

s = s.replace(old, '');
fs.writeFileSync(p, s);
console.log('Debug log removed');
