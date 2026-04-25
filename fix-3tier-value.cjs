const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CaseFan"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  const divisor=ACCESSORY_VALUE_CATS.has(p.c)?Math.max(pr/15,1):Math.max(pr/100,1);
  return b/divisor;
};`;

const neu = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CaseFan"]);
const MID_VALUE_CATS=new Set(["CPUCooler"]);
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  let divisor;
  if(ACCESSORY_VALUE_CATS.has(p.c))divisor=Math.max(pr/15,1);
  else if(MID_VALUE_CATS.has(p.c))divisor=Math.max(pr/25,1);
  else divisor=Math.max(pr/100,1);
  return b/divisor;
};`;

if (!s.includes(old)) { console.log('FATAL: anchor missing'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ 3-tier value formula:');
console.log('  Accessories: /15 (Mouse, Keyboard, Headset, Mic, Webcam, MousePad, CaseFan, ExtensionCables)');
console.log('  Mid: /25 (CPUCooler)');
console.log('  Components: /100 (everything else: CPU, GPU, Mobo, RAM, Storage, PSU, Case, Monitor)');
