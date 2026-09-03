// =============================================================================
//  test/sftp-commit-verdict.test.js
//
//  WHAT A HELD FEED MAY COST.
//
//  #92 made a feed that threw mid-parse come back; #93 made that hold age and
//  escalate. Together they created this: a deterministic parse failure holds a
//  feed indefinitely, totals.errors stays non-zero, and because assert-outcome
//  sat BETWEEN the work and the commit — with no later step marked to run on
//  failure — nothing landed. Not the other feeds' prices, not the absence
//  stamps, not even the manifest carrying the hold's own escalation streak.
//  Indefinitely was also how long the healthy feeds stayed stranded.
//
//  The thing that makes the fix cheap is that the write already happened.
//  parts.js, the exclusives flush and the manifest all sit in the `else` branch
//  of the write-outputs block, gated on DRY_RUN and damagedThisRun and never on
//  totals.errors. A parse-error run has ALWAYS written a full catalog to disk
//  and then thrown it away at the workflow layer. There is no partial write to
//  invent — there is a commit to authorise.
//
//  So commitVerdict() answers one question: did this run deliberately write no
//  catalog? Two things mean yes — a dry run, and the stamp guard withholding it.
//  A held feed is not one of them, and that is the entire change.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commitVerdict } = require('../sftp-ingest.cjs');

const CLEAN = { dryRun: false, damaged: false, heldFeeds: 0, wroteParts: true };

// ── the two refusals ─────────────────────────────────────────────────────────

test('a dry run has nothing of its own to commit', () => {
  const v = commitVerdict({ ...CLEAN, dryRun: true });
  assert.equal(v.safe, false);
  assert.equal(v.wroteParts, false, 'a dry run must never report a write, whatever it was handed');
  assert.match(v.reason, /dry run/i);
});

test('the stamp guard withholding the catalog withholds the commit', () => {
  const v = commitVerdict({ ...CLEAN, damaged: true });
  assert.equal(v.safe, false);
  assert.equal(v.wroteParts, false);
  assert.match(v.reason, /stamp/i);
});

// damagedThisRun means parts.js was deliberately NOT written, so the on-disk
// catalog is yesterday's. Committing would be a no-op at best; the refusal is
// what stops a future change to the write path from making it worse.
test('a dry run that is also damaged still refuses, and says dry run first', () => {
  const v = commitVerdict({ ...CLEAN, dryRun: true, damaged: true });
  assert.equal(v.safe, false);
  assert.match(v.reason, /dry run/i);
});

// ── the change ───────────────────────────────────────────────────────────────

test('a clean run commits and is not partial', () => {
  const v = commitVerdict(CLEAN);
  assert.equal(v.safe, true);
  assert.equal(v.partial, false);
  assert.equal(v.heldFeeds, 0);
});

// THE BUG. Before this, one held feed withheld every other feed's work.
test('a held feed does NOT withhold the feeds that parsed', () => {
  const v = commitVerdict({ ...CLEAN, heldFeeds: 1 });
  assert.equal(v.safe, true, 'this is the whole change: a held feed costs its own rows and nothing else');
  assert.equal(v.partial, true);
  assert.equal(v.heldFeeds, 1);
  assert.match(v.reason, /held/i);
});

test('several held feeds are still committable, and say how many', () => {
  const v = commitVerdict({ ...CLEAN, heldFeeds: 3 });
  assert.equal(v.safe, true);
  assert.equal(v.partial, true);
  assert.equal(v.heldFeeds, 3);
  assert.match(v.reason, /3 feed/);
});

// A run where every feed was held still wrote the absence stamps from the
// feeds that DID parse, and those belong on main. (It also wrote the manifest
// carrying each hold's streak — but catalog-build/* is gitignored, so that one
// travels only by actions/cache. See the note in the PR.)
test('a run where nothing parsed still commits what it did produce', () => {
  const v = commitVerdict({ dryRun: false, damaged: false, heldFeeds: 2, wroteParts: false });
  assert.equal(v.safe, true);
  assert.equal(v.partial, true);
  assert.equal(v.wroteParts, false, 'and it is honest that no catalog was written');
});

// ── the refusals outrank the hold ────────────────────────────────────────────

test('a held feed cannot talk a damaged run into committing', () => {
  const v = commitVerdict({ ...CLEAN, damaged: true, heldFeeds: 1 });
  assert.equal(v.safe, false);
  assert.equal(v.partial, false, 'a withheld run is not a partial one — it is nothing at all');
});

// ── the verdict must be legible to assert-outcome ────────────────────────────
//
// The workflow reads exactly `commit.safe==true` through assert-outcome. A
// verdict whose field were truthy-but-not-boolean would pass the `==true`
// comparison inconsistently, so the shape is asserted here rather than assumed.

test('safe is a real boolean, because the gate compares it as one', () => {
  for (const args of [CLEAN, { ...CLEAN, dryRun: true }, { ...CLEAN, heldFeeds: 1 }]) {
    const v = commitVerdict(args);
    assert.equal(typeof v.safe, 'boolean');
    assert.equal(typeof v.partial, 'boolean');
    assert.equal(typeof v.reason, 'string');
    assert.ok(v.reason.length > 0, 'a verdict with no reason is not reviewable in a run log');
  }
});

test('the defaults refuse nothing and invent nothing', () => {
  const v = commitVerdict({ dryRun: false, damaged: false });
  assert.equal(v.safe, true);
  assert.equal(v.partial, false);
  assert.equal(v.heldFeeds, 0);
  assert.equal(v.wroteParts, false);
});
