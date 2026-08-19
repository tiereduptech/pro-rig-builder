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
const { extractSpecs, ramAttributes, ramRejectReason, ramSticks, resolveDiscoveryBrand } = require('../catalog-classify.cjs');

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
  // "5200MT/s" + CL, capacity with NO parenthesis. "(Kit of 2)" IS a stick
  // count — this row previously asserted sticks absent, which was the bug.
  ['Kingston 64GB 5200MT/s DDR5 CL40 DIMM (Kit of 2) FURY Beast White RGB XMP', { cap: 64, sticks: 2, speed: 5200, memType: 'DDR5', cl: 40 }],
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

test('ramAttributes: rgb + formFactor (incl. Registered/REG -> RDIMM)', () => {
  assert.strictEqual(ramAttributes('… SO-DIMM DDR4 …').formFactor, 'SODIMM');
  assert.strictEqual(ramAttributes('… RDIMM …').formFactor, 'RDIMM');
  assert.strictEqual(ramAttributes('… LRDIMM …').formFactor, 'LRDIMM');
  assert.strictEqual(ramAttributes('Black Diamond 16GB ECC Registered DDR4 2400').formFactor, 'RDIMM');
  assert.strictEqual(ramAttributes('Black Diamond 16GB DDR5 5200 ECC REG Memory').formFactor, 'RDIMM');
  assert.strictEqual(ramAttributes('Corsair Vengeance DDR5 …').formFactor, 'UDIMM');
  assert.strictEqual(ramAttributes('Kingston 32GB DDR5 ECC 4800 unbuffered UDIMM').formFactor, 'UDIMM'); // consumer ECC stays UDIMM
  assert.strictEqual(ramAttributes('… RGB DDR5 …').rgb, true);
  assert.strictEqual(ramAttributes('… DDR5 …').rgb, false);
});

// ── Brand resolution: no chip-giant leaks, spacing/punctuation variants ──────
// The 07-24 batch branded 7 G.Skill "AMD EXPO" kits as "AMD". Resolution must
// prefer the title but fall back to the feed manufacturer on a chip-giant/miss,
// and must NEVER return AMD/Intel/NVIDIA for RAM.
test('resolveDiscoveryBrand: chip-giant EXPO/XMP mis-reads fall back to manufacturer', () => {
  // [title, manufacturer, expected]
  const cases = [
    ['G. SKILL Trident Z5 Neo AMD EXPO 32GB DDR5 6000', 'G.Skill', 'G.Skill'],   // space after period + AMD EXPO
    ['G.Skill Ripjaws S5 DDR5 32GB 6000 CL30', 'G.Skill', 'G.Skill'],            // canonical -> detectBrand
    ['G.SKILL Trident Z5 DDR5 32GB', 'G.Skill', 'G.Skill'],                      // all caps, period
    ['G SKILL Flare X5 AMD EXPO DDR5 32GB', 'G.Skill', 'G.Skill'],               // space, no period + AMD
    ['CORSAIR Dominator Intel XMP DDR5 32GB', 'Corsair', 'Corsair'],             // detectBrand finds Corsair
    ['Team T-Force Delta RGB DDR5 32GB', 'Team Group', 'Team Group'],            // not in BRANDS -> manufacturer
    ['TEAMGROUP T-Create DDR5 32GB', 'TeamGroup', 'TeamGroup'],
    ['Silicon Power DDR5 32GB AMD EXPO 6000', 'Silicon Power', 'Silicon Power'], // not in BRANDS + AMD -> mfr
    ['V-COLOR DDR5 64GB 6400 Intel XMP', 'V-Color', 'V-Color'],
    ['KLEVV CRAS DDR5 32GB AMD EXPO', 'KLEVV', 'KLEVV'],
    ['Kingston FURY Beast DDR5 32GB Intel XMP', 'Kingston Technology', 'Kingston'], // mfr cleaned
  ];
  for (const [title, mfr, exp] of cases) {
    assert.strictEqual(resolveDiscoveryBrand(title, mfr, 'RAM'), exp, `${title}`);
  }
});
test('resolveDiscoveryBrand: never returns a chip giant for RAM', () => {
  for (const [title, mfr] of [
    ['G. SKILL AMD EXPO 32GB DDR5', 'G.Skill'],
    ['Corsair Vengeance AMD EXPO / Intel XMP 32GB', 'Corsair'],
    ['NoName DDR5 AMD EXPO', 'PNY'],
  ]) {
    const b = resolveDiscoveryBrand(title, mfr, 'RAM');
    assert.ok(!['AMD', 'Intel', 'NVIDIA'].includes(b), `${title} -> ${b}`);
  }
});

