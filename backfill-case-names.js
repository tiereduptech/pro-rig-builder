#!/usr/bin/env node
/**
 * backfill-case-names.js — extract maxGPU, fans_inc, and radiator support from case
 * product name strings via regex. Won't get everything, but fills some gaps.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function extractMaxGPU(name) {
  const s = String(name || '');
  // "365mm GPU Max", "330mm GPU Clearance", "GPU Length 365mm", "up to 400mm GPU"
  let m = s.match(/(\d{3})\s*mm\s*(?:horizontal\s*)?GPU/i);
  if (m) return parseInt(m[1]);
  m = s.match(/GPU\s*(?:Length|Clearance|Support|Max)\s*(?:up to\s*)?(\d{3})\s*mm/i);
  if (m) return parseInt(m[1]);
  m = s.match(/up to\s*(\d{3})\s*mm\s*GPU/i);
  if (m) return parseInt(m[1]);
  return null;
}

function extractFansInc(name) {
  const s = String(name || '');
  // Common patterns:
  //   "Pre-installed 6 ARGB Fans"
  //   "3 x 120mm Fans Pre-Installed"
  //   "Includes 3 RGB Fans"
  //   "4 PWM Fans Included"
  //   "6 Fans - 3X 140mm & 3X 120mm"
  let m = s.match(/(?:Pre[-\s]?installs?(?:ed)?|Includes?|Install|Included)\s*(?:with\s*)?(\d{1,2})\s*(?:x\s*\d+mm\s*)?(?:ARGB\s*|RGB\s*|PWM\s*|Black\s*|White\s*)*fans?/i);
  if (m) return parseInt(m[1]);
  m = s.match(/(\d{1,2})\s*x?\s*\d+mm\s*(?:ARGB\s*|RGB\s*|PWM\s*)*fans?\s*(?:Pre[-\s]?install|Included)/i);
  if (m) return parseInt(m[1]);
  m = s.match(/\b(\d{1,2})\s*(?:ARGB\s*|RGB\s*|PWM\s*|aRGB\s*)+fans?\s*(?:included|pre[-\s]?install)/i);
  if (m) return parseInt(m[1]);
  return null;
}

function extractRads(name) {
  const s = String(name || '');
  // "360mm Radiator Support", "Up to 360mm rad", "280mm radiator compatible"
  const rads = [];
  const patterns = [
    /(360|280|240|120)\s*mm\s*(?:AIO|Radiator|rad)/gi,
    /(?:Up to\s*)?(360|280|240|120)\s*mm\s*(?:radiator|rad)\s*support/gi,
  ];
  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(s)) !== null) {
      rads.push(m[1] + 'mm');
    }
  }
  if (rads.length === 0) return null;
  return [...new Set(rads)].join(',');
}

let gpu = 0, fans = 0, rads = 0;
for (const p of parts) {
  if (p.c !== 'Case') continue;
  if (!p.maxGPU) {
    const v = extractMaxGPU(p.n);
    if (v && v >= 200 && v <= 500) { p.maxGPU = v; gpu++; }
  }
  if (p.fans_inc == null) {
    const v = extractFansInc(p.n);
    if (v != null && v >= 0 && v <= 12) { p.fans_inc = v; fans++; }
  }
  if (!p.rads) {
    const v = extractRads(p.n);
    if (v) { p.rads = v; rads++; }
  }
}

console.log('Extracted from names:');
console.log('  maxGPU:  ', gpu);
console.log('  fans_inc:', fans);
console.log('  rads:    ', rads);

const cases = parts.filter(p => p.c === 'Case');
console.log('\nCoverage after:');
console.log('  maxGPU:  ', cases.filter(p => p.maxGPU).length + '/' + cases.length);
console.log('  fans_inc:', cases.filter(p => p.fans_inc != null).length + '/' + cases.length);
console.log('  rads:    ', cases.filter(p => p.rads).length + '/' + cases.length);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
