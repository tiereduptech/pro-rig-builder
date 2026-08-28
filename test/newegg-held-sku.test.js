// The downgrade guard and the exact-match lookup must identify the listing we
// HOLD by deals.newegg.itemNumber ?? deals.newegg.sku.
//
// deals.newegg.sku holds a Rakuten affiliate link ID on 2,108 of 3,178 priced
// Newegg rows; the real item number is in itemNumber. Reading sku alone made
// sellerClass() report 'other' for a row that is really marketplace (or
// official), so the guard blocked a row's own listing as a "downgrade", and
// made the exact-match lookup compare feed item numbers against a link ID, so
// it never matched and the row could never reprice in place.
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

// refresh-newegg-prices.cjs is CommonJS; package.json is type:module.
const require = createRequire(import.meta.url);
const { heldSku, chooseCandidate, loadMatcher } = require('../refresh-newegg-prices.cjs');

test.before(async () => { await loadMatcher(); });

const LINK_ID = '445835917314568012731741'; // Rakuten link ID — classifies as 'other'
const cand = (sku, name = 'candidate', score = 1, method = 'upc') =>
  ({ item: { sku, name, price: 100 }, match: { method, score } });

test('heldSku prefers itemNumber, falls back to sku', () => {
  assert.equal(heldSku({ sku: LINK_ID, itemNumber: '9SIA8X5KW91267' }), '9SIA8X5KW91267');
  assert.equal(heldSku({ sku: 'N82E16819113842' }), 'N82E16819113842');
  assert.equal(heldSku({}), '');
  assert.equal(heldSku(null), '');
});

test('a row already on a marketplace listing reprices onto that same listing', () => {
  // The exact bug: ourSku is a link ID ('other', rank 1), the candidate is the
  // very item number the row already displays ('marketplace', rank 2), so the
  // guard read it as a rank drop and blocked. 30 of 49 blocks in run 33181385798.
  const p = { deals: { newegg: { sku: LINK_ID, itemNumber: '9SIA8X5KW91267', sellerClass: 'marketplace' } } };
  const chosen = chooseCandidate(p, [cand('9SIA8X5KW91267')]);
  assert.equal(chosen.downgrade, undefined, 'must not be blocked as a downgrade');
  assert.equal(chosen.kind, 'reprice');
  assert.equal(chosen.pick.item.sku, '9SIA8X5KW91267');
});

test('marketplace -> a different marketplace listing is rank-equal, not a downgrade', () => {
  // 10 of 49. Permitted by the guard's own rule; only the field it read was wrong.
  const p = { deals: { newegg: { sku: LINK_ID, itemNumber: '9SIA8X5KW91267', sellerClass: 'marketplace' } } };
  const chosen = chooseCandidate(p, [cand('9SIC6E1M4H7166')]);
  assert.equal(chosen.downgrade, undefined);
  assert.equal(chosen.kind, 'rematch');
});

test('official -> marketplace is STILL blocked (policy unchanged)', () => {
  // 9 of 49, whether the item number sits in sku or in itemNumber.
  for (const deal of [
    { sku: 'N82E16819113842' },
    { sku: LINK_ID, itemNumber: 'N82E16819113844' },
    { sku: '2AM-000Z-000G9' }, // dashed format is first-party too
  ]) {
    const chosen = chooseCandidate({ deals: { newegg: deal } }, [cand('9SIC3U3KN45550')]);
    assert.equal(chosen.downgrade, true, `expected a block for ${JSON.stringify(deal)}`);
    assert.equal(chosen.toClass, 'marketplace');
    assert.equal(chosen.fromClass, 'official', 'the block must report the class we actually hold');
  }
});

test('an official candidate is still preferred over the marketplace listing held', () => {
  const p = { deals: { newegg: { sku: LINK_ID, itemNumber: '9SIA8X5KW91267' } } };
  const chosen = chooseCandidate(p, [cand('9SIA8X5KW91267'), cand('N82E16819113896')]);
  assert.equal(chosen.kind, 'migrate');
  assert.equal(chosen.pick.item.sku, 'N82E16819113896');
});

test('the migrate score floor still applies to a SKU change', () => {
  const p = { deals: { newegg: { sku: LINK_ID, itemNumber: '9SIA8X5KW91267' } } };
  const chosen = chooseCandidate(p, [cand('9SIC6E1M4H7166', 'weak', 0.6, 'name')]);
  assert.equal(chosen.weakMatch, true);
});
