// =============================================================================
//  test/sftp-condition-lanes.test.js
//
//  sftp-ingest.cjs is the ONLY writer for deals.newegg_openbox and its sibling
//  condition lanes. deals.newegg has refresh-newegg-prices.cjs to overwrite it
//  nightly; these have nothing else.
//
//  That mattered because the ingest applied a SELECTION rule ("of the listings
//  this feed carries for this product, which do we show?") across RUNS, to the
//  listing it had already stored. Yesterday's price competed with today's price
//  for the same listing and won whenever today's was higher, since
//  `newPrice < oldPrice` is the only path that displaces a same-rank in-stock
//  listing. A price RISE was never written.
//
//  Measured 2026-08-28: 180 open-box products tracked since 2026-05-30 took 10
//  price steps between them; deals.newegg took 2,095 over the same window. The
//  lane moved 5.1% where new-condition Newegg moved 27.1% — and open-box is
//  single-unit inventory that should move MORE, not less.
//
//  That is the #70 mechanism one layer down: a frozen low price is
//  disproportionately the cheapest, and the cheapest wins BEST.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sellerRank } from '../newegg-match.js';

const require = createRequire(import.meta.url);
const { chooseListing, detectCondition, CONDITION_LANES } = require('../sftp-ingest.cjs');

const OFFICIAL = 'N82E16819118507R';
const OFFICIAL2 = 'N82E16819118412R';
const MARKET = '9SIA12345678901';

const pick = (existing, incoming) => chooseListing(existing, incoming, sellerRank);

// ── the regression this file exists for ──────────────────────────────────────

test('THE BUG: the same listing at a HIGHER price is written', () => {
  const existing = { itemNumber: OFFICIAL, price: 265.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 299.99, inStock: true });
  assert.equal(r.sameListing, true);
  assert.equal(r.shouldReplace, true, 'a price rise on the listing we hold must be written');
});

test('the same listing at a LOWER price is also written', () => {
  const existing = { itemNumber: OFFICIAL, price: 299.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 265.99, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('the same listing at an UNCHANGED price still counts as a reprice', () => {
  // It must reach the write path so priceConfirmedAt advances. A row whose price
  // is genuinely stable is not the same thing as a row nobody has checked.
  const existing = { itemNumber: OFFICIAL, price: 265.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 265.99, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('identity falls back to sku when the stored row predates itemNumber', () => {
  // 46 of the 182 open-box rows were written before itemNumber was recorded and
  // carry sku only; matching on itemNumber alone would treat every one of them
  // as a competing listing forever.
  const existing = { sku: '445831605705533023021312', price: 100, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: '445831605705533023021312', price: 140, inStock: true });
  assert.equal(r.sameListing, true);
  assert.equal(r.shouldReplace, true);
});

test('two unidentifiable listings are NOT the same listing', () => {
  // Empty === empty would let any anonymous record reprice any other.
  const r = pick({ price: 100, inStock: true }, { price: 140, inStock: true });
  assert.equal(r.sameListing, false);
  assert.equal(r.shouldReplace, false, 'dearer, same rank — selection rules still apply');
});

// ── selection between DIFFERENT listings is deliberately unchanged ───────────

test('first-party beats marketplace outright, price-independent', () => {
  const r = pick({ itemNumber: MARKET, price: 100, inStock: true },
                 { itemNumber: OFFICIAL, sku: 'a', price: 180, inStock: true });
  assert.equal(r.sameListing, false);
  assert.equal(r.shouldReplace, true);
});

test('marketplace does NOT displace first-party even when cheaper', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: MARKET, sku: 'b', price: 100, inStock: true });
  assert.equal(r.shouldReplace, false);
});

test('within a tier, a cheaper competing listing wins', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'c', price: 150, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('within a tier, a DEARER competing listing does not', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 150, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'd', price: 180, inStock: true });
  assert.equal(r.shouldReplace, false);
});

test('an in-stock competitor displaces an out-of-stock incumbent', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 100, inStock: false },
                 { itemNumber: OFFICIAL2, sku: 'e', price: 180, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('an out-of-stock competitor never displaces an in-stock incumbent', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'f', price: 100, inStock: false });
  assert.equal(r.shouldReplace, false);
});

test('no existing listing means take it', () => {
  const r = pick(undefined, { itemNumber: OFFICIAL, sku: 'g', price: 100, inStock: true });
  assert.deepEqual(r, { shouldReplace: true, sameListing: false });
});

test('saleprice is what competes, not list price', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 400, saleprice: 200, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'h', price: 300, saleprice: 150, inStock: true });
  assert.equal(r.shouldReplace, true);
});

// ── which lanes this job is allowed to certify ──────────────────────────────

test('deals.newegg is NOT a condition lane — one job must not certify another', () => {
  // sftp-ingest contacts the feed for deals.newegg too, so stamping it would be
  // defensible in isolation. It is excluded on purpose: refresh-newegg-prices.cjs
  // owns that lane, and a second stamper would let it die while the freshness
  // gate stayed green on this job's evidence.
  assert.ok(!CONDITION_LANES.includes('newegg'));
});

test('the lanes this job solely owns are the ones it may confirm', () => {
  assert.deepEqual(CONDITION_LANES, ['newegg_openbox', 'newegg_refurb', 'newegg_used']);
});

test('condition detection maps feed names onto those lane keys', () => {
  for (const [name, cond] of [
    ['ASUS PRIME B650 (Open Box)', 'openbox'],
    ['ASUS PRIME B650 OPEN-BOX', 'openbox'],
    ['Corsair RM850x Refurbished', 'refurb'],
    ['Corsair RM850x Renewed', 'refurb'],
    ['Seagate 2TB Used', 'used'],
    ['ASUS PRIME B650-PLUS', 'new'],
  ]) {
    assert.equal(detectCondition(name), cond, name);
    const lane = cond === 'new' ? 'newegg' : 'newegg_' + cond;
    if (cond !== 'new') assert.ok(CONDITION_LANES.includes(lane), lane);
  }
});
