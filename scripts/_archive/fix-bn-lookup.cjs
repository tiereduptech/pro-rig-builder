const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

// Old: looks up by normalized key (gpuKey="RTX 4070 Ti") which doesn't match full product name
const oldLookup = `      // Fallback to local — uses raw PassMark scores when available
      // Find product objects to access cpuMark/g3dMark
      const cpuProd=P.find(x=>x.c==="CPU"&&x.n===cpuKey);
      const gpuProd=P.find(x=>x.c==="GPU"&&x.n===gpuKey);`;

// New: look up by the actual selected dropdown value (bnGPU/bnCPU) which IS the product name
const newLookup = `      // Fallback to local — uses raw PassMark scores when available
      // Find product objects: bnGPU/bnCPU hold the full product name from the dropdown
      const cpuProd=P.find(x=>x.c==="CPU"&&x.n===bnCPU);
      const gpuProd=P.find(x=>x.c==="GPU"&&x.n===bnGPU);`;

if (!s.includes(oldLookup)) {
  console.log('MISS - lookup anchor not found');
  process.exit(1);
}

s = s.replace(oldLookup, newLookup);
fs.writeFileSync(p, s);
console.log('Fixed: lookup now uses full product name from dropdown selection');
