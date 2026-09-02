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
const { countRepricerStamps, stampIntegrity, loadNeweggReach, stampedShareFloor } =
  require('../sftp-ingest.cjs');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A reach file on disk, so the derivation is exercised through the same read
// the ingest performs rather than through an injected object.
function reachFile(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-')), 'newegg-reach.json');
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
}

const PRICED = () => ({ itemNumber: 'N82E1', price: 100 });
const REPRICED = () => ({ ...PRICED(), refreshedAt: '2026-09-02T09:20:00.000Z' });
const MOVED = () => ({ ...PRICED(), priceLastMovedAt: '2026-09-02' });
const BOTH = () => ({ ...REPRICED(), priceLastMovedAt: '2026-09-02' });
const row = (id, deal) => ({ id, c: 'Case', n: `P${id}`, deals: { newegg: deal } });

// A stamp tally in the shape countRepricerStamps() hands back. The movement
// count defaults to a value that holds steady across before/after, so a case
// written about refreshedAt does not accidentally assert something about the
// other stamp — every priceLastMovedAt claim below is made deliberately.
const tally = (refreshedAt, priceLastMovedAt = 281) => ({ refreshedAt, priceLastMovedAt });

// A catalog whose stamps are intact: comfortably above the plausibility floor.
const healthy = { before: tally(2102), after: tally(2102), stamped: 2102, reachable: 3104 };

test('countRepricerStamps tallies refreshedAt and priceLastMovedAt separately', () => {
  const parts = [row('a', BOTH()), row('b', PRICED()), row('c', REPRICED()), row('d', MOVED())];
  assert.deepEqual(countRepricerStamps(parts), { refreshedAt: 2, priceLastMovedAt: 2 });
});

test('countRepricerStamps does not conflate the two stamps into one number', () => {
  // The bug this shape exists to prevent. A single total would read 2 here and
  // 2 for a catalog with two refreshedAt and no movement history at all, so a
  // run that ate every priceLastMovedAt while writing one refreshedAt would
  // balance to zero net loss and pass.
  const parts = [row('a', REPRICED()), row('b', MOVED())];
  assert.deepEqual(countRepricerStamps(parts), { refreshedAt: 1, priceLastMovedAt: 1 });
});

