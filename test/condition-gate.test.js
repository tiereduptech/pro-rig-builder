// Condition gate — the check the Amazon relink path was missing.
//
// The Newegg feed matcher (newegg-match.js) has always rejected wrong-condition
// SKUs via conditionMismatch(). The Amazon discovery/relink path had NO such gate,
// so 29+ renewed/refurbished listings were attached to New-product rows, and 3 of
// them even came back with a live New offer — which does NOT make the SKU right,
// because the stored name still advertises "(Renewed)" to the customer.
//
// This file locks the shared gate (condition.cjs) that now guards BOTH paths.
//
//   node --test
//
// The test also proves the ESM->CJS interop: this ESM file importing the .cjs
// module IS the check that newegg-match.js / verify-catalog-asins.js can too.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isRenewedTitle, CONDITION_MARKERS } from '../condition.cjs';

// ── Titles that MUST be rejected (non-New condition) ─────────────────────────
const REJECT = [
  'ASUS Phoenix GeForce RTX 3050 Graphics Card (Renewed)',
  'MSI Gaming GeForce RTX 3070 Ti Gaming X Trio 8G (Renewed)',
  'SteelSeries Aerox 9 Wireless Gaming Mouse (Renewed)',
  'Corsair RM850x Power Supply - Certified Refurbished',
  'Intel Core i7-12700K Manufacturer Recertified',
  'Samsung 970 EVO SSD - Factory Recertified',
  'Dell UltraSharp Monitor, Open Box',
  'WD Blue Drive Open-Box',
  'Seagate IronWolf 4TB (Used - Very Good)',
  'Logitech G Pro Keyboard Used - Like New',
  'GIGABYTE B650M Motherboard, Pre-Owned',
  'Kingston Fury Grade A Refurbished RAM',
  'EVGA GPU reconditioned unit',
];

// ── Titles that MUST NOT be rejected (genuine New products) ──────────────────
const ACCEPT = [
  'ASUS ROG Strix XF120 Whisper-Quiet 4-pin PWM Fan 120mm',
  'Rode VideoMic Me-C+ USB Microphone',
  'Micro ATX DDR4 LGA 1151 Motherboard H110M-C/CSM',
  'Thermal paste for use with CPU coolers',      // "use" — not a condition
  'Mechanical keyboard used by esports pros in tournaments', // "used by" — prose
  'Brand New Sealed NVIDIA RTX 4070 Graphics Card',
  'Noctua NH-D15 CPU Cooler, refurbisher-proof mounting', // "refurbisher" != refurb\b
];

for (const title of REJECT) {
  test(`REJECT: ${title.slice(0, 55)}`, () => {
    assert.equal(isRenewedTitle(title), true, `should be flagged non-New: ${title}`);
  });
}

for (const title of ACCEPT) {
  test(`ACCEPT: ${title.slice(0, 55)}`, () => {
    assert.equal(isRenewedTitle(title), false, `should NOT be flagged: ${title}`);
  });
}

// The core requirement: a renewed title with a live, plausible New offer must
// STILL be rejected. The gate is a function of the title alone — the caller
// (verify-catalog-asins.js) runs it BEFORE it looks at best.price, so a
// sane-priced renewed listing never wins the link swap.
test('renewed title is rejected regardless of a plausible New price', () => {
  const candidate = { asin: 'B0C3SPXZJ8', title: 'GeForce RTX 3070 (Renewed)', price: 329.99 };
  assert.equal(isRenewedTitle(candidate.title), true,
    'a plausible price must not rescue a renewed-titled SKU');
});

// Guards against silent drift: null/undefined titles must not throw and must not
// be treated as renewed (fail-open on the gate would be a false positive storm).
test('null / undefined / empty titles are safe and not flagged', () => {
  assert.equal(isRenewedTitle(null), false);
  assert.equal(isRenewedTitle(undefined), false);
  assert.equal(isRenewedTitle(''), false);
});

// The token set newegg-match.js imports must stay exactly these four values, or
// its conditionMismatch() coverage silently changes.
test('CONDITION_MARKERS is the shared four-value set', () => {
  assert.deepEqual([...CONDITION_MARKERS].sort(),
    ['openbox', 'refurbished', 'renewed', 'used']);
});
