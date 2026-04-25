const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = 'setBnResult({gpuKey,cpuKey,gpuScore,cpuScore,who,severity,cpuPct,gpuPct,ratio:Math.round(ratio*100)';
const neu = 'console.log("[BOTTLENECK DEBUG]",{gpuKey,cpuKey,cpuMarkRaw:cpuProd?.cpuMark,g3dMarkRaw:gpuProd?.g3dMark,who,severity,cpuPct,gpuPct,ratio,bnRes});setBnResult({gpuKey,cpuKey,gpuScore,cpuScore,who,severity,cpuPct,gpuPct,ratio:Math.round(ratio*100)';

if (!s.includes(old)) {
  console.log('MISS - anchor not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('Debug log added before setBnResult');
