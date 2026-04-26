// =============================================================================
//  enrich-gpu-clocks-pcie.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Fills GPU baseClock, boostClock, pcie, slots from name parsing + reference
//  tables. Pure data — no API cost.
//
//  Strategy:
//    1) Try regex extraction from product name (e.g. "Boost: 2580 MHz",
//       "Base Clock 1980 MHz", "PCIe 4.0", "2.5-slot").
//    2) Fall back to chip-series defaults (e.g. all RTX 4090s use PCIe 4.0,
//       all RTX 5090s use PCIe 5.0, FE cards have known reference clocks).
//    3) Skip products that already have the field filled.
//
//  Usage:
//    node enrich-gpu-clocks-pcie.cjs --dry-run    # preview only
//    node enrich-gpu-clocks-pcie.cjs              # apply changes
// =============================================================================

const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
const DRY_RUN = process.argv.includes('--dry-run');

if (!fs.existsSync(PARTS_PATH)) {
  console.error(`✗ ${PARTS_PATH} not found`);
  process.exit(1);
}

// ─── Reference tables (NVIDIA + AMD reference design specs) ─────────────────
// Source: manufacturer spec pages. baseClock/boostClock are MHz.
const REFERENCE_CLOCKS = [
  // NVIDIA RTX 50 series
  { pattern: /\brtx[\s-]?5090\b/i, base: 2017, boost: 2407, pcie: '5.0 x16' },
  { pattern: /\brtx[\s-]?5080\b/i, base: 2295, boost: 2617, pcie: '5.0 x16' },
  { pattern: /\brtx[\s-]?5070\s*ti\b/i, base: 2295, boost: 2452, pcie: '5.0 x16' },
  { pattern: /\brtx[\s-]?5070\b/i, base: 2325, boost: 2512, pcie: '5.0 x16' },
  { pattern: /\brtx[\s-]?5060\s*ti\b/i, base: 2407, boost: 2572, pcie: '5.0 x8' },
  { pattern: /\brtx[\s-]?5060\b/i, base: 2400, boost: 2497, pcie: '5.0 x8' },
  // NVIDIA RTX 40 series
  { pattern: /\brtx[\s-]?4090\b/i, base: 2235, boost: 2520, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4080\s*super\b/i, base: 2295, boost: 2550, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4080\b/i, base: 2205, boost: 2505, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4070\s*ti\s*super\b/i, base: 2340, boost: 2610, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4070\s*ti\b/i, base: 2310, boost: 2610, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4070\s*super\b/i, base: 1980, boost: 2475, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4070\b/i, base: 1920, boost: 2475, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?4060\s*ti\b/i, base: 2310, boost: 2535, pcie: '4.0 x8' },
  { pattern: /\brtx[\s-]?4060\b/i, base: 1830, boost: 2460, pcie: '4.0 x8' },
  // NVIDIA RTX 30 series
  { pattern: /\brtx[\s-]?3090\s*ti\b/i, base: 1560, boost: 1860, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3090\b/i, base: 1395, boost: 1695, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3080\s*ti\b/i, base: 1365, boost: 1665, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3080\b/i, base: 1440, boost: 1710, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3070\s*ti\b/i, base: 1580, boost: 1770, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3070\b/i, base: 1500, boost: 1725, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3060\s*ti\b/i, base: 1410, boost: 1665, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3060\b/i, base: 1320, boost: 1777, pcie: '4.0 x16' },
  { pattern: /\brtx[\s-]?3050\b/i, base: 1552, boost: 1777, pcie: '4.0 x8' },
  // NVIDIA RTX 20 series
  { pattern: /\brtx[\s-]?2080\s*ti\b/i, base: 1350, boost: 1545, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2080\s*super\b/i, base: 1650, boost: 1815, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2080\b/i, base: 1515, boost: 1710, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2070\s*super\b/i, base: 1605, boost: 1770, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2070\b/i, base: 1410, boost: 1620, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2060\s*super\b/i, base: 1470, boost: 1650, pcie: '3.0 x16' },
  { pattern: /\brtx[\s-]?2060\b/i, base: 1365, boost: 1680, pcie: '3.0 x16' },
  // NVIDIA GTX 16 series
  { pattern: /\bgtx[\s-]?1660\s*ti\b/i, base: 1500, boost: 1770, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1660\s*super\b/i, base: 1530, boost: 1785, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1660\b/i, base: 1530, boost: 1785, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1650\s*super\b/i, base: 1530, boost: 1725, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1650\b/i, base: 1485, boost: 1665, pcie: '3.0 x16' },
  // NVIDIA GTX 10 series
  { pattern: /\bgtx[\s-]?1080\s*ti\b/i, base: 1480, boost: 1582, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1080\b/i, base: 1607, boost: 1733, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1070\s*ti\b/i, base: 1607, boost: 1683, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1070\b/i, base: 1506, boost: 1683, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1060\b/i, base: 1506, boost: 1708, pcie: '3.0 x16' },
  { pattern: /\bgtx[\s-]?1050\s*ti\b/i, base: 1290, boost: 1392, pcie: '3.0 x16' },
  // AMD RX 9000 series
  { pattern: /\brx[\s-]?9070\s*xt\b/i, base: 2400, boost: 2970, pcie: '5.0 x16' },
  { pattern: /\brx[\s-]?9070\b/i, base: 2070, boost: 2520, pcie: '5.0 x16' },
  // AMD RX 7000 series
  { pattern: /\brx[\s-]?7900\s*xtx\b/i, base: 1855, boost: 2500, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?7900\s*xt\b/i, base: 1500, boost: 2400, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?7900\s*gre\b/i, base: 1287, boost: 2245, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?7800\s*xt\b/i, base: 1295, boost: 2430, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?7700\s*xt\b/i, base: 1700, boost: 2544, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?7600\s*xt\b/i, base: 1980, boost: 2755, pcie: '4.0 x8' },
  { pattern: /\brx[\s-]?7600\b/i, base: 1720, boost: 2655, pcie: '4.0 x8' },
  // AMD RX 6000 series
  { pattern: /\brx[\s-]?6950\s*xt\b/i, base: 1925, boost: 2310, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6900\s*xt\b/i, base: 1825, boost: 2250, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6800\s*xt\b/i, base: 1825, boost: 2250, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6800\b/i, base: 1700, boost: 2105, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6750\s*xt\b/i, base: 2150, boost: 2600, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6700\s*xt\b/i, base: 2321, boost: 2581, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?6650\s*xt\b/i, base: 2055, boost: 2635, pcie: '4.0 x8' },
  { pattern: /\brx[\s-]?6600\s*xt\b/i, base: 1968, boost: 2589, pcie: '4.0 x8' },
  { pattern: /\brx[\s-]?6600\b/i, base: 1626, boost: 2491, pcie: '4.0 x8' },
  { pattern: /\brx[\s-]?6500\s*xt\b/i, base: 2310, boost: 2815, pcie: '4.0 x4' },
  // AMD RX 5000 series
  { pattern: /\brx[\s-]?5700\s*xt\b/i, base: 1605, boost: 1905, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?5700\b/i, base: 1465, boost: 1725, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?5600\s*xt\b/i, base: 1130, boost: 1750, pcie: '4.0 x16' },
  { pattern: /\brx[\s-]?5500\s*xt\b/i, base: 1607, boost: 1845, pcie: '4.0 x8' },
];

