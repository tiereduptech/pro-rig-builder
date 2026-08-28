// =============================================================================
//  test/deal-eligibility.test.js
//
//  Which savings claims the site will make, and which products may be featured
//  for making them.
//
//  The rows named below are real. They are the three the front page was showing
//  on 2026-08-28, and each is a different way for `msrp` to be wrong.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  msrpIsTrustworthy, featuredDealEligible, impliedDiscount,
  MAX_IMPLIED_DISCOUNT, MIN_CORROBORATING_RETAILERS, MIN_MATCH_SCORE,
} from '../src/deal-eligibility.js';

// A row that passes everything, to vary one field at a time against.
const ev = (over = {}) => ({
  msrp: 1999.99, pr: 1599.99, price: 1099.99,
  fresh: true, retailerCount: 2, minMatchScore: 1,
  ...over,
});

test('the thresholds are stated constants', () => {
  assert.equal(MAX_IMPLIED_DISCOUNT, 0.60);
  assert.equal(MIN_CORROBORATING_RETAILERS, 2);
  assert.equal(MIN_MATCH_SCORE, 0.9);
});

test('msrp === pr is refused — that is the ingest signature', () => {
  // Every discovery writer sets msrp from the price it just read, so on 4,342
  // of 6,937 rows the "was" price is a frozen copy of our own observation.
  assert.equal(msrpIsTrustworthy(ev({ msrp: 1206.66, pr: 1206.66, price: 399.99 })), false);
  assert.equal(msrpIsTrustworthy(ev()), true, 'an independent msrp is fine');
});

test('the ASUS case is excluded — the row the front page led with', () => {
  // id 103642: msrp === pr === 1206.66, bound to a real $399.99 Newegg listing
  // by a 0.75 fuzzy brand+name match. Two independent reasons to refuse it.
  const asus = ev({ msrp: 1206.66, pr: 1206.66, price: 399.99, minMatchScore: 0.75, retailerCount: 1 });
  assert.equal(msrpIsTrustworthy(asus), false);
  assert.equal(featuredDealEligible(asus), false);
});

test('the WD_BLACK is excluded — msrp === pr, and the gap is not credible', () => {
  // id 102524: msrp === pr === 3799.99 frozen at discovery against a real
  // $1,479.99. An 8TB SN850X has never listed near $3,800.
  const wd = ev({ msrp: 3799.99, pr: 3799.99, price: 1479.99, retailerCount: 1 });
  assert.equal(msrpIsTrustworthy(wd), false);
  // ...and it would fail the ceiling even if msrp were independent.
  assert.equal(msrpIsTrustworthy(ev({ msrp: 3799.99, pr: 3000, price: 1479.99 })), false);
});

test('the LG monitor is KEPT — a genuinely independent reference', () => {
  // id 90338: msrp 1999.99 against pr 1599.99 and a confirmed $1,099.99 at two
  // retailers. This is what the rule is supposed to let through; a filter that
  // dropped it would be broken in the other direction.
  const lg = ev();
  assert.equal(msrpIsTrustworthy(lg), true);
  assert.equal(featuredDealEligible(lg), true);
});

test('a low match score refuses the claim — the row may not be the product', () => {
  assert.equal(msrpIsTrustworthy(ev({ minMatchScore: 0.75 })), false);
  assert.equal(msrpIsTrustworthy(ev({ minMatchScore: 0.89 })), false);
  assert.equal(msrpIsTrustworthy(ev({ minMatchScore: 0.9 })), true, 'the threshold is inclusive');
  assert.equal(msrpIsTrustworthy(ev({ minMatchScore: null })), true, 'no score is not a bad score');
});

test('the ceiling refuses implausible references', () => {
  assert.equal(msrpIsTrustworthy(ev({ msrp: 1000, pr: 900, price: 400 })), true, '60% exactly');
  assert.equal(msrpIsTrustworthy(ev({ msrp: 1000, pr: 900, price: 399 })), false, 'over 60%');
});

test('featuring additionally requires a CONFIRMED price and a second retailer', () => {
  // These two are about whether the deal is worth pointing at, not whether the
  // number may be printed — so they gate featuring only.
  assert.equal(msrpIsTrustworthy(ev({ fresh: false })), true);
  assert.equal(featuredDealEligible(ev({ fresh: false })), false);

  assert.equal(msrpIsTrustworthy(ev({ retailerCount: 1 })), true);
  assert.equal(featuredDealEligible(ev({ retailerCount: 1 })), false);
  assert.equal(featuredDealEligible(ev({ retailerCount: 2 })), true);
});

test('a product that is not cheaper than its reference is not a deal', () => {
  assert.equal(impliedDiscount(ev({ price: 1999.99 })), null);
  assert.equal(impliedDiscount(ev({ price: 2500 })), null);
  assert.equal(msrpIsTrustworthy(ev({ price: 1999.99 })), false);
});

test('missing, zero and malformed values are refused, never coerced into a claim', () => {
  for (const bad of [null, undefined, {}]) {
    assert.equal(msrpIsTrustworthy(bad), false);
    assert.equal(featuredDealEligible(bad), false);
    assert.equal(impliedDiscount(bad), null);
  }
  assert.equal(msrpIsTrustworthy(ev({ msrp: null })), false);
  assert.equal(msrpIsTrustworthy(ev({ pr: null })), false);
  assert.equal(msrpIsTrustworthy(ev({ msrp: 0, pr: 5 })), false);
  assert.equal(msrpIsTrustworthy(ev({ price: 0 })), false);
  assert.equal(msrpIsTrustworthy(ev({ price: NaN })), false);
});

test('impliedDiscount is a fraction, not a percentage', () => {
  assert.equal(impliedDiscount({ msrp: 100, price: 75 }), 0.25);
  assert.equal(impliedDiscount({ msrp: 200, price: 100 }), 0.5);
});
