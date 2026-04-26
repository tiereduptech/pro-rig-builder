// clean-expansion-cards.cjs
// Remove bad fits from WiFiCard, SoundCard

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const BAD_ASINS = [
  'B09G5W9R6R',  // Archer AX55 router (not a card)
  'B09MLPC8X3',  // AIYIMA T9 speaker amp (not sound card)
  'B09Q65NHN1',  // Generic "Sound Card 30SB157000" - sketchy listing
];

const BAD_PATTERNS = [
  /\brouter\b/i,
  /speaker amplifier|power amplifier|stereo amplifier/i,
  /class[- ]?d amplifier/i,
];

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  const targetCats = ['WiFiCard', 'EthernetCard', 'OpticalDrive', 'SoundCard'];
  const toRemove = [];

  for (const p of parts) {
    if (!targetCats.includes(p.c)) continue;
    const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (BAD_ASINS.includes(asin)) {
      toRemove.push(p);
      continue;
    }
    if (BAD_PATTERNS.some(rx => rx.test(p.n))) {
      toRemove.push(p);
    }
  }

  console.log('To remove: ' + toRemove.length);
  toRemove.forEach(p => console.log('  c=' + p.c + ' id=' + p.id + ' | ' + p.n.substring(0, 65)));

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
  console.log('\n✓ Removed ' + toRemove.length + ' bad entries');

  // Final counts
  const m2 = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + (Date.now()+1));
  const parts2 = m2.PARTS || m2.default;
  console.log('\nFinal counts:');
  for (const c of targetCats) {
    console.log('  ' + c + ': ' + parts2.filter(p => p.c === c).length);
  }
})();
