// fix-microphone-gaps.cjs
// Normalizes mic field misclassifications and fills gaps

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

function setFields(s, id, fields) {
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
  let entryText = s.substring(startBrace, endBrace + 1);
  let count = 0;

  for (const [k, v] of Object.entries(fields)) {
    let formatted = typeof v === 'string' ? '"' + v + '"' : v;
    const fieldRegex = new RegExp('"' + k + '":\\s*("[^"]*"|\\d+|true|false)', '');
    if (fieldRegex.test(entryText)) {
      // Replace existing value
      entryText = entryText.replace(fieldRegex, '"' + k + '": ' + formatted);
      count++;
    } else {
      // Add new field before closing brace
      const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
      if (matchClosing) {
        const before = matchClosing[1];
        const closing = matchClosing[2];
        entryText = before.replace(/,?\s*$/, '') + ',\n    "' + k + '": ' + formatted + closing;
        count++;
      }
    }
  }

  if (count === 0) return { s, count: 0 };
  return { s: s.substring(0, startBrace) + entryText + s.substring(endBrace + 1), count };
}

// Microphone specs - normalize micType (USB/XLR/Wireless) and pattern (Cardioid/etc.)
// Format: { micType, pattern, sampleRate (kHz) }
const KNOWN_SPECS = {
  // Existing curated mics (95xxx) - already mostly good
  97500: { sampleRate: 96 },                                        // Elgato Wave:3
  97501: { pattern: 'Multi-Pattern', sampleRate: 96 },              // HyperX QuadCast S
  97502: { sampleRate: 48 },                                        // Rode NT-USB Mini
  97503: { pattern: 'Multi-Pattern', sampleRate: 48 },              // Blue Yeti X

  // Cleanup misclassified existing values + fill
  100065: { micType: 'USB', pattern: 'Multi-Pattern', sampleRate: 48 }, // Blue Yeti USB
  100066: { pattern: 'Cardioid', sampleRate: 44 },                  // Audio-Technica AT2020 (XLR already correct)
  100067: { sampleRate: 0 },                                        // Shure SM58 (XLR/Dynamic, no sample rate)
  100068: { micType: 'XLR', sampleRate: 0 },                        // Rode PodMic XLR
  100069: { sampleRate: 0 },                                        // Shure SM57 XLR
  100070: { micType: 'Wireless', pattern: 'Omnidirectional', sampleRate: 48 }, // DJI Mic Mini
  100071: { micType: 'Wireless', pattern: 'Omnidirectional' },      // Hollyland Lark M2 (sampleRate already 48)
  100072: { pattern: 'Cardioid', sampleRate: 192 },                 // FIFINE XLR/USB
  100073: { sampleRate: 192 },                                      // MAONO already has 192
  100074: { sampleRate: 96 },                                       // HyperX SoloCast
  100075: { sampleRate: 0 },                                        // Shure MV7X XLR
  100076: { pattern: 'Omnidirectional', sampleRate: 48 },           // RØDE Wireless Micro

  // BB-merged mics (100260+)
  100260: { sampleRate: 44 },                                       // Samson Q2U USB Dynamic
  100261: { micType: 'XLR', sampleRate: 0 },                        // RØDE PODMIC XLR
  100262: { sampleRate: 0 },                                        // Shure MV7X XLR (dup)
  100263: { sampleRate: 48 },                                       // RØDE PodMic USB
  100264: { micType: 'XLR', pattern: 'Supercardioid', sampleRate: 0 }, // Logitech Yeti GX (XLR Dynamic)
  100265: { micType: 'XLR', pattern: 'Cardioid', sampleRate: 0 },   // Logitech Yeticaster GX
  100266: { sampleRate: 48 },                                       // Shure MV7+ USB
  100267: { sampleRate: 96 },                                       // Shure MV6
  100268: { sampleRate: 96 },                                       // FIFINE XLR/USB Cardioid Dynamic
  100269: { sampleRate: 96 },                                       // FIFINE AM8T Bundle
  100270: { pattern: 'Multi-Pattern', sampleRate: 48 },             // Blue Yeti Pro Multi-Pattern
  100271: { pattern: 'Multi-Pattern', sampleRate: 48 },             // Blue Yeti Nano
  100272: { sampleRate: 96 },                                       // Razer Seiren V2 Pro
  100273: { pattern: 'Cardioid', sampleRate: 48 },                  // RØDE NT-USB+ (cardioid)
  100274: { micType: 'XLR', pattern: 'Cardioid', sampleRate: 0 },   // RØDE NT1 5th Gen
  100275: { micType: 'USB', sampleRate: 48 },                       // Logitech Yeti Orb
  100276: { sampleRate: 48 },                                       // Razer Seiren V3 Mini
  100277: { pattern: 'Multi-Pattern', sampleRate: 96 },             // HyperX QuadCast 2
  100278: { sampleRate: 96 },                                       // FIFINE Gaming Bundle
  100279: { pattern: 'Cardioid', sampleRate: 192 },                 // FIFINE A6V
  100280: { sampleRate: 96 },                                       // HyperX SoloCast 2
  100281: { sampleRate: 0 },                                        // Shure SM7B XLR
};

let updateCount = 0;
let totalFields = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const r = setFields(s, parseInt(idStr), fields);
  if (r.count > 0) { s = r.s; updateCount++; totalFields += r.count; }
}

fs.writeFileSync(PARTS_PATH, s);
console.log('Updated ' + updateCount + ' mics (' + totalFields + ' field changes)');
