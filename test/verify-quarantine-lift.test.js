/**
 * test/verify-quarantine-lift.test.js
 *
 * The live pass decides which hidden rows a human is allowed to put back on the
 * site, so the bar has to be the one the header claims: link resolves, New Buy
 * Box, and the price we hold still matches. Three ways that bar quietly slips:
 *
 *   - Comparing the wrong stored price. `price` on a multi-retailer row is the
 *     cheapest retailer, often Newegg. Checked against an Amazon Buy Box it
 *     disagrees on nearly every row, and the whole shortlist reads as rotten.
 *
 *   - Letting AMBIGUOUS pass as verified. classifyBuyBox deliberately separates
 *     "cannot confirm" from "affirmatively wrong" so ambiguity does not
 *     quarantine good rows — but ambiguity is equally not grounds to un-hide.
 *
 *   - Reading a degraded run as a clean one. resolveItems never throws and
 *     returns an empty Map when the circuit is open, which marks every row
 *     not_returned and looks exactly like a catalog that rotted overnight.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { verdictFor, priceAgrees, shortlist, PRICE_TOLERANCE } from '../verify-quarantine-lift.mjs';

// A PA API item in the offersV2 shape classifyBuyBox reads.
const item = (listings) => ({ asin: 'B000000001', offersV2: { listings } });
const newBuyBox = (price, seller = 'Amazon.com') => item([
  { price: { money: { amount: price } }, condition: { value: 'New' },
    isBuyBoxWinner: true, availability: { type: 'Now' },
    merchantInfo: { name: seller } },
]);

const row = (over = {}) => ({ id: 1, name: 'Test Part', category: 'CPU',
  asin: 'B000000001', amazonPrice: 100, price: 90, retailer: 'newegg', ...over });

test('a live New Buy Box at the stored price confirms', () => {
  const v = verdictFor(row(), newBuyBox(100));
  assert.strictEqual(v.verdict, 'confirmed');
  assert.strictEqual(v.livePrice, 100);
});

test('the check compares the AMAZON price, not the cheapest retailer', () => {
  // Stored: Amazon 100, Newegg 90 (so `price` is 90). Amazon's Buy Box says 100.
  // Comparing against `price` would call this a price move on a healthy row.
  const v = verdictFor(row({ amazonPrice: 100, price: 90, retailer: 'newegg' }), newBuyBox(100));
  assert.strictEqual(v.verdict, 'confirmed', 'must not compare the Newegg price to an Amazon Buy Box');
});

test('a moved price is reported for re-pricing, never confirmed', () => {
  const v = verdictFor(row({ amazonPrice: 100 }), newBuyBox(140));
  assert.strictEqual(v.verdict, 'price_moved');
  assert.strictEqual(v.livePrice, 140, 'the live price travels with the row');
});

test('the tolerance band absorbs a wobble and nothing more', () => {
  assert.strictEqual(verdictFor(row({ amazonPrice: 100 }), newBuyBox(102)).verdict, 'confirmed');
  assert.strictEqual(verdictFor(row({ amazonPrice: 100 }), newBuyBox(98)).verdict, 'confirmed');
  assert.strictEqual(verdictFor(row({ amazonPrice: 100 }), newBuyBox(103)).verdict, 'price_moved');
  assert.strictEqual(PRICE_TOLERANCE, 0.02);
});

test('priceAgrees refuses to compare against a missing or junk number', () => {
  assert.ok(!priceAgrees(null, 100));
  assert.ok(!priceAgrees(100, null));
  assert.ok(!priceAgrees(0, 100), 'a zero stored price is not a match, it is missing data');
  assert.ok(!priceAgrees(100, NaN));
  assert.ok(priceAgrees(100, 100));
});

// ── ambiguity does not clear the bar ─────────────────────────────────────────

test('an unlabeled Buy Box is unconfirmed, not confirmed', () => {
  const v = verdictFor(row(), item([
    { price: { money: { amount: 100 } }, condition: { value: '' },
      isBuyBoxWinner: true, availability: { type: 'Now' } },
  ]));
  assert.strictEqual(v.verdict, 'unconfirmed');
  assert.strictEqual(v.livePrice, null, 'no price is published from an unconfirmed box');
});

test('a Used Buy Box with a New offer elsewhere is unconfirmed, not liftable', () => {
  const v = verdictFor(row(), item([
    { price: { money: { amount: 80 } }, condition: { value: 'Used' },
      isBuyBoxWinner: true, availability: { type: 'Now' } },
    { price: { money: { amount: 100 } }, condition: { value: 'New' },
      isBuyBoxWinner: false, availability: { type: 'Now' } },
  ]));
  assert.strictEqual(v.verdict, 'unconfirmed');
});

test('an out-of-stock Buy Box is affirmatively bad', () => {
  const v = verdictFor(row(), item([
    { price: { money: { amount: 100 } }, condition: { value: 'New' },
      isBuyBoxWinner: true, availability: { type: 'OutOfStock' } },
  ]));
  assert.strictEqual(v.verdict, 'bad');
});

test('a listing with nothing New offered is affirmatively bad', () => {
  const v = verdictFor(row(), item([
    { price: { money: { amount: 80 } }, condition: { value: 'Refurbished' },
      isBuyBoxWinner: true, availability: { type: 'Now' } },
  ]));
  assert.strictEqual(v.verdict, 'bad');
});

// ── absence is its own verdict, never silence ────────────────────────────────

test('an ASIN PA API did not return is a dead link, not a pass', () => {
  const v = verdictFor(row(), null);
  assert.strictEqual(v.verdict, 'not_returned');
});

test('a row with no ASIN is unverifiable and stays hidden', () => {
  // Best Buy / Newegg-only rows. PA API has nothing to say, so they cannot
  // clear a bar defined by what PA API confirms — but they are still reported.
  const v = verdictFor(row({ asin: null, buyableRetailers: ['bestbuy'] }), null);
  assert.strictEqual(v.verdict, 'unverifiable');
  assert.match(v.reason, /no Amazon ASIN/);
});

test('every verdict is one of the documented six', () => {
  const seen = new Set([
    verdictFor(row(), newBuyBox(100)).verdict,
    verdictFor(row(), newBuyBox(200)).verdict,
    verdictFor(row(), item([{ price: { money: { amount: 100 } }, condition: { value: '' }, isBuyBoxWinner: true, availability: { type: 'Now' } }])).verdict,
    verdictFor(row(), item([{ price: { money: { amount: 100 } }, condition: { value: 'New' }, isBuyBoxWinner: true, availability: { type: 'OutOfStock' } }])).verdict,
    verdictFor(row(), null).verdict,
    verdictFor(row({ asin: null }), null).verdict,
  ]);
  assert.deepStrictEqual([...seen].sort(),
    ['bad', 'confirmed', 'not_returned', 'price_moved', 'unconfirmed', 'unverifiable']);
});

// ── the shortlist this pass is pointed at ────────────────────────────────────

test('the shortlist is the confirmed tier only', () => {
  const base = {
    c: 'CPU', b: 'AMD', needsReview: true, quarantinedAt: '2026-08-01', msrp: 200,
  };
  const deal = (conf) => ({ amazon: { price: 190, url: 'https://www.amazon.com/dp/B0F4BQJV34',
    inStock: true, priceConfirmedAt: '2026-08-24', ...(conf ? { priceConfidence: conf } : {}) } });
  const parts = [
    { id: 1, n: 'Confirmed', ...base, deals: deal('confirmed') },
    { id: 2, n: 'Unconfirmed', ...base, deals: deal('unconfirmed') },
    { id: 3, n: 'No confidence field', ...base, deals: deal(null) },
  ];
  const s = shortlist(parts, '2026-08-25');
  assert.deepStrictEqual(s.map(r => r.id), [1], 'observed is not verified');
  assert.strictEqual(s[0].amazonPrice, 190, 'carries the Amazon price for the live comparison');
  assert.strictEqual(s[0].asin, 'B0F4BQJV34');
});

// ── report-only, and a degraded run cannot pass silently ─────────────────────

test('the live pass cannot write to the catalog', () => {
  const src = readFileSync(new URL('../verify-quarantine-lift.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const writes = code.match(/writeFileSync\s*\(\s*([A-Za-z0-9_$.'"/-]+)/g) || [];
  assert.strictEqual(writes.length, 1, `expected exactly one write, found ${writes.length}`);
  assert.ok(/writeFileSync\s*\(\s*OUT\b/.test(code), 'the only write goes to the report path');
  assert.ok(!/parts\.js['"]?\s*,/.test(code.replace(/import\([^)]*\)/g, '')),
    'parts.js is never passed as a write target');
  for (const banned of ['appendFileSync', 'rmSync', 'unlinkSync', 'renameSync']) {
    assert.ok(!code.includes(banned), `no ${banned} in a report-only script`);
  }
});

test('a degraded run exits non-zero rather than publishing a confident count', () => {
  const src = readFileSync(new URL('../verify-quarantine-lift.mjs', import.meta.url), 'utf8');
  // An empty Map from a circuit-open client marks every row not_returned. That
  // must surface as a failure, not as a report that reads like a clean sweep.
  assert.match(src, /const degraded = !status\.available \|\| runAlerts\.length > 0/);
  assert.match(src, /if \(degraded\)[\s\S]{0,400}process\.exit\(1\)/);
  assert.match(src, /if \(!paapiStatus\(\)\.available\)[\s\S]{0,400}process\.exit\(1\)/,
    'and refuses to start at all when PA API is already down');
  // Alerts raised while probing say nothing about the run itself.
  assert.match(src, /const alertsBeforeRun = alerts\.length/);
});
