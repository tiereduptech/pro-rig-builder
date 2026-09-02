// =============================================================================
//  test/sftp-stamp-integrity.test.js
//
//  THE CENSUS'S OTHER PREMISE.
//
//  coverageCensus() splits deals.newegg on whether a row carries refreshedAt and
//  reads absence as "refresh-newegg-prices has never reached this row". That
//  reading is only sound while every stamp the re-pricer wrote is still on the
//  row it wrote it to — and this ingest is the only thing in the repo that can
//  destroy one, because applyMatchToPart assigns a freshly built listing over
//  part.deals[fieldKey] wholesale.
//
//  It has already happened: the 2026-09-02 ingest took refreshedAt from 2125 to
//  386 in one run. #81 stopped it recurring and restored nothing, and a deleted
//  stamp is indistinguishable from one that was never written. The census would
//  have reported ~2,803 never-repriced rows where ~1,064 belonged.
//
//  THE ERROR IS NOT SYMMETRIC. feedOffered.add() and the wholesale assignment
//  live on the same path, so a row that loses a stamp is necessarily a row the
//  feed offered: erased rows enter both halves of rescuableShare at ~100%
//  coverage and drag it up. A true 40% reads as ~77% — "the feed covers the
//  tail, do the cheap fix". The guard therefore withholds the share rather than
//  discounting it, because a number wrong in a known direction is worse than
//  none.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countRefreshStamps, stampIntegrity } = require('../sftp-ingest.cjs');

const PRICED = () => ({ itemNumber: 'N82E1', price: 100 });
const REPRICED = () => ({ ...PRICED(), refreshedAt: '2026-09-02T09:20:00.000Z' });
const row = (id, deal) => ({ id, c: 'Case', n: `P${id}`, deals: { newegg: deal } });

// A catalog whose stamps are intact: comfortably above the plausibility floor.
const healthy = { before: 2102, after: 2102, stamped: 2102, reachable: 3104 };

test('countRefreshStamps counts only deals.newegg rows carrying refreshedAt', () => {
  const parts = [row('a', REPRICED()), row('b', PRICED()), row('c', REPRICED())];
  assert.equal(countRefreshStamps(parts), 2);
});

test('countRefreshStamps ignores rows with no newegg deal at all', () => {
  const parts = [row('a', REPRICED()), { id: 'b', c: 'Case', deals: {} }, { id: 'c', c: 'Case' }];
  assert.equal(countRefreshStamps(parts), 1);
});

test('an intact catalog publishes: no loss, share well above the floor', () => {
  const v = stampIntegrity(healthy);
  assert.equal(v.intact, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.lostThisRun, 0);
});

test('THE #81 REGRESSION: unexplained in-run loss voids the census', () => {
  // The exact shape of the 2026-09-02 erasure, one run: 2125 -> 386, with no
  // listing swaps to account for any of it.
  const v = stampIntegrity({ before: 2125, after: 386, stamped: 386, reachable: 3104 });
  assert.equal(v.intact, false);
  assert.equal(v.lostThisRun, 1739);
  assert.equal(v.unexplainedLoss, 1739);
  assert.match(v.reasons.join(' '), /the #81 carry is not holding/);
});

test('ONE unexplained stamp is enough — no tolerable amount of unaccounted erasure', () => {
  // Deliberately not a threshold. A stamp that vanished with no swap behind it
  // is a bug by definition, and the row it left behind skews the share upward.
  const v = stampIntegrity({
    before: 2103, after: 2102, stamped: 2102, reachable: 3104, droppedOnReplacement: 0,
  });
  assert.equal(v.intact, false);
  assert.equal(v.unexplainedLoss, 1);
});

test('A HEALTHY NIGHT STILL PUBLISHES: swaps explain the loss exactly', () => {
  // The failure this guard nearly shipped with. A genuine listing swap drops
  // refreshedAt by design, so loss is NORMAL — and "any loss voids" would have
  // withheld the number every single night, which is the same outcome as not
  // having built the census at all.
  const v = stampIntegrity({
    before: 2102, after: 2085, stamped: 2085, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.lostThisRun, 17);
  assert.equal(v.unexplainedLoss, 0);
  assert.equal(v.intact, true);
});

test('swaps explain SOME of it — the remainder still voids', () => {
  const v = stampIntegrity({
    before: 2102, after: 1500, stamped: 1500, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.unexplainedLoss, 585);
  assert.equal(v.intact, false);
});

test('the by-design drop count is carried out for disclosure', () => {
  // Those rows WERE reached by the re-pricer and are counted as never-repriced
  // anyway, so the share is overstated by exactly this many. Stated, not hidden.
  const v = stampIntegrity({
    before: 2102, after: 2085, stamped: 2085, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.droppedOnReplacement, 17);
});

test('THE UNHEALED TREE: no loss this run, but no re-pricer run represented', () => {
  // What the catalog looked like the morning after #81 merged — the ingest is
  // now well-behaved and destroys nothing, yet 1,739 stamps are still gone.
  // Check (1) sees a clean run; only check (2) catches this.
  const v = stampIntegrity({ before: 386, after: 386, stamped: 386, reachable: 3104 });
  assert.equal(v.lostThisRun, 0, 'this run really did destroy nothing');
  assert.equal(v.intact, false, 'but the evidence is still missing');
  assert.match(v.reasons.join(' '), /no completed re-pricer run is represented/);
});

test('the floor is a collapse detector, not a staleness policy', () => {
  // A merely mediocre night — the re-pricer reached fewer rows than usual —
  // must still publish. The guard fires on evidence that is GONE, and holds no
  // opinion about how old a stamp is or how many rows are due a refresh.
  const v = stampIntegrity({ before: 1200, after: 1200, stamped: 1200, reachable: 3104 });
  assert.equal(v.intact, true, '38.7% is thin but is a real re-pricer run');
});

test('unreachable rows are not in the denominator', () => {
  // The 85 rows with no CAT_FILTER entry (#84) can never carry a re-pricer
  // stamp, so counting them as missing evidence would make a healthy catalog
  // look damaged. `reachable` is derived from CAT_FILTER for exactly this.
  const withUnreachable = stampIntegrity({ ...healthy, reachable: 3189 });
  assert.equal(withUnreachable.intact, true);
});

test('an empty lane does not divide by zero and does not cry damage', () => {
  const v = stampIntegrity({ before: 0, after: 0, stamped: 0, reachable: 0 });
  assert.equal(v.stampedShare, 0);
  assert.equal(v.intact, true, 'no reachable rows is not evidence of erasure');
});

test('both failures can fire at once and both are reported', () => {
  const v = stampIntegrity({ before: 2125, after: 300, stamped: 300, reachable: 3104 });
  assert.equal(v.intact, false);
  assert.equal(v.reasons.length, 2);
});

test('the verdict carries the numbers a human needs to act on it', () => {
  const v = stampIntegrity({ before: 2125, after: 386, stamped: 386, reachable: 3104 });
  assert.equal(v.stamped, 386);
  assert.equal(v.reachable, 3104);
  assert.ok(Math.abs(v.stampedShare - 386 / 3104) < 1e-9);
});
