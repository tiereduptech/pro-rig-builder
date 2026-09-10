// =============================================================================
//  test/link-verified-price.test.js
//
//  A human link verification vouches for WHICH listing a row points at, never
//  for what it costs. The nightly used to skip link-verified rows entirely, so a
//  person confirming "this ASIN is this product" exempted the price from ever
//  being checked again — 11 rows on 2026-09-10, 2 on the site with no confirmed
//  price at all. Same confusion as treating matchedAt as a price confirmation.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

// Importing verify-catalog-asins.js is inert (IS_MAIN guard); no creds needed here.
import { selectProducts, paapiToAmazonData } from '../verify-catalog-asins.js';
import { analyzeResult, linkVerificationCurrent } from '../drift-gate.js';

const ASIN = 'B0LINKVER1';
const row = (over = {}) => ({
  id: 70147, n: 'Corsair RM750e 750W PSU', c: 'PSU', b: 'Corsair',
  linkVerifiedAt: '2026-08-10', addedAt: '2026-05-15',
  deals: { amazon: { url: `https://www.amazon.com/dp/${ASIN}?tag=tiereduptech-20`, price: 99.99, inStock: true } },
  ...over,
});
const listing = ({ price = 99.99, cond = 'New', bb = true, avail = 'IN_STOCK' } = {}) => ({
  isBuyBoxWinner: bb, condition: { value: cond }, price: { money: { amount: price } },
  merchantInfo: { name: 'Amazon.com' }, availability: { type: avail },
});
const item = (title, listings) =>
  paapiToAmazonData({ asin: ASIN, itemInfo: { title: { displayValue: title } }, offersV2: { listings } });

// A listing title the matcher rejects for this product. A person who had the
// listing open said otherwise, which is what the marker records.
const DISAGREEING = 'CRSR 750 Watt Gold ATX Unit Black';

test('the fixture really is a matcher disagreement, and the marker really is current', () => {
  const plain = analyzeResult(row({ linkVerifiedAt: undefined }), item(DISAGREEING, [listing()]));
  assert.ok(plain.issues.some((i) => i.type === 'title_mismatch'), 'without the marker this is a title mismatch');
  assert.equal(linkVerificationCurrent(row()), true);
});

test('a current link verification trusts identity — and the price is still confirmed', () => {
  const out = analyzeResult(row(), item(DISAGREEING, [listing({ price: 94.99 })]));
  assert.ok(!out.issues.some((i) => i.type === 'title_mismatch'), 'the person overrules the matcher on identity');
  assert.ok(out.issues.some((i) => i.type === 'identity_human_verified'), 'the disagreement is recorded, not hidden');
  assert.equal(out.fixes.amazonPrice, 94.99, 'the price is read from the listing');
  assert.ok(out.fixes.priceConfirmedAt, 'and stamped confirmed, like any other row');
});

test('the marker never shields the PRICE: an ambiguous buy box stays unconfirmed', () => {
  const out = analyzeResult(row(), item(DISAGREEING, [listing({ cond: '' })]));
  assert.equal(out.fixes.priceConfidence, 'unconfirmed');
  assert.equal(out.fixes.priceConfirmedAt, undefined);
});

test('the marker never shields the PRICE: an out-of-stock buy box is still judged', () => {
  const out = analyzeResult(row(), item(DISAGREEING, [listing({ avail: 'OUT_OF_STOCK' })]));
  assert.equal(out.fixes.needsReview, true, 'a verified link with no buyable New offer is quarantined like any other');
  assert.equal(out.fixes.priceConfirmedAt, undefined);
});

test('a STALE link verification trusts nothing — the deal changed after the person looked', () => {
  const stale = row({ dealChangedAt: '2026-08-20' });
  assert.equal(linkVerificationCurrent(stale), false);
  const out = analyzeResult(stale, item(DISAGREEING, [listing()]));
  assert.ok(out.issues.some((i) => i.type === 'title_mismatch'));
  assert.equal(out.fixes.priceConfirmedAt, undefined);
});

test('a link-verified row whose title DOES match is priced exactly like an unmarked one', () => {
  const title = 'Corsair RM750e 750W 80+ Gold Fully Modular PSU';
  const marked = analyzeResult(row(), item(title, [listing()]));
  const unmarked = analyzeResult(row({ linkVerifiedAt: undefined }), item(title, [listing()]));
  assert.deepEqual(marked.fixes, unmarked.fixes);
  assert.ok(!marked.issues.some((i) => i.type === 'identity_human_verified'));
});

test('the nightly SELECTS link-verified rows — it no longer drops them', () => {
  const plain = row({ id: 1, linkVerifiedAt: undefined, deals: { amazon: { url: 'https://www.amazon.com/dp/B0PLAIN0001', price: 1 } } });
  const picked = selectProducts([row(), plain], '1').map((p) => p.id);
  assert.deepEqual(picked.sort(), [1, 70147]);
});
