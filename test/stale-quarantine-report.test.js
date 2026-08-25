/**
 * test/stale-quarantine-report.test.js
 *
 * The sweep decides which hidden rows can go back on the site. Two failure
 * modes are worth locking, because both look like success:
 *
 *   - Reading liveness in only one shape. The catalog stores retailer links as
 *     `url` on some rows and `linkurl` on others, prices as `price` and
 *     `saleprice`. A checker that reads one shape calls live rows dead and
 *     quietly shrinks the list — the same class of bug as counting coverage by
 *     a field the site cannot read.
 *
 *   - Treating "no confirmation on record" as healthy. A never-stamped row has
 *     a blank price age, not an old one, so any freshness ranking floats it to
 *     the top. Lifting unverified rows onto the site is the thing this whole
 *     effort is undoing.
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  classify, sweep, dealPrice, dealUrl, buyableDeals, asinOf, deliberateHold, implausible,
} from '../stale-quarantine-report.mjs';

const TODAY = '2026-08-25';

// A row that should come back: held for a price-shaped reason, priced sanely,
// confirmed recently, one live Amazon deal.
const healthy = (over = {}) => ({
  id: 1, n: 'Test Part', c: 'CPU', b: 'AMD', needsReview: true,
  quarantinedAt: '2026-07-22', msrp: 200,
  deals: { amazon: { price: 190, url: 'https://www.amazon.com/dp/B0F4BQJV34?tag=x', inStock: true,
                     priceConfirmedAt: '2026-08-24', priceConfidence: 'confirmed' } },
  ...over,
});

test('a healthy price-held row is liftable', () => {
  const r = classify(healthy(), TODAY);
  assert.strictEqual(r.bucket, 'liftable');
  assert.strictEqual(r.price, 190);
  assert.strictEqual(r.priceAgeDays, 1);
  assert.strictEqual(r.quarantineAgeDays, 34);
  assert.strictEqual(r.asin, 'B0F4BQJV34', 'recovers the ASIN from the /dp/ segment');
});

test('a never-stamped row is unverified, not liftable', () => {
  const p = healthy();
  delete p.deals.amazon.priceConfirmedAt;
  const r = classify(p, TODAY);
  assert.strictEqual(r.bucket, 'unverified');
  assert.strictEqual(r.priceAgeDays, null, 'blank age, which is why an age sort misses it');
});

test('a price confirmed today is still excluded when it is implausible', () => {
  // The real row: Ryzen 3 8300G, $534 against a $129 MSRP, confirmed same day.
  const r = classify(healthy({
    msrp: 129,
    deals: { amazon: { price: 534, url: 'https://www.amazon.com/dp/B0F4BQJV34', inStock: true,
                       priceConfirmedAt: TODAY, priceConfidence: 'confirmed' } },
  }), TODAY);
  assert.strictEqual(r.bucket, 'implausible');
  assert.strictEqual(r.msrpRatio, 4.14);
  assert.strictEqual(r.priceAgeDays, 0, 'freshness alone would have waved it through');
});

test('the implausible band catches both directions', () => {
  assert.ok(implausible(2), 'at 2x');
  assert.ok(implausible(0.5), 'at half');
  assert.ok(implausible(4.14));
  assert.ok(!implausible(1.9));
  assert.ok(!implausible(0.51));
  assert.ok(!implausible(null), 'no MSRP is not a verdict');
});

test('a row with no MSRP is judged on verification alone, not dropped', () => {
  const p = healthy({ msrp: undefined });
  const r = classify(p, TODAY);
  assert.strictEqual(r.bucket, 'liftable');
  assert.strictEqual(r.msrpRatio, null);
});

// ── the shape trap ───────────────────────────────────────────────────────────

test('linkurl + saleprice counts as a live deal, exactly as the site reads it', () => {
  const r = classify(healthy({
    deals: { bestbuy: { saleprice: 149.99, linkurl: 'https://bestbuy.com/site/x.p?skuId=1',
                        inStock: true, priceConfirmedAt: '2026-08-24' } },
  }), TODAY);
  assert.strictEqual(r.bucket, 'liftable', 'reading only url/price would call this dead');
  assert.strictEqual(r.price, 149.99);
  assert.deepStrictEqual(r.buyableRetailers, ['bestbuy']);
});

test('dealPrice takes the lower of price and saleprice', () => {
  assert.strictEqual(dealPrice({ price: 100, saleprice: 80 }), 80);
  // 19 catalog rows carry a saleprice ABOVE price; preferring saleprice
  // outright would overstate what the customer pays.
  assert.strictEqual(dealPrice({ price: 80, saleprice: 100 }), 80);
  assert.strictEqual(dealPrice({ price: 0, saleprice: 60 }), 60);
  assert.strictEqual(dealPrice({ price: null, saleprice: null }), null);
  assert.strictEqual(dealPrice(null), null);
});

test('dealUrl reads both link shapes', () => {
  assert.strictEqual(dealUrl({ url: 'a' }), 'a');
  assert.strictEqual(dealUrl({ linkurl: 'b' }), 'b');
  assert.strictEqual(dealUrl({}), null);
});

test('a link with no price is a dead link, not a live deal', () => {
  const r = classify(healthy({
    deals: { amazon: { url: 'https://www.amazon.com/dp/B0F4BQJV34', inStock: true } },
  }), TODAY);
  assert.strictEqual(r.bucket, 'no-deal');
  assert.deepStrictEqual(r.deadLinkRetailers, ['amazon'], 'countable — it needs a relink, not a lift');
});

test('an out-of-stock deal is not buyable', () => {
  const r = classify(healthy({
    deals: { amazon: { price: 190, url: 'https://www.amazon.com/dp/B0F4BQJV34', inStock: false,
                       priceConfirmedAt: '2026-08-24' } },
  }), TODAY);
  assert.strictEqual(r.bucket, 'no-deal');
});

test('the cheapest buyable retailer sets the price, dead ones stay listed', () => {
  const r = classify(healthy({
    deals: {
      amazon: { price: 190, url: 'https://www.amazon.com/dp/B0F4BQJV34', inStock: true,
                priceConfirmedAt: '2026-08-24', priceConfidence: 'confirmed' },
      newegg: { price: 175, saleprice: 165, url: 'https://newegg.com/x', inStock: true,
                priceConfirmedAt: '2026-08-25' },
      bestbuy: { linkurl: 'https://bestbuy.com/x', inStock: false },
    },
  }), TODAY);
  assert.strictEqual(r.price, 165);
  assert.strictEqual(r.retailer, 'newegg');
  assert.deepStrictEqual(r.buyableRetailers.sort(), ['amazon', 'newegg']);
  assert.deepStrictEqual(r.deadLinkRetailers, ['bestbuy']);
});

// ── deliberate holds outrank price health ────────────────────────────────────

test('a deliberate hold is never judged on price', () => {
  for (const [flags, reason] of [
    [['cpu_ff:server_hedt_socket'], 'out-of-scope product'],
    [['storage_price:above_ceiling(0.85$/GB)'], 'price outside category band'],
    [['relink:mismatch'], 'wrong/unconfirmed product identity'],
    [['detector:wrong-asin'], 'wrong/unconfirmed product identity'],
  ]) {
    const r = classify(healthy({ reviewFlags: flags }), TODAY);
    assert.strictEqual(r.bucket, 'held', flags[0]);
    assert.strictEqual(r.holdReason, reason, flags[0]);
  }
});

test('bundles, used and refurbished rows are held regardless of price', () => {
  assert.strictEqual(classify(healthy({ bundle: true }), TODAY).bucket, 'held');
  assert.strictEqual(classify(healthy({ used: true }), TODAY).bucket, 'held');
  assert.strictEqual(classify(healthy({ condition: 'refurbished' }), TODAY).bucket, 'held');
  // "new" is the normal condition and must not be swept up by the same check.
  assert.strictEqual(classify(healthy({ condition: 'new' }), TODAY).bucket, 'liftable');
});

test('a wrong-ASIN hold outranks a perfectly healthy price', () => {
  // The case a good price actively disguises: the number is real, it is just
  // the price of a different product.
  const r = classify(healthy({ reviewFlags: ['detector:wrong-asin'] }), TODAY);
  assert.strictEqual(r.bucket, 'held');
  assert.strictEqual(deliberateHold({ reviewFlags: ['relink:no-price'] }), null,
    'relink:no-price is price-shaped and stays a candidate');
});

// ── the sweep as a whole ─────────────────────────────────────────────────────

test('every hidden row lands in exactly one bucket and none are dropped', () => {
  const parts = [
    healthy({ id: 1 }),
    healthy({ id: 2, reviewFlags: ['cpu_ff:server_hedt_socket'] }),
    healthy({ id: 3, deals: { amazon: { url: 'https://www.amazon.com/dp/B0F4BQJV34' } } }),
    healthy({ id: 4, msrp: 10 }),
    { id: 5, n: 'Visible', c: 'CPU' },   // not quarantined — must not appear
  ];
  delete parts[0].deals.amazon.priceConfirmedAt;   // id 1 -> unverified

  const r = sweep(parts, TODAY);
  assert.strictEqual(r.totals.quarantined, 4, 'only needsReview rows are swept');
  const sum = r.totals.liftable + r.totals.unverified + r.totals.implausible +
              r.totals.noDeal + r.totals.held;
  assert.strictEqual(sum, r.totals.quarantined, 'buckets partition the population');
  assert.deepStrictEqual(
    [r.unverified[0].id, r.held[0].id, r.noDeal[0].id, r.implausible[0].id],
    [1, 2, 3, 4],
  );
});

test('excluded rows stay in the report rather than vanishing', () => {
  // A row that drops out of the report cannot be reasoned about later — the
  // same reason quarantine-skipped rows are kept in the verify-catalog report.
  const parts = [healthy({ id: 7, msrp: 10 })];
  const r = sweep(parts, TODAY);
  assert.strictEqual(r.implausible.length, 1);
  assert.strictEqual(r.implausible[0].id, 7);
  assert.ok(r.implausible[0].msrpRatio >= 2, 'and carries the number that excluded it');
});

// ── the report may never write to the catalog ────────────────────────────────

test('the sweep cannot write to the catalog', () => {
  const src = readFileSync(new URL('../stale-quarantine-report.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // One writeFileSync, and it targets the CLI's OUT path — never parts.js.
  const writes = code.match(/writeFileSync\s*\(\s*([A-Za-z0-9_$.'"/-]+)/g) || [];
  assert.strictEqual(writes.length, 1, `expected exactly one write, found ${writes.length}`);
  assert.ok(/writeFileSync\s*\(\s*OUT\b/.test(code), 'the only write goes to the report path');

  assert.ok(!/parts\.js['"]?\s*,/.test(code.replace(/import\([^)]*\)/g, '')),
    'parts.js is never passed as a write target');
  for (const banned of ['appendFileSync', 'writeFile(', 'rmSync', 'unlinkSync', 'renameSync']) {
    assert.ok(!code.includes(banned), `no ${banned} in a report-only script`);
  }
});

test('asinOf reads all three storage shapes', () => {
  assert.strictEqual(asinOf({ asin: 'B000000001' }), 'B000000001');
  assert.strictEqual(asinOf({ deals: { amazon: { asin: 'B000000002' } } }), 'B000000002');
  assert.strictEqual(asinOf({ deals: { amazon: { url: 'https://www.amazon.com/dp/B000000003?tag=x' } } }), 'B000000003');
  assert.strictEqual(asinOf({ deals: { amazon: { url: 'https://www.amazon.com/gp/product/B000000004' } } }), 'B000000004');
  assert.strictEqual(asinOf({ deals: { newegg: { url: 'https://newegg.com/x' } } }), null);
});

test('buyableDeals ignores a retailer key that is not an object', () => {
  assert.deepStrictEqual(buyableDeals({ deals: { amazon: null, newegg: 'x' } }), []);
});
