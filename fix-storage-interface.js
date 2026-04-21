#!/usr/bin/env node
/**
 * fix-storage-interface.js
 *
 * Re-runs the storage dictionary with the iface→interface key fix.
 * Also re-applies pcie/seq_r/seq_w/nand/dram/rpm for any products
 * that didn't get them because they were skipped last time.
 */
import { writeFileSync, readFileSync } from 'node:fs';

// Load the v2 dictionary by extracting it from the committed file
const v2Src = readFileSync('./backfill-storage-specs-v2.js', 'utf8');
const dbMatch = v2Src.match(/const DB = \[([\s\S]*?)\n\];/);
if (!dbMatch) {
  console.error('Could not extract DB from v2 script. Make sure backfill-storage-specs-v2.js is in this dir.');
  process.exit(1);
}

// Safer: just re-declare the dictionary here. Copy-paste is ugly but reliable.
// Actually, simplest: just eval the DB literal.
let DB;
eval(`DB = [${dbMatch[1]}\n]`);

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function matchStorage(p) {
  const name = String(p.n || '').replace(/[™®©\u00AD\u200B\u200C\u200D]/g, '').replace(/\s+/g, ' ');
  const withBrand = `${p.b || ''} ${name}`;
  for (const entry of DB) {
    if (entry.pat.test(withBrand) || entry.pat.test(name)) return entry;
  }
  return null;
}

const stats = { matched: 0, interface: 0, pcie: 0, seq_r: 0, seq_w: 0, nand: 0, dram: 0, rpm: 0 };

// Map dictionary keys → product field names
const KEY_MAP = {
  iface: 'interface',  // ← THE FIX
  pcie: 'pcie',
  seq_r: 'seq_r',
  seq_w: 'seq_w',
  nand: 'nand',
  dram: 'dram',
  rpm: 'rpm',
};

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const m = matchStorage(p);
  if (!m) continue;
  stats.matched++;
  for (const [mkey, pkey] of Object.entries(KEY_MAP)) {
    if (m[mkey] !== undefined && p[pkey] == null) {
      p[pkey] = m[mkey];
      stats[pkey]++;
    }
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Matched:', stats.matched);
console.log('Fields filled:', JSON.stringify({
  interface: stats.interface, pcie: stats.pcie,
  seq_r: stats.seq_r, seq_w: stats.seq_w,
  nand: stats.nand, dram: stats.dram, rpm: stats.rpm,
}));

const storage = parts.filter(p => p.c === 'Storage');
console.log('\nStorage coverage after:');
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram', 'rpm']) {
  const n = storage.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${storage.length}  (${Math.round(n / storage.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
