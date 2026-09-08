// =============================================================================
//  test/newegg-identity-match.test.js
//
//  scoreMatch() decides whether a candidate IS our product from UPC, then name
//  similarity behind a variant/brand/capacity gate. That is a PROXY for
//  identity, and the right one when identity is unknown. For a row that already
//  carries a Newegg item number it is not unknown: a returned listing whose sku
//  IS that item number is our listing.
//
//  The principle is already in the codebase — applyMigrateFloor() says
//  "repricing the held SKU is exempt: identity is settled by the SKU, and a low
//  name score there only reflects a truncated catalog title" — but scoreMatch()
//  runs first and drops the candidate, so the exempt case never reaches the code
//  that would exempt it.
//
//  Run 34204759944: 294 variant_rejected + 202 guard_rejected = 496 rows where
//  the feed answered with candidates and every one was rejected. Those rows then
//  carry no refreshedAt, which is the population the freshness gate reports as
//  Newegg's stale tail.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { findHeldListing, searchNewegg } from '../newegg-match.js';

const item = (sku, over = {}) => ({
  name: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G', sku, upc: '', price: 599.99,
  saleprice: null, linkurl: 'https://newegg.com/p/1', imageurl: '', secondary: '', ...over,
});

// ── the rule itself ─────────────────────────────────────────────────────────

test('the listing whose sku IS our item number is found', () => {
  const r = findHeldListing([item('N82E16819113669'), item('N82E16819113841')], 'N82E16819113669');
  assert.equal(r.item.sku, 'N82E16819113669');
  assert.equal(r.match.method, 'itemnumber');
  assert.equal(r.match.score, 1, 'identity is not a similarity — it does not get a partial score');
});

test('a marketplace item number matches as readily as a first-party one', () => {
  // 450 of the 1,044 unreached rows are 9SI marketplace listings. Rakuten
  // deprioritises them, so they are exactly the rows the name path loses.
  const r = findHeldListing([item('9SIA2W0KMT6712')], '9SIA2W0KMT6712');
  assert.equal(r.item.sku, '9SIA2W0KMT6712');
});

test('matching is case- and whitespace-insensitive', () => {
  assert.ok(findHeldListing([item('N82E16819113669')], '  n82e16819113669 '));
});

test('no held key, no rescue', () => {
  for (const k of [null, undefined, '', '   ']) {
    assert.equal(findHeldListing([item('N82E16819113669')], k), null, JSON.stringify(k));
  }
});

test('a degenerate stored value cannot match a degenerate feed value', () => {
  // The length floor. Without it a row storing '-' would "identity match" any
  // candidate whose sku is also '-', which is a confirmation built on two
  // pieces of missing data agreeing with each other.
  assert.equal(findHeldListing([item('-')], '-'), null);
  assert.equal(findHeldListing([item('n/a')], 'n/a'), null);
  assert.equal(findHeldListing([item('1234567')], '1234567'), null, '7 chars is below the floor');
  assert.ok(findHeldListing([item('12345678')], '12345678'), '8 chars clears it');
});

test('a DIFFERENT sku is not our listing, however similar the name', () => {
  assert.equal(findHeldListing([item('N82E16819113841')], 'N82E16819113669'), null);
});

test('an item with no sku never matches', () => {
  assert.equal(findHeldListing([item(''), item(null), {}], 'N82E16819113669'), null);
});

// ── the rescue, through searchNewegg ────────────────────────────────────────

const XML = (skus) => '<?xml version="1.0"?><result>' + skus.map((s) =>
  `<item><productname>SOME OTHER BRAND Totally Different Product 4TB</productname>` +
  `<sku>${s}</sku><upccode></upccode><price>599.99</price><saleprice>0</saleprice>` +
  `<linkurl>https://newegg.com/p/${s}</linkurl><imageurl></imageurl></item>`).join('') + '</result>';

const search = (skus, heldSku) => searchNewegg(
  { c: 'CPU', n: 'AMD Ryzen 9 9950X', b: 'AMD' },
  { token: 't', mid: '1', heldSku, fetchImpl: async () => ({ ok: true, text: async () => XML(skus) }) },
);

test('THE RESCUE: every gate rejects the set, our own item number is in it', () => {
  // The candidate name shares nothing with ours, so scoreMatch rejects it — the
  // 496-row shape. The sku says it is the listing we hold.
  return search(['N82E16819113669'], 'N82E16819113669').then((r) => {
    assert.equal(r.ok, true, 'a row that reported no_match/variant_rejected now matches');
    assert.equal(r.identityRescued, true);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].item.sku, 'N82E16819113669');
    assert.equal(r.candidates[0].match.method, 'itemnumber');
  });
});

