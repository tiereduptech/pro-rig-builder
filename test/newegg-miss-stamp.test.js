// =============================================================================
//  test/newegg-miss-stamp.test.js
//
//  THE RE-PRICER'S "I COULD NOT".
//
//  sftp-ingest.cjs may certify deals.newegg only for a row the re-pricer is not
//  confirming. That used to mean "has never carried refreshedAt", which assumed
//  the rows the re-pricer reaches are a fixed set. They are not: on 2026-09-11,
//  139 rows it had once confirmed had gone over 3 days without it, and each was
//  barred from the feed for good by the refreshedAt from its last success.
//
//  The way back in is a MISS: refreshMissedAt, written by re-pricer runs that
//  looked the row up and could not confirm it. sftp-ingest reads a miss newer
//  than refreshedAt as "lost". The property that has to survive is the one the
//  never-reached rule protected — a dead or broken re-pricer must not hand its
//  rows to the feed and read as healthy. So:
//
//    - only a run that is full, unbroken and above the census floor may count
//      a miss at all (missesTrusted). Dead writes nothing; broken writes nothing.
//    - one miss is jitter. A row is lost only after MISSED_CYCLES_ALLOWED
//      consecutive misses, the freshness gate's own threshold.
//    - only a reason that means "the feed answered and this row was not
//      confirmable" is a miss. Throttling and unmapped categories are not.
//    - a miss touches nothing else: not the price, not the absence evidence
//      that removals are gated on.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { missesTrusted, stampMisses, missFloor, MISS_REASONS } = require('../refresh-newegg-prices.cjs');
const { stampedShareFloor, loadNeweggReach } = require('../sftp-ingest.cjs');
const { MISSED_CYCLES_ALLOWED } = require('../scripts/assert-retailer-freshness.cjs');

const RUN1 = '2026-09-10T18:52:18.000Z';
const RUN2 = '2026-09-11T08:28:31.000Z';
const FLOOR = { value: 0.6971 / 2, derived: true, source: 'test' };
const healthy = { breakers: [], dryRun: false, limited: false, fixture: false, stamped: 2150, lookupable: 3107, floor: FLOOR };

const reachFile = (mark) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miss-')), 'newegg-reach.json');
  if (mark !== undefined) fs.writeFileSync(f, JSON.stringify(mark));
  return f;
};

// ── which runs may speak ─────────────────────────────────────────────────────

test('a full, unbroken run above the floor may count misses', () => {
  assert.equal(missesTrusted(healthy).trusted, true);
});

test('A BROKEN RUN WRITES NO MISSES: a tripped breaker', () => {
  // The July shape: every lookup failing. Handing those rows to the feed would
  // turn a broken re-pricer into a green lane.
  for (const b of ['feed failure rate 64.0% > 20%', 'zero successful lookups — cannot trust any absence signal']) {
    const t = missesTrusted({ ...healthy, breakers: [b] });
    assert.equal(t.trusted, false, b);
    assert.match(t.why, /breaker/);
  }
});

test('A BROKEN RUN WRITES NO MISSES: reach collapsed under the census floor', () => {
  // A matcher rejecting most candidates trips no breaker (variant and guard
  // rejections are excluded from feed health) — but its reach gives it away.
  const t = missesTrusted({ ...healthy, stamped: 700 });
  assert.equal(t.trusted, false);
  assert.match(t.why, /floor/);
});

test('partial and pretend runs write no misses', () => {
  for (const extra of [{ dryRun: true }, { limited: true }, { fixture: true }, { lookupable: 0, stamped: 0 }]) {
    assert.equal(missesTrusted({ ...healthy, ...extra }).trusted, false, JSON.stringify(extra));
  }
});

test('the floor is the census floor: missFloor and stampedShareFloor agree on the same file', () => {
  // Derived the same way from the same committed mark, in two files that must
  // not import each other (sftp-ingest loads an SFTP client at top level). This
  // is what stops the two from drifting apart.
  for (const mark of [
    { reach: 0.6971, stamped: 2166, lookupable: 3107, observedAt: '2026-09-09T09:42:25.889Z', run: '1' },
    { reach: 0.6543, stamped: 2031, lookupable: 3104, observedAt: '2026-09-02T00:00:00Z', run: '2' },
    undefined,                 // no file: both fall back to the historical 1/3
    { reach: 0 },              // not an observation: both fall back
    { reach: 1.4 },            // not a share: both fall back
  ]) {
    const f = reachFile(mark);
    assert.equal(missFloor(f).value, stampedShareFloor(loadNeweggReach(f)).value, JSON.stringify(mark));
  }
});

