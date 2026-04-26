// enrich-gpu-length.cjs
// Adds GPU card length (mm) for partner cards missing the field

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Known partner card lengths (mm) - from manufacturer specs
// Match by series + chip family
const KNOWN_LENGTHS = [
  // ASUS TUF Gaming - typically large triple-fan cards
  { pattern: /asus tuf.*rtx 4080 super/i, len: 348 },
  { pattern: /asus tuf.*rtx 4080/i, len: 348 },
  { pattern: /asus tuf.*rtx 4070 ti super/i, len: 305 },
  { pattern: /asus tuf.*rtx 4070 ti/i, len: 305 },
  { pattern: /asus tuf.*rtx 4070 super/i, len: 305 },
  { pattern: /asus tuf.*rtx 4070/i, len: 305 },
  { pattern: /asus tuf.*rtx 3090 ti/i, len: 348 },
  { pattern: /asus tuf.*rtx 3090/i, len: 300 },
  { pattern: /asus tuf.*rtx 3080 ti/i, len: 300 },
  { pattern: /asus tuf.*rtx 3080/i, len: 300 },
  { pattern: /asus tuf.*rtx 3070 ti/i, len: 300 },
  { pattern: /asus tuf.*rtx 3070/i, len: 300 },
  { pattern: /asus tuf.*rtx 3060 ti/i, len: 300 },
  { pattern: /asus tuf.*rtx 3060/i, len: 300 },
  { pattern: /asus tuf.*rx 7900/i, len: 354 },
  { pattern: /asus tuf.*rx 6900|asus tuf.*rx 6800/i, len: 320 },
  { pattern: /asus tuf.*rx 6700/i, len: 320 },

  // ASUS ROG Strix - flagship triple-fan cards (huge)
  { pattern: /asus rog strix.*rtx 4090/i, len: 358 },
  { pattern: /asus rog strix.*rtx 4080/i, len: 358 },
  { pattern: /asus rog strix.*rtx 3090 ti/i, len: 354 },
  { pattern: /asus rog strix.*rtx 3090/i, len: 318 },
  { pattern: /asus rog strix.*rtx 3080/i, len: 318 },
  { pattern: /asus rog strix.*rtx 2080 super/i, len: 305 },
  { pattern: /asus rog strix.*rtx 2080/i, len: 305 },
  { pattern: /asus rog strix.*rtx 2070/i, len: 305 },
  { pattern: /asus rog strix.*rtx 2060/i, len: 305 },

  // ASUS Dual / Phoenix - smaller cards
  { pattern: /asus dual.*rtx 2070/i, len: 267 },
  { pattern: /asus dual.*rx 6600 xt/i, len: 243 },
  { pattern: /asus dual.*rx 5700/i, len: 243 },
  { pattern: /asus phoenix.*rtx 3060/i, len: 175 },
  { pattern: /asus.*rtx 2070 super/i, len: 269 },
  { pattern: /asus.*rtx 2060/i, len: 242 },

  // MSI Gaming X Trio - large triple-fan
  { pattern: /msi.*rtx 3090.*trio|msi.*rtx 3090$/i, len: 323 },
  { pattern: /msi.*rtx 3080 ti.*trio/i, len: 323 },
  { pattern: /msi.*rtx 3080.*trio|msi.*rtx 3080 lhr/i, len: 323 },
  { pattern: /msi.*rtx 3070 ti.*trio/i, len: 323 },

  // MSI Gaming - dual-fan smaller
  { pattern: /msi gaming.*rtx 4060/i, len: 247 },
  { pattern: /msi gaming.*rtx 3070/i, len: 247 },
  { pattern: /msi gaming.*rtx 3060 ti/i, len: 247 },
  { pattern: /msi gaming.*rtx 2080 ti/i, len: 297 },
  { pattern: /msi gaming.*rtx 2080 super/i, len: 247 },
  { pattern: /msi gaming.*rtx 2080/i, len: 247 },
  { pattern: /msi gaming.*rtx 2070 super/i, len: 247 },
  { pattern: /msi gaming.*rtx 2070/i, len: 247 },
  { pattern: /msi gaming.*rtx 2060 super/i, len: 247 },
  { pattern: /msi gaming.*rtx 2060/i, len: 247 },
  { pattern: /msi gaming.*rx 6900 xt/i, len: 324 },
  { pattern: /msi gaming.*rx 6800/i, len: 324 },
  { pattern: /msi gaming.*rx 6700/i, len: 277 },
  { pattern: /msi gaming.*rx 6600/i, len: 232 },
  { pattern: /msi gaming.*rx 6500/i, len: 200 },
  { pattern: /msi gaming.*rx 5700 xt/i, len: 297 },
  { pattern: /msi gaming.*rx 5700$/i, len: 247 },
  { pattern: /msi gaming.*rx 5500/i, len: 232 },
  { pattern: /msi.*rx 580/i, len: 269 },
  { pattern: /msi.*rx 570/i, len: 269 },

  // GIGABYTE Gaming OC - triple-fan medium-large
  { pattern: /gigabyte.*rtx 3090|aorus.*rtx 3090/i, len: 320 },
  { pattern: /gigabyte.*rtx 3080 ti|aorus.*rtx 3080 ti/i, len: 320 },
  { pattern: /gigabyte.*rtx 3080|aorus.*rtx 3080/i, len: 320 },
  { pattern: /gigabyte.*rtx 3070 ti|aorus.*rtx 3070 ti/i, len: 282 },
  { pattern: /gigabyte.*rtx 3070|aorus.*rtx 3070/i, len: 282 },
  { pattern: /gigabyte.*rtx 3060 ti|aorus.*rtx 3060 ti/i, len: 282 },
  { pattern: /gigabyte.*rtx 2080 ti turbo/i, len: 269 },
  { pattern: /gigabyte.*rtx 2070 super/i, len: 282 },
  { pattern: /gigabyte.*rx 6700 xt/i, len: 282 },
  { pattern: /gigabyte.*rx 6600 xt/i, len: 282 },
  { pattern: /gigabyte.*rx 6600/i, len: 282 },
  { pattern: /gigabyte.*rx 6500 xt/i, len: 192 },
  { pattern: /gigabyte.*rx 5700 xt/i, len: 280 },
  { pattern: /gigabyte.*rx 570/i, len: 232 },

  // Sparkle Intel Arc
  { pattern: /sparkle.*arc b580/i, len: 247 },
  { pattern: /sparkle.*arc b570/i, len: 247 },
  { pattern: /sparkle.*arc a770/i, len: 247 },
  { pattern: /sparkle.*arc a750/i, len: 247 },
  { pattern: /sparkle.*arc a380/i, len: 195 },
  { pattern: /arc a380 challenger itx/i, len: 165 },
];

