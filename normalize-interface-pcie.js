#!/usr/bin/env node
/**
 * normalize-interface-pcie.js
 *
 * Canonicalizes both fields:
 *
 *   interface → NVMe | SATA | USB | U.2 | SAS  (plain tag)
 *   pcie      → 3 | 4 | 5   (integer only; UI renders as "PCIe Gen N")
 *
 * Also: any product with "PCIe Gen N" embedded in its OLD interface value
 * gets that gen number extracted and written to pcie (if pcie is missing).
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function normalizeInterface(val) {
  if (val == null) return null;
  const t = String(val).toLowerCase();
  if (/pcie|nvme/.test(t)) return 'NVMe';
  if (/sata/.test(t)) return 'SATA';
  if (/usb|micro-usb|thunderbolt/.test(t)) return 'USB';
  if (/\bu\.?2\b/.test(t)) return 'U.2';
  if (/\bsas\b/.test(t)) return 'SAS';
  return null;
}

function extractPcieGen(val) {
  if (val == null) return null;
  const m = String(val).match(/(?:Gen\s*|PCIe\s*(?:Gen\s*)?)?([3-5])(?:\s*x\s*[24])?/i);
  return m ? parseInt(m[1], 10) : null;
}

function normalizePcie(val) {
  if (val == null) return null;
  // Already a number?
  if (typeof val === 'number') {
    if (val >= 3 && val <= 5) return Math.trunc(val);
    return null;
  }
  // String form: "Gen4", "4", "4.0", "PCIe Gen 5", etc.
  const m = String(val).match(/([3-5])/);
  return m ? parseInt(m[1], 10) : null;
}

let ifaceChanged = 0;
let pcieChanged = 0;
let pcieAdded = 0;

for (const p of parts) {
  if (p.c !== 'Storage') continue;

  // Extract pcie gen from old-style interface BEFORE normalizing
  if (p.interface != null && p.pcie == null) {
    const gen = extractPcieGen(p.interface);
    if (gen) {
      p.pcie = gen;
      pcieAdded++;
    }
  }

  // Normalize interface
  if (p.interface != null) {
    const norm = normalizeInterface(p.interface);
    if (norm && norm !== p.interface) {
      p.interface = norm;
      ifaceChanged++;
    }
  }

  // Normalize pcie (regardless of whether we just set it)
  if (p.pcie != null) {
    const norm = normalizePcie(p.pcie);
    if (norm !== null && norm !== p.pcie) {
      p.pcie = norm;
      pcieChanged++;
    }
  }
}

console.log(`Interface values normalized: ${ifaceChanged}`);
console.log(`PCIe gen extracted from old interface strings: ${pcieAdded}`);
console.log(`PCIe values normalized to int: ${pcieChanged}`);

// Final report
const after = { interface: {}, pcie: {} };
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.interface != null) after.interface[p.interface] = (after.interface[p.interface] || 0) + 1;
  if (p.pcie != null) after.pcie[p.pcie] = (after.pcie[p.pcie] || 0) + 1;
}

console.log('\n━━━ FINAL interface values ━━━');
Object.entries(after.interface).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  console.log(`  ${JSON.stringify(k).padEnd(10)} ${v}`);
});

console.log('\n━━━ FINAL pcie values ━━━');
Object.entries(after.pcie).sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0)).forEach(([k, v]) => {
  console.log(`  Gen ${k}  ${v}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
console.log('\nNext: make sure the filter UI reads pcie as "PCIe Gen {n}" so all 3 gens show up.');
