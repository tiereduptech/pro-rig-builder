// Remove the broken Windows 11 entries (bad ASINs)
const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const badOS = parts.filter(p => p.c === 'OS');
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  for (const p of badOS) {
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
    console.log('Removed: ' + p.n);
  }
  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Removed ' + badOS.length + ' broken OS entries');
  console.log('  Run fetch-niche-categories.cjs to add verified replacements');
})();
