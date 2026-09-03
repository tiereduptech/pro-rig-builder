// =============================================================================
//  test/sftp-hold-escalation.test.js
//
//  THE FIFTH NIGHT.
//
//  #92 made a feed that threw mid-parse come back the next night instead of
//  being skipped forever, and traded a silence for a repetition. A
//  DETERMINISTIC failure now returns every night, fails identically every
//  night, and reports itself in exactly the same words every night.
//
//  epik-watchdog.yml is what that becomes. Its own header was written against
//  passive signals, and it still went red every 30 minutes until the red
//  stopped carrying information and the schedule was commented out — by the
//  same argument, from the other direction. An alarm that repeats is an alarm
//  that gets turned off, and a turned-off alarm is the 95-day freeze again.
//
//  So a hold AGES. It carries how many consecutive attempts it has survived,
//  when it started, and how many distinct versions of the file were fetched and
//  refused; past HOLD_ESCALATE_AFTER the run stops claiming "a feed would not
//  parse" and starts claiming "a merchant's rows have been missing from every
//  ingest for N days". Different claim, different remedy, and in the workflow a
//  differently-named step, so the notification changes too.
//
//  These tests are about the counter and the threshold. The hold itself — that
//  a held feed is looked at again at all — is test/sftp-manifest-hold.test.js.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  onRecordAsProcessed, mintFeedEntry, markFeedParseFailed, clearFeedParseFailed,
  holdVerdict, HOLD_ESCALATE_AFTER,
} = require('../sftp-ingest.cjs');

const REMOTE = '/44583_4681679_mp.txt.gz';
const SIZE = 226_113_984;
const MTIME = 1_756_800_000;

const fetched = (over = {}) => ({
  size: SIZE, mtime: MTIME, mid: '44583',
  localPath: 'catalog-build/feeds/44583/44583_4681679_mp.txt.gz',
  downloadedAt: '2026-09-03T12:04:00.000Z', ...over,
});
const manifestWith = (entry) => ({ files: { [REMOTE]: entry } });
const at = (iso) => new Date(iso);
const BOOM = () => new Error('incorrect header check');

// One nightly run: the feed is re-fetched (carrying the hold), then throws.
function night(manifest, iso, { size = SIZE, mtime = MTIME, err = BOOM() } = {}) {
  const prev = manifest.files[REMOTE];
  manifest.files[REMOTE] = mintFeedEntry(prev, { size, mtime, mid: '44583', localPath: prev.localPath });
  return markFeedParseFailed(manifest, REMOTE, err, at(iso));
}

// ── the threshold ────────────────────────────────────────────────────────────

test('the threshold is a stated constant, not a magic number', () => {
  assert.equal(typeof HOLD_ESCALATE_AFTER, 'number');
  assert.ok(HOLD_ESCALATE_AFTER >= 2, 'escalating on the first failure would make every transient error an emergency');
});

test('an unheld feed has no verdict to give', () => {
  assert.deepEqual(holdVerdict(fetched()), { held: false });
  assert.deepEqual(holdVerdict(undefined), { held: false });
});

// ── the counter ──────────────────────────────────────────────────────────────

test('the first failure opens the hold at one attempt', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  const v = holdVerdict(m.files[REMOTE], at('2026-09-03T12:40:00Z'));
  assert.equal(v.streak, 1);
  assert.equal(v.versions, 1);
  assert.equal(v.days, 0);
  assert.equal(v.escalated, false, 'night one is a parse error, not an emergency');
});

test('consecutive nights accumulate, and the start date does not move', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  const first = m.files[REMOTE].parseFailedFirstAt;

  night(m, '2026-09-04T12:40:00Z');
  night(m, '2026-09-05T12:40:00Z');

  const v = holdVerdict(m.files[REMOTE], at('2026-09-05T12:40:00Z'));
  assert.equal(v.streak, 3);
  assert.equal(v.firstAt, first, 'the clock starts once; a moving start date can never age');
  assert.equal(v.days, 2);
});

// The counter has to survive the re-download, because the re-download happens
// on every run. A streak reset there could never reach its own threshold.
test('the age survives the re-fetch that happens every single run', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));

  const prev = m.files[REMOTE];
  const next = mintFeedEntry(prev, { size: SIZE, mtime: MTIME, mid: '44583', localPath: prev.localPath });
  assert.equal(next.parseFailStreak, 1);
  assert.equal(next.parseFailedFirstAt, prev.parseFailedFirstAt);
  assert.equal(onRecordAsProcessed(next, SIZE, MTIME), false);
});

// ── escalation ───────────────────────────────────────────────────────────────

test('the hold escalates exactly at the threshold, not before', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));

  for (let n = 1; n < HOLD_ESCALATE_AFTER; n++) {
    assert.equal(holdVerdict(m.files[REMOTE]).escalated, false,
      `attempt ${n} must still read as a parse error that may yet clear`);
    night(m, `2026-09-${String(3 + n).padStart(2, '0')}T12:40:00Z`);
  }

  const v = holdVerdict(m.files[REMOTE]);
  assert.equal(v.streak, HOLD_ESCALATE_AFTER);
  assert.equal(v.escalated, true);
});

