// =============================================================================
//  test/sftp-coverage-census.test.js
//
//  A MEASUREMENT, NOT A FIX.
//
//  979 deals.newegg rows are reached by nothing. refresh-newegg-prices searches
//  by name/UPC and cannot address the itemNumber we store, so on the same fixed
//  set every run it either declines what came back (variant_rejected 268,
//  guard_rejected 208, downgrade_blocked 136, weak_match_blocked 32) or gets
//  nothing at all (no_results 318, no_match 19). 765 of the 979 are user-visible
//  — 488 the only offer on their row, 277 the cheapest — at a median 15d and p90
//  43d since last confirmation.
//
//  The tempting next move is "let the SFTP feed confirm them: it is keyed by
//  newegg_item_number, exactly what the re-pricer cannot query". Nothing in the
//  repo can say whether that would work, because this job stamps nothing on
//  mapped newegg rows and leaves no trace of what it saw. The only coverage
//  figure that exists is the condition-lane sweep — 83 of 205 — and
//  extrapolating single-unit open-box stock to new-condition is a guess.
//
//  Guessing from an unrepresentative sample is the exact error that produced the
//  12.0% feed failure rate later remeasured at 40.5%: the arithmetic was fine,
//  the sample was not. So this counts first and decides later.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coverageCensus, laneKey } = require('../sftp-ingest.cjs');

const row = (id, deal) => ({ id, c: 'Case', n: `P${id}`, deals: { newegg: deal } });
const PRICED = { itemNumber: 'N82E1', price: 100 };
const REPRICED = { ...PRICED, refreshedAt: '2026-09-02T09:20:00.000Z' };

/** Set of lane keys, built the same way the ingest builds them. */
const offeredSet = (...parts) => new Set(parts.map((p) => laneKey(p, 'newegg')));

test('the rescuable share is the share of NEVER-repriced rows the feed offered', () => {
  // The number the whole census exists to produce.
  const a = row('a', PRICED), b = row('b', PRICED), c = row('c', PRICED);
  const census = coverageCensus([a, b, c], offeredSet(a, b));
  assert.equal(census.neverRepriced, 3);
  assert.equal(census.neverRepricedOffered, 2);
  assert.ok(Math.abs(census.rescuableShare - 2 / 3) < 1e-9);
});

test('a row the re-pricer HAS reached is not part of the rescuable question', () => {
  // It already has a confirmer. Counting it would inflate the answer with rows
  // that were never the problem — the same dilution #72 removed from feedHealth.
  const reached = row('a', REPRICED), tail = row('b', PRICED);
  const census = coverageCensus([reached, tail], offeredSet(reached, tail));
  assert.equal(census.repriced, 1);
  assert.equal(census.repricedOffered, 1);
  assert.equal(census.neverRepriced, 1);
  assert.equal(census.neverRepricedOffered, 1);
  assert.equal(census.rescuableShare, 1);
});

test('THE ANSWER THAT MEANS "BUILD THE LOOKUP": feed covers none of the tail', () => {
  const reached = row('a', REPRICED), t1 = row('b', PRICED), t2 = row('c', PRICED);
  const census = coverageCensus([reached, t1, t2], offeredSet(reached));
  assert.equal(census.rescuableShare, 0,
    'the feed carries the rows that least need it and none that do');
});

test('THE ANSWER THAT MEANS "LET THE FEED CONFIRM": feed covers all of it', () => {
  const t1 = row('a', PRICED), t2 = row('b', PRICED);
  const census = coverageCensus([t1, t2], offeredSet(t1, t2));
  assert.equal(census.rescuableShare, 1);
});

test('rows with no newegg deal are not counted at all', () => {
  const parts = [
    { id: 'x', c: 'GPU', n: 'x', deals: { amazon: { price: 1 } } },
    { id: 'y', c: 'GPU', n: 'y', deals: {} },
    { id: 'z', c: 'GPU', n: 'z' },
    row('a', PRICED),
  ];
  assert.equal(coverageCensus(parts, new Set()).rows, 1);
});

test('an empty lane reports a 0 share rather than dividing by zero', () => {
  const census = coverageCensus([], new Set());
  assert.equal(census.rows, 0);
  assert.equal(census.rescuableShare, 0);
  assert.ok(!Number.isNaN(census.rescuableShare));
});

test('the split reads refreshedAt PRESENCE, not a staleness threshold', () => {
  // Deliberate: refreshedAt advances on every successful lookup including the
  // unchanged case, and sftp-ingest carries it across rather than erasing it, so
  // its absence is a hard fact about reachability. A budget constant here would
  // transcribe the freshness gate's policy into a second place to drift.
  const ancient = row('a', { ...PRICED, refreshedAt: '2020-01-01T00:00:00.000Z' });
  const census = coverageCensus([ancient], new Set());
  assert.equal(census.repriced, 1, 'reached long ago is still reached');
  assert.equal(census.neverRepriced, 0);
});

test('READ-ONLY: the census mutates neither the parts nor the offered set', () => {
  // The property that keeps this a measurement. If it could write, it would
  // become a second confirmer for deals.newegg — the exact thing CONDITION_LANES
  // exists to prevent, arrived at by accident.
  const parts = [row('a', { ...PRICED }), row('b', { ...REPRICED })];
  const before = JSON.stringify(parts);
  const offered = offeredSet(parts[0]);
  const offeredBefore = [...offered].sort();
  coverageCensus(parts, offered);
  assert.equal(JSON.stringify(parts), before, 'no part was written to');
  assert.deepEqual([...offered].sort(), offeredBefore, 'the offered set was not mutated');
});

test('the census writes no confirmation stamp of any kind', () => {
  // Stated separately from the deep-equal above because THIS is the regression
  // that would matter: a stamp here would let a dead refresh-newegg-prices read
  // as healthy on this job's evidence.
  const parts = [row('a', { ...PRICED })];
  coverageCensus(parts, offeredSet(parts[0]));
  for (const f of ['priceConfirmedAt', 'refreshedAt', 'priceUnconfirmedAt', 'matchedAt']) {
    assert.equal(parts[0].deals.newegg[f], undefined, f);
  }
});
