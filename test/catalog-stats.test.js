// Catalog stats — the counts the admin dashboard's headline is built from.
//
// What these lock:
//   - the two identities the UI depends on (live+quarantined===total, and
//     withReason+withoutReason===quarantined). If either can drift, the
//     dashboard shows two numbers that disagree, which is the exact class of
//     quiet inconsistency the dashboard exists to end.
//   - reviewFlags value-stripping. "cpu_price:above_ceiling(2499$)" and
//     "cpu_price:above_ceiling(4999$)" are ONE reason, not two. Without this the
//     breakdown is a list of unique strings with count 1 — noise.
//   - unattributed rows are COUNTED, not dropped. Measured on the live catalog,
//     ~69% of quarantined rows carry no reason at all; a breakdown that silently
//     omitted them would not reconcile with the headline.
//   - history is keyed by commit, so a re-run corrects its entry rather than
//     appending a phantom zero-delta point.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeStats, reasonsFor, normalizeFlag, mergeHistory } = require('./../scripts/catalog-stats.cjs');

const row = (over = {}) => ({ id: 1, c: 'RAM', ...over });

test('normalizeFlag strips the embedded value', () => {
  assert.equal(normalizeFlag('cpu_price:above_ceiling(2499$)'), 'cpu_price:above_ceiling');
  assert.equal(normalizeFlag('storage_price:above_ceiling(521.015$/GB)'), 'storage_price:above_ceiling');
  assert.equal(normalizeFlag('relink:mismatch'), 'relink:mismatch');
});

test('two ceiling breaches at different prices are ONE reason', () => {
  const stats = computeStats([
    row({ id: 1, needsReview: true, reviewFlags: ['cpu_price:above_ceiling(2499$)'] }),
    row({ id: 2, needsReview: true, reviewFlags: ['cpu_price:above_ceiling(4999$)'] }),
  ]);
  assert.deepEqual(stats.byReason, [{ reason: 'cpu_price:above_ceiling', rows: 2 }]);
});

test('reason sources are namespaced so different gates do not merge', () => {
  // `above_ceiling` occurs BOTH as a bare priceQuarantine.reason and inside a
  // reviewFlag. Collapsing them would report two distinct gates as one bar.
  const reasons = reasonsFor({
    reviewFlags: ['cpu_price:above_ceiling(1$)'],
    priceQuarantine: { reason: 'above_ceiling' },
  });
  assert.deepEqual(reasons.sort(), ['cpu_price:above_ceiling', 'priceQuarantine:above_ceiling']);
});

test('priceQuarantineReason is accepted as a string or an object', () => {
  assert.deepEqual(reasonsFor({ priceQuarantineReason: 'corrupt_price' }), ['priceQuarantineReason:corrupt_price']);
  assert.deepEqual(reasonsFor({ priceQuarantineReason: { reason: 'corrupt_price', ratio: 8.85 } }), [
    'priceQuarantineReason:corrupt_price',
  ]);
});

test('live/quarantined use truthiness, matching the frontend filter', () => {
  // App.jsx:355 filters on `!p.needsReview`. A row carrying a non-boolean truthy
  // value is hidden from the site, so it must count as quarantined here too —
  // otherwise the dashboard claims a row is live that nobody can see.
  const stats = computeStats([
    row({ id: 1, needsReview: true }),
    row({ id: 2, needsReview: 'yes' }),
    row({ id: 3, needsReview: false }),
    row({ id: 4 }),
  ]);
  assert.equal(stats.totals.total, 4);
  assert.equal(stats.totals.quarantined, 2);
  assert.equal(stats.totals.live, 2);
});

test('unattributed quarantined rows are counted, and attribution reconciles', () => {
  const stats = computeStats([
    row({ id: 1, needsReview: true, reviewFlags: ['relink:mismatch'] }),
    row({ id: 2, needsReview: true }),
    row({ id: 3, needsReview: true, quarantinedAt: '2026-08-05' }),
    row({ id: 4 }),
  ]);
  assert.equal(stats.totals.quarantined, 3);
  assert.equal(stats.attribution.withReason, 1);
  assert.equal(stats.attribution.withoutReason, 2);
  assert.equal(stats.attribution.withReason + stats.attribution.withoutReason, stats.totals.quarantined);
});

test('a row with several flags counts once per reason but once in attribution', () => {
  // This is why per-reason rows DO NOT sum to the quarantine total, and why
  // `attribution` is the breakdown the UI reconciles against.
  const stats = computeStats([
    row({ id: 1, needsReview: true, reviewFlags: ['relink:mismatch', 'detector:wrong-asin'] }),
  ]);
  assert.equal(stats.byReason.reduce((n, r) => n + r.rows, 0), 2);
  assert.equal(stats.attribution.withReason, 1);
  assert.equal(stats.totals.quarantined, 1);
});

test('flags on a LIVE row do not appear in the quarantine breakdown', () => {
  // A row that was flagged and then cleared is not quarantined, and counting its
  // stale flag would overstate every reason.
  const stats = computeStats([row({ id: 1, needsReview: false, reviewFlags: ['relink:mismatch'] })]);
  assert.deepEqual(stats.byReason, []);
  assert.equal(stats.attribution.withReason, 0);
});

test('by-category totals sum to the catalog totals', () => {
  const stats = computeStats([
    row({ id: 1, c: 'CPU', needsReview: true }),
    row({ id: 2, c: 'CPU' }),
    row({ id: 3, c: 'GPU' }),
  ]);
  const sum = (k) => stats.byCategory.reduce((n, c) => n + c[k], 0);
  assert.equal(sum('total'), stats.totals.total);
  assert.equal(sum('live'), stats.totals.live);
  assert.equal(sum('quarantined'), stats.totals.quarantined);
});

test('mergeHistory corrects a same-commit re-run instead of appending', () => {
  const a = { at: '2026-08-16T01:00:00Z', commit: 'aaa', total: 10, live: 8, quarantined: 2 };
  const aAgain = { ...a, at: '2026-08-16T02:00:00Z', quarantined: 3, live: 7 };
  const b = { at: '2026-08-17T01:00:00Z', commit: 'bbb', total: 11, live: 9, quarantined: 2 };

  let h = mergeHistory([], a);
  h = mergeHistory(h, aAgain);
  assert.equal(h.length, 1, 're-running on the same commit must not add a point');
  assert.equal(h[0].quarantined, 3, 'the corrected value must win');

  h = mergeHistory(h, b);
  assert.equal(h.length, 2);
});

test('mergeHistory tolerates a missing or corrupt previous file', () => {
  const e = { at: 'x', commit: 'aaa', total: 1, live: 1, quarantined: 0 };
  assert.equal(mergeHistory(undefined, e).length, 1);
  assert.equal(mergeHistory(null, e).length, 1);
  assert.equal(mergeHistory('not an array', e).length, 1);
});

test('the real catalog reconciles', async () => {
  // The identities are asserted inside computeStats, so this passing means the
  // live catalog satisfies them — not merely that the fixtures do.
  const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js');
  const stats = computeStats(mod.PARTS);
  assert.ok(stats.totals.total > 0);
  assert.equal(stats.totals.live + stats.totals.quarantined, stats.totals.total);
  assert.equal(stats.attribution.withReason + stats.attribution.withoutReason, stats.totals.quarantined);
});
