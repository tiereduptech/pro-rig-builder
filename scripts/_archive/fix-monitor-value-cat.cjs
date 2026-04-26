const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CPUCooler","CaseFan","Monitor"]);`;
const neu = `const ACCESSORY_VALUE_CATS=new Set(["Mouse","Keyboard","Headset","Microphone","Webcam","MousePad","ExtensionCables","CaseFan"]);`;

if (!s.includes(old)) { console.log('FATAL: anchor missing'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Removed Monitor + CPUCooler from ACCESSORY_VALUE_CATS - they use component-tier /100 divisor now');