// Fallback: estimate from chip family
function estimateLength(p) {
  const text = p.n;

  // Try known specific match first
  for (const { pattern, len } of KNOWN_LENGTHS) {
    if (pattern.test(text)) return len;
  }

  // Fallback by GPU tier (high-end = longer cards)
  if (/rtx 50(8|9)0|rtx 40(8|9)0|rtx 30(8|9)0|rtx 20(8|9)0|rx 79|rx 69|rx 6800|rx 7900/i.test(text)) {
    return 320; // flagship triple-fan
  }
  if (/rtx 50(6|7)0|rtx 40(6|7)0|rtx 30(6|7)0|rtx 20(6|7)0|rx 7700|rx 6700|rx 5700/i.test(text)) {
    return 280; // mid-high triple-fan
  }
  if (/rx 76|rx 66|rx 56|rx 580|rx 570|gtx 16|arc a7/i.test(text)) {
    return 250; // mid-range dual-fan
  }
  if (/rx 65|rx 64|rx 55|gtx 15|arc a3|arc b5/i.test(text)) {
    return 200; // budget short
  }
  return 240; // generic fallback
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

  let stats = { total: 0, exact: 0, fallback: 0, known: [], inferred: [] };

  for (const p of parts) {
    if (p.c !== 'GPU' || p.length) continue;
    stats.total++;

    // Check if known match
    let isKnown = false;
    for (const { pattern } of KNOWN_LENGTHS) {
      if (pattern.test(p.n)) { isKnown = true; break; }
    }

    const len = estimateLength(p);
    const r = setFields(s, p.id, { length: len });
    if (r.count > 0) {
      s = r.s;
      if (isKnown) { stats.exact++; }
      else { stats.fallback++; }
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('GPU length enrichment:');
  console.log('  Missing length: ' + stats.total);
  console.log('  Known model match: ' + stats.exact);
  console.log('  Tier-based fallback: ' + stats.fallback);
})();