// ── what a miss is, and when a row is lost ──────────────────────────────────

const row = (id, deal = {}) => ({
  id, deals: { newegg: { sku: `S${id}`, price: 100, refreshedAt: '2026-08-29T10:51:10.816Z', ...deal } },
});

test('one miss is jitter: counted, not yet a loss', () => {
  const p = row(1);
  const r = stampMisses([{ p, reason: 'variant_rejected' }], { at: RUN1 });
  assert.deepEqual(r, { counted: 1, lost: MISSED_CYCLES_ALLOWED <= 1 ? 1 : 0 });
  assert.equal(p.deals.newegg.refreshMissStreak, 1);
  if (MISSED_CYCLES_ALLOWED > 1) assert.equal(p.deals.newegg.refreshMissedAt, undefined);
});

test('MISSED_CYCLES_ALLOWED consecutive misses make the row lost, dated by the latest run', () => {
  const p = row(2);
  const runs = Array.from({ length: MISSED_CYCLES_ALLOWED }, (_, i) => (i === MISSED_CYCLES_ALLOWED - 1 ? RUN2 : RUN1));
  let last;
  for (const at of runs) last = stampMisses([{ p, reason: 'downgrade_blocked' }], { at });
  assert.equal(last.lost, 1);
  assert.equal(p.deals.newegg.refreshMissStreak, MISSED_CYCLES_ALLOWED);
  assert.equal(p.deals.newegg.refreshMissedAt, RUN2);
  assert.equal(p.deals.newegg.refreshMissReason, 'downgrade_blocked');
});

test('every allowlisted reason is a miss', () => {
  const rows = [...MISS_REASONS].map((reason, i) => ({ p: row(10 + i, { refreshMissStreak: MISSED_CYCLES_ALLOWED - 1 }), reason }));
  assert.deepEqual(stampMisses(rows, { at: RUN2 }), { counted: MISS_REASONS.size, lost: MISS_REASONS.size });
  for (const { p, reason } of rows) assert.equal(p.deals.newegg.refreshMissReason, reason);
});

test('throttling, unmapped categories and unknown reasons are not misses', () => {
  // http_error is us over the rate limit or Rakuten down; no_cat_mapping never
  // issued a request. Neither is evidence the re-pricer cannot reach the row,
  // and an allowlist means a reason added later is not a miss until named.
  for (const reason of ['http_error', 'no_cat_mapping', 'no_candidate_selected', 'something_new']) {
    const p = row(99, { refreshMissStreak: MISSED_CYCLES_ALLOWED - 1 });
    assert.deepEqual(stampMisses([{ p, reason }], { at: RUN2 }), { counted: 0, lost: 0 }, reason);
    assert.equal(p.deals.newegg.refreshMissedAt, undefined, reason);
    assert.equal(p.deals.newegg.refreshMissStreak, MISSED_CYCLES_ALLOWED - 1, `${reason} must not move the streak`);
  }
});

test('a miss touches nothing else: not the price, not the absence evidence', () => {
  // Removals are gated on staleSince/absentStreak (CONFIRMED_ABSENT only), and
  // the file's first rule is that a failed lookup never mutates the deal's
  // evidence. The miss fields are new, and nothing in the re-pricer reads them.
  const p = row(7, { price: 149.99, saleprice: 119.99, refreshMissStreak: MISSED_CYCLES_ALLOWED - 1 });
  const before = JSON.parse(JSON.stringify(p.deals.newegg));
  delete before.refreshMissStreak;
  stampMisses([{ p, reason: 'variant_rejected' }], { at: RUN2 });
  const { refreshMissedAt, refreshMissReason, refreshMissStreak, ...rest } = p.deals.newegg;
  assert.deepEqual(rest, before);
  assert.ok(refreshMissedAt && refreshMissReason && refreshMissStreak);
});

test('a row with no deals.newegg is skipped, not created', () => {
  const p = { id: 8, deals: {} };
  assert.deepEqual(stampMisses([{ p, reason: 'no_results' }], { at: RUN2 }), { counted: 0, lost: 0 });
  assert.equal(p.deals.newegg, undefined);
});
