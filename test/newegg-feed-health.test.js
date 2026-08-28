// =============================================================================
//  test/newegg-feed-health.test.js
//
//  The breaker's arithmetic. It decides whether removals may run at all, and
//  until now it was computed inline where nothing could assert on it.
//
//  'no_cat_mapping' means CAT_FILTER has no entry for the row's category, so
//  searchNewegg returns before issuing a single request. We never asked Newegg
//  anything — and a question never asked is not evidence about the answer.
//  Counting those rows as feed failures charged our own coverage gap to
//  Newegg's uptime.
//
//  Run 33189471054: 83 such rows, 66 of them GPU, and GPU is absent from
//  CAT_FILTER deliberately (Rakuten Product Search does not carry GPUs).
//
//  The asymmetry with 'variant_rejected' is the substance of these tests.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { feedHealth } = require('../refresh-newegg-prices.cjs');

const stats = (o = {}) => ({ lookupFailed: 0, variantRejected: 0, noCatMapping: 0, ...o });

test('unmappable rows leave BOTH sides; variant rejections leave only the numerator', () => {
  // A row the feed answered is evidence the feed is alive: numerator only.
  const v = feedHealth(stats({ lookupFailed: 100, variantRejected: 100 }), 1000);
  assert.equal(v.feedFailures, 0);
  assert.equal(v.lookupable, 1000, 'variant rejections stay in the denominator');

  // A row we never asked about is not evidence either way: both sides.
  const n = feedHealth(stats({ lookupFailed: 100, noCatMapping: 100 }), 1000);
  assert.equal(n.feedFailures, 0);
  assert.equal(n.lookupable, 900, 'unmappable rows leave the denominator too');
});

test('reproduces run 33189471054 and shows what each fix is worth', () => {
  const processed = 3178;
  const asRun = stats({ lookupFailed: 1260, variantRejected: 223, noCatMapping: 83 });

  // What the run actually reported: unmappable rows counted as feed failures.
  const before = (1260 - 223) / 3178;
  assert.equal((before * 100).toFixed(1), '32.6', 'the rate the run printed');

  const after = feedHealth(asRun, processed);
  assert.equal(after.feedFailures, 954);
  assert.equal(after.lookupable, 3095);
  assert.equal((after.failureRate * 100).toFixed(1), '30.8');

  // Still over the 20% breaker on its own — this fix is an accuracy fix, not a
  // way under the threshold, and must not be sold as one.
  assert.ok(after.failureRate > 0.20, 'excluding unmappable rows alone does NOT clear the breaker');

  // With the pacing fix removing the 362 self-inflicted http_errors as well.
  const paced = feedHealth(stats({ lookupFailed: 1260 - 362, variantRejected: 223, noCatMapping: 83 }), processed);
  assert.equal(paced.feedFailures, 592);
  assert.equal((paced.failureRate * 100).toFixed(1), '19.1');
  assert.ok(paced.failureRate < 0.20, 'both fixes together clear it');
});

test('a catalog of nothing but unmappable rows reports 0%, not NaN or 100%', () => {
  const h = feedHealth(stats({ lookupFailed: 50, noCatMapping: 50 }), 50);
  assert.equal(h.lookupable, 0);
  assert.equal(h.failureRate, 0, 'no lookupable rows means no evidence, not total failure');
  assert.ok(Number.isFinite(h.failureRate));
});

test('downgrade_blocked and weak_match_blocked deliberately stay in', () => {
  // Both are counted in lookupFailed and subtracted by neither term: the feed
  // failed to surface a listing we know exists, which is the defect watched for.
  const h = feedHealth(stats({ lookupFailed: 129 }), 1000);
  assert.equal(h.feedFailures, 129);
  assert.equal(h.lookupable, 1000);
});

test('a clean run is 0% and an all-failed run is 100%', () => {
  assert.equal(feedHealth(stats(), 1000).failureRate, 0);
  assert.equal(feedHealth(stats({ lookupFailed: 1000 }), 1000).failureRate, 1);
});

// ── The safety question this change raises ──────────────────────────────────
// Relaxing the breaker's numerator is what lets removals run. So: can a row we
// never queried end up deleted by the path this change unblocks?
//
// No, and structurally rather than by luck. Absence is only ever concluded from
// reason 'no_match' WITH a healthy candidate set — the feed answered, offered
// real products, and ours was not among them. 'no_cat_mapping' can satisfy
// neither half, so it takes the LOOKUP_FAILED branch, which touches nothing:
// not the price, not staleSince, not absentStreak. Without a streak a row can
// never become a removal candidate.
test('an unmappable row can never satisfy the absence condition', async () => {
  const { searchNewegg } = await import('../newegg-match.js');
  const MIN_HEALTHY_CANDIDATES = 3;  // mirrors the refresher's threshold

  const r = await searchNewegg({ n: 'ASUS TUF RTX 5080 OC', b: 'ASUS', c: 'GPU' }, {
    token: 't', mid: '1',
    fetchImpl: async () => { throw new Error('must not be queried'); },
  });

  assert.equal(r.reason, 'no_cat_mapping');
  assert.equal(r.ok, false);
  assert.equal(r.rawCount, 0);
  assert.ok(!(r.reason === 'no_match' && r.rawCount >= MIN_HEALTHY_CANDIDATES),
    'no_cat_mapping must never read as confirmed absence');
});
