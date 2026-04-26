// enrich-ram-specs.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Known module heights (mm) by series - low-profile is critical for big air coolers
const KNOWN_HEIGHTS = [
  { pattern: /vengeance lpx|low.profile/i, height: 31 },
  { pattern: /corsair vengeance(?!\s*rgb).*ddr5/i, height: 35 },
  { pattern: /corsair vengeance rgb/i, height: 56 },
  { pattern: /corsair dominator/i, height: 56 },
  { pattern: /g\.skill ripjaws v|g\.skill flare/i, height: 42 },
  { pattern: /g\.skill trident z royal/i, height: 44 },
  { pattern: /g\.skill trident z neo|trident z5 neo/i, height: 44 },
  { pattern: /g\.skill trident z5/i, height: 42 },
  { pattern: /g\.skill trident z/i, height: 44 },
  { pattern: /kingston fury beast/i, height: 35 },
  { pattern: /kingston fury renegade/i, height: 39 },
  { pattern: /kingston hyperx/i, height: 35 },
  { pattern: /crucial ballistix/i, height: 39 },
  { pattern: /crucial pro/i, height: 31 },
  { pattern: /crucial.*ddr5/i, height: 31 },
  { pattern: /teamgroup t.force vulcan/i, height: 32 },
  { pattern: /teamgroup t.force delta/i, height: 49 },
  { pattern: /teamgroup t.force xtreem/i, height: 45 },
  { pattern: /patriot viper steel/i, height: 44 },
  { pattern: /patriot viper venom/i, height: 39 },
  { pattern: /xpg lancer|adata lancer/i, height: 35 },
  { pattern: /xpg spectrix/i, height: 49 },
];

function extractRamType(p) {
  if (p.ramType) return null;
  if (p.memType) return p.memType;
  return null;
}

function extractHeight(p) {
  if (p.height != null) return null;
  for (const { pattern, height } of KNOWN_HEIGHTS) {
    if (pattern.test(p.n)) return height;
  }
  // Default: most RGB RAM is ~45mm tall, non-RGB is ~32mm
  if (/rgb|argb|aura/i.test(p.n)) return 45;
  return 32; // standard low/mid profile
}

function extractForm(p) {
  if (p.form) return null;
  if (/sodimm|so.dimm|so dimm|laptop/i.test(p.n)) return 'SODIMM';
  return 'DIMM'; // default desktop form
}

function extractColor(p) {
  if (p.color) return null;
  const text = p.n.toLowerCase();
  if (/white|royal/i.test(text)) return 'White';
  if (/silver/i.test(text)) return 'Silver';
  if (/grey|gray/i.test(text)) return 'Gray';
  if (/red/i.test(text)) return 'Red';
  if (/blue/i.test(text)) return 'Blue';
  if (/pink/i.test(text)) return 'Pink';
  return 'Black';
}

function extractECC(p) {
  if (p.ecc != null) return null;
  if (/ecc|registered|rdimm|server/i.test(p.n)) return true;
  return false;
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

  let stats = { total: 0, ramType: 0, height: 0, form: 0, color: 0, ecc: 0 };

  for (const p of parts) {
    if (p.c !== 'RAM') continue;
    stats.total++;
    const fields = {};
    const r1 = extractRamType(p);
    if (r1 != null) { fields.ramType = r1; stats.ramType++; }
    const r2 = extractHeight(p);
    if (r2 != null) { fields.height = r2; stats.height++; }
    const r3 = extractForm(p);
    if (r3 != null) { fields.form = r3; stats.form++; }
    const r4 = extractColor(p);
    if (r4 != null) { fields.color = r4; stats.color++; }
    const r5 = extractECC(p);
    if (r5 != null) { fields.ecc = r5; stats.ecc++; }

    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) s = r.s;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('RAM enrichment (n=' + stats.total + '):');
  console.log('  ramType added: ' + stats.ramType);
  console.log('  height added: ' + stats.height);
  console.log('  form added: ' + stats.form);
  console.log('  color added: ' + stats.color);
  console.log('  ecc added: ' + stats.ecc);
})();
