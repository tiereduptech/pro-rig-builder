const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

// Rename my injected Set to a non-conflicting name
const old = `const ACCESSORY_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CPUCooler","CaseFan","Monitor"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  // Accessories: smaller divisor since prices are lower ($20-200 typical)
  const divisor=ACCESSORY_CATS.has(p.c)?Math.max(pr/15,1):Math.max(pr/100,1);
  return b/divisor;
};`;

const neu = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CPUCooler","CaseFan","Monitor"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  const divisor=ACCESSORY_VALUE_CATS.has(p.c)?Math.max(pr/15,1):Math.max(pr/100,1);
  return b/divisor;
};`;

if (!s.includes(old)) {
  console.log('FATAL: anchor not found. Manual check needed.');
  process.exit(1);
}
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Renamed ACCESSORY_CATS → ACCESSORY_VALUE_CATS in valueRatio helper');
