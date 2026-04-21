#!/usr/bin/env node
/**
 * backfill-aio-fans-rgb.js
 *
 * Fills fans_inc and rgb for the remaining AIOs using:
 *
 * 1. radSize → fans_inc (universal rule: radiator size determines fan count)
 *      120mm rad → 1 fan
 *      140mm rad → 1 fan
 *      240mm rad → 2 fans
 *      280mm rad → 2 fans
 *      360mm rad → 3 fans
 *      420mm rad → 3 fans
 *
 * 2. Name regex → rgb
 *      "ARGB", "RGB", "LCD", "Infinity Mirror" → true
 *      "Silent Wings", "Low-Noise" without RGB mention → false
 *      Default unknown → null (not populated, so filter treats it as missing)
 *
 * 3. Dictionary patterns for brand-specific AIOs that need explicit specs.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── STEP 1: FILL fans_inc FROM radSize ──────────────────────────────────────
const RAD_TO_FANS = {
  120: 1, 140: 1,
  240: 2, 280: 2,
  360: 3, 420: 3,
  480: 4, 560: 4,
};

let fansFromRad = 0;
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  if (p.coolerType !== 'AIO') continue;
  if (p.fans_inc != null) continue;
  if (p.radSize != null && RAD_TO_FANS[p.radSize]) {
    p.fans_inc = RAD_TO_FANS[p.radSize];
    fansFromRad++;
  }
}
console.log(`AIO fans_inc filled from radSize: ${fansFromRad}`);

// ─── STEP 2: INFER rgb FROM PRODUCT NAME ─────────────────────────────────────
let rgbFromName = 0;
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  if (p.coolerType !== 'AIO') continue;
  if (p.rgb != null) continue;
  const name = p.n || '';

  // Strong positive signals (in order — more specific first)
  if (/\b(?:ARGB|A-RGB|RGB\s*Sync|Infinity\s*Mirror|LCD\s*(?:Screen|Display)|IPS\s*LCD|AMOLED|Customizable\s*LCD)\b/i.test(name)) {
    p.rgb = true;
    rgbFromName++;
  }
  else if (/\bRGB\b/i.test(name) && !/non[\s-]?RGB|no\s*RGB/i.test(name)) {
    p.rgb = true;
    rgbFromName++;
  }
  // Explicit no-RGB signals (quiet lines)
  else if (/\b(?:Silent\s*Wings|Low[\s-]*Noise|Silent\s*Loop|Pure\s*Loop|Quiet\s*Edition)\b/i.test(name)
           && !/\b(?:ARGB|RGB|LCD|Infinity\s*Mirror)\b/i.test(name)) {
    p.rgb = false;
    rgbFromName++;
  }
}
console.log(`AIO rgb inferred from name: ${rgbFromName}`);

// ─── STEP 3: BRAND-SPECIFIC PATTERNS FOR LEFTOVERS ──────────────────────────
// Any AIO still missing rgb or fans_inc after the universal rules above
const DB = [
  // EKWB (premium, but D-RGB only on Lux variant)
  { pat: /EK-AIO\s*360\s*D-RGB/i, rgb: true, fans_inc: 3 },
  { pat: /EK-Nucleus\s*AIO\s*CPU\s*Cooler\s*CR360\s*Lux/i, rgb: true, fans_inc: 3 },

  // Corsair Hydro Series H110 — no RGB on the classic ones
  { pat: /Corsair.*Hydro\s*Series\s*H110/i, rgb: false, fans_inc: 2 },

  // Corsair iCUE Link Titan RX (RX = RGB variant per Corsair)
  { pat: /iCUE\s*Link\s*Titan\s*\d+\s*RX\s*LCD/i, rgb: true },
  { pat: /iCUE\s*Link\s*Titan\s*\d+\s*RX\s*RGB/i, rgb: true },
  { pat: /iCUE\s*Link\s*Titan\s*\d+\s*RX/i, rgb: true },

  // Corsair Nautilus RS (non-LCD base = no RGB; LCD = has LCD screen which counts as RGB)
  { pat: /Nautilus\s*\d+\s*RS\s*LCD/i, rgb: true },
  { pat: /Nautilus\s*\d+\s*RS\s*ARGB/i, rgb: true },
  { pat: /Nautilus\s*\d+\s*RS\b(?!\s*(?:LCD|ARGB))/i, rgb: false },

  // be quiet! Silent Loop 3 — explicitly silent, no RGB
  { pat: /Silent\s*Loop\s*3/i, rgb: false },

  // Minorsonic generic "Low-Noise" lines are non-RGB; ARGB variant has it
  { pat: /Minorsonic.*ARGB/i, rgb: true },
  { pat: /Minorsonic.*Low[\s-]*Noise/i, rgb: false },

  // PCCOOLER generic 360mm AIO (basic version is no RGB)
  { pat: /PCCOOLER\s*CPU\s*Cooler,?\s*360mm\s*AIO\s*Liquid\s*Cooling,?\s*High[\s-]*Performance\s*Pump/i, rgb: false, fans_inc: 3 },
];

let dictHits = 0;
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  if (p.coolerType !== 'AIO') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      if (entry.rgb !== undefined && p.rgb == null) { p.rgb = entry.rgb; dictHits++; }
      if (entry.fans_inc !== undefined && p.fans_inc == null) p.fans_inc = entry.fans_inc;
      break;
    }
  }
}
console.log(`Dictionary hits: ${dictHits}`);

// ─── FINAL REPORT ───────────────────────────────────────────────────────────
const coolers = parts.filter(p => p.c === 'CPUCooler');
const aios = coolers.filter(p => p.coolerType === 'AIO');

console.log(`\n━━━ FINAL AIO COVERAGE ━━━`);
console.log(`Total AIOs: ${aios.length}`);
for (const f of ['radSize', 'fans_inc', 'rgb', 'sockets']) {
  const n = aios.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${aios.length}  (${Math.round(n / aios.length * 100)}%)`);
}

const stillMissing = aios.filter(p => p.fans_inc == null || p.rgb == null);
if (stillMissing.length) {
  console.log(`\n━━━ AIOs still missing fans_inc OR rgb (${stillMissing.length}) ━━━`);
  stillMissing.forEach(p => {
    const flags = [];
    if (p.fans_inc == null) flags.push('no fans_inc');
    if (p.rgb == null) flags.push('no rgb');
    if (p.radSize == null) flags.push('no radSize');
    console.log(`  [${p.b}] (${flags.join(',')})  ${p.n.slice(0, 75)}`);
  });
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
