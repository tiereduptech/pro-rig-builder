// =============================================================================
//  test/sftp-manifest-hold.test.js
//
//  THE SECOND NIGHT.
//
//  The sftp manifest names the feed files the next run will DECLINE to look at.
//  #91 fixed when it is written — after the work, not after the download — so a
//  run that dies leaves no record behind it. It left one door open, and said so:
//  a feed whose parse throws part-way is counted in totals.errors and skipped,
//  but its entry was minted at download time and rides out with the rest of the
//  manifest at the end of a run that otherwise succeeded.
//
//  That entry escapes by CACHE, not by git. sftp-ingest.yml asserts
//  totals.errors==0 between the run and the commit, so the red run never commits
//  the manifest — but actions/cache saves in its post step, which runs on a
//  failed job, and the next run restores it by prefix. Night one is red and
//  loud. Night two skips the feed as unchanged, downloads nothing, returns at
//  "Nothing new to process, done." with errors==0, and the assertion PASSES:
//  feedRecords>0 is a --warn, not a --require. Green, quiet, nothing ingested,
//  and it stays that way until the feed's size or mtime moves on the server.
//
//  These tests are about night two. The skip decision was previously reachable
//  only through a live SFTP pull, which is the same reason applyMatchToPart is
//  exported — a rule nothing can call is a rule nothing checks.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { onRecordAsProcessed, mintFeedEntry, markFeedParseFailed, clearFeedParseFailed } =
  require('../sftp-ingest.cjs');

const REMOTE = '/44583_4681679_mp.txt.gz';
const SIZE = 226_113_984;
const MTIME = 1_756_800_000;

// The entry exactly as walkAndDownload mints it after a completed sftp.get().
const fetched = () => ({
  size: SIZE, mtime: MTIME, mid: '44583',
  localPath: 'catalog-build/feeds/44583/44583_4681679_mp.txt.gz',
  downloadedAt: '2026-09-03T12:04:00.000Z',
});
const manifestWith = (entry) => ({ files: { [REMOTE]: entry } });

// ── the skip decision ────────────────────────────────────────────────────────

test('a feed never seen before is not on record', () => {
  assert.equal(onRecordAsProcessed(undefined, SIZE, MTIME), false);
  assert.equal(onRecordAsProcessed(null, SIZE, MTIME), false);
});

test('unchanged bytes from a run that processed them are skipped', () => {
  assert.equal(onRecordAsProcessed(fetched(), SIZE, MTIME), true);
});

test('changed bytes are re-fetched even though the entry is clean', () => {
  assert.equal(onRecordAsProcessed(fetched(), SIZE + 1, MTIME), false);
  assert.equal(onRecordAsProcessed(fetched(), SIZE, MTIME + 1), false);
});

// The defect itself. Before the hold, this returned true: identical bytes, so
// "unchanged", so skipped — for a feed nothing had ever read to the end.
test('unchanged bytes whose parse threw are NOT on record as processed', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, new Error('incorrect header check'));
  assert.equal(onRecordAsProcessed(m.files[REMOTE], SIZE, MTIME), false);
});

test('the hold outranks the bytes matching, which is the whole point', () => {
  const held = { ...fetched(), parseFailedAt: '2026-09-03T12:40:00.000Z' };
  // Every other field says "we already have this". Only the mark disagrees,
  // and only the mark is allowed to decide.
  assert.equal(held.size, SIZE);
  assert.equal(held.mtime, MTIME);
  assert.equal(onRecordAsProcessed(held, SIZE, MTIME), false);
});

// ── marking and releasing ────────────────────────────────────────────────────

test('the mark records WHY, so the next run can say what it is re-fetching', () => {
  const m = manifestWith(fetched());
  const marked = markFeedParseFailed(m, REMOTE, new Error('unexpected end of file'));
  assert.equal(marked.parseError, 'unexpected end of file');
  assert.match(marked.parseFailedAt, /^\d{4}-\d{2}-\d{2}T/);
  // In place: saveManifest writes this object, so a copy would be marked and
  // then thrown away.
  assert.equal(m.files[REMOTE].parseFailedAt, marked.parseFailedAt);
});

