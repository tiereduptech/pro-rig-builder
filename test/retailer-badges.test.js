// =============================================================================
//  test/retailer-badges.test.js
//
//  The decision half of the retailer badge cluster: WHEN a row may wear BEST,
//  and when it must wear UNCONFIRMED instead.
//
//  The other half — whether the component rendering these is reachable at all —
//  cannot be tested here. It is a property of the build, and it is the half
//  that broke: #73's badge JSX was correct and sat in a component nothing
//  rendered, so the bundle shipped without it. See
//  scripts/assert-bundle-markers.cjs and test/bundle-markers.test.js.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { showBestBadge, unconfirmedBadgeText, REQUIRED_BUNDLE_MARKERS } from '../src/retailer-badges.js';

const row = (over = {}) => ({ inStock: true, fresh: true, ageDays: 0, ...over });

test('BEST requires position, stock AND freshness', () => {
  assert.equal(showBestBadge(row(), true), true);
  assert.equal(showBestBadge(row(), false), false, 'not index 0');
  assert.equal(showBestBadge(row({ inStock: false }), true), false, 'nobody can buy it');
  assert.equal(showBestBadge(row({ fresh: false }), true), false, 'nobody has confirmed it');
});

test('a stale row at index 0 gets NO badge rather than a BEST it has not earned', () => {
  // This is the case the whole change exists for. retailers() sinks stale rows,
  // so index 0 is stale only when EVERY row is stale — and then the positional
  // badge would endorse the least trustworthy number on the card. That is how a
  // 93-day-old MSI price was shown as BEST.
  const allStale = row({ fresh: false, ageDays: 93 });
  assert.equal(showBestBadge(allStale, true), false);
  assert.equal(unconfirmedBadgeText(allStale), 'UNCONFIRMED 93d');
});

test('the badge says HOW stale when we know, and stays bare when we do not', () => {
  assert.equal(unconfirmedBadgeText(row({ fresh: false, ageDays: 93 })), 'UNCONFIRMED 93d');
  assert.equal(unconfirmedBadgeText(row({ fresh: false, ageDays: 15 })), 'UNCONFIRMED 15d');
  // No stamp at all is not a smaller problem — it is a row never confirmed even
  // once — but we cannot put a number on something we never measured.
  assert.equal(unconfirmedBadgeText(row({ fresh: false, ageDays: null })), 'UNCONFIRMED');
  assert.equal(unconfirmedBadgeText(row({ fresh: false, ageDays: undefined })), 'UNCONFIRMED');
});

test('a fresh row gets no staleness tag', () => {
  assert.equal(unconfirmedBadgeText(row()), null);
});

test('an out-of-stock row gets no staleness tag — the callers already say so', () => {
  // Both call sites print "✗ Out of Stock" beside the row. Stacking a staleness
  // tag on top buries the harder failure under the softer one.
  assert.equal(unconfirmedBadgeText(row({ inStock: false, fresh: false, ageDays: 40 })), null);
  assert.equal(unconfirmedBadgeText(row({ inStock: false, fresh: true })), null);
});

test('neither predicate throws on a missing or malformed row', () => {
  for (const bad of [null, undefined, {}]) {
    assert.doesNotThrow(() => showBestBadge(bad, true));
    assert.doesNotThrow(() => unconfirmedBadgeText(bad));
    assert.equal(showBestBadge(bad, true), false);
    assert.equal(unconfirmedBadgeText(bad), null);
  }
});

test('the bundle-marker contract is non-empty and matches what the predicates emit', () => {
  // The assertion script greps for these. If a badge is renamed without
  // updating this list, the script starts looking for a string nothing emits
  // and reports green by checking nothing.
  const markers = REQUIRED_BUNDLE_MARKERS.map(m => m.marker);
  assert.ok(markers.length > 0);
  assert.ok(markers.includes('UNCONFIRMED'), 'the staleness tag must be asserted in the bundle');
  assert.ok(markers.includes('BEST'), 'the endorsement must be asserted in the bundle');
  for (const m of REQUIRED_BUNDLE_MARKERS) {
    assert.equal(typeof m.marker, 'string');
    assert.ok(m.why && m.why.length > 10, `marker ${m.marker} needs a stated reason`);
  }
  // The UNCONFIRMED marker must actually be a substring of what the predicate
  // produces, in both its forms.
  assert.ok(unconfirmedBadgeText(row({ fresh: false, ageDays: 5 })).includes('UNCONFIRMED'));
  assert.ok(unconfirmedBadgeText(row({ fresh: false, ageDays: null })).includes('UNCONFIRMED'));
});
