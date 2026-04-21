#!/usr/bin/env node
/**
 * normalize-mobo-filters.js
 *
 * Cleans up two messy motherboard filters by re-deriving both fields
 * from product names (more reliable than patching scraped values):
 *
 * - memType: DDR4 | DDR5  (sometimes LPDDR5, DDR3 for older)
 * - chipset: canonical chipset tokens (X870, B650, Z790, H610, etc.)
 *            — no suffixes (X870E, B650E, A620M etc. collapsed to
 *              the base chipset for cleaner filtering)
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── memType INFERENCE ──────────────────────────────────────────────────────
function inferMemType(name) {
  const n = String(name);
  // Explicit in name
  if (/\bDDR5\b/i.test(n)) return 'DDR5';
  if (/\bDDR4\b/i.test(n)) return 'DDR4';
  if (/\bDDR3\b/i.test(n)) return 'DDR3';
  // Chipset-implied (newer AMD/Intel are all DDR5; B650+, X670+, X870+, 700+/800+ series)
  if (/\b(X870E?|B850|B860|A620|B650E?|X670E?|Z890|Z790\s*D5|Z890M|B860M|H810|B840|W790)\b/i.test(n)) return 'DDR5';
  // Intel 700-series supported BOTH DDR4 and DDR5 depending on board; default
  // to checking for explicit DDR4 marker in name; the remaining are DDR5
  if (/\bZ790\s*(?:DDR4|D4)\b|\bB760\s*(?:DDR4|D4)\b|\bH610\s*(?:DDR4|D4)\b|H610M-K\s*D4/i.test(n)) return 'DDR4';
  if (/\b(Z790|B760|H610|H770|W680)\b/i.test(n)) return 'DDR5'; // Default new LGA1700 is DDR5
  // AM4 era — all DDR4
  if (/\b(X570|B550|B450|A520|X470|B350|A320|X370|X470|X370)\b/i.test(n)) return 'DDR4';
  // LGA1200 and older Intel
  if (/\b(Z590|B560|H510|Z490|B460|H410|Z390|H370|Z370|B360|H310|Z270|H270|Z170|H170|B150|H110)\b/i.test(n)) return 'DDR4';
  return null;
}

// ─── chipset INFERENCE ──────────────────────────────────────────────────────
// Return just the canonical chipset token (no M/E suffix, no "AM5" noise)
function inferChipset(name) {
  const n = String(name);

  // AMD chipsets. Look for pattern: X870, B650, etc. — canonical is base letter+digits.
  // Suffix E/M/I strip off.
  // Server: WRX90, TRX50, TRX40
  let m = n.match(/\b(WRX90|WRX80|TRX[45]0|WX90|W790)\b/i);
  if (m) return m[1].toUpperCase();

  // AM5/AM4/Intel mainstream. Letter prefix + 3 digits.
  //   Examples: X870E → X870, B650E → B650, B650M → B650, A620 → A620
  m = n.match(/\b([XBZAHWQ])(\d{3})[A-Z]?\b/);
  if (m) {
    return m[1].toUpperCase() + m[2];
  }

  // Older Intel (H110, H310) already covered above
  // Older AMD (X370, A320) too.

  // Intel Xeon datacenter — C612, C621, SP5, SP3
  m = n.match(/\b(C6[12]\d|SP[35])\b/i);
  if (m) return m[1].toUpperCase();

  return null;
}

// ─── APPLY ──────────────────────────────────────────────────────────────────
let memFixed = 0, memAdded = 0;
let chipsetFixed = 0, chipsetAdded = 0;

for (const p of parts) {
  if (p.c !== 'Motherboard') continue;

  // memType — always re-derive (current values are messy)
  const mt = inferMemType(p.n);
  if (mt) {
    if (p.memType !== mt) {
      if (p.memType == null) memAdded++;
      else memFixed++;
      p.memType = mt;
    }
  }

  // chipset — always re-derive
  const cs = inferChipset(p.n);
  if (cs) {
    if (p.chipset !== cs) {
      if (p.chipset == null) chipsetAdded++;
      else chipsetFixed++;
      p.chipset = cs;
    }
  }
}

console.log(`memType: ${memFixed} normalized, ${memAdded} filled in`);
console.log(`chipset: ${chipsetFixed} normalized, ${chipsetAdded} filled in`);

// ─── REPORT ─────────────────────────────────────────────────────────────────
const mobos = parts.filter(p => p.c === 'Motherboard');
const mt = {}, cs = {};
for (const p of mobos) {
  if (p.memType != null) mt[p.memType] = (mt[p.memType] || 0) + 1;
  if (p.chipset != null) cs[p.chipset] = (cs[p.chipset] || 0) + 1;
}

console.log('\n━━━ FINAL memType ━━━');
Object.entries(mt).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(10)} ${v}`);
});

console.log('\n━━━ FINAL chipset ━━━');
Object.entries(cs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(10)} ${v}`);
});

// What's still missing
const noMem = mobos.filter(p => p.memType == null);
const noChipset = mobos.filter(p => p.chipset == null);
console.log(`\nMissing memType: ${noMem.length}`);
console.log(`Missing chipset: ${noChipset.length}`);
if (noChipset.length < 20) noChipset.forEach(p => console.log(`  [${p.b}] ${p.n.slice(0, 75)}`));

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
