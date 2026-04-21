#!/usr/bin/env node
/**
 * normalize-storage-type.js — canonical storageType values:
 *   HDD | NVMe | SSD
 *
 * SATA as a storageType is wrong — SATA is an interface. Products currently
 * tagged storageType:"SATA" are SATA SSDs, so they become storageType:"SSD".
 *
 * Cross-check: look at each product's interface field too. If it's a SATA
 * drive with "HDD"/"hard drive"/"RPM" in the name, it's really an HDD.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const before = {};
const after = {};
const changes = [];

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const old = p.storageType;
  before[old] = (before[old] || 0) + 1;

  let canon = old;
  const name = (p.n || '').toLowerCase();

  // "SATA" as storageType is wrong — decide HDD or SSD
  if (old === 'SATA') {
    if (/\b(?:hdd|hard\s*drive|rpm|barracuda|ironwolf|skyhawk|exos|3\.5\s*inch|bare\s*drive)\b/i.test(name)) {
      canon = 'HDD';
    } else {
      canon = 'SSD';
    }
  }

  // Normalize case / variants
  if (canon != null) {
    const t = String(canon).toLowerCase();
    if (t === 'ssd') canon = 'SSD';
    else if (t === 'hdd') canon = 'HDD';
    else if (t === 'nvme' || t === 'm.2' || t === 'm2') canon = 'NVMe';
  }

  if (canon !== old) {
    changes.push(`[${p.b}] ${old} → ${canon}  |  ${p.n.slice(0, 60)}`);
    p.storageType = canon;
  }
  after[canon] = (after[canon] || 0) + 1;
}

console.log(`Changed ${changes.length} products.\n`);
console.log('━━━ BEFORE ━━━');
Object.entries(before).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${String(k).padEnd(15)} ${v}`);
});
console.log('\n━━━ AFTER ━━━');
Object.entries(after).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${String(k).padEnd(15)} ${v}`);
});

// Show any sample changes so we can verify
console.log('\n━━━ SAMPLE CHANGES (first 5) ━━━');
changes.slice(0, 5).forEach(c => console.log('  ' + c));

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