// ── RAM scope gate (ramRejectReason): consumer/gaming DESKTOP DIMM only ────────
// The gate is CC.ramRejectReason itself (no local mirror to drift). Scope after
// the 2026-07-27 audit: reject laptop (SODIMM/pin-count/"laptop"/"notebook"),
// server (RDIMM/R-DIMM/LRDIMM/LR-DIMM/registered/buffered), AND all ECC incl.
// consumer unbuffered ECC UDIMM. Keep only non-ECC desktop DIMM/UDIMM.
test('RAM scope gate: rejects laptop/server/ECC, keeps non-ECC desktop DIMM', () => {
  const rejects = {
    'Black Diamond Server Memory 16GB DDR3 ECC Registered': 'server_registered_ram',
    'Micron 32GB DDR4 LRDIMM 2Rx4 2666': 'server_registered_ram',
    'Samsung 64GB DDR5 ECC RDIMM 4800': 'server_registered_ram',
    'TEAMGROUP T-Create Master DDR5 R-DIMM 192GB Kit (8 x 24GB) 6400': 'server_registered_ram', // hyphenated
    'Black Diamond 16GB DDR5 5200 ECC REG Memory': 'server_registered_ram',
    'Kingston Server Premier DDR5 32GB ECC 4800MHz UDIMM': 'ecc_ram',                 // consumer ECC UDIMM now OUT
    'NEMIX 48GB DDR5 5600 ECC Unbuffered UDIMM': 'ecc_ram',
    'Corsair Vengeance SODIMM DDR5 16GB 4800 Laptop Memory': 'laptop_sodimm',
    '32GB DDR5 RAM, 5600MHz Laptop Memory, 262-Pin': 'laptop_sodimm',
    'Black Diamond Memory 16GB 260-Pin DDR4 SO-DIMM 3200 Notebook': 'laptop_sodimm',
  };
  for (const [n, reason] of Object.entries(rejects)) {
    assert.strictEqual(ramRejectReason(n), reason, `should reject ${reason}: ${n}`);
  }
  // kept (in scope) → null
  for (const n of [
    'Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz CL30',
    'G.Skill Trident Z5 DDR5 64GB (2x32GB) 6000 CL30',
    'CORSAIR Vengeance 32GB (2 x 16GB) 288-Pin DDR5 6400 Desktop Memory',
    // "On-die ECC" is a standard DDR5 feature on consumer gaming kits, NOT ECC
    // memory — must NOT be flagged (Lexar Thor Z false-positive, 2026-07-27 audit).
    'Lexar Thor Z Series RGB DDR5 RAM 32GB Kit (2x16GB) 6000 MHz, 288-Pin UDIMM Intel XMP 3.0 & AMD EXPO, On-die ECC, PMIC, 1.35V, for Gaming',
  ]) assert.strictEqual(ramRejectReason(n), null, `should keep: ${n}`);
});

// ── ramSticks(): the stick-count fix ─────────────────────────────────────────
// The original extractor required the kit notation to be PARENTHESISED
// (/\((\d+)\s*x\s*\d+\s*gb\)/), which left 75 of 590 visible RAM rows blank and
// undercounted the 1-stick filter bucket 12x (5 shown, ~61 real). Each title
// below is a real catalog row that the old pattern missed.
test('ramSticks: kit notation without parentheses', () => {
  const cases = [
    ['TEAMGROUP T-Create Expert 48GB KIT 2 X 24GB DDR5-7200 PC5-57600 CL34 Dual C', 2],
    ['Corsair Vengeance LPX 32GB 2x16GB DDR4 3600MHz C18', 2],
    ['Crucial 64GB DDR5 RAM Kit (2x32GB), 4800MHz CL40 Desktop Memory', 2],
    ['GIGASTONE Game PRO 32GB Kit (4x8GB) DDR4 3600MHz PC4-28800', 4],
  ];
  for (const [title, want] of cases) assert.strictEqual(ramSticks(title), want, title);
});

test('ramSticks: reversed notation, incl. bracketed and marketplace phrasings', () => {
  assert.strictEqual(ramSticks('CMK32GX4M2C3200C18 DDR4-3200MHz Desktop PC Memory 32GB [16GB x 2 Sheets]'), 2);
  assert.strictEqual(ramSticks('Black Opal DW100 DDR5 RGB RAM 32GB (16GBx2) 6000MHz CL30'), 2);
  assert.strictEqual(ramSticks('Crucial 16GB kit (8GBx2), 288-pin DIMM, DDR4 PC4-19200,'), 2);
});

