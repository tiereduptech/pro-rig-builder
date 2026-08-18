// titleMatches() brand qualification — the catalog stores the manufacturer in
// `b` and usually omits it from `n`, so the gate was scoring a brandless stored
// name against a branded Amazon title and failing on tokens the stored name
// never had. Worse, the existing brandShared arm reads the brand from the FIRST
// TOKEN OF THE STORED NAME, so for these rows it compared a model number
// against the Amazon title and could never fire.
//
// The 2026-08-17 identity audit put 44 of its 233 non-dead findings in this
// bucket. The fix passes `b` in as a fourth argument and retries ONLY when the
// as-is evaluation has already failed.
//
// The property that matters most is MONOTONICITY. Prepending tokens grows
// |tokensA|, and score = |A∩B|/|A| can only fall when the Amazon title omits the
// brand — so a naive "always prepend" would have manufactured NEW defects among
// the 3,167 rows the audit calls clean, none of which store a title we could
// re-test against. Two arms, as-is first, is what makes that impossible.
//
// Every string below is copied verbatim from the catalog and the 2026-08-17
// audit report. Paraphrasing them is what makes a gate test lie: a shortened
// stored name raises token recall and passes the plain arm, so the test stops
// exercising the thing it names.
//
//   node --test test/drift-gate.brand-qualified.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMatches } from '../drift-gate.js';

// ── the 44 class: brandless stored name, branded Amazon title ──────────────
const RESCUED = [
  { id: 70037, brand: 'Lian Li',
    n: 'O11D MINI V2 Flow | Compact ATX Mid-Tower Airflow Computer Case | Panoramic View | High-Performance Airflow | Include...',
    az: 'Lian Li O11D MINI V2 Flow-ATX Mid-Tower PC Case-Black-O11DMIV2FX' },
  { id: 70095, brand: 'Antec',
    n: 'C5 ARGB, Mid-Tower ATX PC Case, Seamless Tempered Glass Front & Side Panels',
    az: 'Antec C5 ARGB Mid-Tower ATX PC Case, 7 ARGB PWM Fans, Black' },
  { id: 20396, brand: 'MSI',
    n: 'PRO H810I WiFi Motherboard, ITX - Supports Intel Core Ultra Processors (Series 2), LGA 1851 - DDR5 Memory Boost (6400...',
    az: 'MSI PRO H810I WiFi Motherboard - ITX, LGA1851' },
];

for (const c of RESCUED) {
  test(`id ${c.id}: brandless stored name is rescued by b (the 44 class)`, () => {
    assert.equal(titleMatches(c.n, c.az, null).match, false);       // today's false defect
    const r = titleMatches(c.n, c.az, null, c.brand);
    assert.equal(r.match, true);
    assert.equal(r.brandRescued, true);                              // and it says so
  });
}

// ── the defects that must SURVIVE the rescue ──────────────────────────────
// Both stored names already lead with their brand, so brandQualified() declines
// to prepend and the verdict is the plain arm's. This is the case that decides
// whether the fix is a correctness change or a loosening.
const SURVIVES = [
  { id: 99931, brand: 'APC', why: 'different manufacturer entirely',
    n: 'APC BX1500M 1500VA UPS',
    az: 'CyberPower CP1500PFCLCD PFC Sinewave UPS Battery Backup and Surge Protector' },
  { id: 99930, brand: 'CyberPower', why: 'same brand, different model',
    n: 'CyberPower CP1500PFCLCD 1500VA UPS',
    az: 'CyberPower CP1500PFCRM2U PFC Sinewave UPS Battery Backup' },
];

for (const c of SURVIVES) {
  test(`id ${c.id}: still flagged — ${c.why}`, () => {
    assert.equal(titleMatches(c.n, c.az, null).match, false);
    assert.equal(titleMatches(c.n, c.az, null, c.brand).match, false);
  });
}

// ── invariants ────────────────────────────────────────────────────────────
test('MONOTONIC: passing without a brand always still passes with one', () => {
  // The brand is absent from the Amazon title, so prepending it strictly lowers
  // forward recall. A single-arm implementation fails this test.
  const n = 'Core i9-14900K Desktop Processor';
  const az = 'Core i9-14900K Desktop Processor';
  assert.equal(titleMatches(n, az).match, true);
  assert.equal(titleMatches(n, az, null, 'Intel').match, true);
});

test('a row the plain arm already clears is not re-scored', () => {
  const n = 'NZXT N7 B850 - AMD B850 AM5 ATX Gaming Motherboard';
  const az = 'NZXT N7 B850 - AMD B850 AM5 ATX Motherboard - Black';
  assert.equal(titleMatches(n, az).match, true);
  const r = titleMatches(n, az, null, 'NZXT');
  assert.equal(r.match, true);
  assert.equal(r.brandRescued, undefined);
});

test('a capacity conflict vetoes both arms', () => {
  const n = '990 PRO 2TB PCIe 4.0 NVMe M.2 Internal Solid State Drive with Heatsink';
  const az = 'Samsung 990 PRO 512GB PCIe 4.0 NVMe M.2 Internal Solid State Drive';
  const r = titleMatches(n, az, null, 'Samsung');
  assert.equal(r.match, false);
  assert.equal(r.capConflict, true);
});

test('an absent or empty brand changes nothing', () => {
  const n = 'C5 ARGB, Mid-Tower ATX PC Case, Seamless Tempered Glass Front & Side Panels';
  const az = 'Antec C5 ARGB Mid-Tower ATX PC Case, 7 ARGB PWM Fans, Black';
  const base = titleMatches(n, az).match;
  for (const b of [null, undefined, '', '   ']) {
    assert.equal(titleMatches(n, az, null, b).match, base);
  }
});

test('a stored name that already leads with its brand is not double-prefixed', () => {
  const n = 'Lian Li O11D MINI V2 Flow | Compact ATX Mid-Tower Airflow Computer Case | Panoramic View';
  const az = 'Lian Li O11D MINI V2 Flow-ATX Mid-Tower PC Case-Black-O11DMIV2FX';
  const r = titleMatches(n, az, null, 'Lian Li');
  // whatever the verdict, it must come from the plain arm — no retry happened
  assert.equal(r.brandRescued, undefined);
});
