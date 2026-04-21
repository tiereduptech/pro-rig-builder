#!/usr/bin/env node
/**
 * normalize-mobo-ff.js
 *
 * 1. Canonicalize existing ff values:
 *      microATX, μATX, μ-ATX → mATX
 *      ITX → Mini-ITX
 *      EATX → E-ATX
 *
 * 2. Infer missing ff from chipset model suffix:
 *      <Chipset>M  (e.g. B650M, B860M, Z890M, A620M) → mATX
 *      <Chipset>I  (e.g. B850I, X870I, H610I, B650I) → Mini-ITX
 *      <Chipset>   (no suffix, e.g. B550, Z790, X870) → ATX
 *      <Chipset>E  (e.g. X870E, B650E) → ATX (still full-size unless has M/I)
 *
 *    Explicit form-factor words in the name always win.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── STEP 1: NORMALIZE EXISTING ff VALUES ───────────────────────────────────
const FF_MAP = {
  'microATX': 'mATX',
  'μATX': 'mATX',
  'μ-ATX': 'mATX',
  'Micro-ATX': 'mATX',
  'Micro ATX': 'mATX',
  'ITX': 'Mini-ITX',
  'EATX': 'E-ATX',
};

let normalized = 0;
for (const p of parts) {
  if (p.c !== 'Motherboard' || p.ff == null) continue;
  if (FF_MAP[p.ff]) {
    p.ff = FF_MAP[p.ff];
    normalized++;
  }
}
console.log(`Normalized ${normalized} existing ff values`);

// ─── STEP 2: INFER ff FROM MODEL NAME ───────────────────────────────────────
function inferFF(name) {
  const n = String(name);

  // Explicit mentions always win (case-insensitive)
  if (/\bE[\s-]?ATX\b/i.test(n)) return 'E-ATX';
  if (/\bMini[\s-]?ITX\b/i.test(n)) return 'Mini-ITX';
  if (/\b(?:m[\s-]?ATX|micro[\s-]?ATX|microATX)\b/i.test(n)) return 'mATX';

  // Chipset + suffix pattern. Match models like:
  //   B650M, B850M, A520M, A620M, X870M, Z890M, B860M, B760M, H610M, etc.
  //   B850I, X870I, B650I, H610I, X870I
  //   B550, X570, Z790, B760, B850, X870, Z890, B860, A620
  // Suffix letter immediately after chipset digits.
  //
  // We look for a capital letter X/B/Z/A/H/W followed by 3-4 digits, then optional suffix
  const m = n.match(/\b([XBZAHW]\d{3}[A-Z]?)(M|I)?\b/);
  if (m) {
    const suffix = m[2];
    if (suffix === 'M') return 'mATX';
    if (suffix === 'I') return 'Mini-ITX';
    // No M/I → ATX (default for mainstream chipsets)
    return 'ATX';
  }

  // Older Intel H110 etc (3-digit with no letter prefix)
  if (/\bH1\d{2}M\b/i.test(n)) return 'mATX';
  if (/\bH1\d{2}\b/i.test(n)) return 'mATX'; // H110/H310 are typically mATX SKUs on budget boards

  return null;
}

let inferred = 0;
const inferences = [];
for (const p of parts) {
  if (p.c !== 'Motherboard') continue;
  if (p.ff != null) continue;
  const ff = inferFF(p.n);
  if (ff) {
    p.ff = ff;
    inferred++;
    if (inferences.length < 15) inferences.push(`  [${p.b}] → ${ff}  |  ${p.n.slice(0, 75)}`);
  }
}
console.log(`\nInferred ff for ${inferred} motherboards. Sample:`);
inferences.forEach(s => console.log(s));

// ─── REPORT ─────────────────────────────────────────────────────────────────
const mobos = parts.filter(p => p.c === 'Motherboard');
const after = {};
for (const p of mobos) {
  if (p.ff != null) after[p.ff] = (after[p.ff] || 0) + 1;
}
console.log('\n━━━ FINAL ff VALUES ━━━');
Object.entries(after).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(12)} ${v}`);
});

const missing = mobos.filter(p => p.ff == null);
console.log(`\nTotal motherboards: ${mobos.length}`);
console.log(`With ff: ${mobos.length - missing.length}  (${Math.round((mobos.length - missing.length) / mobos.length * 100)}%)`);
console.log(`Missing ff: ${missing.length}`);
if (missing.length) {
  console.log('\n━━━ Still missing ━━━');
  missing.forEach(p => console.log(`  [${p.b}] ${p.n.slice(0, 85)}`));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
