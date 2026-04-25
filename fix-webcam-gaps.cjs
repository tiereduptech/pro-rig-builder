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

// Webcam specs from product knowledge
// Format: { fps, autofocus }
const KNOWN_SPECS = {
  // Logitech C-series (mostly 30fps with autofocus)
  100077: { fps: 30, autofocus: true },                  // C920 HD Pro
  100078: { autofocus: true },                            // C920x HD Pro (already has fps)
  100079: { autofocus: true },                            // C922x HD Pro
  100080: { fps: 30, autofocus: true },                  // C920e
  100081: { autofocus: true },                            // C920S HD Pro
  100086: { fps: 30, autofocus: false },                 // C960 (fixed focus)
  100092: { fps: 30, autofocus: false },                 // C960 1080P (fixed focus)
  100094: { fps: 30, autofocus: true },                  // (any other C-series)

  // Logitech Brio
  100091: { fps: 30, autofocus: true },                  // Brio 4K
  100093: { fps: 30, autofocus: true },                  // Brio 301

  // Logitech AI/streaming
  100090: { autofocus: true },                            // MX Brio (already has fps)

  // BB-merged Logitech
  100282: { fps: 30, autofocus: true },                  // Pro Webcam 1080
  100283: { fps: 30, autofocus: true },                  // C922 Pro Stream
  100284: { fps: 30, autofocus: true },                  // 4K Pro
  100285: { fps: 30, autofocus: true },                  // Brio Ultra HD Pro
  100286: { fps: 30, autofocus: true },                  // C920s Pro
  100287: { fps: 60, autofocus: true },                  // StreamCam Plus
  100288: { fps: 30, autofocus: true },                  // C920e Full HD
  100289: { fps: 30, autofocus: true },                  // Brio 500
  100290: { fps: 30, autofocus: false },                 // Brio 100 (fixed focus)
  100291: { fps: 60, autofocus: true },                  // MX Brio
  100294: { fps: 30, autofocus: false },                 // C270 (fixed focus)

  // Insta360 / OBSBOT / 4K specialty
  100082: { fps: 30, autofocus: true },                  // Insta360 Link 2C
  100083: { fps: 30, autofocus: true },                  // Generic 4K Webcam
  100084: { fps: 30, autofocus: true },                  // N930AF (autofocus in name)
  100085: { fps: 30, autofocus: true },                  // Insta360 Link 2 PTZ
  100088: { autofocus: true },                            // Meet SE (already 100fps)
  100089: { autofocus: true },                            // OBSBOT Tiny 2 Lite
  100292: { fps: 30, autofocus: true },                  // Insta360 Link 2 PTZ
  100293: { fps: 30, autofocus: true },                  // Insta360 Link 2C
};

let updateCount = 0;
let totalFields = 0;
for (const [idStr, fields] of Object.entries(KNOWN_SPECS)) {
  const r = addFields(s, parseInt(idStr), fields);
  if (r.count > 0) { s = r.s; updateCount++; totalFields += r.count; }
}

fs.writeFileSync(PARTS_PATH, s);
console.log('Updated ' + updateCount + ' webcams (' + totalFields + ' fields)');
