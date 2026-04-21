#!/usr/bin/env node
/**
 * normalize-storage-formfactor-2.js — final cleanup of form factor outliers.
 *
 * "Portable" (7), "Other" (1), "NVMe SSD" (1) — all junk or misclassified.
 * For Portable, if we can derive a real form factor from the product name,
 * we use it; otherwise we clear it.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const changes = [];
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.ff == null) continue;

  const oldFf = p.ff;
  const name = (p.n || '').toLowerCase();

  if (p.ff === 'Portable' || p.ff === 'Other' || p.ff === 'NVMe SSD') {
    // Try to infer a real form factor from product name
    if (/\bm\.?\s*2\b.*2280|2280/.test(name)) p.ff = 'M.2 2280';
    else if (/\bm\.?\s*2\b/.test(name)) p.ff = 'M.2 2280';
    else if (/2\.5/.test(name)) p.ff = '2.5"';
    else if (/3\.5/.test(name)) p.ff = '3.5"';
    else {
      // Can't infer — clear the field
      delete p.ff;
    }
    changes.push(`[${p.b}] ${oldFf} → ${p.ff || '(cleared)'}  |  ${p.n.slice(0, 60)}`);
  }
}

console.log(`Cleaned ${changes.length} products:`);
changes.forEach(c => console.log('  ' + c));

// Final report
const after = {};
for (const p of parts) {
  if (p.c !== 'Storage' || p.ff == null) continue;
  after[p.ff] = (after[p.ff] || 0) + 1;
}
console.log('\n━━━ FINAL ff VALUES ━━━');
Object.entries(after).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${String(k).padEnd(15)} ${v}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
