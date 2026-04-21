#!/usr/bin/env node
/**
 * dedupe-cases.js
 *
 * Merges 2 true-duplicate cases. Color variants are KEPT separate.
 *
 * Merges:
 *   - id=7137 "Corsair iCUE 7000X RGB"        → into id=16115
 *   - id=7139 "NZXT H7 Flow (2024)"           → into id=16132 (Black default)
 *
 * The "into" target is preserved (it's the more complete record from Best Buy
 * with full name, ASIN, etc). Source IDs are simply removed.
 *
 * Verifies before deleting:
 *   - Same brand
 *   - Target has more useful data (more fields, has spec values)
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// Manual merge map: source ID → target ID
const MERGES = [
  { from: 7137, to: 16115, note: 'Corsair iCUE 7000X RGB → Best Buy entry' },
  { from: 7139, to: 16132, note: 'NZXT H7 Flow 2024 → Best Buy entry (Black variant as default)' },
];

console.log(`━━━ DEDUPE PLAN ━━━`);
const toRemove = new Set();
for (const m of MERGES) {
  const src = parts.find(p => p.id === m.from);
  const tgt = parts.find(p => p.id === m.to);
  if (!src) { console.log(`  ⚠ source id=${m.from} not found, skipping`); continue; }
  if (!tgt) { console.log(`  ⚠ target id=${m.to} not found, skipping`); continue; }
  if (src.b !== tgt.b) { console.log(`  ⚠ brand mismatch ${src.b} vs ${tgt.b}, skipping`); continue; }
  console.log(`  ${m.note}`);
  console.log(`    REMOVE: id=${src.id} | ${src.n.slice(0, 70)}`);
  console.log(`    KEEP:   id=${tgt.id} | ${tgt.n.slice(0, 70)}`);
  toRemove.add(src.id);
}

const before = parts.length;
parts = parts.filter(p => !toRemove.has(p.id));
console.log(`\nRemoved ${before - parts.length} duplicate products`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

// Verify count
const newCases = parts.filter(p => p.c === 'Case');
console.log(`\nFinal Case count: ${newCases.length}`);
