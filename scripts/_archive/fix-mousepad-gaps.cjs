const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

const TO_REMOVE = [100310]; // MX Palm Rest - wrist rest, not mousepad

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

// MousePad specs
// Format: { surface (Cloth/Hard/Hybrid), padSize (Small/Medium/Large/XL/XXL) }
const KNOWN_SPECS = {
  // Tier-1 mousepads
  98500: { surface: 'Hybrid' },                              // Artisan Hien FX (XL already)
  98501: { surface: 'Cloth' },                                // QcK Heavy XXL (XXL already)
  98502: { surface: 'Hard', padSize: 'XL' },                  // Corsair MM700 RGB Extended

  // Amazon-curated (1000xx)
  100095: { surface: 'Cloth' },                               // SteelSeries QcK Heavy Large
  100096: { surface: 'Cloth' },                               // SteelSeries QcK Large
  100097: { padSize: 'XXL' },                                 // SteelSeries QcK XXL
  100098: { surface: 'Cloth' },                               // SteelSeries QcK Medium
  100099: { padSize: 'XXL' },                                 // QcK XXL Thick
  100100: { surface: 'Hard', padSize: 'Large' },              // Aothia Leather (PU leather = hard surface)
  100103: { surface: 'Cloth' },                               // XXL Professional Large
  100104: { surface: 'Cloth', padSize: 'Medium' },            // Mouse Pad Studio Series
  100105: { padSize: 'XXL' },                                 // Razer Gigantus V2 (XXL)
  100106: { surface: 'Cloth' },                               // Generic Large Gaming
  100107: { surface: 'Cloth' },                               // RGB LED Mousepad
  100110: { surface: 'Cloth' },                               // Large Extended (16.7x35.7)
  100112: { surface: 'Hard' },                                // QIYI Pink PU Leather
  100113: { surface: 'Cloth' },                               // Generic Large Stitched

  // BB-merged (100296+)
  100296: { surface: 'Cloth' },                               // Corsair MM200 Medium
  100297: { surface: 'Cloth', padSize: 'Small' },             // Razer Goliathus Mobile Stealth
  100301: { surface: 'Hard', padSize: 'Medium' },             // Razer Firefly V2 (hard RGB pad)
  100302: { padSize: 'XXL' },                                 // Razer Strider Hybrid (XXL)
  100303: { surface: 'Cloth' },                               // HyperX Pulsefire Mat XL
  100304: { padSize: 'Small' },                               // Logitech G240 Cloth
  100306: { padSize: 'Large' },                               // Logitech G440 (this is hard plastic)
  100308: { surface: 'Cloth', padSize: 'Medium' },            // Razer Goliathus Micro-Textured
  100309: { surface: 'Cloth' },                               // SteelSeries QcK Performance XL
  100311: { surface: 'Cloth' },                               // Logitech Mouse Pad Studio Medium
  100312: { surface: 'Cloth' },                               // Logitech Desk Mat Extended

  // G440 is actually hard plastic
  100306: { surface: 'Hard', padSize: 'Large' },
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
console.log('Updated ' + updateCount + ' mousepads (' + totalFields + ' fields)');
