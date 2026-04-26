const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CaseFan"]);
const MID_VALUE_CATS=new Set(["CPUCooler"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  let divisor;
  if(ACCESSORY_VALUE_CATS.has(p.c))divisor=Math.max(pr/15,1);
  else if(MID_VALUE_CATS.has(p.c))divisor=Math.max(pr/18,1);
  else divisor=Math.max(pr/100,1);
  return b/divisor;
};`;

const neu = `const VALUE_DIVISORS={
  Mouse:15,Keyboard:15,Headset:15,Microphone:15,Webcam:15,MousePad:15,ExtensionCables:15,CaseFan:15,
  CPUCooler:18,
  Motherboard:50
};
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  const div=VALUE_DIVISORS[p.c]||100;
  const divisor=Math.max(pr/div,1);
  return b/divisor;
};`;

if (!s.includes(old)) { console.log('FATAL: anchor missing'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Per-category value divisors:');
console.log('  Accessories: /15');
console.log('  CPUCooler: /18');
console.log('  Motherboard: /50');
console.log('  Everything else (CPU/GPU/RAM/PSU/Storage/Case/Monitor): /100');
