// The three-way Buy Box verdict: AMBIGUOUS IS NOT WRONG.
//
// Buy-Box-only pricing is correct, but a two-way confirmed/null split punished
// every listing the DataForSEO feed simply cannot confirm — measured at ~655
// tier-1 rows that would have had a good price blanked and been quarantined.
// The feed has no isBuyBoxWinner field and often returns a blank condition on
// the featured offer, so "cannot confirm" is the feed's limitation, not evidence
// the row is wrong.
//
//   confirmed   -> write the price
//   unconfirmed -> KEEP the stored price, tag it, do NOT quarantine
//   bad         -> quarantine (out of stock, or nothing New offered at all)
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyBuyBox, BUYBOX_STATE } from '../amazon-price.js';

const dfsMain = (condition, current, seller_name = 'Amazon.com') => ({
  type: 'amazon_seller_main_item', condition, price: { current }, seller_name,
});
const dfsSide = (condition, current, seller_name = 'ThirdParty') => ({
  type: 'amazon_seller_item', condition, price: { current }, seller_name,
});
const dfs = (...items) => ({ asin: 'B000000000', title: 't', items });

const paListing = (isBuyBoxWinner, value, amount, name = 'Amazon.com', availability = 'IN_STOCK') => ({
  isBuyBoxWinner, condition: { value, subCondition: 'Unknown', conditionNote: '' },
  price: { money: { amount } }, merchantInfo: { id: 'X', name },
  availability: { type: availability },
});
const pa = (...listings) => ({ asin: 'B000000000', offersV2: { listings } });

// ── confirmed ────────────────────────────────────────────────────────────────
test('New in-stock buybox -> confirmed, offer carries the 1p/3p tag', () => {
  const v = classifyBuyBox(dfs(dfsMain('New', 217.99)));
  assert.equal(v.state, BUYBOX_STATE.CONFIRMED);
  assert.equal(v.offer.price, 217.99);
  assert.equal(v.offer.source, '1p');
});

test('New 3P buybox -> confirmed, tagged 3p', () => {
  const v = classifyBuyBox(pa(paListing(true, 'New', 629.99, 'New Sun Mart')));
  assert.equal(v.state, BUYBOX_STATE.CONFIRMED);
  assert.equal(v.offer.source, '3p');
});

// ── unconfirmed: KEEP THE PRICE ──────────────────────────────────────────────
test('unlabeled buybox -> unconfirmed, NOT bad (this is the ~655-row population)', () => {
  const v = classifyBuyBox(dfs(dfsMain('', 199.99)));
  assert.equal(v.state, BUYBOX_STATE.UNCONFIRMED);
  assert.equal(v.reason, 'unlabeled_buybox');
});

test('used buybox but a New offer exists elsewhere -> unconfirmed, not quarantined', () => {
  // The listing still sells a real New product; we just cannot confirm the
  // buybox price. Blanking this row would be wrong.
  const v = classifyBuyBox(dfs(dfsMain('Used - Like New', 150), dfsSide('New', 205)));
  assert.equal(v.state, BUYBOX_STATE.UNCONFIRMED);
  assert.equal(v.reason, 'buybox_not_new_but_new_offer_exists');
});

test('no buybox at all but a New side offer exists -> unconfirmed', () => {
  const v = classifyBuyBox(dfs(dfsSide('New', 205)));
  assert.equal(v.state, BUYBOX_STATE.UNCONFIRMED);
  assert.equal(v.reason, 'no_buybox_but_new_offer_exists');
});

test('unconfirmed never carries an offer to write', () => {
  assert.equal(classifyBuyBox(dfs(dfsMain('', 199.99))).offer, undefined);
});

// ── bad: quarantine ──────────────────────────────────────────────────────────
test('out-of-stock buybox -> bad, even when New', () => {
  const v = classifyBuyBox(pa(paListing(true, 'New', 5329, 'Amazon.com', 'OUT_OF_STOCK')));
  assert.equal(v.state, BUYBOX_STATE.BAD);
  assert.equal(v.reason, 'buybox_out_of_stock');
});

test('used buybox with NOTHING New anywhere -> bad (pre-existing no_new_offer)', () => {
  const v = classifyBuyBox(dfs(dfsMain('Renewed', 99), dfsSide('Open Box', 105)));
  assert.equal(v.state, BUYBOX_STATE.BAD);
  assert.equal(v.reason, 'buybox_not_new_no_new_offer');
});

test('no offers at all -> bad', () => {
  const v = classifyBuyBox(dfs());
  assert.equal(v.state, BUYBOX_STATE.BAD);
  assert.equal(v.reason, 'no_buybox_no_new_offer');
});

// ── the distinction that matters ─────────────────────────────────────────────
test('a Used buybox is bad ONLY when no New offer exists', () => {
  const withNew = classifyBuyBox(dfs(dfsMain('Used - Good', 100), dfsSide('New', 150)));
  const without = classifyBuyBox(dfs(dfsMain('Used - Good', 100)));
  assert.equal(withNew.state, BUYBOX_STATE.UNCONFIRMED);
  assert.equal(without.state, BUYBOX_STATE.BAD);
});
