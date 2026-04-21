#!/usr/bin/env node
/**
 * backfill-ram-specs.js
 *
 * Closes RAM spec gaps by regex-extracting from product names:
 *   - speed: the 5 missing kits
 *   - voltage: 27% → 100% (derive from speed: DDR4 1.2V, DDR5 1.1V/1.35V, etc)
 *   - rgb: 27% → 100% (detect RGB/Infinity/LED/XPG Lancer tokens)
 *   - memType: 86% → 100%
 *   - cl: 94% → 100%
 *   - sticks: 85% → 100%
 *
 * Also: delete 1 non-product: "Vengeance RGB DDR5 Light Enhancement Kit
 * (No Physical Memory)" — that's a light strip, not RAM.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: REMOVE NON-PRODUCT
// ═══════════════════════════════════════════════════════════════════════════
const before = parts.length;
parts = parts.filter(p => !(p.c === 'RAM' && /Light\s*Enhancement|No\s*Physical\s*Memory/i.test(p.n)));
console.log(`━━━ STEP 1: REMOVED ${before - parts.length} NON-PRODUCT ━━━`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: INFER SPECS FROM NAMES
// ═══════════════════════════════════════════════════════════════════════════
function inferRam(p) {
  const text = `${p.b} ${p.n}`;
  const out = {};

  // speed — e.g. "5600 MHz", "6400MT/s", "DDR5-6000", "PC4-19200"
  if (p.speed == null) {
    // Direct speed in MHz or MT/s
    const m = text.match(/\b(\d{4,5})\s*(?:MHz|MT\/s)\b/i);
    if (m) out.speed = parseInt(m[1], 10);
    // Form "DDR5-6000", "DDR4-3600"
    else {
      const m2 = text.match(/DDR[45]-(\d{4,5})/);
      if (m2) out.speed = parseInt(m2[1], 10);
    }
    // PC speed conversion: PC4-19200 = DDR4-2400, PC4-25600 = DDR4-3200
    if (!out.speed) {
      const pc = text.match(/PC[45]-(\d{4,5})/i);
      if (pc) {
        const pcSpeed = parseInt(pc[1], 10);
        // PC rating = 8 × MHz rating (e.g. PC4-19200 = 2400MHz × 8)
        out.speed = Math.round(pcSpeed / 8);
      }
    }
  }

  // memType — DDR3/DDR4/DDR5
  if (p.memType == null) {
    if (/\bDDR5\b/i.test(text)) out.memType = 'DDR5';
    else if (/\bDDR4\b/i.test(text)) out.memType = 'DDR4';
    else if (/\bDDR3\b/i.test(text)) out.memType = 'DDR3';
    else if (/\bLPDDR5\b/i.test(text)) out.memType = 'LPDDR5';
    // Infer from speed
    else if ((out.speed || p.speed) >= 4800) out.memType = 'DDR5';
    else if ((out.speed || p.speed) >= 1600) out.memType = 'DDR4';
  }

  // cl — CAS latency, e.g. "CL36", "CL30-38-38-96"
  if (p.cl == null) {
    const m = text.match(/\bCL(\d{1,2})(?:[\s-]|$)/i) || text.match(/\b(\d{2})-\d{2}-\d{2}-\d{2,3}\b/);
    if (m) out.cl = parseInt(m[1], 10);
  }

  // sticks — e.g. "2x16GB", "(2 x 16GB)", "Kit of 2"
  if (p.sticks == null) {
    const m = text.match(/\b(\d)\s*x\s*\d+\s*GB\b/i)
          || text.match(/\((\d)\s*x\s*\d+\s*GB\)/i)
          || text.match(/Kit\s*of\s*(\d)/i);
    if (m) out.sticks = parseInt(m[1], 10);
  }

  // voltage — rare in names, derive from memType + speed
  if (p.voltage == null) {
    const m = text.match(/\b(\d\.\d{1,2})\s*V\b/);
    if (m) {
      out.voltage = parseFloat(m[1]);
    } else {
      const mt = out.memType || p.memType;
      const sp = out.speed || p.speed;
      // DDR5 default 1.1V (JEDEC) or 1.35V+ (XMP/EXPO)
      if (mt === 'DDR5') {
        if (sp && sp >= 6400) out.voltage = 1.4;
        else if (sp && sp >= 5600) out.voltage = 1.35;
        else out.voltage = 1.1;
      }
      // DDR4 default 1.2V JEDEC, 1.35V XMP
      else if (mt === 'DDR4') {
        if (sp && sp >= 3600) out.voltage = 1.35;
        else if (sp && sp >= 3200) out.voltage = 1.35;
        else out.voltage = 1.2;
      }
      // DDR3 default 1.5V
      else if (mt === 'DDR3') out.voltage = 1.5;
    }
  }

  // rgb — detect lighting tokens
  if (p.rgb == null) {
    out.rgb = /\b(?:RGB|ARGB|Lancer\s*Blade|Lancer\s*Shadow|Infinity\s*Mirror|Infinity\s*Shine|Neo\s*RGB|Trident\s*Z5\s*RGB|Trident\s*Z5\s*Neo\s*RGB|Trident\s*Z\s*RGB|Dominator|Fury\s*Beast\s*RGB|Fury\s*Renegade\s*RGB|Vengeance\s*RGB|Ripjaws\s*Neo\s*RGB|Flare\s*X5\s*RGB|XPG\s*Lancer\s*RGB|XPG\s*Spectrix|TeamGroup\s*T-Force\s*Delta|Delta\s*RGB|Xtreem\s*ARGB|LED\b)\b/i.test(text);
  }

  // formFactor — UDIMM (desktop) vs SODIMM (laptop)
  if (p.formFactor == null) {
    if (/\bSO-?DIMM\b|\bLaptop\b|\bNotebook\b|\b260-?Pin\b/i.test(text)) out.formFactor = 'SODIMM';
    else if (/\bUDIMM\b|\bDIMM\b|\bDesktop\b|\b288-?Pin\b|\b240-?Pin\b/i.test(text)) out.formFactor = 'UDIMM';
    else out.formFactor = 'UDIMM'; // desktop is the overwhelming default in our catalog
  }

  return out;
}

// Apply
const stats = {};
for (const p of parts) {
  if (p.c !== 'RAM') continue;
  const filled = inferRam(p);
  for (const [k, v] of Object.entries(filled)) {
    if (v !== null && v !== undefined && p[k] == null) {
      p[k] = v;
      stats[k] = (stats[k] || 0) + 1;
    }
  }
}

console.log(`\n━━━ STEP 2: BACKFILL ━━━`);
for (const [k, v] of Object.entries(stats)) {
  console.log(`  ${k.padEnd(14)} +${v}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: RECOMPUTE VALUE SCORES FOR RAM
// ═══════════════════════════════════════════════════════════════════════════
// RAM value = (cap_gb × speed) / price, normalized 0-100 across RAM category
const ram = parts.filter(p => p.c === 'RAM');
function capGb(cap) {
  if (cap == null) return 0;
  const s = String(cap);
  // "2x16GB" → 32, "32GB" → 32
  const m = s.match(/(\d+)\s*x\s*(\d+)\s*GB/i);
  if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
  const m2 = s.match(/(\d+)\s*GB/i);
  if (m2) return parseInt(m2[1], 10);
  return 0;
}

const rawValues = ram.map(p => {
  const gb = capGb(p.cap);
  const sp = p.speed;
  const pr = p.pr;
  if (!gb || !sp || !pr) return null;
  return (gb * sp) / pr;
}).filter(v => v != null);

if (rawValues.length) {
  const sorted = [...rawValues].sort((a, b) => a - b);
  const p05 = sorted[Math.floor(sorted.length * 0.05)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const range = p95 - p05;

  let filled = 0;
  for (const p of ram) {
    const gb = capGb(p.cap);
    const sp = p.speed;
    const pr = p.pr;
    if (!gb || !sp || !pr) continue;
    const raw = (gb * sp) / pr;
    const clamped = Math.max(p05, Math.min(p95, raw));
    p.value = Math.round(((clamped - p05) / range) * 100);
    filled++;
  }
  console.log(`\n━━━ STEP 3: VALUE SCORES ━━━`);
  console.log(`  Filled ${filled}/${ram.length} RAM value scores`);
  console.log(`  Range: ${p05.toFixed(2)} to ${p95.toFixed(2)} (GB·MHz/$)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ FINAL RAM COVERAGE (${ram.length} kits) ━━━`);
for (const f of ['cap', 'speed', 'memType', 'formFactor', 'cl', 'sticks', 'voltage', 'rgb', 'value']) {
  const n = ram.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${ram.length}  (${Math.round(n / ram.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4: ADD formFactor FILTER TO RAM IN App.jsx
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

// Find the RAM CAT entry and inject formFactor filter into its filters block
// Pattern: RAM:{...,filters:{...memType:{...}...}...}
if (!app.includes('formFactor:{label:"Form Factor"') || !/RAM\s*:\s*\{[^}]*formFactor/.test(app)) {
  // Try to inject into RAM's filters block — find memType filter and add formFactor after it
  const ramMemTypeRe = /(RAM\s*:\s*\{[^}]*filters\s*:\s*\{[^}]*memType\s*:\s*\{[^}]*\}\s*,?\s*)/;
  if (ramMemTypeRe.test(app)) {
    app = app.replace(ramMemTypeRe, '$1formFactor:{label:"Form Factor",type:"check"},');
    writeFileSync(appPath, app);
    console.log('Added formFactor filter to RAM in App.jsx');
  } else {
    console.warn('Could not find RAM memType filter injection point; skipping App.jsx edit');
  }
} else {
  console.log('RAM formFactor filter already registered');
}
