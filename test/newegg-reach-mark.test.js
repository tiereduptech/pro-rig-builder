// =============================================================================
//  test/newegg-reach-mark.test.js
//
//  THE FIGURE THAT USED TO BE THROWN AWAY.
//
//  sftp-ingest.cjs's census refuses to publish when almost none of the
//  re-pricer-reachable rows carry a refreshedAt stamp. "Almost none" was a
//  literal 1/3, and its own comment said why it had to be: the number that
//  belongs there is a fact about refresh-newegg-prices.cjs — how much of what
//  it can address does a completed run stamp? — and this script wrote it to
//  newegg-refresh-summary.json, which the workflow uploaded as an artifact and
//  then `rm -f`'d.
//
//  recordReach() commits that one figure. These tests cover the two properties
//  that make the derived floor safe rather than merely derived:
//
//    THE MARK ONLY MOVES UP. If it tracked the last run, a run that reached
//    fewer rows would LOWER the floor and the gate would go slack exactly when
//    the re-pricer is in trouble. Monotone means degradation can only make the
//    census withhold more, never less.
//
//    PARTIAL AND PRETEND RUNS DO NOT SET IT. A --limit draw is a subsample, a
//    --dry-run leaves no stamps in the catalog at all, and --parts= is not the
//    population the census counts. Any of the three could plant a spuriously
//    high mark that then over-refuses forever.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordReach } = require('../refresh-newegg-prices.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-w-')), 'newegg-reach.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// A full, real run: the only shape allowed to move the mark.
const full = { dryRun: false, limited: false, fixture: false };

test('a full run with no standing mark writes the first observation', () => {
  const f = tmp();
  const r = recordReach({ stamped: 2031, lookupable: 3104, ...full, file: f });
  assert.equal(r.recorded, true);
  assert.equal(r.previous, null);
  const w = read(f);
  assert.equal(w.reach, 0.6543);
  assert.equal(w.stamped, 2031);
  assert.equal(w.lookupable, 3104);
});

test('THE MARK ONLY MOVES UP: a worse run leaves it alone', () => {
  // The failure this design exists to prevent. 1,400/3,104 is 45% — a real run,
  // just a poor one. Letting it write would drop the floor from 32.7% to 22.5%,
  // and a catalog with 25% of its stamps left would then publish a census built
  // on evidence that had been eaten.
  const f = tmp();
  recordReach({ stamped: 2031, lookupable: 3104, ...full, file: f });
  const r = recordReach({ stamped: 1400, lookupable: 3104, ...full, file: f });
  assert.equal(r.recorded, false);
  assert.match(r.why, /only moves up/);
  assert.equal(read(f).reach, 0.6543, 'the standing mark is untouched');
});

test('a better run does move it, and reports what it displaced', () => {
  const f = tmp();
  recordReach({ stamped: 2031, lookupable: 3104, ...full, file: f });
  const r = recordReach({ stamped: 2800, lookupable: 3111, ...full, file: f });
  assert.equal(r.recorded, true);
  assert.equal(r.previous, 0.6543);
  assert.ok(read(f).reach > 0.6543);
});

test('a --limit run cannot set the mark', () => {
  // 40 of 40 is 100% reach on a lucky draw. As a mark it would put the floor at
  // 50% and void the census on every ordinary night thereafter.
  const f = tmp();
  const r = recordReach({ stamped: 40, lookupable: 40, ...full, limited: true, file: f });
  assert.equal(r.recorded, false);
  assert.match(r.why, /subsample/);
  assert.equal(fs.existsSync(f), false, 'and nothing at all was written');
});

test('a --dry-run cannot set the mark', () => {
  // It probes the feed and writes no stamps. The mark describes what a run
  // LEAVES IN THE CATALOG, and a run that leaves nothing has demonstrated
  // nothing about it.
  const f = tmp();
  assert.equal(recordReach({ stamped: 2031, lookupable: 3104, ...full, dryRun: true, file: f }).recorded, false);
});

test('a --parts= fixture run cannot set the mark', () => {
  const f = tmp();
  assert.equal(recordReach({ stamped: 2031, lookupable: 3104, ...full, fixture: true, file: f }).recorded, false);
});

test('no lookupable rows is not an observation of zero reach', () => {
  // Dividing here would write reach: NaN or 0, and a 0 is exactly the value
  // that loadNeweggReach() rejects on the read side. Refuse it at the source.
  const f = tmp();
  const r = recordReach({ stamped: 0, lookupable: 0, ...full, file: f });
  assert.equal(r.recorded, false);
  assert.match(r.why, /undefined/);
});

test('a drifted stamp counter refuses to set the mark', () => {
  // stats.stamped is incremented by hand at each refreshedAt write site. If a
  // fourth outcome is added and forgets it, the numerator silently shrinks and
  // the derived floor drops with it — the census would then publish over a
  // catalog it should have refused. Caught at the source instead.
  const f = tmp();
  const r = recordReach({ stamped: 2031, lookupable: 3104, ...full, counterSound: false, file: f });
  assert.equal(r.recorded, false);
  assert.match(r.why, /counter drifted/);
  assert.equal(fs.existsSync(f), false);
});

test('the mark carries the counts it was computed from, so it can be recomputed', () => {
  // The same rule the refresh summary already follows for the breaker: both
  // sides of the ratio travel with it, so the figure can be checked rather than
  // trusted. A bare share is a constant again, one indirection later.
  const f = tmp();
  recordReach({ stamped: 2031, lookupable: 3104, ...full, file: f });
  const w = read(f);
  assert.ok(Math.abs(w.reach - w.stamped / w.lookupable) < 5e-4);
  assert.ok(w.observedAt, 'and when it was observed');
  assert.ok(w.run, 'and which run observed it');
});
