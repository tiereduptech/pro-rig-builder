// enrich-psu-specs.cjs
// Fills atx3, fanSize, rgb, fans for PSUs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function extractATX3(p) {
  if (p.atx3 != null) return null;
  const text = p.n + ' ' + (p.b || '');
  if (/atx 3\.0|atx3\.0|atx 3\.1|atx3\.1|atx 3|atx3|pcie 5/i.test(text)) return true;
  // Newer high-wattage products from major brands almost always ATX 3.0+
  const w = p.watts || 0;
  if (w >= 1000 && /corsair|seasonic|asus|msi|nzxt|be quiet|evga|cooler master|thermaltake/i.test(p.b || '')) {
    // Could be older; check for explicit "ATX 2" or year clues
    if (/atx 2\.|2020|2019|2018/i.test(text)) return false;
    return true;
  }
  return false; // default older spec
}

function extractFanSize(p) {
  if (p.fanSize != null) return null;
  const text = p.n + ' ' + (p.b || '');
  let m = text.match(/(\d{2,3})\s*mm\s*fan/i);
  if (m) return parseInt(m[1]);
  // Estimate by wattage and form factor
  const w = p.watts || 0;
  if (/sfx-l|sfx l/i.test(text)) return 120;
  if (/sfx/i.test(text)) return 92;
  if (w >= 1200) return 140;
  if (w >= 750) return 135;
  if (w >= 500) return 120;
  return 120;
}

function extractRGB(p) {
  if (p.rgb != null) return null;
  const text = p.n + ' ' + (p.b || '');
  if (/rgb|argb|aura|chroma|infinity mirror|icue link/i.test(text)) return true;
  return false;
}

function extractFans(p) {
  if (p.fans != null) return null;
  const text = p.n + ' ' + (p.b || '');
  if (/fanless|passive/i.test(text)) return 0;
  // Most PSUs have 1 fan; some flagships have 2
  if (/dual fan|2 fan|two fan/i.test(text)) return 2;
  return 1;
}

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
    if (v == null) continue;
    if (entryText.includes('"' + k + '":')) continue;
    let formatted = typeof v === 'string' ? '"' + v + '"' : v;
    const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
    if (matchClosing) {
      const before = matchClosing[1];
      const closing = matchClosing[2];
      entryText = before.replace(/,?\s*$/, '') + ',\n    "' + k + '": ' + formatted + closing;
      count++;
    }
  }
  if (count === 0) return { s, count: 0 };
  return { s: s.substring(0, startBrace) + entryText + s.substring(endBrace + 1), count };
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  let stats = { total: 0, atx3: 0, fanSize: 0, rgb: 0, fans: 0 };

  for (const p of parts) {
    if (p.c !== 'PSU') continue;
    stats.total++;
    const fields = {};
    const r1 = extractATX3(p);
    if (r1 != null) { fields.atx3 = r1; stats.atx3++; }
    const r2 = extractFanSize(p);
    if (r2 != null) { fields.fanSize = r2; stats.fanSize++; }
    const r3 = extractRGB(p);
    if (r3 != null) { fields.rgb = r3; stats.rgb++; }
    const r4 = extractFans(p);
    if (r4 != null) { fields.fans = r4; stats.fans++; }

    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) s = r.s;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('PSU enrichment (n=' + stats.total + '):');
  console.log('  atx3 added: ' + stats.atx3);
  console.log('  fanSize added: ' + stats.fanSize);
  console.log('  rgb added: ' + stats.rgb);
  console.log('  fans added: ' + stats.fans);
})();
