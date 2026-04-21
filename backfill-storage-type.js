#!/usr/bin/env node
/**
 * backfill-storage-type.js — infer storageType from existing fields for
 * Storage products missing it. Uses interface, form, pcie, rpm, and name.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function infer(p) {
  const name = (p.n || '').toLowerCase();
  const iface = String(p.interface || '').toLowerCase();
  const form = String(p.form || '').toLowerCase();

  // RPM = hard drive
  if (p.rpm) return 'HDD';

  // NVMe indicators
  if (/\bnvme\b/i.test(p.n) || iface.includes('nvme') || iface.includes('pcie') || /^gen/i.test(p.pcie || '')) {
    return 'NVMe';
  }
  if (form.includes('m.2')) return 'NVMe';

  // SATA SSD
  if (iface.includes('sata') || /\bsata\b/i.test(p.n)) {
    // Could be SATA SSD or HDD — check for SSD indicators
    if (/ssd/i.test(p.n) || form.includes('2.5')) return 'SATA';
    if (form.includes('3.5') || /hdd|hard drive/i.test(p.n)) return 'HDD';
    return 'SATA';
  }

  // Generic form-factor fallback
  if (form.includes('3.5')) return 'HDD';
  if (form.includes('2.5')) return 'SATA';

  // Name-based fallback
  if (/\bssd\b/i.test(p.n)) return 'SSD';
  if (/hard drive|\bhdd\b/i.test(p.n)) return 'HDD';

  return null;
}

let added = 0;
const byType = {};

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.storageType) continue;
  const inferred = infer(p);
  if (inferred) {
    p.storageType = inferred;
    added++;
    byType[inferred] = (byType[inferred] || 0) + 1;
  }
}

console.log('Backfilled', added, 'storageType values');
console.log('Distribution:');
for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + t.padEnd(10), n);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
