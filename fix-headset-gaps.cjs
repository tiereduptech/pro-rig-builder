// fix-headset-gaps.cjs
const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

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

// Headset specs from product knowledge
// Format: { hsType, driver (mm), mic (bool), anc (bool) }
const KNOWN_SPECS = {
  // Audio-Technica M-series
  100029: { hsType: 'Wired', driver: 45, mic: false, anc: false },          // ATH-M50X
  100036: { hsType: 'Wired', driver: 40, mic: false, anc: false },          // ATH-M20x
  100043: { hsType: 'Wired', driver: 40, mic: false, anc: false },          // ATH-M30x
  100045: { hsType: 'Wired', driver: 40, mic: false, anc: false },          // ATH-M40x

  // Sennheiser
  97012: { hsType: 'Wired' },                                                // HD 560S (driver already there)
  100046: { driver: 38, mic: false, anc: false },                            // HD 599 SE
  100048: { driver: 38, mic: false, anc: false },                            // HD 560S
  100054: { hsType: 'Wired', driver: 40, mic: false, anc: false },          // HD 280 Pro
  100058: { hsType: 'Wired', driver: 38, mic: false, anc: false },          // HD 560S (dup)

  // Beyerdynamic
  97013: { hsType: 'Wired' },                                                // DT 900 Pro X
  100033: { driver: 45, mic: false, anc: false },                            // DT 770 PRO 80 Ohm

  // Sony
  100034: { hsType: 'Wired', driver: 40, mic: false, anc: false },          // MDR-7506
  100050: { hsType: 'Wireless', driver: 30, mic: true, anc: true },         // WH-1000XM5
  100051: { hsType: 'Wireless', driver: 30, mic: true, anc: true },         // WH-1000XM5 (dup)
  100062: { driver: 30, mic: true, anc: true },                              // WH-1000XM6
  100226: { driver: 50, mic: true, anc: false },                             // Sony PULSE Elite
  100236: { driver: 40, mic: true, anc: true },                              // Sony INZONE H9
  100237: { driver: 40, mic: true, anc: false },                             // Sony INZONE H3
  100240: { driver: 8, mic: true, anc: true },                               // Sony INZONE Buds
  100241: { driver: 40, mic: true, anc: false },                             // Sony INZONE H5
  100257: { driver: 9, mic: true, anc: false },                              // Sony INZONE E9 IEM

  // HyperX Cloud
  100035: { driver: 53, mic: true, anc: false },                             // HyperX Cloud II
  100047: { driver: 40, mic: true, anc: false },                             // HyperX Cloud Stinger Core
  100061: { driver: 50, mic: true, anc: false },                             // HyperX Cloud Alpha Wireless
  100225: { driver: 40, mic: true, anc: false },                             // HyperX CloudX Stinger 2
  100243: { driver: 40, mic: true, anc: false },                             // HyperX Cloud Mini
  100254: { driver: 40, mic: true, anc: false },                             // HyperX Cloud Jet Dual
  100259: { driver: 40, mic: true, anc: false },                             // HyperX Cloud Flight 2

  // SteelSeries Arctis
  100040: { driver: 40, mic: true, anc: false },                             // Arctis Nova 5
  100250: { driver: 6, mic: true, anc: true },                               // Arctis GameBuds
  100252: { driver: 40, mic: true, anc: false },                             // Arctis Pro Wireless

  // Logitech G
  100041: { driver: 40, mic: true, anc: false },                             // G733 Lightspeed
  100049: { driver: 50, mic: true, anc: false },                             // G432
  100055: { driver: 40, mic: true, anc: false },                             // G435
  100057: { driver: 40, mic: true, anc: false },                             // G335
  100227: { driver: 40, mic: true, anc: false },                             // G535
  100231: { driver: 50, mic: true, anc: false },                             // G935
  100233: { driver: 50, mic: true, anc: false },                             // G PRO X (Gen 2)
  100239: { driver: 50, mic: true, anc: false },                             // G PRO X 2 LIGHTSPEED
  100255: { driver: 40, mic: true, anc: false },                             // G522
  100258: { driver: 40, mic: true, anc: false },                             // G321

  // Astro Gaming
  100223: { driver: 40, mic: true, anc: false },                             // A20 Gen 2 Wireless
  100224: { driver: 40, mic: true, anc: false },                             // A10 Gen 2 Wired
  100229: { driver: 40, mic: true, anc: false },                             // A50 X LIGHTSPEED
  100230: { driver: 40, mic: true, anc: false },                             // A20 X LIGHTSPEED
  100251: { driver: 40, mic: true, anc: false },                             // A50 Gen 5

  // Turtle Beach
  100032: { driver: 40, mic: true, anc: false },                             // Stealth 500
  100053: { driver: 50, mic: true, anc: false },                             // Stealth 600
  100056: { driver: 40, mic: true, anc: false },                             // Recon 70
  100228: { driver: 40, mic: true, anc: false },                             // Atlas 200
  100232: { driver: 14, mic: true, anc: false },                             // Battle Buds

  // Razer
  100060: { hsType: 'Wired', driver: 50, mic: true, anc: false },           // Kraken Gaming
  100235: { driver: 40, mic: true, anc: false },                             // Barracuda X 2022
  100244: { driver: 40, mic: true, anc: false },                             // Kraken Kitty V3 X
  100256: { driver: 40, mic: true, anc: false },                             // BlackShark V3 X

  // Corsair
  100234: { driver: 50, mic: true, anc: false },                             // HS80 RGB
  100238: { driver: 50, mic: true, anc: false },                             // HS55 SURROUND v2
  100242: { driver: 50, mic: true, anc: false },                             // VIRTUOSO PRO Open Back
  100249: { driver: 50, mic: true, anc: false },                             // VIRTUOSO MAX
  100253: { driver: 50, mic: true, anc: false },                             // VOID v2

  // JBL
  100245: { driver: 40, mic: true, anc: false },                             // Quantum 100X
  100246: { driver: 40, mic: true, anc: false },                             // Quantum 100P
  100247: { driver: 50, mic: true, anc: true },                              // Quantum 910X
  100248: { driver: 50, mic: true, anc: true },                              // Quantum 910P

  // Misc
  100039: { driver: 40, mic: false, anc: false },                            // Misc A71 Studio
  100044: { hsType: 'Wired', driver: 40, mic: true, anc: false },           // CloudX Xbox
  100063: { driver: 50, mic: true, anc: false },                             // FIFINE USB Headset
  100064: { driver: 40, mic: true, anc: false },                             // Valorise Wireless
};

let updateCount = 0;
let totalFields = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const r = addFields(s, parseInt(idStr), fields);
  if (r.count > 0) { s = r.s; updateCount++; totalFields += r.count; }
}

fs.writeFileSync(PARTS_PATH, s);
console.log('Updated ' + updateCount + ' headsets (' + totalFields + ' fields)');