// ─── Slot count heuristics from product name ────────────────────────────────
const SLOT_PATTERNS = [
  { pattern: /\b4[\s.]?slot\b/i, slots: 4 },
  { pattern: /\b3[\s.]?5[\s.]?slot\b|\b3\.5-slot\b/i, slots: 3.5 },
  { pattern: /\btriple[\s-]?slot\b|\b3[\s.]?slot\b/i, slots: 3 },
  { pattern: /\b2[\s.]?7[\s.]?slot\b|\b2\.7-slot\b/i, slots: 2.7 },
  { pattern: /\b2[\s.]?5[\s.]?slot\b|\b2\.5-slot\b/i, slots: 2.5 },
  { pattern: /\bdual[\s-]?slot\b|\b2[\s.]?slot\b/i, slots: 2 },
  { pattern: /\bsingle[\s-]?slot\b|\b1[\s.]?slot\b/i, slots: 1 },
];

// Default slot count by chip class — used if name has no explicit slot info.
function defaultSlotsForChip(name) {
  if (/\brtx[\s-]?5090\b/i.test(name)) return 3.5;
  if (/\brtx[\s-]?(5080|4090|4080|7900\s*xtx)\b/i.test(name)) return 3;
  if (/\brtx[\s-]?(40|50|30)\d{2}\b/i.test(name)) return 2.5;
  if (/\bgtx\b|\brx\s*[56]/i.test(name)) return 2;
  return null;
}

