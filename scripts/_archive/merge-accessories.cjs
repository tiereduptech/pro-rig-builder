// merge-accessories.cjs
// Appends entries from _to-import.json into parts.js
// Maintains the file's existing JSON-style formatting

const fs = require('fs');

const TO_IMPORT_PATH = './catalog-build/amazon-discovery/_to-import.json';
const PARTS_PATH = './src/data/parts.js';

const newEntries = JSON.parse(fs.readFileSync(TO_IMPORT_PATH, 'utf8'));
console.log('Loaded ' + newEntries.length + ' new entries to merge');

let s = fs.readFileSync(PARTS_PATH, 'utf8');

// parts.js looks like: export const PARTS = [ {...}, {...}, ... ];
// We find the closing ]; and insert our new entries just before it.

const closeIdx = s.lastIndexOf('];');
if (closeIdx < 0) {
  console.log('FATAL: cannot find closing ]; in parts.js');
  process.exit(1);
}

// Find the last entry's closing brace before ];
const lastBraceIdx = s.lastIndexOf('}', closeIdx);
if (lastBraceIdx < 0) {
  console.log('FATAL: no entries found');
  process.exit(1);
}

// Detect indent style from existing entries (look at the line containing the last "}")
// Most entries are formatted with 2-space indent for fields, 0-space for the closing brace
function formatEntry(entry) {
  // Mimic the existing format: each field on own line
  const lines = ['  {'];
  const keys = Object.keys(entry);
  keys.forEach((k, i) => {
    let v = entry[k];
    let line = '    "' + k + '": ';
    if (typeof v === 'string') {
      // Escape special chars in strings
      const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      line += '"' + escaped + '"';
    } else if (typeof v === 'number') {
      line += v;
    } else if (typeof v === 'boolean') {
      line += v;
    } else if (v === null) {
      line += 'null';
    } else if (typeof v === 'object') {
      // Inline object (deals.amazon)
      line += JSON.stringify(v).replace(/^{|}$/g, m => m).replace(/,/g, ', ');
    }
    if (i < keys.length - 1) line += ',';
    lines.push(line);
  });
  lines.push('  }');
  return lines.join('\n');
}

const insertBefore = closeIdx;
let insertion = ',\n';
insertion += newEntries.map(formatEntry).join(',\n');
insertion += '\n';

const updated = s.substring(0, insertBefore) + insertion + s.substring(insertBefore);
fs.writeFileSync(PARTS_PATH, updated);

console.log('✓ Inserted ' + newEntries.length + ' entries into parts.js');
console.log('  File size: ' + (s.length / 1024).toFixed(0) + ' KB → ' + (updated.length / 1024).toFixed(0) + ' KB');
console.log('\nNext: verify with `npm run build`. If clean, commit + push.');
