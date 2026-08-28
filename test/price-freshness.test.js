// =============================================================================
//  test/price-freshness.test.js
//
//  The gate that decides whether the site will quote a price.
//
//  Nothing in the render path consulted the age of a price: isAvailable,
//  bestPrice, the retailers() sort and the BEST badge were all stock-or-price
//  only. The failure mode was not that stale prices showed — it is that they
//  WON. Prices drift up more often than down, so a frozen number is
//  disproportionately the cheapest, Math.min picked it, it sorted to index 0,
//  and BEST is positional. The least trustworthy number on the card was the one
//  the site endorsed.
//
//  Measured: the de-badged rows are priced a median $8-$27 BELOW the honest
//  price that replaces them, which is the drift showing up as real money.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_STALE_AFTER_DAYS, priceStampOf, isFresh, priceAgeDays } from '../src/price-freshness.js';

const NOW = Date.parse('2026-08-28T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('the threshold is a stated constant, not a magic number', () => {
  assert.equal(PRICE_STALE_AFTER_DAYS, 14);
  // Two backend files justify their own window by citing this constant. It did
  // not exist, so both were anchored to a gate that was never built.
  assert.equal(typeof PRICE_STALE_AFTER_DAYS, 'number');
});

test('a missing stamp is STALE, not fresh — the default must not favour it', () => {
  assert.equal(isFresh({ price: 100 }, NOW), false);
  assert.equal(isFresh({}, NOW), false);
  assert.equal(isFresh(null, NOW), false);
  assert.equal(isFresh(undefined, NOW), false);
  assert.equal(priceAgeDays({ price: 100 }, NOW), null);
});

test('matchedAt is not a price confirmation', () => {
  // All 182 newegg_openbox rows carry matchedAt and have never had a price
  // confirmed. Counting it would certify the worst rows in the catalog.
  const row = { price: 449.99, matchedAt: daysAgo(0) };
  assert.equal(priceStampOf(row), null);
  assert.equal(isFresh(row, NOW), false, 'matchedAt must not read as freshness');
});

test('refreshedAt and priceConfirmedAt both count, refreshedAt wins', () => {
  assert.equal(isFresh({ refreshedAt: daysAgo(1) }, NOW), true);
  assert.equal(isFresh({ priceConfirmedAt: daysAgo(1) }, NOW), true);
  assert.equal(priceStampOf({ refreshedAt: 'A', priceConfirmedAt: 'B' }), 'A');
});

test('the boundary is inclusive at exactly the threshold', () => {
  assert.equal(isFresh({ refreshedAt: daysAgo(13) }, NOW), true);
  assert.equal(isFresh({ refreshedAt: daysAgo(14) }, NOW), true, '14d is not yet stale');
  assert.equal(isFresh({ refreshedAt: daysAgo(15) }, NOW), false);
});

test('a date-only stamp is read as its day, not as an hour boundary', () => {
  // Stamps arrive both ways: '2026-08-28' from the Newegg refresher, a full
  // ISO string from Best Buy. Truncating to the day makes them comparable, so
  // a row does not flip fresh/stale depending on which writer touched it.
  assert.equal(isFresh({ refreshedAt: '2026-08-14' }, NOW), true);
  assert.equal(isFresh({ refreshedAt: '2026-08-14T23:59:59Z' }, NOW), true);
  assert.equal(priceAgeDays({ refreshedAt: '2026-08-14' }, NOW), 14);
});

test('an unparseable stamp is stale, not an exception and not fresh', () => {
  assert.equal(isFresh({ refreshedAt: 'sometime last week' }, NOW), false);
  assert.equal(isFresh({ refreshedAt: 42 }, NOW), false);
  assert.equal(priceAgeDays({ refreshedAt: 'garbage' }, NOW), null);
});

test('a future stamp is not negative age', () => {
  assert.equal(priceAgeDays({ refreshedAt: daysAgo(-5) }, NOW), 0);
  assert.equal(isFresh({ refreshedAt: daysAgo(-5) }, NOW), true);
});

test('the 93-day case the thread started from', () => {
  const msi = { price: 1299, priceConfirmedAt: daysAgo(93) };
  assert.equal(isFresh(msi, NOW), false);
  assert.equal(priceAgeDays(msi, NOW), 93);
});
