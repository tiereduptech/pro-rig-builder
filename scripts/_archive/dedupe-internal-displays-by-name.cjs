// dedupe-internal-displays-by-name.cjs
// When 2+ products have the same name (ASIN variants), keep only the cheapest

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const internal = parts.filter(p => p.c === 'InternalDisplay');

  // Group by normalized name (first 60 chars, lowercase)
  const groups = {};
  for (const p of internal) {
    const key = p.n.substring(0, 60).toLowerCase().trim();
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }

  // Find duplicates (groups with 2+ entries)
  const toRemove = [];
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > 1) {
      // Keep cheapest
      items.sort((a, b) => (a.pr || 999) - (b.pr || 999));
      const keep = items[0];
      const dupes = items.slice(1);
      console.log('Duplicate group: "' + key.substring(0,50) + '"');
      console.log('  KEEP id=' + keep.id + ' $' + keep.pr);
      dupes.forEach(d => {
        console.log('  REMOVE id=' + d.id + ' $' + d.pr);
        toRemove.push(d);
      });
    }
  }

  if (toRemove.length === 0) {
    console.log('No duplicates found.');
    return;
  }

  let s = fs.readFileSync(PARTS_PATH, 'utf8');
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
    let removeStart = startBrace;
    let removeEnd = endBrace + 1;
    let p2 = startBrace - 1;
    while (p2 > 0 && /\s/.test(s[p2])) p2--;
    if (s[p2] === ',') removeStart = p2;
    s = s.substring(0, removeStart) + s.substring(removeEnd);
  }
  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Removed ' + toRemove.length + ' duplicates');
})();
