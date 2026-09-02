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

// =============================================================================
//  A BREAKER THAT IS ALWAYS TRIPPED IS NOT A BREAKER
//
//  The rate ran 23.0-23.2% against a 20% threshold on every run measured
//  (33607979228, 33547739235, 33490323017, 33440406391), so the breaker tripped
//  every single time it was evaluated. It could not distinguish a sick feed from
//  a healthy one, which is the only thing it is for.
//
//  The cause was the exclusion rule being applied to ONE outcome instead of to
//  every outcome that meets it. 'variant_rejected' was subtracted because the
//  feed answered and we declined what it offered. 'guard_rejected' (208 rows)
//  and 'weak_match_blocked' (32) are the same thing — newegg-match.js says so
//  outright: "A guard reject is ALSO evidence of presence, not absence."
//
//  The threshold is untouched. Charging our own matcher's strictness to Newegg's
//  uptime is what moved the number.
// =============================================================================

test('every decision of OURS leaves the numerator, not just variant rejections', () => {
  const v = feedHealth(stats({ lookupFailed: 300, variantRejected: 100, guardRejected: 100, weakMatchBlocked: 100 }), 1000);
  assert.equal(v.feedFailures, 0, 'three classes of our own decision, zero feed failures');
  assert.equal(v.ourDecisions, 300);
  assert.equal(v.lookupable, 1000, 'all three stay in the denominator — the feed answered');
});

test('reproduces run 33607979228 and clears the breaker on consistency alone', () => {
  const r = feedHealth(stats({
    lookupFailed: 1066, variantRejected: 268, guardRejected: 208,
    weakMatchBlocked: 32, noCatMapping: 85,
  }), 3189);
  assert.equal(r.lookupable, 3104, '3189 rows less the 85 never queried');
  // no_results 318 + no_match 19 + downgrade_blocked 136
  assert.equal(r.feedFailures, 473);
  assert.ok(Math.abs(r.failureRate - 0.1524) < 0.001, `got ${r.failureRate}`);
  assert.ok(r.failureRate < 0.20, 'under the untouched 20% breaker, with headroom');
});

test('the OLD arithmetic on the same run tripped the breaker', () => {
  // Pinning what was actually wrong, so a regression reads as a regression.
  const old = (s, processed) => {
    const lookupable = processed - s.noCatMapping;
    return (s.lookupFailed - s.variantRejected - s.noCatMapping) / lookupable;
  };
  const rate = old({ lookupFailed: 1066, variantRejected: 268, noCatMapping: 85 }, 3189);
  assert.ok(Math.abs(rate - 0.2297) < 0.001, `got ${rate}`);
  assert.ok(rate > 0.20, 'this is the 23.0% that tripped on every run');
});

test('downgrade_blocked deliberately STAYS a feed failure', () => {
  // The distinction that makes the rule a rule rather than "subtract until it
  // passes": these rows are the feed failing to surface an official listing we
  // already know exists. That is the defect the breaker watches for.
  const r = feedHealth(stats({ lookupFailed: 136 }), 1000);
  assert.equal(r.feedFailures, 136, 'not excluded — nothing here subtracts it');
});

test('a genuinely sick feed still trips the breaker', () => {
  // The direction that matters. Consistency must not have bought the pass by
  // making the breaker unable to fire.
  const r = feedHealth(stats({ lookupFailed: 900, variantRejected: 50, guardRejected: 50 }), 1000);
  assert.ok(r.failureRate > 0.20, `800/1000 unanswered must still trip; got ${r.failureRate}`);
});

test('a caller predating the new counters does not silently pass the breaker', () => {
  // An absent field must read as 0, not NaN — NaN > 0.20 is false, which would
  // disable the breaker rather than trip it.
  const r = feedHealth({ lookupFailed: 500, variantRejected: 0, noCatMapping: 0 }, 1000);
  assert.equal(r.feedFailures, 500);
  assert.ok(!Number.isNaN(r.failureRate));
  assert.ok(r.failureRate > 0.20);
});
