// extractSpecs(RAM) — must read specs from BOTH title dialects:
//   Amazon (curated, adjacent):  "Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz CL30"
//   Newegg (raw feed, scattered): "Kingston FURY Beast 64GB (2 x 32GB) ... DDR5 5200 (PC5 41600)"
//
// The Newegg fix must not regress Amazon extraction. Every case below is a real
// title (Amazon from the live catalog, Newegg from the 2026-07-23 discovery
// dry-run's spec-bar rejects/survivors), with hand-verified expected specs.
//
//   node --test test/catalog-classify.ram-specs.test.js

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractSpecs, ramAttributes } = require('../catalog-classify.cjs');

// Each row: [title, expected-subset]. We assert every named field equals; fields
// not named must be absent (so a wrong extraction that INVENTS a value fails).
function check(title, expect) {
  const got = extractSpecs(title, 'RAM');
  for (const [k, v] of Object.entries(expect)) {
    assert.strictEqual(got[k], v, `${k} for "${title}": got ${got[k]}, want ${v}`);
  }
  for (const k of ['cap', 'speed', 'memType', 'sticks', 'cl']) {
    if (!(k in expect)) assert.ok(got[k] === undefined, `${k} for "${title}" should be absent, got ${got[k]}`);
  }
}

// ── AMAZON dialect (must keep working) ───────────────────────────────────────
const AMAZON = [
  ['Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz CL30', { cap: 32, sticks: 2, speed: 6000, memType: 'DDR5', cl: 30 }],
  ['Corsair Vengeance DDR5 64GB (2x32GB) 5600MHz CL40', { cap: 64, sticks: 2, speed: 5600, memType: 'DDR5', cl: 40 }],
  ['Corsair Dominator Titanium DDR5 32GB (2x16GB) 7200MHz CL34', { cap: 32, sticks: 2, speed: 7200, memType: 'DDR5', cl: 34 }],
  ['G.Skill Trident Z5 Royal DDR5 32GB (2x16GB) 7600MHz CL36', { cap: 32, sticks: 2, speed: 7600, memType: 'DDR5', cl: 36 }],
  ['G.Skill Trident Z5 Neo DDR5 32GB (2x16GB) 6000MHz CL30', { cap: 32, sticks: 2, speed: 6000, memType: 'DDR5', cl: 30 }],
  ['TeamGroup T-Force Vulcan DDR5 32GB (2x16GB) 5200MHz CL40', { cap: 32, sticks: 2, speed: 5200, memType: 'DDR5', cl: 40 }],
  ['Crucial DDR5 32GB (2x16GB) 4800MHz CL40', { cap: 32, sticks: 2, speed: 4800, memType: 'DDR5', cl: 40 }],
  // ECC modules — no parenthesis; the OLD extractor missed cap on these too.
  ['Kingston Server Premier DDR5 32GB ECC 4800MHz', { cap: 32, speed: 4800, memType: 'DDR5' }],
  ['Samsung DDR5 64GB ECC RDIMM 4800MHz', { cap: 64, speed: 4800, memType: 'DDR5' }],
  // DDR4 kit
  ['Corsair Vengeance LPX DDR4 32GB (2x16GB) 3600MHz CL18', { cap: 32, sticks: 2, speed: 3600, memType: 'DDR4', cl: 18 }],
];

