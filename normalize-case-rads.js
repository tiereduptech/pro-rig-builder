#!/usr/bin/env node
/**
 * normalize-case-rads.js
 *
 * Two fixes:
 *
 *   1. DATA: Normalize Case.rads from mixed shapes to array of integers:
 *      - "120mm,140mm,240mm,280mm,360mm" → [120,140,240,280,360]
 *      - [120,140,240,280,360] stays as is
 *      - "" / [] stay as []
 *
 *   2. APP.JSX: Change the AIO/Radiator Support filter from plain check to
 *      use an `extract` function that returns "Up to Xmm" based on max(rads).
 *      This collapses all the duplicate "Up to 360mm" entries into one.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: NORMALIZE rads
// ═══════════════════════════════════════════════════════════════════════════
let fixed = 0;
for (const p of parts) {
  if (p.c !== 'Case') continue;
  if (p.rads == null) continue;

  // If string, parse
  if (typeof p.rads === 'string') {
    const nums = p.rads.split(',')
      .map(s => {
        const m = s.trim().match(/^(\d+)\s*mm$/i) || s.trim().match(/^(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(n => n != null)
      .sort((a, b) => a - b);
    // Dedupe
    const unique = [...new Set(nums)];
    p.rads = unique;
    fixed++;
  }
  // If array, make sure all entries are integers (no strings) and sorted unique
  else if (Array.isArray(p.rads)) {
    const nums = p.rads.map(v => {
      if (typeof v === 'number') return v;
      const m = String(v).match(/^(\d+)\s*mm$/i) || String(v).match(/^(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    }).filter(n => n != null);
    const unique = [...new Set(nums)].sort((a, b) => a - b);
    if (JSON.stringify(unique) !== JSON.stringify(p.rads)) {
      p.rads = unique;
      fixed++;
    }
  }
}
console.log(`━━━ STEP 1: NORMALIZED ${fixed} rads FIELDS ━━━`);

// Verify shapes now
const shapes = {};
for (const p of parts) {
  if (p.c !== 'Case' || !p.rads) continue;
  const key = JSON.stringify(p.rads);
  shapes[key] = (shapes[key] || 0) + 1;
}
console.log(`\nDistinct shapes after normalization: ${Object.keys(shapes).length}`);
Object.entries(shapes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
  console.log(`  ${String(v).padStart(3)} → ${k}`));

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: PATCH App.jsx FILTER TO USE "Up to Xmm" DISPLAY
// ═══════════════════════════════════════════════════════════════════════════
const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

const oldFilter = 'rads:{label:"AIO/Radiator Support",type:"check"}';
const newFilter = 'rads:{label:"AIO/Radiator Support",type:"check",extract:p=>{const arr=Array.isArray(p.rads)?p.rads:[];if(!arr.length)return"None";const max=Math.max(...arr);return"Up to "+max+"mm"}}';

if (app.includes(oldFilter)) {
  app = app.replace(oldFilter, newFilter);
  writeFileSync(appPath, app);
  console.log('\n━━━ STEP 2: PATCHED App.jsx ━━━');
  console.log('✓ rads filter now shows "Up to Xmm" based on max(rads)');
} else if (app.includes(newFilter)) {
  console.log('\n━━━ STEP 2: App.jsx ALREADY PATCHED ━━━');
} else {
  console.warn('\n⚠️ Could not find old filter string — App.jsx not patched');
}
