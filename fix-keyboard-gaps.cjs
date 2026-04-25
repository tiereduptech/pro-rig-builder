const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

// Remove keycaps + standalone switch packs miscategorized as keyboards
const TO_REMOVE = [100197, 100198, 100202, 100208];

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

let removeCount = 0;
for (const id of TO_REMOVE) {
  const r = removeEntry(s, id);
  if (r.removed) { s = r.s; removeCount++; console.log('Removed id=' + id); }
}

// Fill specs for keyboards we know
const KNOWN_SPECS = {
  // Tier 1 mechanical keyboards (95009-95013)
  95009: { wireless: true, rgb: true },   // Keychron Q1 Pro 75%
  95010: { wireless: true, rgb: true },   // Razer Huntsman V3 Pro TKL
  95011: { wireless: false, rgb: true },  // Wooting 60HE
  95012: { wireless: false, rgb: true },  // Corsair K70 MAX RGB
  95013: { wireless: true, rgb: true },   // Logitech G Pro X TKL

  // BB-merged keyboards
  100008: { layout: 'TKL', wireless: false },          // Apex 3 RGB
  100009: { layout: 'Compact', wireless: false, rgb: true }, // Tartarus V2 keypad
  100014: { layout: '96%', wireless: true },           // F99 Wireless
  100019: { wireless: false },                          // Redragon K552P
  100023: { layout: 'Full-Size', wireless: false },    // K580 VATA
  100025: { layout: 'Full-Size', wireless: false },    // HyperX Alloy Origins

  // RGB additions for missing
  100010: { rgb: false },  // Logitech Ergo K860 (no RGB on ergo)
  100020: { rgb: false },  // Pebble Keys 2 K380s
  100213: { rgb: false },  // Drop LotR (themed not RGB)
};

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

let updateCount = 0;
let totalFields = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const r = addFields(s, parseInt(idStr), fields);
  if (r.count > 0) { s = r.s; updateCount++; totalFields += r.count; console.log('id=' + idStr + ' added ' + r.count + ' fields'); }
}

fs.writeFileSync(PARTS_PATH, s);
console.log('\nRemoved ' + removeCount + ' miscategorized entries');
console.log('Updated ' + updateCount + ' keyboards (' + totalFields + ' fields)');
