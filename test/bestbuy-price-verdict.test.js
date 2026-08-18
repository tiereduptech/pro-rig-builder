// What a probed Best Buy row is allowed to conclude.
//
// This rule decides whether anyone builds a refresh cron, and it got that
// wrong once already: run 32172326071 tallied a 404ed sku — no salePrice at
// all — as STALE-ONLY, a bucket whose published meaning is "`salePrice` is
// correct, stored value is old, build the refresh job". These pin each bucket
// to the evidence it actually requires.
//
//   node --test test/bestbuy-price-verdict.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, tallyOf, VERDICTS, EPSILON } from '../bestbuy-price-verdict.mjs';

test('REGRESSION: a row with no salePrice abstains instead of counting as STALE-ONLY', () => {
  // motherboard/20040, sku 11013277, run 32172326071: SKU-404, so the
  // Developer API published no salePrice, yet stored != live.
  assert.equal(classify({ stored: 180.49, sale: null, live: 345.76 }), 'NO-SALEPRICE');
});

test('REGRESSION: a sample of dead skus does not read as an argument for the cron', () => {
  const rows = [
    { stored: 180.49, sale: null, live: 345.76 },
    { stored: 99.99, sale: null, live: 149.99 },
    { stored: 59.0, sale: null, live: 59.0 },
  ];
  const t = tallyOf(rows.map(classify));
  assert.equal(t['NO-SALEPRICE'], 3);
  assert.equal(t['STALE-ONLY'], 0);
  assert.equal(t['AGREE'], 0, 'an equal stored and live still says nothing about the field');
});

test('salePrice that is not what a customer pays is FIELD-WRONG', () => {
  // The 2026-06-28 sku 6519477 case: salePrice 399.99, real price 239.99.
  assert.equal(classify({ stored: 399.99, sale: 399.99, live: 239.99 }), 'FIELD-WRONG');
});

test('salePrice right and stored old is STALE-ONLY — the only cron argument', () => {
  assert.equal(classify({ stored: 299.99, sale: 239.99, live: 239.99 }), 'STALE-ONLY');
});

test('all three agreeing is AGREE', () => {
  assert.equal(classify({ stored: 239.99, sale: 239.99, live: 239.99 }), 'AGREE');
});

test('no live price is UNRESOLVED, whether or not a salePrice exists', () => {
  assert.equal(classify({ stored: 10, sale: 10, live: null }), 'UNRESOLVED');
  assert.equal(classify({ stored: 10, sale: null, live: null }), 'UNRESOLVED');
});

test('UNRESOLVED outranks NO-SALEPRICE — an unreached row is not an abstaining row', () => {
  // Both are "cannot answer", but they are different work: one is a dead sku,
  // the other is a resolution failure to chase.
  assert.equal(classify({ stored: 10, sale: null, live: null }), 'UNRESOLVED');
});

test('sub-cent differences are float noise, not price movement', () => {
  assert.equal(classify({ stored: 100, sale: 100, live: 100.005 }), 'AGREE');
  assert.equal(classify({ stored: 100, sale: 100.005, live: 100 }), 'AGREE');
  assert.equal(classify({ stored: 100, sale: 100, live: 100 + EPSILON * 2 }), 'FIELD-WRONG');
});

test('a legitimate 0.00 is a price, not a missing one', () => {
  assert.equal(classify({ stored: 0, sale: 0, live: 0 }), 'AGREE');
  assert.equal(classify({ stored: 0, sale: 0, live: 9.99 }), 'FIELD-WRONG');
});

test('every verdict the classifier can return has a bucket in the tally', () => {
  const t = tallyOf([]);
  assert.deepEqual(Object.keys(t).sort(), [...VERDICTS].sort());
  for (const v of VERDICTS) assert.equal(t[v], 0);
});