test('a non-Error throw still produces a readable reason', () => {
  const m = manifestWith(fetched());
  assert.equal(markFeedParseFailed(m, REMOTE, 'boom').parseError, 'boom');
  const m2 = manifestWith(fetched());
  assert.equal(markFeedParseFailed(m2, REMOTE, undefined).parseError, 'unknown');
});

// Absence already means "not on record". Minting an entry here would invent a
// size/mtime pair nothing measured, and that invented pair is exactly what a
// later run would skip on.
test('marking a path with no entry invents nothing', () => {
  const m = { files: {} };
  assert.equal(markFeedParseFailed(m, REMOTE, new Error('x')), null);
  assert.deepEqual(m.files, {});
});

test('a completed parse releases the hold, and the feed is skippable again', () => {
  const m = manifestWith(fetched());
  markFeedParseFailed(m, REMOTE, new Error('incorrect header check'));
  assert.equal(clearFeedParseFailed(m, REMOTE), true);
  assert.equal('parseFailedAt' in m.files[REMOTE], false);
  assert.equal('parseError' in m.files[REMOTE], false);
  assert.equal(onRecordAsProcessed(m.files[REMOTE], SIZE, MTIME), true);
});

test('releasing an unheld or unknown feed is a no-op, not a write', () => {
  const m = manifestWith(fetched());
  assert.equal(clearFeedParseFailed(m, REMOTE), false);
  assert.equal(clearFeedParseFailed(m, '/nope.txt.gz'), false);
  assert.deepEqual(m.files[REMOTE], fetched());
});

// ── the two-night sequence, end to end ───────────────────────────────────────
//
// The scenario in the header, run against the real predicate. The server does
// not touch the feed between the nights — that is the case the old code got
// wrong, because "the file did not change" was read as "we are done with it".

test('night two re-fetches a feed night one could not parse', () => {
  const manifest = { files: {} };

  // Night one: downloaded, then threw at ~500k records in.
  manifest.files[REMOTE] = fetched();
  markFeedParseFailed(manifest, REMOTE, new Error('incorrect header check'));

  // The manifest survives the red job via the actions/cache post step.
  const cached = JSON.parse(JSON.stringify(manifest));

  // Night two, same bytes on the server.
  assert.equal(onRecordAsProcessed(cached.files[REMOTE], SIZE, MTIME), false,
    'night two must look at the feed again rather than idle on an empty download');

  // It parses this time, and the record is earned.
  assert.equal(clearFeedParseFailed(cached, REMOTE), true);
  assert.equal(onRecordAsProcessed(cached.files[REMOTE], SIZE, MTIME), true,
    'night three has no reason to re-fetch a feed night two read end to end');
});

// A hold that a plain re-download could clear would be no hold at all in
// --download-only, which saves the manifest and never parses anything. The
// carry is what keeps that flag from promoting a held feed to processed.
test('the hold survives a re-download, because fetching is not reading', () => {
  const prev = { ...fetched(), parseFailedAt: '2026-09-03T12:40:00.000Z', parseError: 'incorrect header check' };

  // The write walkAndDownload performs after sftp.get() resolves.
  const next = mintFeedEntry(prev, { size: SIZE, mtime: MTIME, mid: '44583', localPath: prev.localPath });

  assert.notEqual(next.downloadedAt, prev.downloadedAt, 'the fetch itself is fresh');
  assert.equal(next.parseFailedAt, prev.parseFailedAt, 'the hold is carried, not re-minted');
  assert.equal(next.parseError, 'incorrect header check');
  assert.equal(onRecordAsProcessed(next, SIZE, MTIME), false);
});

test('a clean re-download of a feed that never failed carries no mark', () => {
  const next = mintFeedEntry(fetched(), { size: SIZE + 99, mtime: MTIME + 1, mid: '44583', localPath: 'x' });
  assert.equal('parseFailedAt' in next, false);
  assert.equal(onRecordAsProcessed(next, SIZE + 99, MTIME + 1), true);
});

test('a first-ever download has no prev to carry from', () => {
  const next = mintFeedEntry(undefined, { size: SIZE, mtime: MTIME, mid: '44583', localPath: 'x' });
  assert.equal('parseFailedAt' in next, false);
  assert.equal(onRecordAsProcessed(next, SIZE, MTIME), true);
});
