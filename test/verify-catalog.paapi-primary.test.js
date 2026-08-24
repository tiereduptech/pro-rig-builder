// Migration 3 — verify-catalog PASS 1 inverts to PA API GetItems primary, with the
// DataForSEO sellers pass kept as the residual/failover. This is the change that
// stops the recurring DataForSEO spend (verify-catalog is the only consumer on a cron).
//
// The contract these tests lock:
//   - partitionByPaapi routes a row to the FREE PA-settled bucket ONLY when PA returns
//     an item whose Buy Box classifies CONFIRMED. UNCONFIRMED / BAD / absent all route
//     to the paid DataForSEO sellers pass (PA's <=2-listing cap makes "no New offer"
//     untrustworthy; the full offer table stays the authority).
//   - A gated PA API yields an empty item map, so EVERY row falls to DataForSEO — the
//     failover is the empty-map case, not a special branch.
//   - A PA item passed as PRIMARY amazonData is tagged priceResolvedVia:'paapi' and
//     writes a confirmed price; a DataForSEO result0 (has .items) stays 'dataforseo'.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';

// Importing verify-catalog-asins.js is inert (IS_MAIN guard); no creds needed here.
import { partitionByPaapi, paapiToAmazonData } from '../verify-catalog-asins.js';
import { analyzeResult } from '../drift-gate.js';

// ── fixtures ────────────────────────────────────────────────────────────────
const productWith = (asin, name = 'Corsair RM750e 750W PSU', price = 99.99) => ({
  id: Number(asin.replace(/\D/g, '')) || 1, n: name, c: 'PSU', b: 'Corsair',
  deals: { amazon: { url: `https://www.amazon.com/dp/${asin}`, price } },
});

// PA listing/item builders (Creators-API offersV2 shape).
const paListing = ({ price = 99.99, cond = 'New', bb = true, seller = 'Amazon.com', avail = 'IN_STOCK' } = {}) => ({
  isBuyBoxWinner: bb, condition: { value: cond }, price: { money: { amount: price } },
  merchantInfo: { name: seller }, availability: { type: avail },
});
const paItem = (asin, title, listings) => ({ asin, itemInfo: { title: { displayValue: title } }, offersV2: { listings } });

const confirmedItem = (asin) => paItem(asin, 'Corsair RM750e 750W 80+ Gold Fully Modular PSU', [paListing()]);
const unlabeledItem = (asin) => paItem(asin, 'Corsair RM750e 750W PSU', [paListing({ cond: '' })]);        // blank condition -> UNCONFIRMED
const oosBadItem   = (asin) => paItem(asin, 'Corsair RM750e 750W PSU', [paListing({ avail: 'OUT_OF_STOCK' })]); // buybox OOS -> BAD

// ── partitionByPaapi ─────────────────────────────────────────────────────────
test('a PA CONFIRMED buy box settles the row for $0 (no DataForSEO)', () => {
  const products = [productWith('B00CONF001')];
  const paItems = new Map([['B00CONF001', confirmedItem('B00CONF001')]]);
  const { paSettled, needDfs } = partitionByPaapi(products, paItems);
  assert.equal(paSettled.length, 1);
  assert.equal(needDfs.length, 0);
  assert.equal(paSettled[0].asin, 'B00CONF001');
});

test('PA UNCONFIRMED (unlabeled buy box) routes to the DataForSEO sellers pass', () => {
  const products = [productWith('B00UNCF001')];
  const paItems = new Map([['B00UNCF001', unlabeledItem('B00UNCF001')]]);
  const { paSettled, needDfs } = partitionByPaapi(products, paItems);
  assert.equal(paSettled.length, 0);
  assert.equal(needDfs.length, 1);
  assert.ok(needDfs[0].paItem, 'the PA item rides along as the second opinion');
});

test('PA BAD (buy box out of stock) routes to DataForSEO — never trusted to quarantine', () => {
  const products = [productWith('B00BAD0001')];
  const paItems = new Map([['B00BAD0001', oosBadItem('B00BAD0001')]]);
  const { paSettled, needDfs } = partitionByPaapi(products, paItems);
  assert.equal(paSettled.length, 0);
  assert.equal(needDfs.length, 1);
});

test('an ASIN PA could not resolve routes to DataForSEO with a null PA item', () => {
  const products = [productWith('B00ABSENT1')];
  const paItems = new Map();   // PA returned nothing for it
  const { paSettled, needDfs } = partitionByPaapi(products, paItems);
  assert.equal(paSettled.length, 0);
  assert.equal(needDfs.length, 1);
  assert.equal(needDfs[0].paItem, null);
});

test('gated PA (empty map) sends EVERY row to DataForSEO — the failover is the empty-map case', () => {
  const products = [productWith('B00CONF001'), productWith('B00UNCF001'), productWith('B00BAD0001')];
  const { paSettled, needDfs } = partitionByPaapi(products, new Map());
  assert.equal(paSettled.length, 0);
  assert.equal(needDfs.length, 3);
});

test('mixed batch splits confirmable from unconfirmable', () => {
  const products = ['B00CONF001', 'B00UNCF001', 'B00ABSENT1'].map(a => productWith(a));
  const paItems = new Map([
    ['B00CONF001', confirmedItem('B00CONF001')],
    ['B00UNCF001', unlabeledItem('B00UNCF001')],
  ]);
  const { paSettled, needDfs } = partitionByPaapi(products, paItems);
  assert.deepEqual(paSettled.map(x => x.asin), ['B00CONF001']);
  assert.deepEqual(needDfs.map(x => x.asin), ['B00UNCF001', 'B00ABSENT1']);
});

// ── PA item as PRIMARY amazonData → provenance ───────────────────────────────
test('paapiToAmazonData + analyzeResult writes a CONFIRMED price tagged priceResolvedVia:paapi', () => {
  const product = productWith('B00CONF001');           // stored price 99.99 == PA price -> stable, still confirmed
  const out = analyzeResult(product, paapiToAmazonData(confirmedItem('B00CONF001')));
  assert.equal(out.fixes.priceConfidence, 'confirmed');
  assert.equal(out.fixes.priceResolvedVia, 'paapi', 'PA-primary write is tagged paapi provenance');
  assert.equal(out.fixes.priceSource, '1p', 'Amazon.com seller -> first-party');
  assert.ok(out.fixes.priceConfirmedAt, 'a confirmed observation stamps the staleness clock');
  assert.ok(!out.fixes.needsReview);
});

test('regression: a DataForSEO result0 (has .items) stays tagged dataforseo', () => {
  const product = productWith('B00CONF001');
  const dfs = { title: 'Corsair RM750e 750W 80+ Gold Fully Modular PSU',
    items: [{ type: 'amazon_seller_main_item', condition: 'New', price: { current: 99.99 }, seller_name: 'Amazon.com' }] };
  const out = analyzeResult(product, dfs);
  assert.equal(out.fixes.priceConfidence, 'confirmed');
  assert.equal(out.fixes.priceResolvedVia, 'dataforseo');
});
