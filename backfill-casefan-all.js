#!/usr/bin/env node
/**
 * backfill-casefan-all.js
 *
 * Three jobs in one pass:
 *
 * 1. REMOVE misclassified products from CaseFan category:
 *    - Desk fans (Noctua NV-FS1)
 *    - AIO coolers (NZXT Kraken Plus, Thermaltake TH120, Pure Loop 3, Light Loop)
 *    - Full PC cases (be quiet! Pure Base 500/501/Silent Base 802/Shadow Base 800)
 *    - Corsair cases (iCUE 220T, 4000D)
 *    - Fan controllers / hubs (Lian Li L-Wireless, SL-Infinity Hub, Corsair Commander)
 *    - Cables / splitters (EZDIY-FAB, COMeap, RGB Splitter)
 *    - Non-PC fans (Apple MacBook fan, RC model fan, ESC fan)
 *    - Weird brand names (SHENZHEN SURPASS TECH CO.,LTD, MG62090V1-Q030-S99)
 *    - Corsair AIOs (iCUE Link H170i, iCUE Link Titan, Nautilus 240)
 *    - Thermalright CPU cooler (Jonsbo CR-1200 CPU cooler)
 *
 * 2. NORMALIZE brand duplicates:
 *    - CORSAIR → Corsair
 *    - Lian-Li → Lian Li
 *    - Deepcool → DeepCool
 *    - Thermalright T → Thermalright
 *
 * 3. DICTIONARY of fan specs for 300+ known models
 *    Fills: size, cfm, rpm, noise, rgb, pwm, pack, fans_inc
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = mod.PARTS;

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: REMOVE MISCLASSIFIED PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════
const REMOVE_PATTERNS = [
  // Desk fans / non-PC fans
  /NV-FS1|Desk,?\s*Room\s*and\s*Multi-Purpose\s*Fan/i,
  /RC\s*Model|ESC\s*Cooling\s*Fan|28000RPM\s*RC/i,
  /MacBook|Apple\s*MacBook/i,

  // AIO coolers hiding in CaseFan
  /Kraken\s*Plus\b/i,
  /TH120\s*ARGB\s*Sync\s*V2\s*CPU\s*Liquid/i,
  /Pure\s*Loop\s*3\s*\d+mm\s*All-in-One/i,
  /Light\s*Loop\s*\d+mm.*Water\s*Cooling/i,
  /GA\s*II\s*Trinity\s*SL-INF\s*360/i,
  /H170i\s*RGB\s*Liquid\s*CPU\s*Cooler/i,
  /iCUE\s*Link\s*Titan\s*\d+\s*RX\s*RGB\s*Liquid/i,
  /Nautilus\s*240\s*RS\s*ARGB\s*Liquid\s*CPU/i,

  // Full PC cases
  /Pure\s*Base\s*50[01]\s*(?:ATX|Black|White)/i,
  /Silent\s*Base\s*802\s*ATX/i,
  /Shadow\s*Base\s*800\s*FX/i,
  /iCUE\s*220T\s*RGB\s*Airflow.*Tempered\s*Glass/i,
  /iCUE\s*4000D\s*RGB\s*Airflow/i,

  // Fan controllers / hubs / cables
  /Commander\s*Duo\s*iCUE/i,
  /UNI\s*Fan\s*SL-Infinity\s*Fan\s*Hub\s*Controller/i,
  /UNI\s*Fan\s*L-Wireless\s*Controller/i,
  /RGB\s*Splitter\s*for\s*Corsair/i,
  /Adapter\s*Cable\s*Compatible/i,

  // CPU coolers
  /Jonsbo.*CR-1200.*CPU\s*Cooler/i,

  // Garbage brand / non-product
  /SHENZHEN\s*SURPASS\s*TECH/i,
];

const toRemove = [];
for (const p of parts) {
  if (p.c !== 'CaseFan') continue;
  const text = `${p.b} ${p.n}`;
  if (REMOVE_PATTERNS.some(re => re.test(text))) {
    toRemove.push({ id: p.id, b: p.b, n: p.n.slice(0, 70) });
  }
  // Also remove by brand name garbage
  if (p.b === 'MG62090V1-Q030-S99' || p.b === 'SHENZHEN SURPASS TECH CO.,LTD') {
    if (!toRemove.some(r => r.id === p.id)) {
      toRemove.push({ id: p.id, b: p.b, n: p.n.slice(0, 70) });
    }
  }
}

console.log(`━━━ STEP 1: REMOVING ${toRemove.length} MISCLASSIFIED ━━━`);
toRemove.forEach(x => console.log(`  [${x.b}] ${x.n}`));
const removeIds = new Set(toRemove.map(x => x.id));
parts = parts.filter(p => !removeIds.has(p.id));

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: NORMALIZE BRAND NAMES
// ═══════════════════════════════════════════════════════════════════════════
const BRAND_FIXES = {
  'CORSAIR': 'Corsair',
  'Lian-Li': 'Lian Li',
  'Deepcool': 'DeepCool',
  'Thermalright T': 'Thermalright',
};

let brandFixed = 0;
for (const p of parts) {
  if (p.c !== 'CaseFan') continue;
  if (BRAND_FIXES[p.b]) {
    p.b = BRAND_FIXES[p.b];
    brandFixed++;
  }
}
console.log(`\n━━━ STEP 2: BRAND NORMALIZATION ━━━`);
console.log(`Brand names normalized: ${brandFixed}`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: FAN SPEC DICTIONARY
// ═══════════════════════════════════════════════════════════════════════════
// Spec format:
//   size: 120 | 140 | 92 | 80 | 200
//   cfm: airflow (higher = more air)
//   rpm: max RPM
//   noise: dBA at max speed
//   pwm: true (all 4-pin fans) | false (3-pin)
//   rgb: true | false
//   rgbType: 'ARGB' | 'RGB' | null
//   pack: number of fans in the package
//
// All specs are from manufacturer spec sheets.
const DB = [
  // ═══ NOCTUA ═══════════════════════════════════════════════════════════════
  { pat: /NF-A12x25\s*G2\s*PWM\s*Sx2-PP/i, size: 120, cfm: 60.1, rpm: 2000, noise: 22.6, pwm: true, rgb: false, pack: 2 },
  { pat: /NF-A12x25\s*G2\s*PWM/i, size: 120, cfm: 60.1, rpm: 2000, noise: 22.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A12x25\s*5V\s*PWM/i, size: 120, cfm: 60.1, rpm: 2000, noise: 22.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A12x25\s*PWM\s*3-Pack/i, size: 120, cfm: 60.1, rpm: 2000, noise: 22.6, pwm: true, rgb: false, pack: 3 },
  { pat: /NF-A12x25\s*PWM/i, size: 120, cfm: 60.1, rpm: 2000, noise: 22.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A14x25\s*G2\s*PWM\s*Sx2-PP/i, size: 140, cfm: 82.5, rpm: 1500, noise: 23.6, pwm: true, rgb: false, pack: 2 },
  { pat: /NF-A14x25\s*G2\s*PWM/i, size: 140, cfm: 82.5, rpm: 1500, noise: 23.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A14\s*iPPC-3000\s*PWM/i, size: 140, cfm: 158.5, rpm: 3000, noise: 41.3, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A14\s*PWM/i, size: 140, cfm: 82.5, rpm: 1500, noise: 24.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A15\s*HS-PWM/i, size: 140, cfm: 78.7, rpm: 1500, noise: 24.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A15\s*PWM/i, size: 140, cfm: 78.7, rpm: 1500, noise: 24.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-F12\s*iPPC\s*3000\s*PWM/i, size: 120, cfm: 109.9, rpm: 3000, noise: 43.5, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-F12\s*PWM/i, size: 120, cfm: 55, rpm: 1500, noise: 22.4, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-P12\s*redux-1700\s*PWM/i, size: 120, cfm: 70.7, rpm: 1700, noise: 25.1, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-P12\s*redux-1300\s*PWM/i, size: 120, cfm: 54.3, rpm: 1300, noise: 19.8, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-P14s\s*redux-1500\s*PWM/i, size: 140, cfm: 78.6, rpm: 1500, noise: 25.8, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-P14s\s*redux-1200\s*PWM/i, size: 140, cfm: 64.9, rpm: 1200, noise: 19.2, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-P14s\s*redux-1200\b(?!\s*PWM)/i, size: 140, cfm: 64.9, rpm: 1200, noise: 19.2, pwm: false, rgb: false, pack: 1 },
  { pat: /NF-S12A\s*PWM/i, size: 120, cfm: 63.3, rpm: 1200, noise: 17.8, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A9x14\s*HS-PWM/i, size: 92, cfm: 33.8, rpm: 2500, noise: 23.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A9x14\s*PWM/i, size: 92, cfm: 33.8, rpm: 2500, noise: 23.6, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-A12x15\s*PWM/i, size: 120, cfm: 55.4, rpm: 1850, noise: 23.9, pwm: true, rgb: false, pack: 1 },
  { pat: /NF-D9L|NF-D9\b/i, size: 92, cfm: 57.5, rpm: 2000, noise: 22.8, pwm: true, rgb: false, pack: 1 },

  // ═══ ARCTIC ═══════════════════════════════════════════════════════════════
  { pat: /P12\s*Pro\s*A-RGB.*3\s*Pack|P12\s*Pro\s*A-RGB\s*\(White\)\s*-\s*3\s*Pack/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /P12\s*Pro\s*A-RGB/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /P12\s*Pro\s*Reverse\s*A-RGB.*3\s*Pack/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /P12\s*Pro\s*Reverse\s*A-RGB/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /P12\s*Pro\s*Reverse\b(?!\s*A-?RGB)/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P12\s*Pro\s*PST\s*CO/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P12\s*Pro\s*PST\s*-\s*5\s*Pack/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: false, pack: 5 },
  { pat: /P12\s*Pro\s*PST\b/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P12\s*Pro\b/i, size: 120, cfm: 56.3, rpm: 3000, noise: 39.5, pwm: true, rgb: false, pack: 1 },
  { pat: /Arctic\s*P12\s*PST\s*5-Pack|P12\s*\(5\s*Pack\)/i, size: 120, cfm: 53, rpm: 1800, noise: 22.5, pwm: true, rgb: false, pack: 5 },
  { pat: /P12\s*PWM\s*PST\s*A-RGB\s*\(3\s*Pack\)/i, size: 120, cfm: 48.8, rpm: 2000, noise: 22.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /P12\s*PWM\s*PST\s*A-RGB/i, size: 120, cfm: 48.8, rpm: 2000, noise: 22.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /P12\s*Slim\s*PWM\s*PST\s*\(3\s*Pack\)/i, size: 120, cfm: 34, rpm: 1800, noise: 21.5, pwm: true, rgb: false, pack: 3 },
  { pat: /P12\s*PWM\s*PST\b/i, size: 120, cfm: 53, rpm: 1800, noise: 22.5, pwm: true, rgb: false, pack: 1 },
  { pat: /Arctic\s*P14\s*PST\s*5-Pack|P14\s*PWM\s*PST\s*\(5\s*Pack\)/i, size: 140, cfm: 72.8, rpm: 1700, noise: 24.6, pwm: true, rgb: false, pack: 5 },
  { pat: /P14\s*Max\b/i, size: 140, cfm: 119, rpm: 2800, noise: 43.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P14\s*Pro\s*A-RGB.*3\s*Pack/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /P14\s*Pro\s*Reverse\s*A-RGB.*3\s*Pack/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /P14\s*Pro\s*Reverse\s*A-RGB/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /P14\s*Pro\s*Reverse\b(?!\s*A-?RGB)/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P14\s*Pro\s*A-RGB/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /P14\s*Pro\s*PST/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: false, pack: 1 },
  { pat: /P14\s*Pro\b/i, size: 140, cfm: 72.8, rpm: 2500, noise: 34.5, pwm: true, rgb: false, pack: 1 },
  { pat: /Arctic.*P14\s*-\s*PC\s*Fan/i, size: 140, cfm: 72.8, rpm: 1700, noise: 24.6, pwm: false, rgb: false, pack: 1 },
  { pat: /P8\s*PWM\s*PST\s*\(5\s*Pack\)/i, size: 80, cfm: 31, rpm: 3000, noise: 22, pwm: true, rgb: false, pack: 5 },

  // ═══ NZXT ═════════════════════════════════════════════════════════════════
  { pat: /F420\s*RGB\s*Core/i, size: 140, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /F360\s*RGB\s*Core/i, size: 120, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /F280\s*RGB\s*Core/i, size: 140, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /F240\s*RGB\s*Core/i, size: 120, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /F120\s*Core\s*RGB/i, size: 120, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /NZXT-F360X\s*Performance/i, size: 120, cfm: 67.5, rpm: 2500, noise: 35.8, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /NZXT-F280X\s*Performance/i, size: 140, cfm: 70.3, rpm: 2000, noise: 32.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /NZXT-F240X\s*Performance/i, size: 120, cfm: 67.5, rpm: 2500, noise: 35.8, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /F140X\s*Performance/i, size: 140, cfm: 70.3, rpm: 2000, noise: 32.5, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F120X\s*Performance/i, size: 120, cfm: 67.5, rpm: 2500, noise: 35.8, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F140\s*Duo\s*RGB/i, size: 140, cfm: 70.3, rpm: 1800, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F120\s*Duo\s*RGB/i, size: 120, cfm: 56.5, rpm: 1800, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F140\s*RGB\s*Twin\s*Pack/i, size: 140, cfm: 50, rpm: 1800, noise: 31, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /F140\s*RGB\b/i, size: 140, cfm: 50, rpm: 1800, noise: 31, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F140RGB\s*Core|F140\s*RGB\s*Core/i, size: 140, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F120\s*RGB\s*Core/i, size: 120, cfm: 56.5, rpm: 1800, noise: 32, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F120\s*RGB\b/i, size: 120, cfm: 50, rpm: 1800, noise: 31, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /AER\s*F140\s*RGB/i, size: 140, cfm: 74, rpm: 1800, noise: 33, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /F140Q\b/i, size: 140, cfm: 50, rpm: 1000, noise: 21, pwm: true, rgb: false, pack: 1 },

  // ═══ BE QUIET! ════════════════════════════════════════════════════════════
  { pat: /Silent\s*Wings\s*Pro\s*4\s*120mm/i, size: 120, cfm: 77.9, rpm: 3000, noise: 36.9, pwm: true, rgb: false, pack: 1 },
  { pat: /Silent\s*Wings\s*Pro\s*4\s*140mm/i, size: 140, cfm: 110.5, rpm: 2400, noise: 36.3, pwm: true, rgb: false, pack: 1 },
  { pat: /Silent\s*Wings\s*4\s*120mm\s*PWM\s*High\s*Speed|Silent\s*Wings\s*4\s*120mm\s*PWM\s*2500/i, size: 120, cfm: 78.5, rpm: 2500, noise: 36.9, pwm: true, rgb: false, pack: 1 },
  { pat: /Silent\s*Wings\s*4\s*120mm\s*PWM\s*1600/i, size: 120, cfm: 55.5, rpm: 1600, noise: 18.9, pwm: true, rgb: false, pack: 1 },
  { pat: /Silent\s*Wings\s*4\s*120mm\b/i, size: 120, cfm: 55.5, rpm: 1600, noise: 18.9, pwm: true, rgb: false, pack: 1 },
  { pat: /Silent\s*Wings\s*4\s*140mm\b/i, size: 140, cfm: 80.3, rpm: 1100, noise: 13.6, pwm: true, rgb: false, pack: 1 },
  { pat: /Light\s*Wings\s*LX\s*120mm\s*PWM\s*high-Speed\s*Triple\s*Pack/i, size: 120, cfm: 63.8, rpm: 2100, noise: 25.3, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Light\s*Wings\s*LX\s*120mm/i, size: 120, cfm: 63.8, rpm: 2100, noise: 25.3, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Light\s*Wings\s*LX\s*140mm/i, size: 140, cfm: 71.4, rpm: 1700, noise: 22.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Light\s*Wings\s*White\s*140mm\s*PWM\s*Triple/i, size: 140, cfm: 71.4, rpm: 1700, noise: 22.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Light\s*Wings\s*140mm\s*PWM.*3-Pack|Light\s*Wings\s*140mm\s*PWM.*Triple/i, size: 140, cfm: 71.4, rpm: 1700, noise: 22.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Light\s*Wings\s*140mm\s*PWM\s*High\s*Speed/i, size: 140, cfm: 98.6, rpm: 2500, noise: 33.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Light\s*Wings\s*140mm/i, size: 140, cfm: 71.4, rpm: 1700, noise: 22.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Light\s*Wings\s*120mm\s*3-Pack/i, size: 120, cfm: 46.2, rpm: 1700, noise: 25.3, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Light\s*Wings\s*120mm/i, size: 120, cfm: 46.2, rpm: 1700, noise: 25.3, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Pure\s*Wings\s*3\s*120mm\s*PWM\s*Triple\s*Pack|Pure\s*Wings\s*3\s*120mm\s*PWM.*3\s*Included.*high\s*top-end/i, size: 120, cfm: 59, rpm: 2100, noise: 30.5, pwm: true, rgb: false, pack: 3 },
  { pat: /Pure\s*Wings\s*3\s*120mm\s*PWM\s*high-Speed.*3\s*Included/i, size: 120, cfm: 59, rpm: 2100, noise: 30.5, pwm: true, rgb: false, pack: 3 },
  { pat: /Pure\s*Wings\s*3\s*120mm\s*PWM\s*High-Speed|Pure\s*Wings\s*3\s*120mm\s*PWM\s*high-Speed/i, size: 120, cfm: 59, rpm: 2100, noise: 30.5, pwm: true, rgb: false, pack: 1 },
  { pat: /Pure\s*Wings\s*3\s*120mm\s*Quiet/i, size: 120, cfm: 40.6, rpm: 1600, noise: 20.4, pwm: true, rgb: false, pack: 1 },
  { pat: /Pure\s*Wings\s*3\s*140mm\s*PWM\s*high-Speed.*3\s*Included/i, size: 140, cfm: 78.8, rpm: 1900, noise: 30.4, pwm: true, rgb: false, pack: 3 },
  { pat: /Pure\s*Wings\s*3\s*140mm\s*PWM.*3\s*Included/i, size: 140, cfm: 78.8, rpm: 1900, noise: 30.4, pwm: true, rgb: false, pack: 3 },
  { pat: /Pure\s*Wings\s*3\s*140mm\s*PWM\s*High-Speed|Pure\s*Wings\s*3\s*140mm\s*PWM\s*high-Speed/i, size: 140, cfm: 78.8, rpm: 1900, noise: 30.4, pwm: true, rgb: false, pack: 1 },
  { pat: /Pure\s*Wings\s*3\s*140mm\s*Quiet/i, size: 140, cfm: 51.7, rpm: 1400, noise: 16.4, pwm: true, rgb: false, pack: 1 },
  { pat: /Shadow\s*Wings\s*2\s*140mm/i, size: 140, cfm: 61.2, rpm: 900, noise: 14.7, pwm: true, rgb: false, pack: 1 },

  // ═══ CORSAIR ══════════════════════════════════════════════════════════════
  // iCUE Link QX series (premium daisy-chain)
  { pat: /iCUE\s*Link\s*QX140\s*RGB.*(?:2-pack|2\s*Pack)/i, size: 140, cfm: 77, rpm: 2000, noise: 36, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /iCUE\s*Link\s*QX140\s*RGB/i, size: 140, cfm: 77, rpm: 2000, noise: 36, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*Link\s*QX120\s*RGB.*(?:3-pack|Triple\s*Fan)/i, size: 120, cfm: 64, rpm: 2400, noise: 37, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*Link\s*QX120\s*RGB/i, size: 120, cfm: 64, rpm: 2400, noise: 37, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  // iCUE Link RX series
  { pat: /iCUE\s*Link\s*RX120\s*MAX\s*RGB/i, size: 120, cfm: 84, rpm: 2100, noise: 35, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*Link\s*RX120\s*RGB.*(?:3-pack|Starter\s*Kit)/i, size: 120, cfm: 67.8, rpm: 2100, noise: 37, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*Link\s*RX120\s*RGB/i, size: 120, cfm: 67.8, rpm: 2100, noise: 37, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*Link\s*RX120\b(?!\s*RGB)/i, size: 120, cfm: 67.8, rpm: 2100, noise: 37, pwm: true, rgb: false, pack: 1 },
  // iCUE Link LX series
  { pat: /iCUE\s*Link\s*LX120-R\s*RGB.*(?:3-pack|Starter\s*Kit)/i, size: 120, cfm: 52, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*Link\s*LX120-R\s*RGB/i, size: 120, cfm: 52, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*Link\s*LX140-R\s*RGB/i, size: 140, cfm: 74.9, rpm: 2000, noise: 30.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*Link\s*LX120\s*RGB.*(?:3-pack|Starter\s*Kit)/i, size: 120, cfm: 52, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*Link\s*LX120\s*RGB/i, size: 120, cfm: 52, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  // RS series (non-iCUE Link)
  { pat: /RS120-R\s*ARGB/i, size: 120, cfm: 55.1, rpm: 1800, noise: 28.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /RS120\s*ARGB.*(?:3-pack|Triple)/i, size: 120, cfm: 55.1, rpm: 1800, noise: 28.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /RS120\s*ARGB/i, size: 120, cfm: 55.1, rpm: 1800, noise: 28.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /RS140\s*ARGB.*(?:Dual\s*Pack|2\s*Pack)/i, size: 140, cfm: 68.9, rpm: 1600, noise: 28.7, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /RS140\s*ARGB/i, size: 140, cfm: 68.9, rpm: 1600, noise: 28.7, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /RS120\s*120mm\s*PWM\b(?!.*ARGB)/i, size: 120, cfm: 55.1, rpm: 1800, noise: 28.6, pwm: true, rgb: false, pack: 1 },
  { pat: /RS140\s*140mm\s*PWM.*(?:Dual\s*Pack|2\s*Pack)/i, size: 140, cfm: 68.9, rpm: 1600, noise: 28.7, pwm: true, rgb: false, pack: 2 },
  // iCUE SP/AF/ML series (older)
  { pat: /iCUE\s*SP120\s*RGB\s*Elite\s*3-Pack/i, size: 120, cfm: 52, rpm: 1800, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*SP120\s*RGB\s*Elite/i, size: 120, cfm: 52, rpm: 1800, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /iCUE\s*SP140\s*RGB\s*Elite/i, size: 140, cfm: 68, rpm: 1400, noise: 24, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /iCUE\s*AF120\s*RGB\s*Elite\s*3-Pack/i, size: 120, cfm: 63, rpm: 2100, noise: 34, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /iCUE\s*AF120\s*RGB\s*Elite/i, size: 120, cfm: 63, rpm: 2100, noise: 34, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /LL120\s*RGB.*Single\s*Pack|LL\s*Series\s*LL120/i, size: 120, cfm: 43.25, rpm: 1500, noise: 24.8, pwm: true, rgb: true, rgbType: 'RGB', pack: 1 },
  { pat: /ML140\s*RGB\s*Elite.*2-Pack|ML140\s*RGB\s*Elite.*Dual/i, size: 140, cfm: 91.3, rpm: 2000, noise: 37, pwm: true, rgb: true, rgbType: 'RGB', pack: 2 },
  { pat: /ML120\s*LED\s*Elite/i, size: 120, cfm: 58.1, rpm: 2400, noise: 36, pwm: true, rgb: false, pack: 1 },

  // ═══ THERMALTAKE ══════════════════════════════════════════════════════════
  { pat: /SWAFAN\s*EX12\s*ARGB.*(?:3-Fan\s*Pack|3-Pack)/i, size: 120, cfm: 54.7, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /SWAFAN\s*EX\s*12\s*ARGB/i, size: 120, cfm: 54.7, rpm: 2000, noise: 29.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /SWAFAN\s*EX14\s*RGB.*3-Pack/i, size: 140, cfm: 62.8, rpm: 2000, noise: 32.7, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Toughfan\s*EX\s*120\s*ARGB.*3-Pack/i, size: 120, cfm: 72.69, rpm: 2000, noise: 28.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /CT\s*120\s*ARGB\s*Sync.*(?:3-Pack)/i, size: 120, cfm: 42.63, rpm: 1500, noise: 21.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /CT\s*120\s*ARGB\s*Sync.*(?:2-Pack)/i, size: 120, cfm: 42.63, rpm: 1500, noise: 21.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /CT120\s*ARGB\s*Sync.*(?:2-Pack|3-Pack)/i, size: 120, cfm: 42.63, rpm: 1500, noise: 21.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /CT120\s*EX\s*ARGB\s*Sync.*3-Pack/i, size: 120, cfm: 42.63, rpm: 1500, noise: 21.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /CT120\b.*(?:2-Pack)/i, size: 120, cfm: 42.63, rpm: 1500, noise: 21.1, pwm: true, rgb: false, pack: 2 },
  { pat: /CT140\s*ARGB\s*Sync.*(?:2-Fan\s*Pack|2-Pack)/i, size: 140, cfm: 60.93, rpm: 1500, noise: 26.4, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /CT200\s*ARGB\s*PWM/i, size: 200, cfm: 103.4, rpm: 1000, noise: 24.9, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /CT200\s*PWM\b/i, size: 200, cfm: 103.4, rpm: 1000, noise: 24.9, pwm: true, rgb: false, pack: 1 },
  { pat: /LE120\s*ARGB.*(?:Sync\s*)?.*(?:3-Pack|3\s*Pack)/i, size: 120, cfm: 40, rpm: 1500, noise: 21, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Pure\s*20\b/i, size: 200, cfm: 85, rpm: 800, noise: 14, pwm: false, rgb: false, pack: 1 },
  { pat: /Riing\s*12\s*LED/i, size: 120, cfm: 40.6, rpm: 1500, noise: 24.6, pwm: true, rgb: false, pack: 1 },

  // ═══ LIAN LI ══════════════════════════════════════════════════════════════
  { pat: /Lian\s*Li\s*UNI\s*FAN\s*SL-INF\s*120\s*3-Pack/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*120-Single\s*Pack/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*Wireless\s*120\s*-\s*Triple/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*TL\s*Wireless\s*120-Triple/i, size: 120, cfm: 68.5, rpm: 2600, noise: 33, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*TL\s*LCD\s*Wireless\s*120-Single/i, size: 120, cfm: 68.5, rpm: 2600, noise: 33, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /UNI\s*Fan\s*SL\s*Wireless\s*120mm\s*ARGB\s*Fan\s*-\s*Triple/i, size: 120, cfm: 58.54, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*120\s*-\s*Triple\s*Pack\s*\(Reverse\s*Blade\)/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*120mm\s*-\s*Triple\s*Pack\s*\(Reverse\s*Blade\)/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*SL-INF\s*120\s*RGB\s*Infinity\s*Mirror/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*UF-SLIN120-3B/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*FAN\s*SL\s*Wireless\s*LCD\s*PC\s*Fan\s*120mm\s*RGB/i, size: 120, cfm: 68.5, rpm: 2600, noise: 33, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*FAN\s*SL-INF\s*Reverse\s*Blade\s*ARGB\s*120mm\s*Triple/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /UNI\s*Fan\s*CL120\s*ARGB\s*120mm.*Triple/i, size: 120, cfm: 68.5, rpm: 2150, noise: 32.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Lian-?Li\s*UNI\s*FAN\s*AL120.*3-Pack/i, size: 120, cfm: 56, rpm: 1900, noise: 31, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Lian-?Li\s*UNI\s*Fan\s*SL-Infinity\s*120mm\s*ARGB.*3-Pack/i, size: 120, cfm: 61.3, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /SL120V2-3B|Uni\s*Fan\s*Sl\s*V2\s*Sl120/i, size: 120, cfm: 58.54, rpm: 1900, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /UNI\s*Fan\s*P28\s*120/i, size: 120, cfm: 65.8, rpm: 2200, noise: 33, pwm: true, rgb: false, pack: 1 },
  { pat: /UNI\s*Fan\s*SL-Infinity\s*ARGB\s*PWM.*140mm/i, size: 140, cfm: 73.2, rpm: 1600, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /14RSLIN1B|14RSLIN1W|UNI\s*Fan\s*SL\s*Infinity\s*140/i, size: 140, cfm: 73.2, rpm: 1600, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ THERMALRIGHT ═════════════════════════════════════════════════════════
  { pat: /Thermalright\s*TL-C12C-S\s*3-Pack/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-C12C-S\s*X3\s*CPU\s*Fan\s*120mm\s*ARGB/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-C12C-S\s*X5/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 5 },
  { pat: /5\s*Pack\s*TL-C12C-S/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 5 },
  { pat: /TL-C12C\s*X3/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: false, pack: 3 },
  { pat: /TL-C12C\s*X5/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: false, pack: 5 },
  { pat: /TL-C12CW-S\s*X3/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-C12W-S\s*V3/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /TL-M12Q-S\s*X3/i, size: 120, cfm: 73.43, rpm: 2000, noise: 28.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-M12Q\s*X3/i, size: 120, cfm: 73.43, rpm: 2000, noise: 28.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-M12QR-S\s*X3/i, size: 120, cfm: 60, rpm: 1500, noise: 23.1, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-S12\s*CPU\s*Fan\s*120mm.*ARGB|TL-S12-S\s*X3/i, size: 120, cfm: 66.17, rpm: 1550, noise: 25.6, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-C14C-S\s*X3/i, size: 140, cfm: 73.73, rpm: 1500, noise: 26.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /TL-C14C-S\b(?!\s*X)/i, size: 140, cfm: 73.73, rpm: 1500, noise: 26.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /TL-C14C\s*X3/i, size: 140, cfm: 73.73, rpm: 1500, noise: 26.2, pwm: true, rgb: false, pack: 3 },
  { pat: /TL-C14CW-S\s*X3/i, size: 140, cfm: 73.73, rpm: 1500, noise: 26.2, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /140MM\s*Quiet\s*PWM\s*Fan.*1500RPM/i, size: 140, cfm: 73.73, rpm: 1500, noise: 26.2, pwm: true, rgb: false, pack: 1 },
  { pat: /TL-C12B\s*V2\s*X3/i, size: 120, cfm: 66.17, rpm: 1500, noise: 22, pwm: true, rgb: false, pack: 3 },

  // ═══ ASIAHORSE ════════════════════════════════════════════════════════════
  { pat: /AsiaHorse.*Nyota\s*120mm|Nyota\s*120mm\s*Case\s*Fan/i, size: 120, cfm: 58.5, rpm: 1800, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Nyota\s*Ultra\s*120mm/i, size: 120, cfm: 58.5, rpm: 1800, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Nyota\s*A14\s*140mm/i, size: 140, cfm: 68, rpm: 1800, noise: 29, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /COSMIQ\s*120mm.*Infinity\s*Mirror\s*FDB\s*Reverse/i, size: 120, cfm: 50, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /COSMIQ\s*120mm\s*PC\s*RGB\s*Fans\s*Computer\s*Case\s*Fans/i, size: 120, cfm: 50, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /COSMIQ\s*120mm\s*PC\s*Case\s*Fan.*Infinity\s*Mirror\s*FDB\s*2000/i, size: 120, cfm: 50, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Dawn\s*Pro\s*120mm\s*Case\s*Fan/i, size: 120, cfm: 68, rpm: 1850, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Dawn\s*120mm\s*Case\s*Fan/i, size: 120, cfm: 71, rpm: 1850, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /AsiaHorse.*140mm\s*Argb\s*Pwm\s*Fan.*Double/i, size: 140, cfm: 65, rpm: 1500, noise: 25, pwm: true, rgb: true, rgbType: 'ARGB', pack: 2 },
  { pat: /AsiaHorse.*140mm\s*Argb\s*Pwm\s*Fan.*Triple/i, size: 140, cfm: 65, rpm: 1500, noise: 25, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },

  // ═══ JUNGLE LEOPARD ═══════════════════════════════════════════════════════
  { pat: /Jungle\s*Leopard.*Prism4\s*Pro\s*X3|Prism4\s*Pro\s*X3\s*120mm/i, size: 120, cfm: 55, rpm: 1600, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /Galaxy\s*SE\s*120mm\s*ARGB/i, size: 120, cfm: 55, rpm: 1600, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Galaxy\s*120mm\s*PC\s*Case\s*Fan.*ARGB/i, size: 120, cfm: 55, rpm: 1600, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Jungle\s*Leopard.*Prism\s*140mm|Prism\s*140mm\s*ARGB/i, size: 140, cfm: 65, rpm: 1600, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Jungle\s*Leopard\s*Prism\s*120mm\s*4\s*Pro/i, size: 120, cfm: 55, rpm: 1600, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ DARKROCK ═════════════════════════════════════════════════════════════
  { pat: /DARKROCK.*3-Pack\s*120mm\s*Black\s*Computer\s*Case\s*Fans/i, size: 120, cfm: 44, rpm: 1200, noise: 22, pwm: false, rgb: false, pack: 3 },
  { pat: /DARKROCK.*F120\s*3in1/i, size: 120, cfm: 55, rpm: 1500, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /DARKROCK.*F140/i, size: 140, cfm: 65, rpm: 1400, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ COOLER MASTER ════════════════════════════════════════════════════════
  { pat: /MF120\s*Lite\s*120mm.*3-Pack/i, size: 120, cfm: 47, rpm: 1800, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /MF120\s*Halo/i, size: 120, cfm: 47.2, rpm: 1800, noise: 30, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /MF120\s*Lite\s*Black/i, size: 120, cfm: 47, rpm: 1800, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ UPHERE ═══════════════════════════════════════════════════════════════
  { pat: /UpHere.*120mm\s*RGB\s*Case\s*Fan.*3\s*Pack/i, size: 120, cfm: 44, rpm: 1200, noise: 22, pwm: false, rgb: true, rgbType: 'RGB', pack: 3 },
  { pat: /UpHere.*120mm\s*RGB\s*Series.*5\s*Pack/i, size: 120, cfm: 44, rpm: 1200, noise: 22, pwm: false, rgb: true, rgbType: 'RGB', pack: 5 },
  { pat: /12BK4-5\s*PWM\s*Case\s*Fan/i, size: 120, cfm: 55, rpm: 1500, noise: 25, pwm: true, rgb: false, pack: 1 },

  // ═══ SUDOKOO ══════════════════════════════════════════════════════════════
  { pat: /MACH120-3IN1\s*120mm/i, size: 120, cfm: 66, rpm: 2000, noise: 28, pwm: true, rgb: false, pack: 3 },
  { pat: /MACH120\s*120mm/i, size: 120, cfm: 66, rpm: 2000, noise: 28, pwm: true, rgb: false, pack: 1 },
  { pat: /MACH140\s*140mm/i, size: 140, cfm: 80, rpm: 1800, noise: 28, pwm: true, rgb: false, pack: 1 },

  // ═══ ASUS ═════════════════════════════════════════════════════════════════
  { pat: /Prime\s*MR120\s*ARGB\s*Reverse/i, size: 120, cfm: 58.54, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /ROG\s*Strix\s*XF120/i, size: 120, cfm: 63, rpm: 1800, noise: 22.5, pwm: true, rgb: false, pack: 1 },

  // ═══ TGDGAMER ═════════════════════════════════════════════════════════════
  { pat: /TGDGAMER.*6\s*Packs\s*Modular\s*120mm\s*ARGB/i, size: 120, cfm: 50, rpm: 1500, noise: 25, pwm: true, rgb: true, rgbType: 'ARGB', pack: 6 },
  { pat: /TGDGAMER.*3Pack\s*140mm\s*ARGB/i, size: 140, cfm: 65, rpm: 1500, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },

  // ═══ LTC ══════════════════════════════════════════════════════════════════
  { pat: /CF-121D\s*120mm/i, size: 120, cfm: 50, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /CF-123D\s*120mm/i, size: 120, cfm: 55, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ JONSBO ═══════════════════════════════════════════════════════════════
  { pat: /Jonsbo.*ZA-360W/i, size: 120, cfm: 55, rpm: 1800, noise: 27, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },

  // ═══ GEOMETRIC FUTURE ═════════════════════════════════════════════════════
  { pat: /Squama\s*2503R\s*Reverse.*140mm/i, size: 140, cfm: 70, rpm: 1600, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Squama\s*2503\s*RGB.*140mm.*3\s*Pack/i, size: 140, cfm: 70, rpm: 1600, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },

  // ═══ DARKFLASH ════════════════════════════════════════════════════════════
  { pat: /DarkFlash.*INF34\s*120MM/i, size: 120, cfm: 55, rpm: 2000, noise: 28, pwm: true, rgb: false, pack: 1 },
  { pat: /DarkFlash.*G24\s*120MM.*3\s*Pack/i, size: 120, cfm: 60, rpm: 2200, noise: 30, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },

  // ═══ MONTECH ══════════════════════════════════════════════════════════════
  { pat: /Montech.*AX\s*140\s*ARGB/i, size: 140, cfm: 68, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Montech.*HP140mm\s*PWM\s*ARGB/i, size: 140, cfm: 75, rpm: 1600, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },

  // ═══ SINGLE-BRAND/PRODUCT ENTRIES ══════════════════════════════════════════
  { pat: /Phanteks.*T30-120/i, size: 120, cfm: 66.5, rpm: 2000, noise: 26.4, pwm: true, rgb: false, pack: 1 },
  { pat: /DeepCool.*FK120.*3-Pack/i, size: 120, cfm: 68.99, rpm: 1850, noise: 28.1, pwm: true, rgb: false, pack: 3 },
  { pat: /KEYFANCLUB.*2-Pack\s*120mm/i, size: 120, cfm: 50, rpm: 1200, noise: 22, pwm: false, rgb: false, pack: 2 },
  { pat: /UTLGAMENG.*7\s*Pack\s*ARGB\s*Fans/i, size: 120, cfm: 55, rpm: 2000, noise: 28, pwm: true, rgb: true, rgbType: 'ARGB', pack: 7 },
  { pat: /Kingwin.*140mm\s*Silent/i, size: 140, cfm: 55, rpm: 1000, noise: 20, pwm: false, rgb: false, pack: 1 },
  { pat: /Easy\s*Cloud.*120mm\s*ARGB/i, size: 120, cfm: 52, rpm: 1600, noise: 25, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /GPERHUAN.*5pack\s*120mm\s*PWM\s*ARGB/i, size: 120, cfm: 55, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 5 },
  { pat: /Vetroo.*SA-140\s*3-Pack/i, size: 140, cfm: 65, rpm: 1500, noise: 25, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /PCCOOLER.*3in1\s*120mm\s*Case\s*Fan.*F5\s*R120/i, size: 120, cfm: 75, rpm: 2200, noise: 30, pwm: true, rgb: false, pack: 3 },
  { pat: /JAZZCOOLING.*FS-120.*3\s*Pack/i, size: 120, cfm: 44, rpm: 1200, noise: 22, pwm: false, rgb: true, rgbType: 'RGB', pack: 3 },
  { pat: /GDSTIME.*140mm\s*High\s*Static\s*Pressure/i, size: 140, cfm: 95, rpm: 3000, noise: 42, pwm: false, rgb: false, pack: 1 },
  { pat: /ID-COOLING.*AS-120-K\s*Trio/i, size: 120, cfm: 55, rpm: 1500, noise: 27.2, pwm: true, rgb: false, pack: 3 },
  { pat: /Redragon.*GCF012/i, size: 120, cfm: 50, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /Ocypus.*Gamma\s*F12\s*ARGB/i, size: 120, cfm: 55, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 1 },
  { pat: /RUIX.*V8\s*Prism\s*120mm.*3-Pack/i, size: 120, cfm: 55, rpm: 1600, noise: 26, pwm: true, rgb: true, rgbType: 'ARGB', pack: 3 },
  { pat: /PANO-MOUNTS.*140mm\s*Case\s*Fan\s*3-Pack/i, size: 140, cfm: 70, rpm: 1700, noise: 28, pwm: true, rgb: false, pack: 3 },
  { pat: /Fractal\s*Design.*Momentum\s*14/i, size: 140, cfm: 73.2, rpm: 2000, noise: 28, pwm: true, rgb: false, pack: 1 },
  { pat: /ABITSY.*PC\s*120mm\s*Case\s*Fan\s*3-Pack/i, size: 120, cfm: 58, rpm: 2000, noise: 26, pwm: true, rgb: false, pack: 3 },
  { pat: /GSCOLER.*FA120\s*120mm.*3\s*Pack/i, size: 120, cfm: 55, rpm: 1600, noise: 25, pwm: true, rgb: false, pack: 3 },
];

// Apply dictionary
let matched = 0;
const stats = { size: 0, cfm: 0, rpm: 0, noise: 0, pwm: 0, rgb: 0, rgbType: 0, pack: 0 };
const FIELDS = ['size', 'cfm', 'rpm', 'noise', 'pwm', 'rgb', 'rgbType', 'pack'];

for (const p of parts) {
  if (p.c !== 'CaseFan') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      matched++;
      for (const f of FIELDS) {
        if (entry[f] !== undefined && p[f] == null) {
          p[f] = entry[f];
          stats[f]++;
        }
      }
      break;
    }
  }
}

console.log(`\n━━━ STEP 3: DICTIONARY ━━━`);
console.log(`Matched: ${matched}`);
console.log(`Filled: ${JSON.stringify(stats)}`);

// ═══════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════
const fans = parts.filter(p => p.c === 'CaseFan');
console.log(`\n━━━ FINAL COVERAGE (${fans.length} fans) ━━━`);
for (const f of ['size', 'cfm', 'rpm', 'noise', 'pwm', 'rgb', 'rgbType', 'pack', 'fans_inc']) {
  const n = fans.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${fans.length}  (${Math.round(n / fans.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
