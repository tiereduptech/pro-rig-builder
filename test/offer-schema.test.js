// =============================================================================
//  test/offer-schema.test.js
//
//  ── THE BUG CLASS THIS FILE EXISTS FOR ──────────────────────────────────────
//  A guard that reads as applied because it cannot read the field it tests.
//  Three times this month:
//
//    the JSON-LD offer filter keyed on `d.url`, and all 3,198 deals.newegg rows
//    carry `linkurl` — so the freshness check ran on a candidate set that could
//    not contain the lane with the worst freshness in the catalog;
//
//    a coverage count read a field in a shape its filter could not parse, and
//    reported the uncovered rows as covered;
//
//    and #73's UNCONFIRMED tag went into a component nothing renders, so the
//    string was absent from the shipped bundle while present in the source.
//
//  Every one of them passed its own unit tests. They had to: a predicate tested
//  only against fixtures written beside it can confirm that it agrees with
//  itself and nothing else. What none of them had was an assertion that the
//  predicate matches SOMETHING REAL — that pointed at the live catalog, it
//  selects a non-empty set in every lane it is supposed to cover.
//
//  That is what the first two tests here do, and why they read
//  src/data/parts.js instead of a fixture. They assert shape, never counts:
//  the catalog changes several times a day (see test/search-match.test.js for
//  the same rule), so "> 0 in every lane" is the assertion and "3,198" is not.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS } from '../src/data/parts.js';
import {
  OFFER_LINK_FIELDS,
  offerLinkOf,
  dealPrice,
  offerCandidates,
  confirmedOffers,
  confirmedPrimaryOffer,
  PRIMARY_OFFER_ORDER,
} from '../src/offer-schema.js';

// Every deal in the catalog, grouped by the retailer lane it sits in.
function lanes() {
  const out = {};
  for (const p of PARTS) {
    const deals = (p && p.deals) || {};
    for (const [name, d] of Object.entries(deals)) {
      if (!d || typeof d !== 'object') continue;
      (out[name] ??= []).push(d);
    }
  }
  return out;
}

// What keys a lane's deals actually carry — so a failure says what to fix
// rather than only that something is wrong.
function keySample(deals) {
  const seen = new Set();
  for (const d of deals.slice(0, 200)) for (const k of Object.keys(d)) seen.add(k);
  return [...seen].sort().join(', ');
}

test('the offer link predicate matches something real in EVERY retailer lane', () => {
  const all = lanes();
  assert.ok(Object.keys(all).length >= 3, 'catalog should expose several retailer lanes');

  const blind = [];
  for (const [name, deals] of Object.entries(all)) {
    // Only lanes that HAVE something to publish are in scope. A lane with no
    // priced deal at all is not evidence the predicate is broken.
    const priced = deals.filter((d) => dealPrice(d) != null);
    if (!priced.length) continue;
    const matched = priced.filter((d) => offerLinkOf(d) != null);
    if (!matched.length) blind.push(`${name}: 0 of ${priced.length} priced deals have a link the predicate can read — their keys are: ${keySample(priced)}`);
  }

  assert.deepEqual(blind, [],
    'offerLinkOf() matches nothing in these lanes, so every guard downstream of it ' +
    'is running on an empty set and passing:\n  ' + blind.join('\n  ') +
    '\nIf the lane carries its link in a new field, add it to OFFER_LINK_FIELDS.');
});

test('the Newegg lane specifically is visible to the offer predicate', () => {
  // The regression. Newegg is the largest lane, the stalest, and the one the
  // filter could not see: it carries a LinkSynergy redirect in `linkurl` and
  // never populates `url`. Asserted by name rather than left to the sweep above
  // because this is the case that shipped.
  const newegg = lanes().newegg || [];
  const priced = newegg.filter((d) => dealPrice(d) != null);
  assert.ok(priced.length > 0, 'the catalog should have priced Newegg deals');

  const matched = priced.filter((d) => offerLinkOf(d) != null);
  assert.equal(matched.length, priced.length,
    `${priced.length - matched.length} of ${priced.length} priced Newegg deals carry no link ` +
    'the offer predicate can read');

  // And the reason it was invisible, stated so a future reader does not "tidy
  // up" OFFER_LINK_FIELDS back down to one entry.
  assert.ok(OFFER_LINK_FIELDS.includes('linkurl'),
    'Newegg publishes its link in linkurl; dropping it blinds the whole lane again');
});

