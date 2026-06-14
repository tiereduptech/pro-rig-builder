const fs = require("fs");
let s = fs.readFileSync("src/App.jsx", "utf8");

function one(oldStr, newStr) {
  const n = s.split(oldStr).length - 1;
  if (n !== 1) { console.error(`ABORT (need 1, got ${n}): ${oldStr.slice(0,55)}`); process.exit(1); }
  s = s.replace(oldStr, newStr);
  console.log(`ok x1: ${oldStr.slice(0,40)}`);
}
function all(oldStr, newStr, expect) {
  const n = s.split(oldStr).length - 1;
  if (n !== expect) { console.error(`ABORT (need ${expect}, got ${n}): ${oldStr.slice(0,55)}`); process.exit(1); }
  s = s.split(oldStr).join(newStr);
  console.log(`ok x${n}: ${oldStr.slice(0,40)}`);
}

// Bug 1+2: clocks stored in MHz, not GHz
one('baseClock:v=>v+"GHz",boostClock:v=>v+"GHz"', 'baseClock:v=>v+"MHz",boostClock:v=>v+"MHz"');
// Bug 2: drop duplicate "Boost Clock" label
one(',boost:"Boost Clock",tier:"Suggested Use"', ',tier:"Suggested Use"');
// Bug 3: guard undefined GPU specs in both consider-instead arrays (mobile + desktop)
all(
  'if(x.c==="GPU")return [{l:"VRAM",v:`${x.vram}GB`},{l:"TDP",v:`${x.tdp}W`},{l:"Length",v:`${x.length}mm`},{l:"Arch",v:x.arch}];',
  'if(x.c==="GPU")return [{l:"VRAM",v:x.vram!=null?`${x.vram}GB`:"\u2014"},{l:"TDP",v:x.tdp!=null?`${x.tdp}W`:"\u2014"},{l:"Length",v:(x.length||x.gpuLen)!=null?`${x.length||x.gpuLen}mm`:"\u2014"},{l:"Arch",v:x.arch||"\u2014"}];',
  2
);

fs.writeFileSync("src/App.jsx", s);
console.log("done");
