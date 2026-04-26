// =============================================================================
//  enrich-cpu-specs.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Fills CPU baseClock, boostClock, memType, igpu by parsing product names +
//  applying chip-ID reference data. Pure data, no API cost.
//
//  Strategy:
//    1) Try regex on product name (e.g. "5.7 GHz", "DDR5-5600", "Boost: 5.4 GHz").
//    2) Fall back to chip-ID reference (e.g. "i9-14900K" → known clocks).
//    3) Determine memType from chip generation (Intel 12th+ = DDR5 + DDR4,
//       Intel 13th+ = DDR5, AMD AM5 = DDR5, AMD AM4 = DDR4).
//    4) Determine igpu by detecting "F" suffix (Intel "F" = no iGPU) and
//       AMD "G" suffix (AMD "G" = has iGPU; non-G AMD = no iGPU except APUs).
//
//  Usage:
//    node enrich-cpu-specs.cjs --dry-run
//    node enrich-cpu-specs.cjs
// =============================================================================

const fs = require('fs');

const PARTS_PATH = './src/data/parts.js';
const DRY_RUN = process.argv.includes('--dry-run');

if (!fs.existsSync(PARTS_PATH)) {
  console.error(`✗ ${PARTS_PATH} not found`);
  process.exit(1);
}

// ─── Reference table (Intel + AMD modern desktop CPUs, all clocks in MHz) ───
// Sources: ark.intel.com, amd.com.
const REFERENCE = [
  // Intel Core Ultra Series 2 (Arrow Lake, LGA1851)
  { pattern: /\bcore\s+ultra\s+9\s+285k\b/i, base: 3700, boost: 5700, memType: 'DDR5', igpu: true },
  { pattern: /\bcore\s+ultra\s+7\s+265kf?\b/i, base: 3900, boost: 5500, memType: 'DDR5', igpu: false },
  { pattern: /\bcore\s+ultra\s+7\s+265\b/i, base: 3900, boost: 5500, memType: 'DDR5', igpu: true },
  { pattern: /\bcore\s+ultra\s+5\s+245kf?\b/i, base: 4200, boost: 5200, memType: 'DDR5', igpu: false },
  { pattern: /\bcore\s+ultra\s+5\s+245\b/i, base: 4200, boost: 5200, memType: 'DDR5', igpu: true },
  { pattern: /\bcore\s+ultra\s+7\s+270k\b/i, base: 3900, boost: 5500, memType: 'DDR5', igpu: true },

  // Intel 14th Gen (Raptor Lake Refresh, LGA1700)
  { pattern: /\b(?:i9-)?14900ks\b/i, base: 3200, boost: 6200, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?14900kf\b/i, base: 3200, boost: 6000, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?14900k\b/i, base: 3200, boost: 6000, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?14900f\b/i, base: 2000, boost: 5800, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?14900\b/i, base: 2000, boost: 5800, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?14700kf\b/i, base: 3400, boost: 5600, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?14700k\b/i, base: 3400, boost: 5600, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?14700f\b/i, base: 2100, boost: 5400, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?14700\b/i, base: 2100, boost: 5400, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?14600kf\b/i, base: 3500, boost: 5300, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?14600k\b/i, base: 3500, boost: 5300, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?14600\b/i, base: 2700, boost: 5200, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?14500\b/i, base: 2600, boost: 5000, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?14400f\b/i, base: 2500, boost: 4700, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?14400\b/i, base: 2500, boost: 4700, memType: 'DDR5', igpu: true },

  // Intel 13th Gen (Raptor Lake)
  { pattern: /\b(?:i9-)?13900ks\b/i, base: 3200, boost: 6000, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?13900kf\b/i, base: 3000, boost: 5800, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?13900k\b/i, base: 3000, boost: 5800, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?13900f\b/i, base: 2000, boost: 5600, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?13900\b/i, base: 2000, boost: 5600, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?13700kf\b/i, base: 3400, boost: 5400, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?13700k\b/i, base: 3400, boost: 5400, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?13700f\b/i, base: 2100, boost: 5200, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?13700\b/i, base: 2100, boost: 5200, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?13600kf\b/i, base: 3500, boost: 5100, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?13600k\b/i, base: 3500, boost: 5100, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?13600\b/i, base: 2700, boost: 5000, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?13500\b/i, base: 2500, boost: 4800, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?13400f\b/i, base: 2500, boost: 4600, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?13400\b/i, base: 2500, boost: 4600, memType: 'DDR5', igpu: true },

  // Intel 12th Gen (Alder Lake)
  { pattern: /\b(?:i9-)?12900ks\b/i, base: 3400, boost: 5500, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?12900kf\b/i, base: 3200, boost: 5200, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?12900k\b/i, base: 3200, boost: 5200, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i9-)?12900f\b/i, base: 2400, boost: 5100, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i9-)?12900\b/i, base: 2400, boost: 5100, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?12700kf\b/i, base: 3600, boost: 5000, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?12700k\b/i, base: 3600, boost: 5000, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i7-)?12700f\b/i, base: 2100, boost: 4900, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i7-)?12700\b/i, base: 2100, boost: 4900, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?12600kf\b/i, base: 3700, boost: 4900, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?12600k\b/i, base: 3700, boost: 4900, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?12600\b/i, base: 3300, boost: 4800, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?12500\b/i, base: 3000, boost: 4600, memType: 'DDR5', igpu: true },
  { pattern: /\b(?:i5-)?12400f\b/i, base: 2500, boost: 4400, memType: 'DDR5', igpu: false },
  { pattern: /\b(?:i5-)?12400\b/i, base: 2500, boost: 4400, memType: 'DDR5', igpu: true },

  // AMD Ryzen 9000 series (Zen 5, AM5)
  { pattern: /\bryzen\s+9\s+9950x3d\b/i, base: 4300, boost: 5700, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+9950x\b/i, base: 4300, boost: 5700, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+9900x3d\b/i, base: 4400, boost: 5500, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+9900x\b/i, base: 4400, boost: 5600, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+7\s+9800x3d\b/i, base: 4700, boost: 5200, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+7\s+9700x\b/i, base: 3800, boost: 5500, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+5\s+9600x\b/i, base: 3900, boost: 5400, memType: 'DDR5', igpu: true },

  // AMD Ryzen 7000 series (Zen 4, AM5)
  { pattern: /\bryzen\s+9\s+7950x3d\b/i, base: 4200, boost: 5700, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+7950x\b/i, base: 4500, boost: 5700, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+7900x3d\b/i, base: 4400, boost: 5600, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+7900x\b/i, base: 4700, boost: 5600, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+9\s+7900\b/i, base: 3700, boost: 5400, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+7\s+7800x3d\b/i, base: 4200, boost: 5000, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+7\s+7700x\b/i, base: 4500, boost: 5400, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+7\s+7700\b/i, base: 3800, boost: 5300, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+5\s+7600x3d\b/i, base: 4100, boost: 4700, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+5\s+7600x\b/i, base: 4700, boost: 5300, memType: 'DDR5', igpu: true },
  { pattern: /\bryzen\s+5\s+7600\b/i, base: 3800, boost: 5100, memType: 'DDR5', igpu: true },

  // AMD Ryzen 5000 series (Zen 3, AM4)
  { pattern: /\bryzen\s+9\s+5950x\b/i, base: 3400, boost: 4900, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+9\s+5900x\b/i, base: 3700, boost: 4800, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5800x3d\b/i, base: 3400, boost: 4500, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5800x\b/i, base: 3800, boost: 4700, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5800\b/i, base: 3400, boost: 4600, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5700x3d\b/i, base: 3000, boost: 4100, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5700x\b/i, base: 3400, boost: 4600, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+7\s+5700g\b/i, base: 3800, boost: 4600, memType: 'DDR4', igpu: true },
  { pattern: /\bryzen\s+5\s+5600x3d\b/i, base: 3300, boost: 4400, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+5\s+5600x\b/i, base: 3700, boost: 4600, memType: 'DDR4', igpu: false },
  { pattern: /\bryzen\s+5\s+5600g\b/i, base: 3900, boost: 4400, memType: 'DDR4', igpu: true },
  { pattern: /\bryzen\s+5\s+5600\b/i, base: 3500, boost: 4400, memType: 'DDR4', igpu: false },

  // AMD Threadripper 9000 / 7000 (sTR5)
  { pattern: /\bthreadripper\s+9980x\b/i, base: 3200, boost: 5400, memType: 'DDR5', igpu: false },
  { pattern: /\bthreadripper\s+9970x\b/i, base: 3500, boost: 5400, memType: 'DDR5', igpu: false },
  { pattern: /\bthreadripper\s+pro\s+7995wx\b/i, base: 2500, boost: 5100, memType: 'DDR5', igpu: false },
  { pattern: /\bthreadripper\s+7980x\b/i, base: 3200, boost: 5100, memType: 'DDR5', igpu: false },
  { pattern: /\bthreadripper\s+7970x\b/i, base: 4000, boost: 5300, memType: 'DDR5', igpu: false },
  { pattern: /\bthreadripper\s+7960x\b/i, base: 4200, boost: 5300, memType: 'DDR5', igpu: false },
];

