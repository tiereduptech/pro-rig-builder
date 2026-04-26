// clean-internal-displays.cjs
// Removes incorrectly-categorized products from InternalDisplay
// Bad: 15.6"+ laptop monitors, full PC cases, display cabinets/boxes

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const BAD_PATTERNS = [
  /portable.*monitor/i,        // laptop portable monitors
  /15\.6|15\"/i,                // 15.6 inch
  /14\.1|14\"|14 inch/i,        // 14 inch
  /11\.6|11\"|11 inch/i,        // 11.6 inch
  /16\"|16 inch|17\"|17 inch/i, // 16-17 inch
  /hyte y70|atx mid tower|atx case/i, // PC cases
  /display cabinet|adjustable shelves|bookcase|acrylic display/i, // furniture
  /display case for collect/i,  // display cases for items
];

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const internalDisplays = parts.filter(p => p.c === 'InternalDisplay');

  console.log('Total InternalDisplay products: ' + internalDisplays.length);

  const toRemove = [];
  for (const p of internalDisplays) {
    for (const bad of BAD_PATTERNS) {
      if (bad.test(p.n)) {
        toRemove.push(p);
        break;
      }
    }
  }

  console.log('To remove: ' + toRemove.length);
  toRemove.forEach(p => console.log('  REMOVE id=' + p.id + ' | ' + p.n.substring(0, 70)));

  if (toRemove.length === 0) {
    console.log('Nothing to remove.');
    return;
  }

  // Remove entries from parts.js
  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  let removedCount = 0;

  for (const p of toRemove) {
    const idMarker = '"id": ' + p.id + ',';
    const idIdx = s.indexOf(idMarker);
    if (idIdx < 0) continue;

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

    // Also consume the leading or trailing comma
    let removeStart = startBrace;
    let removeEnd = endBrace + 1;

    // Look backwards for a comma + whitespace to remove with the entry
    let p2 = startBrace - 1;
    while (p2 > 0 && /\s/.test(s[p2])) p2--;
    if (s[p2] === ',') {
      removeStart = p2;
    } else {
      // Look forward instead - this is the first entry, remove trailing comma
      let p3 = endBrace + 1;
      while (p3 < s.length && /\s/.test(s[p3])) p3++;
      if (s[p3] === ',') removeEnd = p3 + 1;
    }

    s = s.substring(0, removeStart) + s.substring(removeEnd);
    removedCount++;
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Removed ' + removedCount + ' bad entries');

  // Verify count
  const m2 = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + (Date.now() + 1));
  const remaining = (m2.PARTS || m2.default).filter(p => p.c === 'InternalDisplay');
  console.log('Remaining InternalDisplay products: ' + remaining.length);
  remaining.forEach(p => console.log('  KEEP id=' + p.id + ' | ' + p.n.substring(0, 70)));
})();
