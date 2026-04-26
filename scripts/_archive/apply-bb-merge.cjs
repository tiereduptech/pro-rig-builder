// apply-bb-merge.cjs
// Reads _to-merge-bb.json + _to-import-bb.json
// Updates parts.js: adds deals.bestbuy to matched entries; appends new BB-only entries

const fs = require('fs');
const path = require('path');

const PARTS_PATH = './src/data/parts.js';
const TO_MERGE = './catalog-build/bestbuy-discovery/_to-merge-bb.json';
const TO_IMPORT = './catalog-build/bestbuy-discovery/_to-import-bb.json';

const updates = JSON.parse(fs.readFileSync(TO_MERGE, 'utf8'));
const newEntries = JSON.parse(fs.readFileSync(TO_IMPORT, 'utf8'));

console.log('Updates: ' + updates.length + ' (existing entries getting deals.bestbuy)');
console.log('New entries: ' + newEntries.length + ' (BB-only products to add)');

let s = fs.readFileSync(PARTS_PATH, 'utf8');

// =========================================================================
// Stage 1: For each update, find the entry by id and inject deals.bestbuy
// =========================================================================

function formatBestbuyDeal(d) {
  // Compact JSON for inline insertion
  return '{"url": "' + d.url.replace(/"/g, '\\"') + '", "price": ' + d.price + ', "inStock": ' + d.inStock + '}';
}

let updatesApplied = 0;

for (const u of updates) {
  // Find the entry block: starts with `"id": <id>,` and ends with closing }
  // Search for `"id": <id>,` (parts.js uses JSON-style formatting per merge-accessories)
  const idMarker = '"id": ' + u.id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) {
    console.log('  WARN: id ' + u.id + ' not found in parts.js');
    continue;
  }

  // Find the end of this entry: next `}` at the same brace level
  // Simple approach: find the closing `}` that's followed by either `,\n  {` or `\n];`
  let depth = 1;
  let pos = idIdx;
  // walk back to opening { for this entry
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  // walk forward tracking braces
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    const ch = s[pos];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos; // position of closing }
  const entryText = s.substring(startBrace, endBrace + 1);

  // Build new entry text:
  // - If "deals" exists: insert/update bestbuy in it
  // - If no "deals": add deals at the end
  const dealText = formatBestbuyDeal({ url: u.bbUrl, price: u.bbPrice, inStock: u.bbInStock });
  let newEntry;
  if (entryText.includes('"deals":')) {
    // Has deals - check if bestbuy already exists
    if (entryText.includes('"bestbuy":')) {
      // Replace existing bestbuy
      newEntry = entryText.replace(/"bestbuy":\s*\{[^}]*\}/, '"bestbuy": ' + dealText);
    } else {
      // Add bestbuy to deals object
      // Find the deals { ... } and inject before closing }
      newEntry = entryText.replace(
        /("deals":\s*\{)([\s\S]*?)(\n\s*\})/,
        function(m, open, content, close) {
          // Trim trailing comma from content if present, then add new
          const trimmed = content.replace(/,?\s*$/, '');
          return open + trimmed + ', "bestbuy": ' + dealText + close;
        }
      );
    }
  } else {
    // No deals object - add it before the closing }
    newEntry = entryText.replace(/\n\s*\}$/, ',\n    "deals": {"bestbuy": ' + dealText + '}\n  }');
  }

  if (newEntry !== entryText) {
    s = s.substring(0, startBrace) + newEntry + s.substring(endBrace + 1);
    updatesApplied++;
  }
}

console.log('Updates applied: ' + updatesApplied + ' / ' + updates.length);

// =========================================================================
// Stage 2: Append new BB-only entries before the closing ];
// =========================================================================

if (newEntries.length > 0) {
  const closeIdx = s.lastIndexOf('];');
  if (closeIdx < 0) {
    console.log('FATAL: cannot find closing ]; in parts.js');
    process.exit(1);
  }

  function formatEntry(entry) {
    const lines = ['  {'];
    const keys = Object.keys(entry);
    keys.forEach((k, i) => {
      let v = entry[k];
      let line = '    "' + k + '": ';
      if (typeof v === 'string') {
        const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        line += '"' + escaped + '"';
      } else if (typeof v === 'number') {
        line += v;
      } else if (typeof v === 'boolean') {
        line += v;
      } else if (v === null) {
        line += 'null';
      } else if (typeof v === 'object') {
        line += JSON.stringify(v);
      }
      if (i < keys.length - 1) line += ',';
      lines.push(line);
    });
    lines.push('  }');
    return lines.join('\n');
  }

  let insertion = ',\n' + newEntries.map(formatEntry).join(',\n') + '\n';
  s = s.substring(0, closeIdx) + insertion + s.substring(closeIdx);
  console.log('New entries appended: ' + newEntries.length);
}

fs.writeFileSync(PARTS_PATH, s);
console.log('\n✓ parts.js updated');
console.log('  Run `npm run build` to verify.');
