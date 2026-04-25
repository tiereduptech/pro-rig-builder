const fs = require('fs');
const p = 'bestbuy-discover-v2.js';
let s = fs.readFileSync(p, 'utf8');

// Insert new category IDs after OpticalDrive line
const old = `  // Optical — Internal DVD drives only (CD/DVD and Blu-ray empty at Best Buy)
  OpticalDrive: ['pcmcat189600050010'],
};`;

const neu = `  // Optical — Internal DVD drives only (CD/DVD and Blu-ray empty at Best Buy)
  OpticalDrive: ['pcmcat189600050010'],

  // Peripherals — accessories
  Mouse:        ['pcmcat304600050013'],                              // Gaming Mice
  Keyboard:     ['pcmcat304600050014'],                              // Gaming Keyboards
  Headset:      ['pcmcat230800050019', 'pcmcat1572279759550'],       // PC Gaming Headsets + Gaming Headsets
  Microphone:   ['pcmcat221400050015', 'pcmcat221400050014'],        // Condenser + Dynamic Microphones
  Webcam:       ['abcat0515046'],                                    // Webcams
  MousePad:     ['pcmcat1503427739152', 'abcat0515032'],             // Gaming Mouse Pads + Mouse Pads
  // ExtensionCables: not stocked by Best Buy in any meaningful volume - skip
};`;

if (!s.includes(old)) {
  console.log('FATAL: anchor not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Added 6 accessory categories to bestbuy-discover-v2.js');
console.log('  (ExtensionCables skipped - not stocked by Best Buy)');