// ─── Per-product parse: extract from the product name itself ────────────────
function parseFromName(name) {
  const out = {};
  // Boost clock: "Boost: 5.7 GHz", "5.7 GHz Max Boost", "(5.7 GHz Max Boost)"
  let m = name.match(/(\d\.\d{1,2})\s*GHz\s*(?:Max\s+)?Boost/i)
       || name.match(/Boost[:\s-]+(?:Clock\s+)?(\d\.\d{1,2})\s*GHz/i);
  if (m) {
    const v = Math.round(parseFloat(m[1]) * 1000);
    if (v >= 3000 && v <= 7000) out.boostClock = v;
  }
  // Base clock: "3.0 GHz", "Base 4.5 GHz" — only when accompanied by "Base"
  m = name.match(/Base[:\s-]+(?:Clock\s+)?(\d\.\d{1,2})\s*GHz/i);
  if (m) {
    const v = Math.round(parseFloat(m[1]) * 1000);
    if (v >= 1500 && v <= 5000) out.baseClock = v;
  }
  // memType: "DDR5", "DDR4"
  m = name.match(/\bDDR(4|5)\b/i);
  if (m) out.memType = `DDR${m[1]}`;
  return out;
}

// ─── Generation-based memType fallback ──────────────────────────────────────
// Uses chip family to infer memType when the name doesn't explicitly state it.
function memTypeFromName(name) {
  if (/\bcore\s+ultra\b/i.test(name)) return 'DDR5';
  if (/\b(?:i[3579]-)?1[2-4]\d{3}/i.test(name)) return 'DDR5';   // Intel 12-14th gen (some support DDR4 too, but DDR5 is canonical)
  if (/\b(?:i[3579]-)?1[01]\d{3}/i.test(name)) return 'DDR4';   // Intel 10-11th gen
  if (/\bryzen\s+[579]\s+(9|7)\d{3}/i.test(name)) return 'DDR5'; // Ryzen 7000+
  if (/\bryzen\s+[579]\s+5\d{3}/i.test(name)) return 'DDR4';     // Ryzen 5000
  if (/\bthreadripper\s+(9|7)\d{3}/i.test(name)) return 'DDR5';  // TR 7000+
  return null;
}

