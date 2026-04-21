#!/usr/bin/env node
/**
 * normalize-storage-formfactor.js — collapse 20+ form factor variants
 * into clean canonical values: M.2 2280, 2.5", 3.5", mSATA.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function canonical(ff, productName = '') {
  if (ff == null) return null;
  const t = String(ff).toLowerCase().trim();
  const n = String(productName).toLowerCase();

  // M.2 variants (all collapse to "M.2 2280" if we can confirm 2280, else "M.2")
  if (/m\.?\s*2\b|m2\b/.test(t)) {
    // If the spec says 2280, or the product name says 2280, it's M.2 2280
    if (/2280/.test(t) || /2280/.test(n)) return 'M.2 2280';
    if (/2230/.test(t) || /2230/.test(n)) return 'M.2 2230';
    if (/2242/.test(t) || /2242/.test(n)) return 'M.2 2242';
    if (/22110/.test(t) || /22110/.test(n)) return 'M.2 22110';
    // Default M.2 SSDs are 2280 by convention
    return 'M.2 2280';
  }
  if (/2280/.test(t)) return 'M.2 2280';

  // 2.5-inch variants
  if (/2\.5/.test(t)) return '2.5"';
  if (/2,5/.test(t)) return '2.5"';
  if (/2\.28/.test(t)) return '2.5"';  // "2.28 inches" looks like OCR error for 2.5

  // 3.5-inch variants
  if (/3\.5/.test(t)) return '3.5"';

  // mSATA
  if (/msata/.test(t)) return 'mSATA';

  // Junk/ambiguous values — delete
  if (/^(bar|compact|custom|laptop)$/i.test(t)) return null;

  return String(ff);  // unknown — leave alone
}

const before = {};
const after = {};
let changed = 0;
let cleared = 0;

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.ff == null) continue;
  before[p.ff] = (before[p.ff] || 0) + 1;
  const canon = canonical(p.ff, p.n);
  if (canon === null) {
    delete p.ff;
    cleared++;
  } else if (canon !== p.ff) {
    p.ff = canon;
    changed++;
  }
  if (p.ff != null) after[p.ff] = (after[p.ff] || 0) + 1;
}

console.log(`Changed: ${changed}  Cleared (junk values): ${cleared}`);

console.log(`\n━━━ BEFORE ━━━`);
Object.entries(before).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${String(k).padEnd(25)} ${v}`);
});

console.log(`\n━━━ AFTER ━━━`);
Object.entries(after).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${String(k).padEnd(25)} ${v}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