// ── NEWEGG dialect (the fix) ─────────────────────────────────────────────────
const NEWEGG = [
  // "DDR5 5200" — no MHz suffix (the dominant, 92% format)
  ['Kingston FURY Beast 64GB (2 x 32GB) 288-Pin PC RAM DDR5 5200 (PC5 41600) Memory', { cap: 64, sticks: 2, speed: 5200, memType: 'DDR5' }],
  ['Kingston FURY Beast 16GB (2 x 8GB) 288-Pin PC RAM DDR5 5600 (PC5 44800) Memory', { cap: 16, sticks: 2, speed: 5600, memType: 'DDR5' }],
  ['Kingston FURY Beast 128GB (4 x 32GB) 288-Pin PC RAM DDR5 5200 (PC5 41600) Memory', { cap: 128, sticks: 4, speed: 5200, memType: 'DDR5' }],
  // SO-DIMM DDR4, "DDR4 3200"
  ['Kingston FURY Impact 32GB (1 x 32GB) 260-pin SO-DIMM DDR4 3200', { cap: 32, sticks: 1, speed: 3200, memType: 'DDR4' }],
  // "5200MT/s" + CL, capacity with NO parenthesis
  ['Kingston 64GB 5200MT/s DDR5 CL40 DIMM (Kit of 2) FURY Beast White RGB XMP', { cap: 64, speed: 5200, memType: 'DDR5', cl: 40 }],
  // reversed sticks "(32GBx4)" + explicit PC class
  ['V-COLOR 128GB (32GBx4) DDR5 6400MT/s PC5-51200 CL52', { cap: 128, sticks: 4, speed: 6400, memType: 'DDR5', cl: 52 }],
  ['V-COLOR DDR5 64GB (16GBx4) 6400MT/s CL52 2Gx8 1Rx8 ECC', { cap: 64, sticks: 4, speed: 6400, memType: 'DDR5', cl: 52 }],
  // Silicon Power / Patriot survivors
  ['Silicon Power DDR5 32GB (2x16GB) Storm RGB 6000MT/s (PC5 48000)', { cap: 32, sticks: 2, speed: 6000, memType: 'DDR5' }],
  ['Patriot Viper Venom DDR5 RAM 32GB (1X32GB) 5600MT/s CL30', { cap: 32, sticks: 1, speed: 5600, memType: 'DDR5', cl: 30 }],
  // old DDR3 with 3-digit speed + PCn fallback; "1 GB" spaced capacity
  ['HP - DDR3 - 1 GB - SO-DIMM 144-pin - 800 MHz / PC3-6400 - unbuffered - non-ECC', { cap: 1, speed: 800, memType: 'DDR3' }],
  // PCn-only speed (no MHz, no "DDR4 NNNN"): must fall back to PC/8
  ['Micron 16GB DDR4 PC4-25600 UDIMM', { cap: 16, speed: 3200, memType: 'DDR4' }],
];

// ── Genuinely under-specced — must STAY unspecced (spec bar will reject) ──────
const UNSPECCED = [
  // server/OEM module with no speed in the title
  ['Total Micro 8GB DDR4 SDRAM Memory Module AA101752TM', { cap: 8, memType: 'DDR4' }],
  ['Black Diamond Memory 16GB System Specific Memory', { cap: 16 }],
];

for (const [title, exp] of AMAZON) test(`amazon: ${title.slice(0, 48)}`, () => check(title, exp));
for (const [title, exp] of NEWEGG) test(`newegg: ${title.slice(0, 48)}`, () => check(title, exp));
for (const [title, exp] of UNSPECCED) test(`unspecced: ${title.slice(0, 40)}`, () => check(title, exp));

// ── ramAttributes: ECC must be false for EVERY negation spelling ──────────────
// The first capped batch set non-ECC modules to ecc:true because a bare "ECC"
// matched inside "non-ECC". Cover all the forms vendors actually print.
const ECC_CASES = [
  ['HP DDR3 1GB SO-DIMM 800 MHz unbuffered non-ECC', false],
  ['Total Micro 16GB DDR4 2666MHz PC4-21300 Unbuffered Non-ECC 1.2V', false],
  ['Crucial 16GB DDR4 3200 Non ECC UDIMM', false],
  ['Some 8GB DDR4 NonECC module', false],
  ['Kingston 16GB DDR5 without ECC', false],
  ['Generic 8GB DDR4 no ECC desktop memory', false],
  ['Kingston Server Premier 32GB DDR5 ECC 4800MHz', true],
  ['Samsung 64GB DDR5 ECC RDIMM 4800MHz', true],
  ['Micron 32GB DDR4 LRDIMM 2Rx4 2666', true],          // registered => ECC
  ['Corsair Vengeance 32GB (2x16GB) DDR5 6000 CL30', false], // no ECC mention
];
for (const [title, exp] of ECC_CASES) {
  test(`ecc: ${title.slice(0, 44)}`, () => assert.strictEqual(ramAttributes(title).ecc, exp, title));
}

test('ramAttributes: rgb + formFactor', () => {
  assert.strictEqual(ramAttributes('… SO-DIMM DDR4 …').formFactor, 'SODIMM');
  assert.strictEqual(ramAttributes('… RDIMM …').formFactor, 'RDIMM');
  assert.strictEqual(ramAttributes('… LRDIMM …').formFactor, 'LRDIMM');
  assert.strictEqual(ramAttributes('Corsair Vengeance DDR5 …').formFactor, 'UDIMM');
  assert.strictEqual(ramAttributes('… RGB DDR5 …').rgb, true);
  assert.strictEqual(ramAttributes('… DDR5 …').rgb, false);
});
