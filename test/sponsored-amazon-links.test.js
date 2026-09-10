// =============================================================================
//  test/sponsored-amazon-links.test.js
//
//  verify-catalog selects a row only when its Amazon URL contains /dp/<ASIN>.
//  13 visible products carried sponsored-ad redirect links instead, with the
//  ASIN only URL-encoded inside `url=`, so the verifier never selected them and
//  nothing ever confirmed their prices. See canonicalize-sponsored-amazon-links.mjs.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTS } from '../src/data/parts.js';
import { canonicalFromSponsored, isSponsoredRedirect, SELECTABLE_ASIN } from '../canonicalize-sponsored-amazon-links.mjs';

// Shape copied from a real catalog row (#99984), spc/aref shortened.
const SPONSORED =
  'https://www.amazon.com/sspa/click?ie=UTF8&spc=MTo2MzM0MDMwNzQyNjEwMzY3OjE3NzcxMzA0MzA6c3Bf' +
  '&url=%2FLogitech-Vertical-Wireless-Mouse-Rechargeable%2Fdp%2FB07FNJB8TT%2Fref%3Dsxin_14_pa_sp_s%3Fcontent-id%3Dx' +
  '&aref=abc&tag=tiereduptech-20';

test('the raw sponsored link is NOT selectable — this is the defect', () => {
  assert.equal(SELECTABLE_ASIN.test(SPONSORED), false, 'the ASIN is only present URL-encoded');
  assert.equal(isSponsoredRedirect(SPONSORED), true);
});

test('the ASIN inside the redirect becomes a canonical, selectable link', () => {
  const c = canonicalFromSponsored(SPONSORED);
  assert.deepEqual(c, { asin: 'B07FNJB8TT', url: 'https://www.amazon.com/dp/B07FNJB8TT?tag=tiereduptech-20' });
  assert.equal(c.url.match(SELECTABLE_ASIN)[1], 'B07FNJB8TT', 'the verifier would now select it');
});

test('nothing is guessed: a redirect that names no product is refused', () => {
  const noDp = 'https://www.amazon.com/sspa/click?ie=UTF8&url=%2Fs%3Fk%3Dmouse&tag=tiereduptech-20';
  assert.equal(canonicalFromSponsored(noDp), null);
  // An ASIN-shaped run that is not a whole path segment is not an ASIN.
  const partial = 'https://www.amazon.com/sspa/click?url=%2Fx%2Fdp%2FB07FNJB8TTX&tag=t';
  assert.equal(canonicalFromSponsored(partial), null);
});

test('only Amazon sponsored redirects are touched', () => {
  assert.equal(canonicalFromSponsored('https://www.amazon.com/dp/B07FNJB8TT?tag=tiereduptech-20'), null);
  assert.equal(canonicalFromSponsored('https://evil.example/sspa/click?url=%2Fx%2Fdp%2FB07FNJB8TT'), null);
  assert.equal(canonicalFromSponsored('not a url'), null);
});

test('the live catalog: every Amazon deal link is one the verifier can select', () => {
  // The invariant the 13 rows broke. A link the verifier cannot select is a
  // price nothing will ever confirm, and until 2026-09-10 the freshness gate
  // dropped such rows too — so this is the check that fires first.
  const unselectable = PARTS
    .filter((p) => p.deals?.amazon && typeof p.deals.amazon === 'object' && p.deals.amazon.url)
    .filter((p) => !SELECTABLE_ASIN.test(p.deals.amazon.url))
    .map((p) => `#${p.id} ${String(p.deals.amazon.url).slice(0, 60)}`);
  assert.deepEqual(unselectable, [],
    `Amazon deals verify-catalog cannot select:\n  ${unselectable.join('\n  ')}`);
});
