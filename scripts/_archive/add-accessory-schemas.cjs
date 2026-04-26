const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

let fixes = 0;

// Webcam
const webcamOld = `Webcam:{icon:"📷",label:"Webcams",singular:"Webcam",desc:"4K & 1080p cameras",cols:[]}`;
const webcamNew = `Webcam:{icon:"📷",label:"Webcams",singular:"Webcam",desc:"4K & 1080p cameras",cols:["resolution","fps","autofocus"],filters:{resolution:{label:"Resolution",type:"check"},autofocus:{label:"Autofocus",type:"bool"}}}`;
if (s.includes(webcamOld)) { s = s.replace(webcamOld, webcamNew); fixes++; console.log('✓ Webcam schema'); }
else console.log('MISS Webcam');

// Microphone
const micOld = `Microphone:{icon:"🎙️",label:"Microphones",singular:"Microphone",desc:"USB & XLR mics",cols:[]}`;
const micNew = `Microphone:{icon:"🎙️",label:"Microphones",singular:"Microphone",desc:"USB & XLR mics",cols:["micType","pattern","sampleRate"],filters:{micType:{label:"Connection",type:"check"},pattern:{label:"Polar Pattern",type:"check"}}}`;
if (s.includes(micOld)) { s = s.replace(micOld, micNew); fixes++; console.log('✓ Microphone schema'); }
else console.log('MISS Microphone');

// MousePad
const padOld = `MousePad:{icon:"🖼️",label:"Mouse Pads",singular:"Mouse Pad",desc:"Cloth & hard surface",cols:[]}`;
const padNew = `MousePad:{icon:"🖼️",label:"Mouse Pads",singular:"Mouse Pad",desc:"Cloth & hard surface",cols:["surface","padSize"],filters:{surface:{label:"Surface",type:"check"},padSize:{label:"Size",type:"check"}}}`;
if (s.includes(padOld)) { s = s.replace(padOld, padNew); fixes++; console.log('✓ MousePad schema'); }
else console.log('MISS MousePad');

// ExtensionCables
const cableOld = `ExtensionCables:{icon:"🔗",label:"Extension Cables",singular:"Cable Kit",desc:"Sleeved PSU extensions",cols:[],multi:true,maxQty:4}`;
const cableNew = `ExtensionCables:{icon:"🔗",label:"Extension Cables",singular:"Cable Kit",desc:"Sleeved PSU extensions",cols:["cableType","cableLength"],filters:{cableType:{label:"Type",type:"check"}},multi:true,maxQty:4}`;
if (s.includes(cableOld)) { s = s.replace(cableOld, cableNew); fixes++; console.log('✓ ExtensionCables schema'); }
else console.log('MISS ExtensionCables');

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