// ─── Per-product parse: extract from the product name itself ────────────────
function parseFromName(name) {
  const out = {};
  // Boost clock pattern: "Boost: 2580 MHz" or "Boost Clock 2.58 GHz"
  let m = name.match(/boost[:\s-]+(?:clock\s+)?(\d{3,4}|\d\.\d{1,2})\s*(MHz|GHz)?/i);
  if (m) {
    let v = parseFloat(m[1]);
    if (m[2] && m[2].toLowerCase() === 'ghz') v *= 1000;
    if (v >= 800 && v <= 4000) out.boostClock = Math.round(v);
  }
  // Base clock pattern.
  m = name.match(/base[:\s-]+(?:clock\s+)?(\d{3,4}|\d\.\d{1,2})\s*(MHz|GHz)?/i);
  if (m) {
    let v = parseFloat(m[1]);
    if (m[2] && m[2].toLowerCase() === 'ghz') v *= 1000;
    if (v >= 500 && v <= 3500) out.baseClock = Math.round(v);
  }
  // PCIe pattern: "PCIe 4.0", "PCIe Gen 5"
  m = name.match(/pci[\s-]?e[:\s-]*(?:gen[:\s-]*)?(\d(?:\.\d)?)/i);
  if (m) {
    const ver = m[1].includes('.') ? m[1] : `${m[1]}.0`;
    out.pcie = `${ver} x16`;  // assume x16 for full-size cards
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const src = fs.readFileSync(PARTS_PATH, 'utf8');
const partsMatch = src.match(/export\s+const\s+PARTS\s*=\s*(\[[\s\S]*\]);/);
if (!partsMatch) {
  console.error('✗ Could not find PARTS array in parts.js');
  process.exit(1);
}

// Use eval-style import (parts.js has no top-level external refs, just data).
// Safer: Function constructor in a sandbox.
let parts;
try {
  parts = new Function('return ' + partsMatch[1])();
} catch (e) {
  console.error('✗ Failed to parse PARTS array:', e.message);
  process.exit(1);
}

const C = { reset: '\x1b[0m', dim: '\x1b[90m', good: '\x1b[92m', mid: '\x1b[93m' };
const stats = { baseClock: 0, boostClock: 0, pcie: 0, slots: 0 };
const updates = [];

for (const p of parts) {
  if (p.c !== 'GPU') continue;
  if (p.needsReview || p.bundle) continue;
  const name = p.n || '';
  const updated = {};

  // 1) Try parsing fields from the product name first.
  const fromName = parseFromName(name);

  // 2) Fall back to reference table for missing clocks/pcie.
  let ref = null;
  for (const r of REFERENCE_CLOCKS) {
    if (r.pattern.test(name)) { ref = r; break; }
  }

  // baseClock
  if (!p.baseClock) {
    const v = fromName.baseClock || (ref && ref.base);
    if (v) updated.baseClock = v;
  }
  // boostClock
  if (!p.boostClock) {
    const v = fromName.boostClock || (ref && ref.boost);
    if (v) updated.boostClock = v;
  }
  // pcie
  if (!p.pcie) {
    const v = fromName.pcie || (ref && ref.pcie);
    if (v) updated.pcie = v;
  }
  // slots
  if (!p.slots) {
    let slotVal = null;
    for (const sp of SLOT_PATTERNS) {
      if (sp.pattern.test(name)) { slotVal = sp.slots; break; }
    }
    if (!slotVal) slotVal = defaultSlotsForChip(name);
    if (slotVal) updated.slots = slotVal;
  }

  if (Object.keys(updated).length > 0) {
    updates.push({ id: p.id, name, fields: updated });
    for (const k of Object.keys(updated)) stats[k]++;
  }
}

console.log('\n  GPU enrichment plan');
console.log('  ' + '─'.repeat(50));
console.log(`  Products to update: ${updates.length}`);
console.log(`    baseClock        +${stats.baseClock}`);
console.log(`    boostClock       +${stats.boostClock}`);
console.log(`    pcie             +${stats.pcie}`);
console.log(`    slots            +${stats.slots}`);
console.log('');

// Show 3 examples of changes.
console.log('  Sample updates:');
for (const u of updates.slice(0, 3)) {
  console.log(`    ${C.dim}id ${u.id}${C.reset} ${u.name.slice(0, 55)}`);
  for (const [k, v] of Object.entries(u.fields)) console.log(`      ${C.good}+${k}: ${v}${C.reset}`);
}
console.log('');

if (DRY_RUN) {
  console.log(`  ${C.mid}--dry-run: NO changes written${C.reset}\n`);
  process.exit(0);
}

if (updates.length === 0) {
  console.log('  Nothing to update.\n');
  process.exit(0);
}

// ─── Apply updates by mutating the parts array and re-serializing ───────────
const updatesById = new Map(updates.map((u) => [u.id, u.fields]));
for (const p of parts) {
  const fix = updatesById.get(p.id);
  if (!fix) continue;
  Object.assign(p, fix);
}

// Re-serialize PARTS array. Preserve the rest of parts.js.
// JSON.stringify doesn't quite match the original style, but parts.js is
// machine-generated anyway and the formatter normalizes it.
const newPartsJson = JSON.stringify(parts, null, 2);
const newSrc = src.replace(
  /export\s+const\s+PARTS\s*=\s*\[[\s\S]*\];/,
  `export const PARTS = ${newPartsJson};`
);

// Make a backup before writing.
const backup = PARTS_PATH + '.bak.' + Date.now();
fs.writeFileSync(backup, src, 'utf8');
fs.writeFileSync(PARTS_PATH, newSrc, 'utf8');
console.log(`  ${C.good}✓ Updated ${updates.length} GPU products${C.reset}`);
console.log(`    Backup: ${backup}`);
console.log(`    Re-run: node audit-spec-coverage.cjs\n`);