test('ramSticks: counted kit words and explicit single-module wording', () => {
  assert.strictEqual(ramSticks('Kingston FURY Beast RGB 64GB 5600MT/s DDR5 CL40 DIMM Desktop Memory (Kit of 2)'), 2);
  assert.strictEqual(ramSticks('FURY Beast 8GB 3200MHz DDR4 CL16 Desktop Memory Single Module KF432C16BB/8'), 1);
  assert.strictEqual(ramSticks('Kingston Fury Beast 32GB 3600MHz DDR4 CL18 Desktop Memory Single Stick KF436C18BB/32'), 1);
  assert.strictEqual(ramSticks('Samsung M378A1K43CB2-CTD Memory Module (8 GB, 1 x 8 GB, DDR4, 2666 MHz)'), 1);
});

test('ramSticks: vendor part-number kit markers', () => {
  assert.strictEqual(ramSticks('G.Skill Ripjaws V F4-3600C18D-32GVK'), 2);      // D = dual
  assert.strictEqual(ramSticks('G. SKILL Ripjaws V Series 16GB Model F4-3200C16S-16GVK'), 1); // S = single
  assert.strictEqual(ramSticks('G.Skill Trident Z5 Neo F5-6000J3038F16GX2-TZ5NR'), 2);
  assert.strictEqual(ramSticks('G. SKILL Flare X5 16GB Model F5-6000J3636F16GX1-FX5'), 1);
  assert.strictEqual(ramSticks('Kingston FURY Beast RGB 64GB KF556C40BBAK2-64'), 2);
  assert.strictEqual(ramSticks('Crucial 32GB DDR4 RAM Kit CT2K16G4DFRA32A'), 2);
});

// The guard that matters most: rank notation is not a stick count.
test('ramSticks: "2Rx8" is module RANK, never a stick count', () => {
  assert.strictEqual(ramSticks('Black Diamond 32GB (2Rx8) DDR5 5600 Memory BD32G5600MC28'), null);
  assert.strictEqual(ramSticks('Black Diamond 8GB (1Rx8) DDR5 4800 Memory BD8G4800MC28'), null);
  // rank alongside real kit notation must still read the kit, not the rank
  assert.strictEqual(ramSticks('V-COLOR DDR5 64GB (16GBx4) 6400MT/s CL52 2Gx8 1Rx8 ECC'), 4);
});

// The one place absence counts as evidence: a complete Kingston/Crucial part
// number carries a kit marker when it is a kit, so a complete one without a kit
// marker says "single module". Measured against rows whose count comes
// independently from title kit notation: Kingston 51/51, Crucial 4/4.
test('ramSticks: a well-formed vendor part number with no kit marker is one module', () => {
  assert.strictEqual(ramSticks('Fury Beast RGB 8GB 3200MT/s DDR4 CL16 DIMM Computer Memory KF432C16BB2A/8'), 1);
  assert.strictEqual(ramSticks('FURY Beast White 32GB 5600MT/s CL36 DDR5 EXPO DIMM | AMD EXPO | KF556C36BWE-32'), 1);
  assert.strictEqual(ramSticks('Kingston Fury Beast 16GB PC RAM DDR4 3200 Memory Model KF432C16BB/16'), 1);
  assert.strictEqual(ramSticks('Crucial RAM 8GB DDR4 2666 MHz CL19 Desktop Memory CT8G4DFRA266'), 1);
  // the kit marker still wins wherever it is present
  assert.strictEqual(ramSticks('Kingston FURY Beast RGB 64GB KF556C40BBAK2-64'), 2);
  assert.strictEqual(ramSticks('Crucial 32GB DDR4 RAM Kit CT2K16G4DFRA32A'), 2);
});

// Rejected on measurement: singular "Module" wording scored 2 agree / 16
// disagree against the same truth set, because it sits happily on kit titles.
test('ramSticks: singular "Memory Module" wording is not a stick count', () => {
  assert.strictEqual(ramSticks('T-Force Vulcan DDR5 32GB (2x16GB) 6000MHz CL38 Desktop Memory Module Ram'), 2);
  assert.strictEqual(ramSticks('Crucial Pro - DDR5 - Module - 16 GB - DIMM 288-PIN - 6000 MHz - CL36'), null);
});

// Unknown must stay unknown. Assuming 1 here is what breaks builds.
test('ramSticks: returns null rather than guessing', () => {
  for (const title of [
    '16GB DDR4 RAM, 3200MHz (PC4-25600) CL22 Desktop Memory, UDIMM 288-Pin',
    'Total Micro 16GB DDR4 2666MHz PC4-21300 Unbuffered Non-ECC 1.2',
    'Total Micro - A9321911-TM - 8gb 2400mhz Ddr4 Memory For Dell',
  ]) assert.strictEqual(ramSticks(title), null, title);
});
