// enrich-fan-specs.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function extractRGB(p) {
  if (p.rgb != null) return null;
  const text = p.n + ' ' + (p.b || '');
  if (/non[-\s]?rgb|no[-\s]?rgb|black\s*$/i.test(text)) return false;
  if (/rgb|chroma|aura|argb|mystic light|infinity mirror/i.test(text)) return true;
  if (/noctua nf|brown/i.test(text)) return false; // Noctua brown fans no RGB
  return false; // default no RGB
}

function extractPack(p) {
  if (p.pack != null) return null;
  const text = p.n + ' ' + (p.b || '');
  // "3-pack", "3 pack", "Triple Pack", "Pack of 3"
  let m = text.match(/(\d+)[-\s]?pack/i);
  if (m) return parseInt(m[1]);
  m = text.match(/pack\s*of\s*(\d+)/i);
  if (m) return parseInt(m[1]);
  m = text.match(/(\d+)\s*x\s*(?:120|140|92|80)/i); // "3 x 120mm"
  if (m) return parseInt(m[1]);
  if (/triple/i.test(text)) return 3;
  if (/dual|twin/i.test(text)) return 2;
  if (/quad/i.test(text)) return 4;
  return 1;
}

function extractRPM(p) {
  if (p.rpm != null) return null;
  const text = p.n + ' ' + (p.b || '');
  const match = text.match(/(\d{3,4})\s*rpm/i);
  if (match) return parseInt(match[1]);
  return null;
}

function extractCFM(p) {
  if (p.cfm != null) return null;
  const text = p.n + ' ' + (p.b || '');
  const match = text.match(/(\d{2,3}(?:\.\d+)?)\s*cfm/i);
  if (match) return parseFloat(match[1]);
  // Estimate from size + RPM
  const size = p.size || 0;
  const rpm = p.rpm || 0;
  if (size > 0 && rpm > 0) {
    // Rough formula: bigger fan + higher RPM = more CFM
    // 120mm @ 1500 RPM ≈ 60 CFM
    // 140mm @ 1500 RPM ≈ 80 CFM
    if (size === 120) return Math.round(rpm * 0.04);
    if (size === 140) return Math.round(rpm * 0.055);
    if (size === 200) return Math.round(rpm * 0.08);
  }
  return null;
}

function extractPWM(p) {
  if (p.pwm != null) return null;
  const text = p.n + ' ' + (p.b || '');
  if (/pwm|4[-\s]?pin/i.test(text)) return true;
  if (/3[-\s]?pin/i.test(text)) return false;
  return null;
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

  let stats = { total: 0, rgb: 0, pack: 0, rpm: 0, cfm: 0, pwm: 0 };

  for (const p of parts) {
    if (p.c !== 'CaseFan') continue;
    stats.total++;
    const fields = {};
    const r1 = extractRGB(p);
    if (r1 != null) { fields.rgb = r1; stats.rgb++; }
    const r2 = extractPack(p);
    if (r2 != null) { fields.pack = r2; stats.pack++; }
    const r3 = extractRPM(p);
    if (r3 != null) { fields.rpm = r3; stats.rpm++; }
    const r4 = extractCFM(p);
    if (r4 != null) { fields.cfm = r4; stats.cfm++; }
    const r5 = extractPWM(p);
    if (r5 != null) { fields.pwm = r5; stats.pwm++; }

    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) s = r.s;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('CaseFan enrichment (n=' + stats.total + '):');
  console.log('  rgb added: ' + stats.rgb);
  console.log('  pack added: ' + stats.pack);
  console.log('  rpm added: ' + stats.rpm);
  console.log('  cfm added: ' + stats.cfm);
  console.log('  pwm added: ' + stats.pwm);
})();