// ─── igpu fallback from chip suffix ─────────────────────────────────────────
// Intel "F" suffix = no iGPU. Otherwise has one.
// AMD: most desktop Ryzens lack iGPU EXCEPT G-series APUs and Ryzen 7000+ (which
// all have a small iGPU). Threadripper = no iGPU.
function igpuFromName(name) {
  if (/\bthreadripper\b/i.test(name)) return false;
  // Intel F suffix
  if (/\b(?:core\s+ultra\s+\d+\s+\d{3}f|i[3579]-\d{4,5}f)\b/i.test(name)) return false;
  // Intel non-F = has iGPU
  if (/\b(?:core\s+ultra|i[3579]-\d{4,5})\b/i.test(name)) return true;
  // AMD G-series
  if (/\bryzen\s+\d\s+\d{4}g\b/i.test(name)) return true;
  // Ryzen 7000+ all have iGPU
  if (/\bryzen\s+\d\s+(9|7|8)\d{3}/i.test(name)) return true;
  // Ryzen 5000 and earlier non-G = no iGPU
  if (/\bryzen\s+\d\s+[1-6]\d{3}/i.test(name)) return false;
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const src = fs.readFileSync(PARTS_PATH, 'utf8');
const partsMatch = src.match(/export\s+const\s+PARTS\s*=\s*(\[[\s\S]*\]);/);
if (!partsMatch) { console.error('✗ PARTS array not found'); process.exit(1); }

let parts;
try { parts = new Function('return ' + partsMatch[1])(); }
catch (e) { console.error('✗ Parse failed:', e.message); process.exit(1); }

const C = { reset: '\x1b[0m', dim: '\x1b[90m', good: '\x1b[92m', mid: '\x1b[93m' };
const stats = { baseClock: 0, boostClock: 0, memType: 0, igpu: 0 };
const updates = [];

for (const p of parts) {
  if (p.c !== 'CPU') continue;
  if (p.needsReview || p.bundle) continue;
  const name = p.n || '';
  const updated = {};

  const fromName = parseFromName(name);
  let ref = null;
  for (const r of REFERENCE) if (r.pattern.test(name)) { ref = r; break; }

  if (!p.baseClock) {
    const v = fromName.baseClock || (ref && ref.base);
    if (v) updated.baseClock = v;
  }
  if (!p.boostClock) {
    const v = fromName.boostClock || (ref && ref.boost);
    if (v) updated.boostClock = v;
  }
  if (!p.memType) {
    const v = fromName.memType || (ref && ref.memType) || memTypeFromName(name);
    if (v) updated.memType = v;
  }
  if (p.igpu === undefined || p.igpu === null) {
    let v = ref ? ref.igpu : null;
    if (v === null) v = igpuFromName(name);
    if (v !== null) updated.igpu = v;
  }

  if (Object.keys(updated).length > 0) {
    updates.push({ id: p.id, name, fields: updated });
    for (const k of Object.keys(updated)) stats[k]++;
  }
}

console.log('\n  CPU enrichment plan');
console.log('  ' + '─'.repeat(50));
console.log(`  Products to update: ${updates.length}`);
console.log(`    baseClock        +${stats.baseClock}`);
console.log(`    boostClock       +${stats.boostClock}`);
console.log(`    memType          +${stats.memType}`);
console.log(`    igpu             +${stats.igpu}`);
console.log('');
console.log('  Sample updates:');
for (const u of updates.slice(0, 4)) {
  console.log(`    ${C.dim}id ${u.id}${C.reset} ${u.name.slice(0, 55)}`);
  for (const [k, v] of Object.entries(u.fields)) console.log(`      ${C.good}+${k}: ${v}${C.reset}`);
}
console.log('');

if (DRY_RUN) {
  console.log(`  ${C.mid}--dry-run: NO changes written${C.reset}\n`);
  process.exit(0);
}

if (updates.length === 0) { console.log('  Nothing to update.\n'); process.exit(0); }

const updatesById = new Map(updates.map((u) => [u.id, u.fields]));
for (const p of parts) {
  const fix = updatesById.get(p.id);
  if (!fix) continue;
  Object.assign(p, fix);
}

const newPartsJson = JSON.stringify(parts, null, 2);
const newSrc = src.replace(/export\s+const\s+PARTS\s*=\s*\[[\s\S]*\];/, `export const PARTS = ${newPartsJson};`);

const backup = PARTS_PATH + '.bak.' + Date.now();
fs.writeFileSync(backup, src, 'utf8');
fs.writeFileSync(PARTS_PATH, newSrc, 'utf8');
console.log(`  ${C.good}✓ Updated ${updates.length} CPU products${C.reset}`);
console.log(`    Backup: ${backup}`);
console.log(`    Re-run: node audit-spec-coverage.cjs\n`);