test('an escalated hold stays escalated as it keeps failing', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  for (let n = 0; n < 6; n++) night(m, `2026-09-${String(4 + n).padStart(2, '0')}T12:40:00Z`);
  const v = holdVerdict(m.files[REMOTE], at('2026-09-09T12:40:00Z'));
  assert.equal(v.streak, 7);
  assert.equal(v.escalated, true);
  assert.equal(v.days, 6, 'the report needs the days, not just the attempts — that is the fact a human acts on');
});

// ── same bytes vs. a republished file ────────────────────────────────────────
//
// Both escalate, because the streak measures how long these rows have been
// missing from the catalog and that clock does not care whose fault it is. They
// are counted apart because the REMEDY differs, and the escalation says which.

test('failing on the same bytes every night counts one version', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  night(m, '2026-09-04T12:40:00Z');
  night(m, '2026-09-05T12:40:00Z');
  assert.equal(holdVerdict(m.files[REMOTE]).versions, 1);
});

test('a republished feed that still will not parse does not reset the streak', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  night(m, '2026-09-04T12:40:00Z', { size: SIZE + 4096, mtime: MTIME + 86400 });
  night(m, '2026-09-05T12:40:00Z', { size: SIZE + 9000, mtime: MTIME + 172800 });

  const v = holdVerdict(m.files[REMOTE], at('2026-09-05T12:40:00Z'));
  assert.equal(v.streak, 3, 'the rows have been missing for three runs either way');
  assert.equal(v.versions, 3, 'three distinct files fetched and refused — the merchant is publishing broken');
  assert.equal(v.escalated, true);
});

test('a changed error message is still the same hold', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, new Error('incorrect header check'), at('2026-09-03T12:40:00Z'));
  night(m, '2026-09-04T12:40:00Z', { err: new Error('unexpected end of file') });
  const v = holdVerdict(m.files[REMOTE]);
  assert.equal(v.streak, 2, 'the feed is absent from the catalog regardless of which way it broke');
  assert.equal(v.error, 'unexpected end of file', 'and the report carries the most recent reason');
});

// ── release ──────────────────────────────────────────────────────────────────

test('a successful parse clears the counters, not just the flag', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  night(m, '2026-09-04T12:40:00Z');
  night(m, '2026-09-05T12:40:00Z');
  assert.equal(holdVerdict(m.files[REMOTE]).escalated, true);

  assert.equal(clearFeedParseFailed(m, REMOTE), true);
  for (const k of ['parseFailedAt', 'parseError', 'parseFailedFirstAt', 'parseFailStreak', 'parseFailVersions', 'parseFailBytes']) {
    assert.equal(k in m.files[REMOTE], false, `${k} survived the release`);
  }
  assert.deepEqual(holdVerdict(m.files[REMOTE]), { held: false });
});

// A surviving counter would make the NEXT hold on this feed open at the last
// hold's count and escalate on its first night — an alarm that cries wolf about
// a genuinely transient error, which is the failure this whole file is against.
test('a later, unrelated hold starts its own clock', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, BOOM(), at('2026-09-03T12:40:00Z'));
  night(m, '2026-09-04T12:40:00Z');
  night(m, '2026-09-05T12:40:00Z');
  clearFeedParseFailed(m, REMOTE);

  markFeedParseFailed(m, REMOTE, new Error('something new'), at('2026-10-01T12:40:00Z'));
  const v = holdVerdict(m.files[REMOTE], at('2026-10-01T12:40:00Z'));
  assert.equal(v.streak, 1);
  assert.equal(v.days, 0);
  assert.equal(v.escalated, false);
});

// ── the manifest #92 left in the cache ───────────────────────────────────────

test('a hold written before the counter existed is continued, not restarted', () => {
  // Exactly what #92 wrote: the failure recorded, its age not.
  const legacy = fetched({ parseFailedAt: '2026-09-03T12:40:00.000Z', parseError: 'incorrect header check' });
  const v = holdVerdict(legacy, at('2026-09-05T12:40:00Z'));
  assert.equal(v.held, true);
  assert.equal(v.streak, 1, 'one recorded failure is all it can honestly claim');
  assert.equal(v.firstAt, '2026-09-03T12:40:00.000Z', 'and it started when that failure was recorded');
  assert.equal(v.days, 2);

  // The next night must build on it rather than reopening at one forever.
  const m = manifestWith(legacy);
  night(m, '2026-09-05T12:40:00Z');
  assert.equal(holdVerdict(m.files[REMOTE]).streak, 2);
  assert.equal(holdVerdict(m.files[REMOTE]).firstAt, '2026-09-03T12:40:00.000Z');
});

test('a malformed start date degrades to zero days rather than NaN', () => {
  const v = holdVerdict(fetched({ parseFailedAt: 'not-a-date', parseFailStreak: 4 }));
  assert.equal(v.days, 0);
  assert.equal(v.escalated, true, 'the attempt count still escalates without a usable clock');
});
