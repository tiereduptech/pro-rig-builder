// Buy Box price-selection gate. Pins the policy: we price ONLY from a New,
// in-stock Buy Box winner, and tag it 1p (Amazon.com-sold) or 3p (marketplace).
//
// History this locks:
//   - "unlabeled buybox counts as New" is gone (blank == UNKNOWN, never New).
//   - the `lowest_new` fallback is gone: a non-buybox 3P New *side* offer is NEVER
//     written as the price. Writing side offers put marketplace prices on ~68% of a
//     run's rows. If the Buy Box itself is not a New, in-stock offer → null →
//     caller quarantines.
//   - both 1P and 3P New buyboxes are writable; the source tag drives downstream
//     gating + disclosure, not exclusion.
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectNewOffer, isNewCondition, lowestAnyConditionPrice, normalizeOffer, sellerTier } from '../amazon-price.js';

// ── shape builders ───────────────────────────────────────────────────────────
const dfsMain = (condition, current, seller_name = 'Amazon.com') => ({
  type: 'amazon_seller_main_item', condition, price: { current }, seller_name,
});
const dfsSide = (condition, current, seller_name = 'ThirdParty') => ({
  type: 'amazon_seller_item', condition, price: { current }, seller_name,
});
const dfs = (...items) => ({ asin: 'B000000000', title: 't', items });

const paListing = (isBuyBoxWinner, value, amount, name = 'Amazon.com', availability = 'IN_STOCK') => ({
  isBuyBoxWinner, condition: { value, subCondition: 'Unknown', conditionNote: '' },
  price: { money: { amount, currency: 'USD', displayAmount: `$${amount}` } },
  merchantInfo: { id: 'X', name }, availability: { type: availability },
});
const pa = (...listings) => ({ asin: 'B000000000', offersV2: { listings } });

// ── unlabeled / non-buybox never write ───────────────────────────────────────
test('DataForSEO: unlabeled buybox is NOT treated as New → null', () => {
  assert.equal(selectNewOffer(dfs(dfsMain('', 199.99))), null);
});

test('DataForSEO: a New side offer does NOT rescue a non-New buybox (no lowest_new)', () => {
  // Previously returned the 219.99 side offer as source lowest_new. That was the bug.
  assert.equal(selectNewOffer(dfs(dfsMain('', 199.99), dfsSide('New', 219.99))), null);
  assert.equal(selectNewOffer(dfs(dfsMain('Used - Like New', 150), dfsSide('New', 205))), null);
});

// ── the 1P / 3P tag ──────────────────────────────────────────────────────────
test('DataForSEO: New buybox sold by Amazon.com → source 1p', () => {
  const r = selectNewOffer(dfs(dfsMain('New', 217.99, 'Amazon.com'), dfsSide('Used - Good', 180)));
  assert.equal(r.price, 217.99);
  assert.equal(r.source, '1p');
  assert.equal(r.seller, 'Amazon.com');
});

test('DataForSEO: New buybox won by a marketplace seller → source 3p (still written)', () => {
  const r = selectNewOffer(dfs(dfsMain('New', 599.95, 'XPC Technologies')));
  assert.equal(r.price, 599.95);
  assert.equal(r.source, '3p');
  assert.equal(r.seller, 'XPC Technologies');
});

test('DataForSEO: blank/unknown seller on a New buybox → treated as 3p (conservative)', () => {
  const r = selectNewOffer(dfs(dfsMain('New', 100, '')));
  assert.equal(r.source, '3p');
});

test('DataForSEO: no New buybox anywhere → null', () => {
  assert.equal(selectNewOffer(dfs(dfsMain('Renewed', 99), dfsSide('Open Box', 105))), null);
});

// ── PA API path (isBuyBoxWinner + availability authoritative) ─────────────────
test('PA API: New Amazon-sold buybox → 1p, cheaper Used alternate never wins', () => {
  const r = selectNewOffer(pa(
    paListing(true, 'New', 39.99, 'Amazon.com'),
    paListing(false, 'Used', 31.93, 'Amazon Resale'),
  ));
  assert.equal(r.price, 39.99);
  assert.equal(r.source, '1p');
});

test('PA API: New 3P buybox → 3p', () => {
  const r = selectNewOffer(pa(paListing(true, 'New', 629.99, 'New Sun Mart')));
  assert.equal(r.source, '3p');
  assert.equal(r.seller, 'New Sun Mart');
});

test('PA API: Used buy-box winner → null (New side offer does not rescue it)', () => {
  assert.equal(selectNewOffer(pa(paListing(true, 'Used', 109), paListing(false, 'New', 169.99))), null);
});

test('PA API: OUT_OF_STOCK New buybox → null (never price an unbuyable offer)', () => {
  assert.equal(selectNewOffer(pa(paListing(true, 'New', 5329, 'Amazon.com', 'OUT_OF_STOCK'))), null);
});

test('PA API: non-buybox New listing → null (not the buybox)', () => {
  assert.equal(selectNewOffer(pa(paListing(false, 'New', 88))), null);
});

test('PA API: bare offersV2 object with a New buybox is accepted', () => {
  const r = selectNewOffer({ listings: [paListing(true, 'New', 50, 'Amazon.com')] });
  assert.equal(r.price, 50);
  assert.equal(r.source, '1p');
});

// ── helpers ──────────────────────────────────────────────────────────────────
test('sellerTier: Amazon.com is 1p, everything else 3p', () => {
  assert.equal(sellerTier('Amazon.com'), '1p');
  assert.equal(sellerTier('amazon.com'), '1p');
  assert.equal(sellerTier('XPC Technologies'), '3p');
  assert.equal(sellerTier('Amazon Warehouse'), '3p');   // used reseller, not 1P
  assert.equal(sellerTier(''), '3p');
  assert.equal(sellerTier(null), '3p');
});

test('isNewCondition handles both shapes', () => {
  assert.equal(isNewCondition(dfsSide('New', 10)), true);
  assert.equal(isNewCondition(dfsSide('Used - Very Good', 10)), false);
  assert.equal(isNewCondition(dfsSide('', 10)), false);
  assert.equal(isNewCondition(paListing(false, 'New', 10)), true);
  assert.equal(isNewCondition(paListing(false, 'Used', 10)), false);
  assert.equal(isNewCondition(null), false);
});

test('normalizeOffer flattens both shapes + out-of-stock', () => {
  const d = normalizeOffer(dfsMain('New', 10));
  assert.equal(d.isBuyBox, true);
  assert.equal(d.explicitBuyBox, false);
  assert.equal(d.outOfStock, false);
  const p = normalizeOffer(paListing(true, 'New', 10, 'Amazon.com', 'OUT_OF_STOCK'));
  assert.equal(p.isBuyBox, true);
  assert.equal(p.explicitBuyBox, true);
  assert.equal(p.outOfStock, true);
});

test('lowestAnyConditionPrice reads both shapes', () => {
  assert.equal(lowestAnyConditionPrice(dfs(dfsMain('New', 200), dfsSide('Used - Good', 150))), 150);
  assert.equal(lowestAnyConditionPrice(pa(paListing(true, 'New', 39.99), paListing(false, 'Used', 31.93))), 31.93);
  assert.equal(lowestAnyConditionPrice(dfs()), null);
});
