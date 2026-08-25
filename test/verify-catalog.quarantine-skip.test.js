// =============================================================================
//  test/verify-catalog.quarantine-skip.test.js
//
//  A quarantined row (needsReview) is already hidden from every buy surface —
//  App.jsx filters !needsReview before the catalog reaches the page. We were
//  still paying DataForSEO to re-price those rows on every run: 692 of 2163
//  tier-1 rows (32%) were quarantined, 246 of them both quarantined and billed,
//  which at 2x/day is $22.44/month for answers about rows nobody can see.
//
//  The rule these protect has two halves, and the second is the one that is easy
//  to break later: skip the PAID pass, but keep the row in the FREE PA pass, so a
//  row that recovers is still seen to recover. Dropping the row entirely would
//  make quarantine a one-way door — which is exactly how 385 healthy rows ended
//  up stuck behind one.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionPaidPass, partitionByPaapi } from '../verify-catalog-asins.js';

const row = (id, extra = {}) => ({
  product: { id, c: 'GPU', n: `Product ${id}`, needsReview: false, ...extra },
  asin: `B00000000${id}`,
  paItem: null,
});

test('quarantined rows are held back from the paid pass', () => {
  const { needDfs, quarantineSkipped } = partitionPaidPass([
    row(1),
    row(2, { needsReview: true }),
    row(3),
    row(4, { needsReview: true, quarantinedAt: '2026-08-05' }),
  ]);
  assert.deepEqual(needDfs.map(x => x.product.id), [1, 3]);
  assert.deepEqual(quarantineSkipped.map(x => x.product.id), [2, 4]);
});

test('every unconfirmed row lands in exactly one bucket — none are dropped', () => {
  const input = Array.from({ length: 50 }, (_, i) => row(i, { needsReview: i % 3 === 0 }));
  const { needDfs, quarantineSkipped } = partitionPaidPass(input);
  assert.equal(needDfs.length + quarantineSkipped.length, input.length);
  const ids = new Set([...needDfs, ...quarantineSkipped].map(x => x.product.id));
  assert.equal(ids.size, input.length, 'a row must not appear in both buckets');
});

test('the skip is on the PAID pass only — quarantined rows still ride the free PA pass', () => {
  // This is the half that keeps quarantine from becoming a one-way door. A
  // quarantined row must still be partitioned by PA API, so a recovery is visible.
  const confirmed = {
    Offers: { Listings: [{ Price: { Amount: 99 }, Condition: { Value: 'New' }, IsBuyBoxWinner: true }] },
  };
  const quarantined = { id: 7, c: 'GPU', n: 'Recovered card', needsReview: true,
                        deals: { amazon: { url: 'https://www.amazon.com/dp/B000000007' } } };
  const paItems = new Map([['B000000007', confirmed]]);
  const { paSettled, needDfs } = partitionByPaapi([quarantined], paItems);

  // PA settled it for $0 despite the quarantine — that is the recovery signal.
  assert.equal(paSettled.length + needDfs.length, 1, 'the row must be seen, not dropped');
  if (paSettled.length) {
    assert.equal(paSettled[0].product.id, 7);
  }
  // And a PA-settled row never reaches partitionPaidPass at all, so it is never billed.
  const { quarantineSkipped } = partitionPaidPass(needDfs);
  assert.equal(quarantineSkipped.length + paSettled.length, 1);
});

test('a row with no product object does not throw', () => {
  const { needDfs, quarantineSkipped } = partitionPaidPass([{ asin: 'X', paItem: null }]);
  assert.equal(needDfs.length, 1);
  assert.equal(quarantineSkipped.length, 0);
});

test('an empty input yields two empty buckets', () => {
  const { needDfs, quarantineSkipped } = partitionPaidPass([]);
  assert.deepEqual(needDfs, []);
  assert.deepEqual(quarantineSkipped, []);
});
