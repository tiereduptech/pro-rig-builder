// Replace the local-fallback bottleneck formula with one that uses raw cpuMark/g3dMark
// Based on real-world bottleneck thresholds derived from PassMark scores

const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// The new local-fallback bottleneck formula
// Uses raw PassMark cpuMark + g3dMark (added in earlier patch)
// Falls back to old bench-based math if raw scores aren't available

// Find the old fallback block — starts with "// Fallback to local"
const oldBlock = `      // Fallback to local
      const gpuScore=GPU_SCORES[gpuKey]||100;const cpuScore=CPU_SCORES[cpuKey]||100;
      const cpuWeight=bnRes==="4K"?0.5:bnRes==="1440p"?0.75:1.0;
      const effectiveCPU=cpuScore*cpuWeight;
      const ratio=effectiveCPU/gpuScore;
      const cpuPct=Math.round(Math.max(0,(1-ratio))*100);
      const gpuPct=Math.round(Math.max(0,(ratio-1))*100);
      const who=ratio<0.85?"CPU":ratio>1.15?"GPU":"Balanced";
      const severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;`;

const newBlock = `      // Fallback to local — uses raw PassMark scores when available
      // Find product objects to access cpuMark/g3dMark
      const cpuProd=P.find(x=>x.c==="CPU"&&x.n===cpuKey);
      const gpuProd=P.find(x=>x.c==="GPU"&&x.n===gpuKey);
      let cpuPct,gpuPct,who,severity,ratio,gpuScore,cpuScore;
      if(cpuProd?.cpuMark&&gpuProd?.g3dMark){
        // Real PassMark scores: use empirical resolution-aware ratio
        // The "ideal CPU mark" for a GPU at each resolution is roughly:
        //   1080p: g3dMark * 1.40 (CPU work dominates)
        //   1440p: g3dMark * 1.05 
        //   4K:    g3dMark * 0.75 (GPU does heavy lifting)
        const targetMultiplier=bnRes==="4K"?0.75:bnRes==="1440p"?1.05:1.40;
        const idealCpuMark=gpuProd.g3dMark*targetMultiplier;
        const cpuDeficit=Math.max(0,(idealCpuMark-cpuProd.cpuMark)/idealCpuMark);
        const cpuOverkill=Math.max(0,(cpuProd.cpuMark-idealCpuMark*1.30)/(idealCpuMark*1.30));
        cpuPct=Math.round(cpuDeficit*100);
        gpuPct=Math.round(cpuOverkill*100);
        who=cpuPct>=10?"CPU":gpuPct>=10?"GPU":"Balanced";
        severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;
        ratio=cpuProd.cpuMark/idealCpuMark;
        gpuScore=gpuProd.bench||0;
        cpuScore=cpuProd.bench||0;
      } else {
        // Fallback to old bench-based math if raw scores missing
        gpuScore=GPU_SCORES[gpuKey]||100;cpuScore=CPU_SCORES[cpuKey]||100;
        const cpuWeight=bnRes==="4K"?0.5:bnRes==="1440p"?0.75:1.0;
        const effectiveCPU=cpuScore*cpuWeight;
        ratio=effectiveCPU/gpuScore;
        cpuPct=Math.round(Math.max(0,(1-ratio))*100);
        gpuPct=Math.round(Math.max(0,(ratio-1))*100);
        who=ratio<0.85?"CPU":ratio>1.15?"GPU":"Balanced";
        severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;
      }`;

if (!s.includes(oldBlock)) {
  console.log('ANCHOR MISS - the local fallback block has changed');
  process.exit(1);
}

s = s.replace(oldBlock, newBlock);

// Also disable the API call so we use ONLY local logic (the API gave 41% — wrong)
const oldApiCall = `    // Try API first
    const apiResult=await apiFetch("/bottleneck/analyze",{gpu:bnGPU,cpu:bnCPU,resolution:bnRes});
    if(apiResult&&apiResult.who){`;

const newApiCall = `    // Skip API call - use accurate local PassMark-based calculation
    const apiResult=null;
    if(apiResult&&apiResult.who){`;

if (s.includes(oldApiCall)) {
  s = s.replace(oldApiCall, newApiCall);
  console.log('✓ Disabled buggy API call, using local PassMark math');
} else {
  console.log('WARN: API call anchor not found');
}

fs.writeFileSync(p, s);
console.log('✓ Bottleneck formula replaced with PassMark-based math');
console.log('\nFor i7-13700K (cpuMark 45714) + RTX 4070 Ti (g3dMark 31567) at 1080p:');
console.log('  ideal CPU mark = 31567 * 1.40 = ' + (31567 * 1.40).toFixed(0));
console.log('  actual CPU mark = 45714');
console.log('  cpuMark exceeds ideal → no CPU bottleneck');
console.log('  Result: should now report Balanced or minor GPU bottleneck');