test('countRepricerStamps ignores rows with no newegg deal at all', () => {
  const parts = [row('a', BOTH()), { id: 'b', c: 'Case', deals: {} }, { id: 'c', c: 'Case' }];
  assert.deepEqual(countRepricerStamps(parts), { refreshedAt: 1, priceLastMovedAt: 1 });
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
  const v = stampIntegrity({ before: tally(2125), after: tally(386), stamped: 386, reachable: 3104 });
  assert.equal(v.intact, false);
  assert.equal(v.lostThisRun, 1739);
  assert.equal(v.unexplainedLoss, 1739);
  assert.match(v.reasons.join(' '), /the #81 carry is not holding/);
});

test('ONE unexplained stamp is enough — no tolerable amount of unaccounted erasure', () => {
  // Deliberately not a threshold. A stamp that vanished with no swap behind it
  // is a bug by definition, and the row it left behind skews the share upward.
  const v = stampIntegrity({
    before: tally(2103), after: tally(2102), stamped: 2102, reachable: 3104, droppedOnReplacement: 0,
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
    before: tally(2102), after: tally(2085), stamped: 2085, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.lostThisRun, 17);
  assert.equal(v.unexplainedLoss, 0);
  assert.equal(v.intact, true);
});

test('swaps explain SOME of it — the remainder still voids', () => {
  const v = stampIntegrity({
    before: tally(2102), after: tally(1500), stamped: 1500, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.unexplainedLoss, 585);
  assert.equal(v.intact, false);
});

test('the by-design drop count is carried out for disclosure', () => {
  // Those rows WERE reached by the re-pricer and are counted as never-repriced
  // anyway, so the share is overstated by exactly this many. Stated, not hidden.
  const v = stampIntegrity({
    before: tally(2102), after: tally(2085), stamped: 2085, reachable: 3104, droppedOnReplacement: 17,
  });
  assert.equal(v.droppedOnReplacement, 17);
});

test('THE UNHEALED TREE: no loss this run, but no re-pricer run represented', () => {
  // What the catalog looked like the morning after #81 merged — the ingest is
  // now well-behaved and destroys nothing, yet 1,739 stamps are still gone.
  // Check (1) sees a clean run; only check (2) catches this.
  const v = stampIntegrity({ before: tally(386), after: tally(386), stamped: 386, reachable: 3104 });
  assert.equal(v.lostThisRun, 0, 'this run really did destroy nothing');
  assert.equal(v.intact, false, 'but the evidence is still missing');
  assert.match(v.reasons.join(' '), /no completed re-pricer run is represented/);
});

test('the floor is a collapse detector, not a staleness policy', () => {
  // A merely mediocre night — the re-pricer reached fewer rows than usual —
  // must still publish. The guard fires on evidence that is GONE, and holds no
  // opinion about how old a stamp is or how many rows are due a refresh.
  const v = stampIntegrity({ before: tally(1200), after: tally(1200), stamped: 1200, reachable: 3104 });
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
  const v = stampIntegrity({ before: tally(0, 0), after: tally(0, 0), stamped: 0, reachable: 0 });
  assert.equal(v.stampedShare, 0);
  assert.equal(v.intact, true, 'no reachable rows is not evidence of erasure');
});

test('both failures can fire at once and both are reported', () => {
  const v = stampIntegrity({ before: tally(2125), after: tally(300), stamped: 300, reachable: 3104 });
  assert.equal(v.intact, false);
  assert.equal(v.reasons.length, 2);
});

// ── THE STAMP THE GUARD USED TO MISS ─────────────────────────────────────────
//
// #81 restored two carries and armed a regression guard over one of them. These
// cover the other. The measured shape is the 2026-09-02 ingest, where
// deals.newegg went 315 -> 202 priceLastMovedAt (-113) in the same run that took
// refreshedAt 2125 -> 386 — and where the loss surfaced not here but in
// refresh-newegg-prices' movement report, ten days later, as movedShare 0.0881
// against a 0.1 floor with Newegg's name on it.

test('THE MISATTRIBUTION: priceLastMovedAt erasure is caught here, not by the freeze alarm', () => {
  const v = stampIntegrity({
    before: tally(2125, 315), after: tally(2125, 202), stamped: 2125, reachable: 3104,
  });
  assert.equal(v.intact, false);
  assert.equal(v.movedLostThisRun, 113);
  assert.equal(v.lostThisRun, 0, 'refreshedAt was untouched — the old guard saw nothing');
  assert.match(v.reasons.join(' '), /destroyed 113 priceLastMovedAt/);
});

test('the reason names the alarm that would otherwise blame the retailer', () => {
  // The point of the wording. A run that reads this must not go looking at
  // Newegg's feed, which is where the last two days went.
  const v = stampIntegrity({
    before: tally(2125, 315), after: tally(2125, 202), stamped: 2125, reachable: 3104,
  });
  const why = v.reasons.join(' ');
  assert.match(why, /price-movement/);
  assert.match(why, /numerator/);
});

test('ONE lost movement stamp is enough — there is no by-design drop to net off', () => {
  // Deliberately asymmetric with refreshedAt. droppedOnReplacement exists
  // because a listing swap legitimately drops refreshedAt; the movement carry
  // sits under `shouldReplace` instead, so a swap KEEPS it and no allowance is
  // owed. Passing a swap count must not buy tolerance here.
  const v = stampIntegrity({
    before: tally(2102, 282), after: tally(2102, 281), stamped: 2102, reachable: 3104,
    droppedOnReplacement: 17,
  });
  assert.equal(v.intact, false);
  assert.equal(v.movedLostThisRun, 1);
});

test('a movement stamp GAINED is not a loss', () => {
  // The ordinary healthy night: prices moved, so the count goes up.
  const v = stampIntegrity({
    before: tally(2102, 281), after: tally(2102, 421), stamped: 2102, reachable: 3104,
  });
  assert.equal(v.movedLostThisRun, 0);
  assert.equal(v.intact, true);
});

test('the movement stamp is NOT added to the plausibility floor denominator', () => {
  // Only a fraction of rows carry priceLastMovedAt even when everything works,
  // because most prices did not move. Folding it into `stamped` would make a
  // healthy catalog clear the floor for the wrong reason — and a collapsed one
  // clear it on movement history alone.
  const v = stampIntegrity({
    before: tally(386, 281), after: tally(386, 281), stamped: 386, reachable: 3104,
  });
  assert.equal(v.intact, false);
  assert.match(v.reasons.join(' '), /no completed re-pricer run is represented/);
});

test('a bare number is refused rather than read as a refreshedAt-only tally', () => {
  // The half-measurement this shape exists to prevent. A caller still passing
  // the old scalar has not been taught about the second stamp, and silently
  // treating it as {refreshedAt: n} would reinstate the blind spot exactly.
  assert.throws(
    () => stampIntegrity({ before: 2125, after: 386, stamped: 386, reachable: 3104 }),
    /countRepricerStamps\(\) tally/);
  assert.throws(
    () => stampIntegrity({ before: tally(2125), after: 386, stamped: 386, reachable: 3104 }),
    /`after`/);
});

test('the verdict carries the numbers a human needs to act on it', () => {
  const v = stampIntegrity({ before: tally(2125), after: tally(386), stamped: 386, reachable: 3104 });
  assert.equal(v.stamped, 386);
  assert.equal(v.reachable, 3104);
  assert.ok(Math.abs(v.stampedShare - 386 / 3104) < 1e-9);
});

// ── THE FLOOR IS DERIVED, NOT PICKED ─────────────────────────────────────────
//
// The plausibility floor used to be a literal 1/3 whose own comment admitted it
// was a judgment call, and said exactly why it had to be one: the re-pricer's
// reach was written to an artifact the workflow then deleted. Committing that
// one figure is what these cover — the floor now moves when the re-pricer's
// behaviour moves, and says so when it cannot.

test('the floor is half the reach the re-pricer demonstrated', () => {
  const f = stampedShareFloor({ reach: 0.6543, stamped: 2031, lookupable: 3104, observedAt: '2026-09-02T20:18:32Z' });
  assert.equal(f.derived, true);
  assert.ok(Math.abs(f.value - 0.32715) < 1e-9);
});

test('DERIVED LANDS WHERE THE CONSTANT WAS — the guess was good, and is no longer a guess', () => {
  // The whole justification for changing this is that it does not change a
  // verdict today: 32.72% against the old 33.33%. If these diverged materially
  // the derivation would be relitigating the threshold under cover of a
  // refactor, which is the thing that must not happen silently.
  const derived = stampedShareFloor({ reach: 0.6543, stamped: 2031, lookupable: 3104, observedAt: 'x' }).value;
  assert.ok(Math.abs(derived - 1 / 3) < 0.01, `derived ${derived} must stay within a point of the historical 1/3`);
});

test('THE FLOOR TRACKS THE RE-PRICER: better reach raises it', () => {
  // Add GPU to CAT_FILTER and both populations grow from the same rule. The
  // floor is supposed to follow, which is what a constant could never do.
  const before = stampedShareFloor({ reach: 0.6543, stamped: 2031, lookupable: 3104, observedAt: 'x' }).value;
  const after = stampedShareFloor({ reach: 0.90, stamped: 2800, lookupable: 3111, observedAt: 'y' }).value;
  assert.ok(after > before);
  assert.equal(after, 0.45);
});

test('NO OBSERVATION YET: falls back to the historical constant and says so', () => {
  const f = stampedShareFloor(null);
  assert.equal(f.derived, false);
  assert.equal(f.value, 1 / 3);
  assert.match(f.source, /historical constant/);
});

test('a corrupt or out-of-range file cannot relax the gate', () => {
  // A file that is wrong must fall back, not be believed. Zero and >1 are not
  // shares; a lowered floor is the one failure mode that makes the census
  // publish a number it should have withheld.
  assert.equal(loadNeweggReach(reachFile('{ not json')), null);
  assert.equal(loadNeweggReach(reachFile({ reach: 0 })), null);
  assert.equal(loadNeweggReach(reachFile({ reach: 1.4 })), null);
  assert.equal(loadNeweggReach(reachFile({ ok: 1, lookupable: 2 })), null);
  assert.equal(loadNeweggReach(reachFile('/nonexistent/newegg-reach.json')), null);
});

test('the committed observation on disk is usable and in range', () => {
  // Guards the seeded file itself: a hand-edit that breaks it would otherwise
  // only show up as the gate silently reverting to the constant.
  const r = loadNeweggReach();
  assert.ok(r, 'src/data/newegg-reach.json must parse and be in range');
  assert.ok(Math.abs(r.reach - r.stamped / r.lookupable) < 5e-4, 'reach must match stamped/lookupable');
});

test('the verdict states the floor it was judged against and where it came from', () => {
  const v = stampIntegrity({
    before: tally(386), after: tally(386), stamped: 386, reachable: 3104,
    floor: stampedShareFloor({ reach: 0.6543, stamped: 2031, lookupable: 3104, observedAt: '2026-09-02T20:18:32Z' }),
  });
  assert.equal(v.intact, false);
  assert.equal(v.floorDerived, true);
  assert.match(v.reasons.join(' '), /floor 32\.7% = half the 65\.4% reach/);
  assert.match(v.reasons.join(' '), /2031\/3104 on 2026-09-02/);
});

test('an injected floor governs the verdict, both ways', () => {
  // 38.7% stamped: intact under the derived floor, void under a stricter one.
  const args = { before: tally(1200), after: tally(1200), stamped: 1200, reachable: 3104 };
  assert.equal(stampIntegrity({ ...args, floor: stampedShareFloor(null) }).intact, true);
  assert.equal(stampIntegrity({ ...args, floor: { value: 0.5, source: 'test', derived: true } }).intact, false);
});
