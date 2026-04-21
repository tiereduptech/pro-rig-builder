#!/usr/bin/env node
/**
 * backfill-gpu-specs.js — fill in tdp, length, and bench for GPU products
 * by matching their names to a dictionary of known GPU models.
 *
 * Approach:
 *   - Match product name against a dictionary of GPU model patterns
 *   - Fill in reference spec values (TDP, length, bench)
 *   - bench is normalized 0-100 where RTX 5090 = 100 (roughly 3DMark Time Spy scaled)
 *   - length is a "typical AIB card length" since reference cards vary
 *
 * Sources: NVIDIA/AMD spec sheets, TechPowerUp database, 3DMark charts.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// GPU database — keyed by regex pattern that matches model in product name.
// order matters: more specific patterns first.
const GPU_DB = [
  // ─── RTX 50 Series (Blackwell, 2025) ───
  { pat: /RTX\s*5090/i,          tdp: 575, len: 330, bench: 100 },
  { pat: /RTX\s*5080/i,          tdp: 360, len: 310, bench: 78 },
  { pat: /RTX\s*5070\s*Ti/i,     tdp: 300, len: 305, bench: 68 },
  { pat: /RTX\s*5070/i,          tdp: 250, len: 290, bench: 55 },
  { pat: /RTX\s*5060\s*Ti/i,     tdp: 180, len: 260, bench: 45 },
  { pat: /RTX\s*5060/i,          tdp: 150, len: 250, bench: 38 },
  { pat: /RTX\s*5050/i,          tdp: 130, len: 240, bench: 30 },

  // ─── RTX 40 Series (Ada Lovelace, 2022-24) ───
  { pat: /RTX\s*4090/i,          tdp: 450, len: 336, bench: 85 },
  { pat: /RTX\s*4080\s*SUPER/i,  tdp: 320, len: 310, bench: 73 },
  { pat: /RTX\s*4080/i,          tdp: 320, len: 310, bench: 70 },
  { pat: /RTX\s*4070\s*Ti\s*SUPER/i, tdp: 285, len: 305, bench: 62 },
  { pat: /RTX\s*4070\s*Ti/i,     tdp: 285, len: 305, bench: 58 },
  { pat: /RTX\s*4070\s*SUPER/i,  tdp: 220, len: 290, bench: 53 },
  { pat: /RTX\s*4070/i,          tdp: 200, len: 285, bench: 48 },
  { pat: /RTX\s*4060\s*Ti/i,     tdp: 160, len: 245, bench: 36 },
  { pat: /RTX\s*4060/i,          tdp: 115, len: 245, bench: 30 },

  // ─── RTX 30 Series (Ampere, 2020-22) ───
  { pat: /RTX\s*3090\s*Ti/i,     tdp: 450, len: 336, bench: 67 },
  { pat: /RTX\s*3090/i,          tdp: 350, len: 313, bench: 60 },
  { pat: /RTX\s*3080\s*Ti/i,     tdp: 350, len: 313, bench: 58 },
  { pat: /RTX\s*3080/i,          tdp: 320, len: 285, bench: 54 },
  { pat: /RTX\s*3070\s*Ti/i,     tdp: 290, len: 285, bench: 44 },
  { pat: /RTX\s*3070/i,          tdp: 220, len: 285, bench: 40 },
  { pat: /RTX\s*3060\s*Ti/i,     tdp: 200, len: 240, bench: 34 },
  { pat: /RTX\s*3060/i,          tdp: 170, len: 235, bench: 28 },
  { pat: /RTX\s*3050/i,          tdp: 130, len: 225, bench: 22 },

  // ─── GTX 16 Series ───
  { pat: /GTX\s*1660\s*SUPER/i,  tdp: 125, len: 225, bench: 18 },
  { pat: /GTX\s*1660/i,          tdp: 120, len: 225, bench: 16 },
  { pat: /GTX\s*1650/i,          tdp:  75, len: 175, bench: 12 },

  // ─── Radeon RX 9000 Series (RDNA 4, 2025) ───
  { pat: /RX\s*9070\s*XT/i,      tdp: 304, len: 290, bench: 62 },
  { pat: /RX\s*9070/i,           tdp: 220, len: 285, bench: 52 },
  { pat: /RX\s*9060\s*XT/i,      tdp: 180, len: 260, bench: 40 },
  { pat: /RX\s*9060/i,           tdp: 150, len: 255, bench: 34 },

  // ─── Radeon RX 7000 Series (RDNA 3) ───
  { pat: /RX\s*7900\s*XTX/i,     tdp: 355, len: 287, bench: 65 },
  { pat: /RX\s*7900\s*XT/i,      tdp: 315, len: 276, bench: 58 },
  { pat: /RX\s*7900\s*GRE/i,     tdp: 260, len: 276, bench: 48 },
  { pat: /RX\s*7800\s*XT/i,      tdp: 263, len: 267, bench: 42 },
  { pat: /RX\s*7700\s*XT/i,      tdp: 245, len: 267, bench: 35 },
  { pat: /RX\s*7600\s*XT/i,      tdp: 190, len: 240, bench: 26 },
  { pat: /RX\s*7600/i,           tdp: 165, len: 240, bench: 24 },

  // ─── Radeon RX 6000 Series (RDNA 2) ───
  { pat: /RX\s*6950\s*XT/i,      tdp: 335, len: 267, bench: 47 },
  { pat: /RX\s*6900\s*XT/i,      tdp: 300, len: 267, bench: 45 },
  { pat: /RX\s*6800\s*XT/i,      tdp: 300, len: 267, bench: 42 },
  { pat: /RX\s*6800/i,           tdp: 250, len: 267, bench: 38 },
  { pat: /RX\s*6750\s*XT/i,      tdp: 250, len: 267, bench: 32 },
  { pat: /RX\s*6700\s*XT/i,      tdp: 230, len: 267, bench: 30 },
  { pat: /RX\s*6650\s*XT/i,      tdp: 180, len: 240, bench: 24 },
  { pat: /RX\s*6600\s*XT/i,      tdp: 160, len: 240, bench: 22 },
  { pat: /RX\s*6600/i,           tdp: 132, len: 235, bench: 20 },
  { pat: /RX\s*6500\s*XT/i,      tdp: 107, len: 200, bench: 14 },
  { pat: /RX\s*5700\s*XT/i,      tdp: 225, len: 267, bench: 24 },
  { pat: /RX\s*5500\s*XT/i,      tdp: 130, len: 210, bench: 14 },

  // ─── Intel Arc ───
  { pat: /Arc\s*B580/i,          tdp: 190, len: 270, bench: 28 },
  { pat: /Arc\s*B570/i,          tdp: 150, len: 270, bench: 22 },
  { pat: /Arc\s*A770/i,          tdp: 225, len: 267, bench: 24 },
  { pat: /Arc\s*A750/i,          tdp: 225, len: 267, bench: 20 },
  { pat: /Arc\s*A580/i,          tdp: 185, len: 267, bench: 16 },
  { pat: /Arc\s*A380/i,          tdp:  75, len: 190, bench:  8 },

  // ─── NVIDIA RTX Ada Generation (Professional) ───
  // Pattern note: "RTX 6000 Ada" must come before "RTX 6000" generic
  { pat: /RTX\s*(?:Pro\s*)?6000\s*(?:Ada|Blackwell)/i, tdp: 300, len: 267, bench: 72 },
  { pat: /RTX\s*(?:Pro\s*)?5000\s*(?:Ada|Blackwell)/i, tdp: 250, len: 267, bench: 60 },
  { pat: /RTX\s*(?:Pro\s*)?4500\s*(?:Ada|Blackwell)/i, tdp: 210, len: 267, bench: 48 },
  { pat: /RTX\s*(?:Pro\s*)?4000\s*(?:Ada|Blackwell)/i, tdp: 130, len: 240, bench: 40 },
  { pat: /RTX\s*(?:Pro\s*)?2000\s*(?:Ada|Blackwell)/i, tdp:  70, len: 170, bench: 22 },
  // Generic fallbacks without Ada/Blackwell — assume Ada (most common workstation line)
  { pat: /RTX\s*6000\b/i,        tdp: 300, len: 267, bench: 72 },
  { pat: /RTX\s*5000\b/i,        tdp: 250, len: 267, bench: 60 },
  { pat: /RTX\s*4500\b/i,        tdp: 210, len: 267, bench: 48 },
  { pat: /RTX\s*4000\b/i,        tdp: 130, len: 240, bench: 40 },
  { pat: /RTX\s*2000\b/i,        tdp:  70, len: 170, bench: 22 },

  // ─── NVIDIA RTX A-series (Ampere workstation) ───
  { pat: /RTX\s*A6000/i,         tdp: 300, len: 267, bench: 55 },
  { pat: /RTX\s*A5500/i,         tdp: 230, len: 267, bench: 50 },
  { pat: /RTX\s*A5000/i,         tdp: 230, len: 267, bench: 44 },
  { pat: /RTX\s*A4500/i,         tdp: 200, len: 267, bench: 38 },
  { pat: /RTX\s*A4000/i,         tdp: 140, len: 240, bench: 32 },
  { pat: /RTX\s*A2000/i,         tdp:  70, len: 170, bench: 18 },
  { pat: /RTX\s*A1000/i,         tdp:  50, len: 170, bench: 12 },
  { pat: /RTX\s*A400/i,          tdp:  50, len: 170, bench:  8 },
  { pat: /NVIDIA\s+A2\b/i,       tdp:  60, len: 170, bench: 10 },

  // ─── AMD Radeon PRO (Workstation) ───
  { pat: /Radeon\s*PRO\s*W7900/i, tdp: 295, len: 280, bench: 58 },
  { pat: /Radeon\s*PRO\s*W7800/i, tdp: 260, len: 267, bench: 46 },
  { pat: /Radeon\s*PRO\s*W7700/i, tdp: 190, len: 267, bench: 36 },
  { pat: /Radeon\s*PRO\s*W7600/i, tdp: 130, len: 240, bench: 26 },
  { pat: /Radeon\s*PRO\s*W7500/i, tdp:  70, len: 170, bench: 18 },
  { pat: /Radeon\s*PRO\s*W6800/i, tdp: 250, len: 267, bench: 36 },
  { pat: /Radeon\s*PRO\s*W6600/i, tdp: 100, len: 240, bench: 22 },
  { pat: /Radeon\s*PRO\s*W5700/i, tdp: 205, len: 240, bench: 20 },
  { pat: /Radeon\s*PRO\s*W5500/i, tdp: 125, len: 240, bench: 14 },
];

function matchGPU(name) {
  // Normalize: strip trademark/registered/copyright symbols and soft hyphens
  // (some manufacturers like GIGABYTE insert invisible U+00AD between words)
  const s = String(name || '')
    .replace(/[™®©\u00AD\u200B\u200C\u200D]/g, '')
    .replace(/\s+/g, ' ');
  for (const entry of GPU_DB) {
    if (entry.pat.test(s)) return entry;
  }
  return null;
}

let tdpAdded = 0;
let lenAdded = 0;
let benchAdded = 0;
let matched = 0;
let unmatched = 0;
const unmatchedSamples = [];

for (const p of parts) {
  if (p.c !== 'GPU') continue;
  const match = matchGPU(p.n);
  if (!match) {
    unmatched++;
    if (unmatchedSamples.length < 10) unmatchedSamples.push(p.n.slice(0, 90));
    continue;
  }
  matched++;
  if (!p.tdp && match.tdp) { p.tdp = match.tdp; tdpAdded++; }
  if (!p.length && match.len) { p.length = match.len; lenAdded++; }
  if (p.bench == null && match.bench != null) { p.bench = match.bench; benchAdded++; }
}

console.log('Matched:', matched, '| Unmatched:', unmatched);
console.log('Added tdp to', tdpAdded, 'products');
console.log('Added length to', lenAdded, 'products');
console.log('Added bench to', benchAdded, 'products');

const g = parts.filter(p => p.c === 'GPU');
console.log('\nCoverage after:');
console.log('  tdp:   ', g.filter(p => p.tdp).length + '/' + g.length);
console.log('  length:', g.filter(p => p.length).length + '/' + g.length);
console.log('  bench: ', g.filter(p => p.bench != null).length + '/' + g.length);

if (unmatchedSamples.length) {
  console.log('\nUnmatched samples:');
  unmatchedSamples.forEach(n => console.log('  ' + n));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
