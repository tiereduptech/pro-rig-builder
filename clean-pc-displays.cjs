// clean-pc-displays.cjs
// Removes products misclassified as InternalDisplay

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const BAD_PATTERNS = [
  /sceptre/i,                       // gaming monitors
  /hyte y70/i,                      // PC case
  /aio cooler|liquid cooler|aio$/i, // AIOs (even with displays)
  /uni fan|tl lcd.*fan|fan.*tl lcd/i, // Lian Li fans
  /hydroshift/i,                    // AIO cooler
  /atx mid tower/i,                 // PC cases
  /portable monitor.*laptop/i,      // laptop monitors
  /16:9 gaming monitor|gaming monitor 24|gaming monitor 27/i,
];

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const internal = parts.filter(p => p.c === 'InternalDisplay');
  console.log('Total InternalDisplay: ' + internal.length);

  const toRemove = internal.filter(p => BAD_PATTERNS.some(bad => bad.test(p.n)));
  console.log('To remove: ' + toRemove.length);
  toRemove.forEach(p => console.log('  REMOVE id=' + p.id + ' | ' + p.n.substring(0,70)));

  if (toRemove.length === 0) return;

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

  // Verify
  const m2 = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + (Date.now()+1));
  const remaining = (m2.PARTS || m2.default).filter(p => p.c === 'InternalDisplay');
  console.log('\n✓ Removed ' + toRemove.length + ' bad entries');
  console.log('Remaining: ' + remaining.length);
  remaining.forEach(p => console.log('  KEEP id=' + p.id + ' | ' + p.n.substring(0,70)));

  // Also dedupe by ASIN (we have the Lian Li twice)
  const asinSeen = new Set();
  const dupes = [];
  for (const p of remaining) {
    const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (asin && asinSeen.has(asin)) dupes.push(p);
    if (asin) asinSeen.add(asin);
  }
  if (dupes.length > 0) {
    console.log('\nDuplicate ASINs to remove: ' + dupes.length);
    dupes.forEach(p => console.log('  DUPE id=' + p.id + ' | ' + p.n.substring(0,60)));
    let s2 = fs.readFileSync(PARTS_PATH, 'utf8');
    for (const p of dupes) {
      const idMarker = '"id": ' + p.id + ',';
      const idIdx = s2.indexOf(idMarker);
      if (idIdx < 0) continue;
      let pos = idIdx;
      while (pos > 0 && s2[pos] !== '{') pos--;
      const startBrace = pos;
      let depth = 1;
      pos = startBrace + 1;
      while (pos < s2.length && depth > 0) {
        if (s2[pos] === '{') depth++;
        else if (s2[pos] === '}') depth--;
        if (depth === 0) break;
        pos++;
      }
      const endBrace = pos;
      let removeStart = startBrace;
      let removeEnd = endBrace + 1;
      let p2 = startBrace - 1;
      while (p2 > 0 && /\s/.test(s2[p2])) p2--;
      if (s2[p2] === ',') removeStart = p2;
      s2 = s2.substring(0, removeStart) + s2.substring(removeEnd);
    }
    fs.writeFileSync(PARTS_PATH, s2);
    console.log('✓ Removed duplicate entries');
  }
})();
