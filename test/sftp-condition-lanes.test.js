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

// =============================================================================
//  STAMP CARRY-OVER
//
//  applyMatchToPart() assigns a freshly-built object over part.deals[fieldKey],
//  so every field it does not name is erased. For the condition lanes that is
//  harmless — this job is their only writer. For deals.newegg it destroyed the
//  re-pricer's work nightly: 1,739 refreshedAt, 102 priceLastMovedAt, 27
//  migratedAt and 27 rematchedAt gone in the single 2026-09-02 ingest
//  (6147e809174 -> 14c2aae18ba).
//
//  The inversion is what made it invisible. matchedAt IS carried, deliberately,
//  so a row kept its 15-day-old binding stamp and lost the 0-day-old
//  confirmation refresh-newegg-prices had written hours earlier — and the
//  freshness gate read a 15d median over a catalog that had measured 0d and
//  PASSED six hours before.
// =============================================================================

const { applyMatchToPart, loadDeps } = require('../sftp-ingest.cjs');

const TODAY = new Date().toISOString().slice(0, 10);

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

// A GPU: no `cap`, so the capacity guard passes, and peer-free so neweggSanity
// has nothing to contradict. Mirrors the 68 real GPU rows, all sftp-matched.
const part = (deal, over = {}) => ({
  id: 'p1', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G',
  deals: { newegg: deal }, ...over,
});

const STAMPED = {
  itemNumber: OFFICIAL, sku: 'RK-1', price: 599.99, inStock: true,
  matchedAt: '2026-08-18T14:17:46.759Z',
  refreshedAt: '2026-09-02T09:20:00.000Z',
  priceLastMovedAt: '2026-08-30',
  migratedAt: '2026-08-29T00:00:00.000Z', migratedFrom: 'OLD-SKU',
};

test('THE BUG: repricing the listing we hold does not erase refreshedAt', () => {
  const p = part({ ...STAMPED });
  assert.equal(applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 }), true);
  assert.equal(p.deals.newegg.price, 649.99, 'the reprice must still land');
  assert.equal(p.deals.newegg.refreshedAt, STAMPED.refreshedAt,
    'the re-pricer confirmed this row hours ago; this job must not delete that');
});

test('the movement history survives a reprice, and advances when the price moves', () => {
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceLastMovedAt, TODAY,
    'a real price move must advance the stamp scripts/price-movement.cjs reads');
});

test('an unchanged price CARRIES priceLastMovedAt rather than advancing it', () => {
  // The distinction the whole freeze alarm rests on: re-reading the same number
  // is not the number moving.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceLastMovedAt, '2026-08-30');
});

test('deals.newegg movement is carried too — not just the condition lanes', () => {
  // The hoist. This lane is the largest, and the only one price-movement.cjs
  // actually reports on, yet it was the one lane excluded from the carry.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.ok(p.deals.newegg.priceLastMovedAt, 'the primary lane must keep its movement history');
});

test('re-pricer provenance survives', () => {
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.migratedAt, STAMPED.migratedAt);
  assert.equal(p.deals.newegg.migratedFrom, 'OLD-SKU');
});

test('CARRIED, NEVER MINTED: this job still writes no confirmation for deals.newegg', () => {
  // The property that keeps a dead re-pricer detectable. If this job could mint
  // a stamp, refresh-newegg-prices could die and the gate would stay green.
  const p = part({ itemNumber: OFFICIAL, sku: 'RK-1', price: 599.99, inStock: true });
  applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.refreshedAt, undefined,
    'a row the re-pricer has never reached must not gain a confirmation from the ingest');
  assert.equal(p.deals.newegg.priceConfirmedAt, undefined,
    'deals.newegg is not a lane this job may certify — see CONDITION_LANES');
});

test('a DIFFERENT listing does not inherit the old one\'s confirmation', () => {
  // Carrying here would vouch for a price nothing has confirmed. Same gate, and
  // same reason, as matchedAt's.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec({ newegg_item_number: OFFICIAL2, retail_price: '449.99' }),
    { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.itemNumber, OFFICIAL2, 'the replacement must land');
  assert.equal(p.deals.newegg.refreshedAt, undefined,
    'the old refreshedAt attests to a listing this row no longer holds');
  assert.equal(p.deals.newegg.migratedAt, undefined);
});

test('the condition lanes still get their own minted confirmation', () => {
  // The asymmetry is the design: this job solely owns these, so it may certify
  // them. Guarding it here so the hoist above cannot quietly level the two.
  const p = { id: 'p2', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G', deals: {} };
  applyMatchToPart(p, rec({ product_name: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G (Open Box)' }),
    { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg_openbox.priceConfirmedAt, TODAY);
});
