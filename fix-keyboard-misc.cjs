// fix-keyboard-misc.cjs
// 1. Removes non-keyboard items wrongly categorized as Keyboard
// 2. Adds known-correct specs to common products that don't have them in titles

const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

// =====================================================================
// MISCATEGORIZED items to REMOVE
// =====================================================================
// Wrist rests, keycaps - they slipped past curation
const TO_REMOVE = [
  100179, // HyperX Wrist Rest
  100189, // SteelSeries PRISMCAPS keycaps
];

let removeCount = 0;
for (const id of TO_REMOVE) {
  // Find the entry block: "id": <id>,
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) continue;

  // Walk back to opening brace
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;

  // Walk back further to include leading whitespace + comma
  let blockStart = startBrace;
  while (blockStart > 0 && /[\s,]/.test(s[blockStart - 1])) blockStart--;

  // Walk forward to closing brace
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;

  // Remove from blockStart to endBrace
  s = s.substring(0, blockStart) + s.substring(endBrace + 1);
  removeCount++;
  console.log('Removed id=' + id);
}

// =====================================================================
// KNOWN PRODUCT SPECS - manual annotations for common products
// =====================================================================
// These are scissor/membrane keyboards that don't have switches listed in title
const KNOWN_SPECS = {
  100010: { switches: 'Scissor', layout: 'Full-Size', wireless: true, rgb: false }, // Logitech Ergo K860
  100011: { switches: 'Scissor', layout: '75%', wireless: true, rgb: true },        // Logitech MX Keys Mini
  100013: { switches: 'Membrane', layout: 'Full-Size', wireless: false, rgb: true }, // Generic 15-Zone RGB
  100015: { switches: 'Scissor', layout: 'Full-Size', wireless: true, rgb: true },  // Logitech MX Keys S
  100020: { switches: 'Scissor', layout: 'Compact', wireless: true, rgb: false },   // Pebble Keys 2 K380s
  100024: { switches: 'Membrane', layout: 'Full-Size', wireless: true, rgb: true }, // Redragon S107KS
  100026: { switches: 'Mechanical', layout: 'Full-Size', wireless: true, rgb: true }, // AULA S99
  100027: { switches: 'Mechanical', layout: 'Full-Size', wireless: true, rgb: true }, // AULA 99 Key
};

let updateCount = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const id = parseInt(idStr);
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) { console.log('  WARN id ' + id + ' not found'); continue; }

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

  // Build new field lines for missing fields only
  const newFieldLines = [];
  for (const [k, v] of Object.entries(fields)) {
    if (entryText.includes('"' + k + '":')) continue;
    let formatted;
    if (typeof v === 'string') formatted = '"' + v + '"';
    else formatted = v;
    newFieldLines.push('    "' + k + '": ' + formatted);
  }

  if (newFieldLines.length === 0) continue;

  // Inject before closing }
  const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
  if (!matchClosing) continue;
  const before = matchClosing[1];
  const closing = matchClosing[2];
  const newEntry = before.replace(/,?\s*$/, '') + ',\n' + newFieldLines.join(',\n') + closing;

  s = s.substring(0, startBrace) + newEntry + s.substring(endBrace + 1);
  updateCount++;
  console.log('Updated id=' + id + ' added ' + newFieldLines.length + ' fields');
}

fs.writeFileSync(PARTS_PATH, s);
console.log('\nRemoved ' + removeCount + ' miscategorized entries');
console.log('Updated ' + updateCount + ' keyboards with known specs');
