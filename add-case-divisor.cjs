const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `const VALUE_DIVISORS={
  Mouse:15,Keyboard:15,Headset:15,Microphone:15,Webcam:15,MousePad:15,ExtensionCables:15,CaseFan:15,
  CPUCooler:18,
  Motherboard:40
};`;

const neu = `const VALUE_DIVISORS={
  Mouse:15,Keyboard:15,Headset:15,Microphone:15,Webcam:15,MousePad:15,ExtensionCables:15,CaseFan:15,
  CPUCooler:18,
  Case:25,
  Motherboard:40
};`;

if (!s.includes(old)) { console.log('FATAL'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Added Case:25 to VALUE_DIVISORS');
