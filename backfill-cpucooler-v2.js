#!/usr/bin/env node
/**
 * backfill-cpucooler-v2.js
 *
 * 1. REMOVE misclassified products from CPUCooler (they belong elsewhere):
 *      - Cooler Master HAF 500 Pro  → that's a Case, remove from coolers
 *      - Cooler Master MasterFan MF140 Halo → that's a Case Fan
 *      - Noctua NA-HC3/HC4 chromax → heatsink covers (accessory)
 *      - Thermaltake UX200 (non-CPU version) → LED controller, not a cooler
 *
 * 2. FILL remaining AIO radSize + Air height/tdp for identifiable models.
 *
 * 3. Final coverage report.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = mod.PARTS;

// ─── STEP 1: REMOVE MISCLASSIFIED ────────────────────────────────────────────
const REMOVE_PATTERNS = [
  /HAF\s*500\s*Pro/i,              // Case, not cooler
  /MasterFan\s*MF140\s*Halo/i,     // Case fan
  /NA-HC[34]/i,                    // Heatsink cover (accessory)
  /UX200\s*(?:5V|SE\s*ARGB\s*Lighting)/i, // LED controller, not cooler
];

const toRemove = [];
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  const text = `${p.b} ${p.n}`;
  if (REMOVE_PATTERNS.some(re => re.test(text))) {
    toRemove.push({ id: p.id, b: p.b, n: p.n.slice(0, 70) });
  }
}
console.log(`━━━ REMOVING ${toRemove.length} MISCLASSIFIED ━━━`);
toRemove.forEach(x => console.log(`  [${x.b}] ${x.n}`));
parts = parts.filter(p => !toRemove.some(r => r.id === p.id));

// ─── STEP 2: EXTENDED DICTIONARY ────────────────────────────────────────────
const DB = [
  // ═══ CORSAIR H60x ════════════════════════════════════════════════════════
  { pat: /Corsair\s+H60x\s*RGB\s*Elite/i, type: 'AIO', radSize: 120, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ THERMALRIGHT AIO — MISSED VARIANTS ═════════════════════════════════
  { pat: /Thermalright\s+FW\s*240/i,          type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+FW\s*360/i,          type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+FW\s*PRO\s*360/i,    type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Frozen\s*Notte\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Frozen\s*Infinity\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Frozen\s*Infinity\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Peerless\s*Vision\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Aqua\s*Elite\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Aqua\s*Elite\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ NZXT MISSING ═══════════════════════════════════════════════════════
  { pat: /NZXT\s+Kraken\s*M22/i,              type: 'AIO', radSize: 120, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Z73/i,              type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Z63/i,              type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Z53/i,              type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ EKWB ════════════════════════════════════════════════════════════════
  { pat: /EK-Nucleus\s*AIO\s*CR360/i,         type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /EK-Nucleus\s*AIO\s*CR240/i,         type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ LIAN LI HYDROSHIFT + GALAHAD II ════════════════════════════════════
  { pat: /Lian\s*Li.*Hydroshift\s*II-S\s*LCD\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li.*Hydroshift\s*360/i,      type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Galahad.*(?:II\s*)?Trinity\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Galahad.*(?:II\s*)?Trinity\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ COOLER MASTER ATMOS ════════════════════════════════════════════════
  { pat: /(?:Cooler\s*Master\s+)?360\s*Atmos(?:\s*Stealth)?/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ MONTECH HYPERFLOW ══════════════════════════════════════════════════
  { pat: /Montech\s+HyperFlow\s*(?:ARGB\s*|Silent\s*)?360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Montech\s+HyperFlow\s*(?:ARGB\s*|Silent\s*)?240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ ASUS PRIME + TUF ═══════════════════════════════════════════════════
  { pat: /ASUS.*Prime\s*LC\s*360/i,           type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS.*Prime\s*LC\s*240/i,           type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS.*TUF\s*Gaming\s*LC\s*III\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS.*TUF\s*Gaming\s*LC\s*III\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ AIR COOLERS ════════════════════════════════════════════════════════
  // be quiet! Pure Rock 3 lineup
  { pat: /be\s*quiet!\s*Pure\s*Rock\s*3\s*Black/i,    type: 'Air', height: 155, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Pure\s*Rock\s*Pro\s*3(?:\s*(?:Black|Silver|LX))?/i, type: 'Air', height: 162, tdp: 220, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },

  // Thermalright additional
  { pat: /Thermalright\s+PS120SE/i,                   type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Assassin\s*X\s*120R\s*Digital/i, type: 'Air', height: 154, tdp: 210, fans: 1, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Peerless\s*Assassin\s*140(?:\s*(?:Black|Digital|SE\s*ARGB))?/i, type: 'Air', height: 160, tdp: 265, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Peerless\s*Assassin\s*90\s*SE/i, type: 'Air', height: 129, tdp: 180, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+SI-100/i,                    type: 'Air', height: 61,  tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ID-COOLING FROZN lineup
  { pat: /ID-COOLING\s+FROZN\s*A620(?:\s*(?:PRO|GDL))?/i, type: 'Air', height: 157, tdp: 260, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /ID-COOLING\s+FROZN\s*A720/i,                 type: 'Air', height: 162, tdp: 270, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // Scythe
  { pat: /SCYTHE\s+Fuma\s*3/i,                         type: 'Air', height: 155, tdp: 200, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // Noctua NH-D9L
  { pat: /Noctua.*NH-D9L/i,                            type: 'Air', height: 110, tdp: 140, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // TRYX TURRIS
  { pat: /TRYX\s+TURRIS\s*620/i,                       type: 'Air', height: 164, tdp: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // PCCOOLER additional
  { pat: /PCCOOLER\s+RZ620/i,                          type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // Cooler Master Hyper additional
  { pat: /Cooler\s*Master\s+Hyper\s*620S/i,            type: 'Air', height: 158, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+Hyper\s*411\s*Nano/i,      type: 'Air', height: 130, tdp: 100, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Cooler\s*Master\s+Hyper\s*212\s*3DHP/i,      type: 'Air', height: 159, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // DarkFlash Z4Pro
  { pat: /DarkFlash\s+Z4Pro/i,                         type: 'Air', height: 158, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // Montech NX600
  { pat: /Montech\s+NX600/i,                           type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // Thermaltake
  { pat: /Thermaltake.*TOUGHAIR\s*510/i,               type: 'Air', height: 155, tdp: 180, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermaltake.*Contac\s*(?:9|Silent\s*12)/i,   type: 'Air', height: 155, tdp: 140, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermaltake.*UX200/i,                        type: 'Air', height: 159, tdp: 170, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // KingCool Iron Wind
  { pat: /KINGCOOL\s+Iron\s*Wind/i,                    type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // SAMA A60B
  { pat: /SAMA\s+A60B/i,                               type: 'Air', height: 154, tdp: 220, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // UpHere Generic
  { pat: /UpHere.*Dual\s*Tower.*6\s*Heat/i,            type: 'Air', height: 158, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // Sudokoo SK700V
  { pat: /Sudokoo\s+SK700V/i,                          type: 'Air', height: 158, tdp: 245, fans: 2, sockets: 'AM5', rgb: true },

  // Generic PCCOOLER single-tower ARGB
  { pat: /PCCOOLER.*5×6mm\s*Heat\s*Pipes|PCCOOLER.*120mm\s*ARGB\s*Fan/i, type: 'Air', height: 155, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
];

let matched = 0;
const stats = { coolerType: 0, radSize: 0, height: 0, tdp_rating: 0, fans_inc: 0, sockets: 0, rgb: 0 };

for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      matched++;
      if (entry.type && p.coolerType == null) { p.coolerType = entry.type; stats.coolerType++; }
      if (entry.radSize != null && p.radSize == null) { p.radSize = entry.radSize; stats.radSize++; }
      if (entry.height != null && p.height == null) { p.height = entry.height; stats.height++; }
      if (entry.tdp != null && p.tdp_rating == null) { p.tdp_rating = entry.tdp; stats.tdp_rating++; }
      if (entry.fans != null && p.fans_inc == null) { p.fans_inc = entry.fans; stats.fans_inc++; }
      if (entry.sockets && p.sockets == null) { p.sockets = entry.sockets; stats.sockets++; }
      if (entry.rgb !== undefined && p.rgb == null) { p.rgb = entry.rgb; stats.rgb++; }
      break;
    }
  }
}

console.log(`\nMatched: ${matched}`);
console.log('Filled:', JSON.stringify(stats));

// ─── FINAL REPORT ──────────────────────────────────────────────────────────
const coolers = parts.filter(p => p.c === 'CPUCooler');
const aios = coolers.filter(p => p.coolerType === 'AIO');
const airs = coolers.filter(p => p.coolerType === 'Air');

console.log(`\n━━━ FINAL COVERAGE ━━━`);
console.log(`Total coolers: ${coolers.length}  (AIO: ${aios.length}, Air: ${airs.length})`);
console.log(`\n  AIO fields:`);
console.log(`    radSize    ${aios.filter(x => x.radSize != null).length}/${aios.length}  (${Math.round(aios.filter(x => x.radSize != null).length / Math.max(aios.length, 1) * 100)}%)`);
console.log(`    fans_inc   ${aios.filter(x => x.fans_inc != null).length}/${aios.length}  (${Math.round(aios.filter(x => x.fans_inc != null).length / Math.max(aios.length, 1) * 100)}%)`);
console.log(`    rgb        ${aios.filter(x => x.rgb != null).length}/${aios.length}  (${Math.round(aios.filter(x => x.rgb != null).length / Math.max(aios.length, 1) * 100)}%)`);
console.log(`\n  Air fields:`);
console.log(`    height     ${airs.filter(x => x.height != null).length}/${airs.length}  (${Math.round(airs.filter(x => x.height != null).length / Math.max(airs.length, 1) * 100)}%)`);
console.log(`    tdp_rating ${airs.filter(x => x.tdp_rating != null).length}/${airs.length}  (${Math.round(airs.filter(x => x.tdp_rating != null).length / Math.max(airs.length, 1) * 100)}%)`);
console.log(`    sockets    ${airs.filter(x => x.sockets != null).length}/${airs.length}  (${Math.round(airs.filter(x => x.sockets != null).length / Math.max(airs.length, 1) * 100)}%)`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
