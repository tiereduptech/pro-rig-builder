// apply-enrichments.cjs
// Reads _enrichments.json, injects spec fields into the matching parts.js entries

const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
const ENRICHMENTS_PATH = './catalog-build/_enrichments.json';

const enrichments = JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8'));
console.log('Loaded ' + Object.keys(enrichments).length + ' enrichments');

let s = fs.readFileSync(PARTS_PATH, 'utf8');
let applied = 0;
let failed = 0;

function formatValue(v) {
  if (typeof v === 'string') return '"' + v.replace(/"/g, '\\"') + '"';
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

for (const [idStr, fields] of Object.entries(enrichments)) {
  const id = parseInt(idStr);
  // Find entry by "id": <id>,
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) { failed++; continue; }

  // Walk back to opening brace
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;

  // Walk forward to closing brace at depth 0
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

  // Build new fields string
  const newFieldLines = [];
  for (const [k, v] of Object.entries(fields)) {
    // Skip if entry already has this field
    if (entryText.includes('"' + k + '":')) continue;
    newFieldLines.push('    "' + k + '": ' + formatValue(v));
  }

  if (newFieldLines.length === 0) continue;

  // Inject before the closing }
  // Find last non-whitespace char before }
  const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
  if (!matchClosing) { failed++; continue; }
  const before = matchClosing[1];
  const closing = matchClosing[2];

  // before ends with the last field's value (no trailing comma); add comma + new fields
  const newEntry = before.replace(/,?\s*$/, '') + ',\n' + newFieldLines.join(',\n') + closing;

  s = s.substring(0, startBrace) + newEntry + s.substring(endBrace + 1);
  applied++;
}

console.log('Applied: ' + applied);
console.log('Failed: ' + failed);

fs.writeFileSync(PARTS_PATH, s);
console.log('\n✓ parts.js updated. Run `npm run build` to verify.');
