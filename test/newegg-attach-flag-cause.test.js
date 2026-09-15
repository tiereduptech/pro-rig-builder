// =============================================================================
//  test/newegg-attach-flag-cause.test.js
//
//  When the nightly sftp ingest refuses a Newegg price on attach, the row it
//  hides carries the cause, and a row already hidden keeps the cause it was
//  hidden for.
//
//  The site wrote `needsReview = true` and `quarantinedAt = today` straight onto
//  the row. That hid the row with no cause. On a row already hidden for
//  something else it also re-dated that hold every night the feed carried an
//  outlier, so the date said the older cause was fresh.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { NEWEGG_ATTACH_FLAGGED_REASON } from '../newegg-match.js';

const require = createRequire(import.meta.url);
const { applyMatchToPart, loadDeps } = require('../sftp-ingest.cjs');

const TODAY = new Date().toISOString().slice(0, 10);
const OFFICIAL = 'N82E16819118507R';

test('load the ESM deps applyMatchToPart reaches through', async () => {
  await loadDeps();
});

const rec = (over = {}) => ({
  product_name: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G',
  sku: 'RK-1', newegg_item_number: OFFICIAL,
  retail_price: '599.99', sale_price: '',
  product_url: 'https://newegg.com/p/1', image_url: 'https://img/1.jpg',
  availability: 'in-stock', ...over,
});

// A GPU priced at $599.99 on Amazon and on the Newegg listing we hold. The feed
// then offers the same listing at more than three times that.
const part = (over = {}) => ({
  id: 'p1', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G',
  deals: {
    amazon: { asin: 'B0TEST', price: 599.99, inStock: true },
    newegg: { itemNumber: OFFICIAL, sku: 'RK-1', price: 599.99, inStock: true, matchedAt: '2026-08-18' },
  },
  ...over,
});
const OUTLIER = rec({ retail_price: '1999.99' });
const MATCH = { method: 'upc', confidence: 0.95 };

test('a visible row refused on attach is hidden WITH its cause, and keeps its price', () => {
  const p = part();
  applyMatchToPart(p, OUTLIER, MATCH);
  assert.equal(p.needsReview, true, 'the outlier must still hide the row');
  assert.equal(p.quarantineReason, NEWEGG_ATTACH_FLAGGED_REASON);
  assert.equal(p.quarantinedAt, TODAY);
  assert.equal(p.deals.newegg.price, 599.99, 'the refused price is never written');
});

test('a row already hidden for something else keeps that cause and its date', () => {
  const p = part({ needsReview: true, quarantinedAt: '2026-09-01', quarantineReason: 'asin_repair_no_match' });
  applyMatchToPart(p, OUTLIER, MATCH);
  assert.equal(p.quarantineReason, 'asin_repair_no_match');
  assert.equal(p.quarantinedAt, '2026-09-01', 'the older hold must not be re-dated by a different cause');
  assert.deepEqual(p.quarantineAlso, [NEWEGG_ATTACH_FLAGGED_REASON]);
});

test('a row hidden with no recorded cause does not acquire this one as its cause', () => {
  const p = part({ needsReview: true, quarantinedAt: '2026-09-01' });
  applyMatchToPart(p, OUTLIER, MATCH);
  assert.equal('quarantineReason' in p, false);
  assert.equal(p.quarantinedAt, '2026-09-01');
  assert.deepEqual(p.quarantineAlso, [NEWEGG_ATTACH_FLAGGED_REASON]);
});

test('a sane price hides nothing', () => {
  const p = part();
  applyMatchToPart(p, rec({ retail_price: '609.99' }), MATCH);
  assert.equal(p.needsReview, undefined);
  assert.equal(p.deals.newegg.price, 609.99);
});