test('no hit falls through to EXACTLY the reason it returned before', () => {
  // The invariant the 2026-07-06 removals were about: this may turn "learned
  // nothing" into a match, and must never turn it into an absence.
  return search(['N82E16819999999'], 'N82E16819113669').then((r) => {
    assert.equal(r.ok, false);
    assert.ok(['no_match', 'variant_rejected', 'guard_rejected'].includes(r.reason), r.reason);
    assert.equal(r.identityRescued, undefined);
    assert.deepEqual(r.candidates, []);
  });
});

test('with no held key the result is byte-for-byte the old behaviour', () => {
  return Promise.all([search(['N82E16819113669'], null), search(['N82E16819113669'], undefined)])
    .then(([a, b]) => {
      assert.equal(a.ok, false, 'nothing to identify the row by — the proxy is all there is');
      assert.deepEqual(a.reason, b.reason);
    });
});

test('a row that ALREADY matched is not touched by any of this', () => {
  // Scoped to the empty path on purpose. Injecting the held listing on a healthy
  // row would change which candidate wins and could suppress a legitimate
  // migration onto a first-party listing — a different question, on rows that
  // work today.
  const matching = '<?xml version="1.0"?><result>' +
    `<item><productname>AMD Ryzen 9 9950X Desktop Processor</productname><sku>N82E16819113841</sku>` +
    `<upccode></upccode><price>549</price><saleprice>0</saleprice>` +
    `<linkurl>https://newegg.com/p/x</linkurl><imageurl></imageurl></item></result>`;
  return searchNewegg({ c: 'CPU', n: 'AMD Ryzen 9 9950X', b: 'AMD' },
    { token: 't', mid: '1', heldSku: 'N82E16819113669',
      fetchImpl: async () => ({ ok: true, text: async () => matching }) },
  ).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.identityRescued, undefined, 'the normal path answered — no rescue was needed');
    assert.equal(r.candidates[0].item.sku, 'N82E16819113841', 'and the normal winner still wins');
  });
});

test('an http_error is still a failed lookup, not a rescue opportunity', () => {
  // Nothing came back. There is no candidate set to find our listing in, and
  // "we could not ask" must never read as "we asked and found it".
  return searchNewegg({ c: 'CPU', n: 'AMD Ryzen 9 9950X', b: 'AMD' },
    { token: 't', mid: '1', heldSku: 'N82E16819113669',
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) },
  ).then((r) => {
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http_error');
    assert.equal(r.identityRescued, undefined);
  });
});

// ── what the re-pricer then does with it ────────────────────────────────────

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chooseCandidate, heldSku, loadMatcher } = require('../refresh-newegg-prices.cjs');
test.before(async () => { await loadMatcher(); });

const rescued = (sku) => ({ item: { sku, name: 'Truncated Catalog Title', price: 599.99 },
                            match: { method: 'itemnumber', score: 1 } });

test('a rescued candidate reprices in place — it cannot read as a downgrade', () => {
  // The guard exists to stop a first-party row being rematched onto a
  // marketplace reseller. Our own listing is the same rank as itself by
  // definition, so it must pass however the seller class reads.
  for (const sku of ['N82E16819113669', '9SIA2W0KMT6712']) {
    const p = { c: 'CPU', n: 'AMD Ryzen 9 9950X', deals: { newegg: { itemNumber: sku, price: 500 } } };
    const r = chooseCandidate(p, [rescued(sku)]);
    assert.equal(r.kind, 'reprice', sku);
    assert.equal(r.downgrade, undefined, sku);
    assert.equal(r.pick.item.sku, sku);
  }
});

test('a rescued candidate bypasses the migrate floor, as UPC identity does', () => {
  // applyMigrateFloor exempts any non-name method. A truncated catalog title is
  // why the name score was low in the first place, so re-imposing a name floor
  // here would discard the row for the exact reason it needed rescuing.
  const p = { c: 'CPU', n: 'AMD Ryzen 9 9950X',
              deals: { newegg: { itemNumber: 'N82E16819113669', price: 500 } } };
  const r = chooseCandidate(p, [rescued('N82E16819113669')]);
  assert.equal(r.weakMatch, undefined, 'not blocked as a weak match');
  assert.equal(r.pick.match.method, 'itemnumber');
});

test('heldSku is what the rescue is keyed on, and it reads itemNumber then sku', () => {
  // Measured on the live catalog 2026-09-08: heldSku() already resolves a real
  // item number for 1,043 of the 1,044 unreached rows, and the item= parameter
  // inside the stored linkurl agrees with it on every single one. No URL
  // recovery is needed, which is why none is built here.
  assert.equal(heldSku({ itemNumber: 'N82E16819113669', sku: '4458359173145680' }), 'N82E16819113669');
  assert.equal(heldSku({ sku: '9SIA2W0KMT6712' }), '9SIA2W0KMT6712');
});
