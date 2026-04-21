#!/usr/bin/env node
/**
 * storage-final-patterns.js — adds the last batch of SSD patterns that
 * slipped through the earlier dictionaries. These are mostly newer budget
 * drives (2024-2025 releases) and a handful of rare models.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const DB = [
  // WD budget NVMe lineup (2024)
  { pat: /SN5000/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5500, seq_w: 5000, nand: 'TLC', dram: false },
  { pat: /SN3000\b|Green\s*SN3000/i, iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4200, nand: 'QLC', dram: false },

  // Patriot
  { pat: /Patriot.*P320|(?:^|\s)P320\b/i, iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /Patriot.*P220|(?:^|\s)P220\b/i, iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // TeamGroup
  { pat: /T-?Force\s*G70\s*Pro/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /T-?Force\s*G70/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6000, nand: 'TLC', dram: false },
  { pat: /T-?Force\s*G50/i,        iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4500, nand: 'TLC', dram: false },
  { pat: /T-?Force\s*G40/i,        iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /T-?Force\s*Z44A7/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6500, nand: 'TLC', dram: false },

  // Fanxiang budget SATA line
  { pat: /Fanxiang.*S201/i,        iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*(?:^|\s)SSD\s*\d+TB.*SATA/i, iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // KingSpec
  { pat: /KingSpec.*(?:^|\s)\d+GB.*2\.5.*SATA|KingSpec.*SATA\s*SSD/i, iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // Bestoss generic (fallback — their SSDs tend to be budget Gen3)
  { pat: /Bestoss.*NVMe/i,         iface: 'NVMe', pcie: 3.0, seq_r: 2200, seq_w: 1600, nand: 'TLC', dram: false },
  { pat: /Bestoss.*SATA/i,         iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },

  // Acer SSDs (Predator line)
  { pat: /Acer.*Predator\s*GM7000/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6700, nand: 'TLC', dram: true },
  { pat: /Acer.*Predator\s*GM7\b/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7200, seq_w: 6300, nand: 'TLC', dram: false },
  { pat: /Acer.*(?:RE100|SA100)/i,   iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // OSCOO NVMe (generic budget)
  { pat: /OSCOO.*NVMe/i,           iface: 'NVMe', pcie: 3.0, seq_r: 2000, seq_w: 1600, nand: 'TLC', dram: false },

  // Fikwot remaining variants
  { pat: /Fikwot.*FE520/i,         iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
];

let matched = 0;
const stats = { interface: 0, pcie: 0, seq_r: 0, seq_w: 0, nand: 0, dram: 0 };
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      matched++;
      for (const [dkey, pkey] of Object.entries({ iface: 'interface', pcie: 'pcie', seq_r: 'seq_r', seq_w: 'seq_w', nand: 'nand', dram: 'dram' })) {
        if (entry[dkey] !== undefined && p[pkey] == null) {
          p[pkey] = entry[dkey];
          stats[pkey]++;
        }
      }
      break;
    }
  }
}

console.log(`Matched: ${matched}`);
console.log(`Added:`, JSON.stringify(stats));

const storage = parts.filter(p => p.c === 'Storage');
console.log('\nFinal Storage coverage:');
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram', 'rpm']) {
  const n = storage.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${storage.length}  (${Math.round(n / storage.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
