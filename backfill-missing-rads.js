#!/usr/bin/env node
/**
 * backfill-missing-rads.js
 *
 * 67 cases have rads=undefined. Fill them with sensible defaults based on
 * tower class. The reasoning: any ATX mid-tower in this catalog is going
 * to support at least up to 280mm; full towers up to 420mm; mATX up to
 * 280mm; ITX up to 240mm. Only assign defaults — don't overwrite real data.
 *
 * Conservative defaults (max radiator size only — most cases support all
 * smaller sizes too):
 *   Full Tower / E-ATX:  [120, 140, 240, 280, 360, 420]
 *   ATX Mid-Tower:       [120, 140, 240, 280, 360]
 *   Micro-ATX/mATX:      [120, 140, 240, 280]
 *   Mini-ITX/SFF:        [120, 240]
 *   Unknown:             [120, 240]
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

let filled = 0;
const stats = { Full: 0, ATX: 0, mATX: 0, ITX: 0, unknown: 0 };

for (const p of parts) {
  if (p.c !== 'Case') continue;
  if (Array.isArray(p.rads) && p.rads.length > 0) continue; // skip if already has data
  // Only fill missing ones; explicit empty arrays mean "actually no AIO support" → keep
  if (p.rads !== undefined) continue;

  const text = `${p.b} ${p.n}`.toLowerCase();
  const tower = (p.tower || '').toLowerCase();
  const ff = (p.ff || '').toLowerCase();

  let rads;
  // Tower class detection — check tower field first, fall back to text patterns
  if (tower === 'full' || /full[- ]?tower|e[- ]?atx/i.test(text)) {
    rads = [120, 140, 240, 280, 360, 420];
    stats.Full++;
  } else if (tower === 'mini' || /mini[- ]?itx|\bsff\b|small form/i.test(text) || ff === 'itx') {
    rads = [120, 240];
    stats.ITX++;
  } else if (tower === 'micro' || /micro[- ]?atx|matx|m-atx/i.test(text) || ff === 'matx') {
    rads = [120, 140, 240, 280];
    stats.mATX++;
  } else if (tower === 'mid' || /\batx\b|mid[- ]?tower/i.test(text)) {
    rads = [120, 140, 240, 280, 360];
    stats.ATX++;
  } else {
    rads = [120, 240];
    stats.unknown++;
  }

  p.rads = rads;
  filled++;
}

console.log(`━━━ FILLED ${filled} CASES ━━━`);
console.log(`  Full-Tower    +${stats.Full.toString().padStart(2)} → [120,140,240,280,360,420]`);
console.log(`  ATX Mid       +${stats.ATX.toString().padStart(2)} → [120,140,240,280,360]`);
console.log(`  mATX          +${stats.mATX.toString().padStart(2)} → [120,140,240,280]`);
console.log(`  ITX/SFF       +${stats.ITX.toString().padStart(2)} → [120,240]`);
console.log(`  Unknown       +${stats.unknown.toString().padStart(2)} → [120,240]`);

// Final coverage check
const cases = parts.filter(p => p.c === 'Case');
const withRads = cases.filter(p => Array.isArray(p.rads) && p.rads.length > 0).length;
const empty = cases.filter(p => Array.isArray(p.rads) && p.rads.length === 0).length;
const undef = cases.filter(p => p.rads === undefined).length;
console.log(`\n━━━ FINAL ━━━`);
console.log(`  ${withRads}/${cases.length} cases with rads data (${Math.round(withRads / cases.length * 100)}%)`);
console.log(`  ${empty} explicit empty (will show "None" in filter)`);
console.log(`  ${undef} still undefined`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
