// =============================================================================
//  test/verdict-outcomes.test.js
//
//  Every verdict analyzeResult reaches on a listing it actually READ must end in
//  exactly one of three recorded outcomes:
//
//    CONFIRMED     priceConfirmedAt            — we stand behind the price
//    QUARANTINED   needsReview                 — the product comes off the site
//    UNCONFIRMED   priceConfidence:'unconfirmed' — price kept, tagged with why,
//                                                 priceUnconfirmedAt stamped
//
//  A verdict with none of them leaves the row on the site, unconfirmed, with
//  nothing recording that the check disagreed. #100767 sat in that state: a
//  capacity conflict (stored 24GB per stick vs a 48GB kit listing) that neither
//  confirmed nor quarantined, re-read and dropped on every run.
//
//  The one exception is deliberate: `no_data`, where nothing was read. A failed
//  read is not a verdict about the price, and recording it as one would make
//  "Amazon told us no" and "we could not reach Amazon" look identical. That row
//  keeps its last stamp and ages, which the freshness gate measures.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeResult } from '../drift-gate.js';
import { paapiToAmazonData } from '../verify-catalog-asins.js';

const listing = ({ price = 99.99, cond = 'New', bb = true, avail = 'IN_STOCK' } = {}) => ({
  isBuyBoxWinner: bb, condition: { value: cond }, price: { money: { amount: price } },
  merchantInfo: { name: 'Amazon.com' }, availability: { type: avail },
});
const item = (title, listings) =>
  paapiToAmazonData({ asin: 'B0OUTCOME1', itemInfo: { title: { displayValue: title } }, offersV2: { listings } });

const psu = { id: 1, n: 'Corsair RM750e 750W PSU', c: 'PSU', b: 'Corsair',
  deals: { amazon: { url: 'https://www.amazon.com/dp/B0OUTCOME1', price: 99.99, inStock: true } } };
const PSU_TITLE = 'Corsair RM750e 750W 80+ Gold Fully Modular PSU';

// The #100767 shape, taken from the live row.
const kit = { id: 100767, n: 'Biwin Black Opal DW100 DDR5 RGB RAM 48GB (24GBx2)', c: 'RAM', b: 'Biwin', cap: 24,
  deals: { amazon: { url: 'https://www.amazon.com/dp/B0G2TMTNJK', price: 499.99, inStock: true } } };
const KIT_TITLE = 'Biwin Black Opal DW100 DDR5 RGB RAM 48GB (24GBx2) 6000MHz CL30 Desktop Memory';

/** Which recorded outcomes a result carries. Exactly one is the contract. */
const outcomes = ({ fixes }) => [
  fixes.priceConfirmedAt ? 'confirmed' : null,
  fixes.needsReview ? 'quarantined' : null,
  fixes.priceConfidence === 'unconfirmed' ? 'unconfirmed' : null,
].filter(Boolean);

const CASES = [
  ['matched, New buy box', () => analyzeResult(psu, item(PSU_TITLE, [listing()])), 'confirmed'],
  ['matched, ambiguous buy box', () => analyzeResult(psu, item(PSU_TITLE, [listing({ cond: '' })])), 'unconfirmed'],
  ['matched, no buyable New offer', () => analyzeResult(psu, item(PSU_TITLE, [listing({ avail: 'OUT_OF_STOCK' })])), 'quarantined'],
  ['title mismatch', () => analyzeResult(psu, item('Logitech MX Vertical Wireless Mouse', [listing()])), 'unconfirmed'],
  ['capacity conflict (#100767)', () => analyzeResult(kit, item(KIT_TITLE, [listing({ price: 499.99 })])), 'unconfirmed'],
];

for (const [name, run, expected] of CASES) {
  test(`every read verdict ends in exactly one outcome: ${name} -> ${expected}`, () => {
    assert.deepEqual(outcomes(run()), [expected]);
  });
}

test('the capacity conflict is still reported as one — the check is not changed, only its outcome', () => {
  const out = analyzeResult(kit, item(KIT_TITLE, [listing({ price: 499.99 })]));
  assert.ok(out.issues.some((i) => i.type === 'capacity_mismatch'), 'this test is about the #100767 verdict');
  assert.equal(out.fixes.priceUnconfirmedReason, 'capacity_mismatch');
  assert.equal(out.fixes.amazonPrice, undefined, 'no price is written from a listing we doubt');
  assert.equal(out.fixes.needsReview, undefined, 'and the product is not hidden for our matcher disagreeing');
});

test('a title mismatch records its own reason', () => {
  const out = analyzeResult(psu, item('Logitech MX Vertical Wireless Mouse', [listing()]));
  assert.equal(out.fixes.priceUnconfirmedReason, 'title_mismatch');
});

test('no_data is NOT a verdict: a failed read records no outcome at all', () => {
  // Empty and failed must differ. Stamping "unconfirmed" here would tell the
  // site Amazon disagreed when we simply could not reach it.
  const out = analyzeResult(psu, null);
  assert.deepEqual(out.fixes, {});
  assert.ok(out.issues.some((i) => i.type === 'no_data'));
});
