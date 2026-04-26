// fix-mouse-gaps.cjs
// Adds known mouse specs + removes miscategorized

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

const TO_REMOVE = [99999]; // Hard Case Replacement - not a mouse

function removeEntry(s, id) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, removed: false };
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let blockStart = startBrace;
  while (blockStart > 0 && /[\s,]/.test(s[blockStart - 1])) blockStart--;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  return { s: s.substring(0, blockStart) + s.substring(pos + 1), removed: true };
}

function addFields(s, id, fields) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, count: 0 };
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;
  const entryText = s.substring(startBrace, endBrace + 1);
  const newFieldLines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (entryText.includes('"' + k + '":')) continue;
    let formatted = typeof v === 'string' ? '"' + v + '"' : v;
    newFieldLines.push('    "' + k + '": ' + formatted);
  }
  if (newFieldLines.length === 0) return { s, count: 0 };
  const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
  if (!matchClosing) return { s, count: 0 };
  const before = matchClosing[1];
  const closing = matchClosing[2];
  const newEntry = before.replace(/,?\s*$/, '') + ',\n' + newFieldLines.join(',\n') + closing;
  return { s: s.substring(0, startBrace) + newEntry + s.substring(endBrace + 1), count: newFieldLines.length };
}

// Known specs per ID, from product knowledge. Format: { sensor, dpi, weight (g), mouseType }
const KNOWN_SPECS = {
  // Tier 1 mice
  96012: { mouseType: 'Wireless' },                                                  // Pulsar X2V2 Mini
  96013: { mouseType: 'Wireless' },                                                  // Razer DeathAdder V3
  96014: { mouseType: 'Wireless' },                                                  // Endgame Gear OP1we

  // Logitech G-series
  99972: { weight: 121 },                                                            // G502 Hero (already has sensor/dpi)
  99974: { weight: 134 },                                                            // M510
  99976: { weight: 114, dpi: 25600 },                                                // G502 Lightspeed
  99977: { weight: 63, dpi: 25600 },                                                 // PRO X Superlight
  99978: { weight: 110 },                                                            // M612 Predator
  99980: { weight: 96, mouseType: 'Wired' },                                         // DeathAdder Essential
  99981: { weight: 101, dpi: 26000, mouseType: 'Wired' },                            // Basilisk V3
  99982: { sensor: 'Advanced Optical', weight: 135 },                                // M720 Triathlon
  99983: { sensor: 'Laser', dpi: 1000, weight: 135 },                                // M705 Marathon
  99984: { sensor: 'Optical', dpi: 4000, weight: 135 },                              // MX Vertical
  99985: { sensor: 'Optical', dpi: 4000, weight: 125 },                              // Lift Vertical
  99986: { sensor: 'Optical', dpi: 4000, weight: 125 },                              // Lift Vertical (dup)
  99987: { sensor: 'Optical', dpi: 8000, weight: 141 },                              // MX Master 3S
  99988: { dpi: 25600, weight: 95 },                                                 // G703 Lightspeed
  99989: { weight: 158 },                                                            // M908 Impact MMO
  99990: { sensor: 'Optical', weight: 130 },                                         // Redragon M810 Pro
  99991: { sensor: 'Optical', dpi: 7200, weight: 110 },                              // M602 Gaming
  99992: { weight: 110 },                                                            // M602 Griffin
  99993: { dpi: 2000, weight: 86 },                                                  // TECKNET Wireless
  99994: { dpi: 18000, weight: 60 },                                                 // Razer Orochi V2
  99995: { weight: 105 },                                                            // M913 Impact Elite
  99996: { dpi: 25600, weight: 89 },                                                 // G502 X Plus
  99997: { sensor: 'HERO 2', dpi: 32000, weight: 60 },                               // PRO X Superlight 2
  99998: { sensor: 'Optical', dpi: 8000, weight: 99 },                               // MX Anywhere 3S
  100000: { sensor: 'Optical', dpi: 4000, weight: 96, mouseType: 'Wireless' },       // Lenovo Yoga Pro
  100001: { sensor: 'HyperSpeed', dpi: 18000, weight: 76 },                          // Basilisk V3 X HyperSpeed
  100002: { sensor: 'HERO 2', dpi: 32000, weight: 80 },                              // PRO 2 Lightspeed
  100003: { dpi: 30000, weight: 82 },                                                // Viper V3 HyperSpeed
  100004: { dpi: 30000, weight: 112 },                                               // Razer Basilisk V3 Pro
  100005: { sensor: 'Optical', dpi: 512, weight: 259, mouseType: 'Wireless' },       // MX Ergo S Trackball
  100006: { dpi: 12800 },                                                            // acer Wired

  // BB-merged mice
  100135: { dpi: 25600, sensor: 'HERO' },                                            // Logitech PRO Lightweight
  100136: { dpi: 10000 },                                                            // Corsair HARPOON RGB
  100137: { dpi: 25600 },                                                            // Logitech G403 Hero
  100138: { dpi: 12000 },                                                            // Logitech G903 LIGHTSPEED
  100139: { dpi: 18000 },                                                            // Corsair Nightsword RGB
  100140: { dpi: 18000 },                                                            // Corsair IRONCLAW RGB
  100141: { dpi: 16000 },                                                            // Razer Viper Optical
  100142: { dpi: 7200 },                                                             // Redragon Griffin M607
  100143: { dpi: 18000 },                                                            // Corsair Scimitar RGB Elite
  100144: { dpi: 18000 },                                                            // Corsair DARK CORE RGB Pro
  100145: { dpi: 8500 },                                                             // SteelSeries Rival 3
  100146: { dpi: 18000 },                                                            // SteelSeries Rival 5
  100147: { dpi: 8500 },                                                             // SteelSeries Aerox 3
  100148: { dpi: 26000 },                                                            // Corsair M65 RGB Ultra
  100149: { dpi: 18000 },                                                            // SteelSeries Aerox 9
  100150: { dpi: 16000 },                                                            // HyperX Pulsefire Haste
  100151: { dpi: 8200 },                                                             // Logitech G705 Aurora
  100152: { dpi: 19000 },                                                            // Glorious Model D Wireless
  100153: { dpi: 30000 },                                                            // Razer Naga V2 HyperSpeed
  100154: { dpi: 19000 },                                                            // ASUS ROG Spatha X
  100155: { dpi: 36000 },                                                            // ASUS ROG Harpe Ace
  100156: { dpi: 26000 },                                                            // Glorious Model O 2
  100157: { dpi: 8500 },                                                             // Razer Cobra
  100158: { dpi: 30000 },                                                            // Razer Cobra Pro
  100159: { sensor: 'HERO 2', dpi: 32000, weight: 60 },                              // PRO X Superlight 2 (dup)
  100160: { dpi: 12400 },                                                            // Corsair KATAR PRO
  100161: { dpi: 26000 },                                                            // Corsair M75 WIRELESS
  100162: { dpi: 26000 },                                                            // Glorious Model D 2 Wireless
  100163: { sensor: 'HERO 2', dpi: 32000, weight: 60 },                              // Logitech G309
  100164: { sensor: 'HERO 2', dpi: 44000, weight: 60 },                              // PRO X Superlight 2 DEX
  100165: { sensor: 'HERO 2', dpi: 44000 },                                          // PRO 2 LIGHTSPEED
  100166: { dpi: 12400 },                                                            // Corsair M55
  100167: { dpi: 45000 },                                                            // Razer DeathAdder V4 Pro
  100168: { dpi: 26000 },                                                            // Corsair Scimitar Elite
  100169: { dpi: 26000 },                                                            // Glorious Model O Eternal
  100170: { dpi: 26000 },                                                            // Glorious Model O3
  100171: { dpi: 26000 },                                                            // Glorious Model D3
  100172: { dpi: 26000 },                                                            // Corsair Sabre V2 Pro
  100174: { dpi: 18000, weight: 130 },                                               // Corsair IRONCLAW WIRELESS SE
  100175: { dpi: 44000 },                                                            // Logitech PRO X2 SUPERSTRIKE
  100176: { dpi: 45000 },                                                            // Razer Viper V4 Pro
};

let removeCount = 0;
for (const id of TO_REMOVE) {
  const r = removeEntry(s, id);
  if (r.removed) { s = r.s; removeCount++; console.log('Removed id=' + id); }
}

let updateCount = 0;
let totalFields = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const r = addFields(s, parseInt(idStr), fields);
  if (r.count > 0) { s = r.s; updateCount++; totalFields += r.count; }
}

fs.writeFileSync(PARTS_PATH, s);
console.log('\nRemoved ' + removeCount + ' miscategorized');
console.log('Updated ' + updateCount + ' mice (' + totalFields + ' fields)');