// ── the rest is ordinary unit coverage of the rule itself ────────────────────

const DAY = 86400000;
const NOW = Date.parse('2026-09-08T12:00:00Z');
const stamp = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

const fresh = (over = {}) => ({ price: 100, url: 'https://x/1', refreshedAt: stamp(1), ...over });
const stale = (over = {}) => ({ price: 90, url: 'https://x/2', refreshedAt: stamp(60), ...over });
const never = (over = {}) => ({ price: 80, url: 'https://x/3', ...over });

test('confirmedOffers keeps the confirmed and drops the stale', () => {
  const got = confirmedOffers({ amazon: fresh(), bestbuy: stale() }, NOW);
  assert.deepEqual(got.map(([k]) => k), ['amazon']);
});

test('confirmedOffers does NOT fall back to the unconfirmed when nothing is confirmed', () => {
  // The exemption that fired exactly when the guard had something to say.
  assert.deepEqual(confirmedOffers({ newegg: stale({ linkurl: 'https://x/n', url: undefined }) }, NOW), []);
  assert.deepEqual(confirmedOffers({ amazon: never() }, NOW), []);
  assert.deepEqual(confirmedOffers({}, NOW), []);
  assert.deepEqual(confirmedOffers(null, NOW), []);
});

test('a deal with no link, or no price, is not a publishable candidate', () => {
  assert.deepEqual(offerCandidates({ amazon: { price: 10, refreshedAt: stamp(0) } }), []);
  assert.deepEqual(offerCandidates({ amazon: { url: 'https://x/1', refreshedAt: stamp(0) } }), []);
  assert.equal(offerCandidates({ amazon: fresh() }).length, 1);
});

test('matchedAt does not certify a price for publication', () => {
  // The lane gate counts matchedAt; this one must not. See
  // test/price-stamp-vocabulary.test.js for why the two lists differ.
  assert.deepEqual(confirmedOffers({ newegg: { price: 50, linkurl: 'https://x/n', matchedAt: stamp(0) } }, NOW), []);
});

test('dealPrice takes the LOWER of price and saleprice', () => {
  assert.equal(dealPrice({ price: 100, saleprice: 80 }), 80);
  assert.equal(dealPrice({ price: 100, saleprice: 120 }), 100);  // bad feed data
  assert.equal(dealPrice({ price: 100 }), 100);
  assert.equal(dealPrice({ saleprice: 70 }), 70);
  assert.equal(dealPrice({ price: 0, saleprice: 0 }), null);
  assert.equal(dealPrice(null), null);
});

test('confirmedPrimaryOffer returns null rather than falling back to a catalog price', () => {
  // The 519 products that published product.pr — a number no retailer ever
  // confirmed — as an InStock Offer. null here means the caller omits `offers`.
  assert.equal(confirmedPrimaryOffer({ amazon: stale() }, NOW), null);
  assert.equal(confirmedPrimaryOffer({}, NOW), null);
  assert.equal(confirmedPrimaryOffer(undefined, NOW), null);
});

test('confirmedPrimaryOffer skips a stale higher-precedence lane for a confirmed lower one', () => {
  const got = confirmedPrimaryOffer({ amazon: stale(), newegg: fresh({ linkurl: 'https://x/n', url: undefined }) }, NOW);
  assert.equal(got.key, 'newegg');
  assert.equal(got.url, 'https://x/n');
});

test('confirmedPrimaryOffer still prefers in-stock within the precedence', () => {
  const got = confirmedPrimaryOffer({ amazon: fresh({ inStock: false }), bestbuy: fresh() }, NOW);
  assert.equal(got.key, 'bestbuy');
});

test('every lane in PRIMARY_OFFER_ORDER still exists in the catalog', () => {
  // A precedence entry for a lane the catalog no longer has is a rule about
  // nothing, and it hides the absence of the lane it names.
  const present = new Set(Object.keys(lanes()));
  const phantom = PRIMARY_OFFER_ORDER.map(([k]) => k).filter((k) => !present.has(k));
  assert.deepEqual(phantom, [], `PRIMARY_OFFER_ORDER names lanes no deal uses: ${phantom.join(', ')}`);
});
