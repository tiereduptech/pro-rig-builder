// PA API second opinion inside analyzeResult, plus the staleness stamp.
//
// Two things are pinned here:
//
//  1. A DFS-unconfirmed row is upgraded to a real price when PA API returns a
//     clean New Buy Box — but a PA API "bad" is NEVER trusted, because PA API
//     caps offersV2.listings at buy box + one alternate, so "no New offer" from
//     PA API can just mean it was truncated out. DataForSEO sees the full offer
//     table and stays the authority on absence.
//
//  2. priceConfirmedAt is stamped on any confirmed, gate-passing observation —
//     NOT only when the price changed. A row confirmed nightly at a stable price
//     would otherwise look never-confirmed forever, which is precisely the hole
//     that let id=30114 sit at $1399 against a real $1799.99 with nothing firing.
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeResult } from '../drift-gate.js';

const product = (over = {}) => ({
  id: 1, c: 'GPU', n: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7',
  deals: { amazon: { price: 1399, url: 'https://www.amazon.com/dp/B0DSXJ5QF4', inStock: true } },
  ...over,
});

// DataForSEO: unlabeled buybox + a New side offer -> UNCONFIRMED
const dfsUnconfirmed = {
  asin: 'B0DSXJ5QF4', title: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7',
  items: [
    { type: 'amazon_seller_main_item', condition: '', price: { current: 1399 }, seller_name: 'Amazon.com' },
    { type: 'amazon_seller_item', condition: 'New', price: { current: 1450 }, seller_name: 'Other' },
  ],
};

const paItem = (value, amount, name = 'Amazon.com', availability = 'IN_STOCK', isBuyBoxWinner = true) => ({
  asin: 'B0DSXJ5QF4',
  itemInfo: { title: { displayValue: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7' } },
  offersV2: { listings: [{
    isBuyBoxWinner, condition: { value, subCondition: 'Unknown', conditionNote: '' },
    availability: { type: availability },
    price: { money: { amount } }, merchantInfo: { id: 'X', name },
  }] },
});

// ── baseline: no PA API data ────────────────────────────────────────────────
test('without PA API, an unconfirmed row keeps its price and is not quarantined', () => {
  const { fixes } = analyzeResult(product(), dfsUnconfirmed);
  assert.equal(fixes.priceConfidence, 'unconfirmed');
  assert.equal(fixes.amazonPrice, undefined, 'must not write a price');
  assert.ok(!fixes.needsReview, 'must not quarantine an ambiguous row');
  assert.equal(fixes.priceConfirmedAt, undefined, 'unconfirmed rows get no confirmation stamp');
});

// ── the upgrade ─────────────────────────────────────────────────────────────
test('PA API New buybox upgrades an unconfirmed row to a confirmed price', () => {
  const { fixes } = analyzeResult(product(), dfsUnconfirmed, paItem('New', 1799.99));
  assert.equal(fixes.priceConfidence, 'confirmed');
  assert.equal(fixes.amazonPrice, 1799.99);
  assert.equal(fixes.priceResolvedVia, 'paapi');
  assert.equal(fixes.priceSource, '1p');
  assert.ok(fixes.priceConfirmedAt, 'a confirmed write stamps the staleness clock');
  assert.ok(!fixes.needsReview);
});

test('the 30114 case: a 28.7% understatement is corrected, not left sitting', () => {
  const { fixes, issues } = analyzeResult(product(), dfsUnconfirmed, paItem('New', 1799.99));
  assert.equal(fixes.amazonPrice, 1799.99);
  assert.ok(issues.some(i => i.type === 'price_drift' || i.type === 'price_rise'),
    'the corrected rise should be reported, not silent');
});

// ── PA API "bad" is not authoritative ───────────────────────────────────────
test('a PA API Used buybox does NOT quarantine — the 2-offer cap makes absence unprovable', () => {
  const { fixes } = analyzeResult(product(), dfsUnconfirmed, paItem('Used', 900));
  assert.equal(fixes.priceConfidence, 'unconfirmed', 'falls back to keep-price');
  assert.ok(!fixes.needsReview, 'PA API must never be the reason a row is quarantined');
  assert.equal(fixes.amazonPrice, undefined);
});

test('a PA API out-of-stock buybox also falls back to keep-price, never quarantine', () => {
  const { fixes } = analyzeResult(product(), dfsUnconfirmed, paItem('New', 1799.99, 'Amazon.com', 'OUT_OF_STOCK'));
  assert.equal(fixes.priceConfidence, 'unconfirmed');
  assert.ok(!fixes.needsReview);
});

test('a null paapiItem is the same as not passing one', () => {
  const a = analyzeResult(product(), dfsUnconfirmed, null).fixes;
  const b = analyzeResult(product(), dfsUnconfirmed).fixes;
  assert.equal(a.priceConfidence, b.priceConfidence);
});

// ── DFS stays the authority when it can confirm ─────────────────────────────
test('when DFS already confirms, PA API is not consulted and provenance says dataforseo', () => {
  const dfsConfirmed = {
    asin: 'B0DSXJ5QF4', title: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7',
    items: [{ type: 'amazon_seller_main_item', condition: 'New', price: { current: 1450 }, seller_name: 'Amazon.com' }],
  };
  const { fixes } = analyzeResult(product(), dfsConfirmed, paItem('New', 9999));
  assert.equal(fixes.priceResolvedVia, 'dataforseo');
  assert.notEqual(fixes.amazonPrice, 9999);
});

// ── the stamping hole this closes ───────────────────────────────────────────
test('a stable price still stamps priceConfirmedAt even though nothing is written', () => {
  // Same price as stored -> sub-epsilon -> price_ok -> no amazonPrice write.
  const dfsStable = {
    asin: 'B0DSXJ5QF4', title: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7',
    items: [{ type: 'amazon_seller_main_item', condition: 'New', price: { current: 1399 }, seller_name: 'Amazon.com' }],
  };
  const { fixes } = analyzeResult(product(), dfsStable);
  assert.equal(fixes.amazonPrice, undefined, 'stable price writes nothing');
  assert.ok(fixes.priceConfirmedAt, 'but it IS a confirmation and must be stamped');
  assert.equal(fixes.priceConfidence, 'confirmed');
});

test('a quarantined row is never stamped as confirmed', () => {
  // 3P buybox that fails cross-retailer sanity -> quarantine, no stamp.
  const dfs3pGouge = {
    asin: 'B0DSXJ5QF4', title: 'NVIDIA GeForce RTX 5080 Graphic Card 16 GB GDDR7',
    items: [{ type: 'amazon_seller_main_item', condition: 'New', price: { current: 99999 }, seller_name: 'Gouger LLC' }],
  };
  const p = product({ deals: { amazon: { price: 1399, url: 'https://www.amazon.com/dp/B0DSXJ5QF4' },
                               bestbuy: { price: 1399 }, newegg: { price: 1420 } } });
  const { fixes } = analyzeResult(p, dfs3pGouge);
  assert.ok(fixes.needsReview, 'gouged 3P price must quarantine');
  assert.equal(fixes.priceConfirmedAt, undefined, 'and must NOT carry a confirmation stamp');
});
