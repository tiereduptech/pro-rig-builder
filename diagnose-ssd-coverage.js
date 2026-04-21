#!/usr/bin/env node
/**
 * diagnose-ssd-coverage.js — shows SSD/NVMe-only coverage and lists all
 * remaining products missing seq_r, grouped by brand.
 */
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function isSSD(p) {
  const text = `${p.b} ${p.n}`.toLowerCase();
  // Must have interface=NVMe/SATA/U.2 (we're 98% confident on this) OR explicit SSD/NVMe marker
  if (p.interface === 'NVMe' || p.interface === 'U.2') return true;
  if (p.interface === 'SATA') {
    // SATA products are SSDs only if they're not HDDs
    if (/\b(?:rpm|barracuda|ironwolf|skyhawk|exos|hard\s*drive|3\.5\s*inch)\b/i.test(text)) return false;
    return /\bssd\b|solid\s*state/i.test(text);
  }
  if (p.interface === 'USB') {
    return /\bssd\b|solid\s*state/i.test(text);
  }
  // No interface set — fall back to keyword scan
  return /\bssd\b|\bnvme\b/i.test(text) && !/\bhdd\b|hard\s*drive|\brpm\b/i.test(text);
}

const storage = parts.filter(p => p.c === 'Storage');
const ssd = storage.filter(isSSD);

console.log(`━━━ SSD-ONLY COVERAGE ━━━`);
console.log(`SSDs: ${ssd.length} / ${storage.length} total storage products\n`);
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram']) {
  const n = ssd.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${ssd.length}  (${Math.round(n / ssd.length * 100)}%)`);
}

const missingSeqR = ssd.filter(p => p.seq_r == null);
console.log(`\n━━━ SSDs MISSING seq_r (${missingSeqR.length}) — by brand ━━━`);
const byBrand = {};
missingSeqR.forEach(p => { byBrand[p.b] = (byBrand[p.b] || 0) + 1; });
Object.entries(byBrand).sort((a, b) => b[1] - a[1]).forEach(([b, n]) => {
  console.log(`  ${b.padEnd(22)} ${n}`);
});

console.log(`\n━━━ ALL ${missingSeqR.length} SSDs MISSING seq_r (full titles) ━━━`);
missingSeqR.forEach(p => {
  console.log(`  [${p.b.padEnd(20)}] ${p.n}`);
});
