// =============================================================================
//  test/sftp-manifest-durable.test.js
//
//  AN ALARM THAT FORGETS.
//
//  #93 put a parse hold's AGE in the manifest — parseFailStreak,
//  parseFailedFirstAt, parseFailVersions — and escalates on it. That only means
//  anything if the manifest survives.
//
//  It did not. `.gitignore` carried `catalog-build/*` with only
//  price-history.json and reviews.json negated, so the commit step's `git add`
//  of sftp-manifest.json exited 1 every run and its `2>/dev/null || true`
//  swallowed the error: ZERO commits ever touched the file. It lived on the
//  runner and in actions/cache, and nowhere else. Evict that cache and an
//  escalated hold — one the run had been shouting about for five nights —
//  silently reopens at attempt 1 with its clock reset.
//
//  Two halves, and both are needed. The manifest is now committed, so the record
//  is durable. And losing it is now LOUD, because loadManifest() used to return
//  an empty manifest for both "no file" and "unparseable file", which made a
//  destroyed record indistinguishable from the first run this job ever made.
//  The only visible consequence was that every feed got re-downloaded, which
//  reads as "the feeds changed" — not as "the alarm forgot".
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseManifest, holdVerdict } = require('../sftp-ingest.cjs');

const ENTRY = {
  size: 226113984, mtime: 1756800000, mid: '44583',
  localPath: 'catalog-build/feeds/44583/x.txt.gz',
  downloadedAt: '2026-09-03T12:04:00.000Z',
};
const good = (files = { '/x.txt.gz': ENTRY }) => JSON.stringify({ files });

// ── the three outcomes are distinguishable ───────────────────────────────────

test('a real manifest reads as loaded from disk', () => {
  const r = parseManifest(good());
  assert.equal(r.source, 'disk');
  assert.deepEqual(r.manifest.files['/x.txt.gz'], ENTRY);
});

test('no file at all is ABSENT, not silently empty', () => {
  const r = parseManifest(null);
  assert.equal(r.source, 'absent');
  assert.deepEqual(r.manifest.files, {});
});

test('unparseable JSON is UNREADABLE, and carries the reason', () => {
  const r = parseManifest('{"files": {"a": ');
  assert.equal(r.source, 'unreadable');
  assert.deepEqual(r.manifest.files, {});
  assert.ok(r.error && r.error.length, 'a truncated manifest must say what went wrong with it');
});

// THE POINT. Before this, all three returned the identical `{files:{}}` and the
// caller could not tell a destroyed record from a first run.
test('the three are not the same value, which is the whole defect', () => {
  const sources = [parseManifest(good()), parseManifest(null), parseManifest('nope')].map(r => r.source);
  assert.equal(new Set(sources).size, 3);
});

// ── shapes that parse but are not manifests ──────────────────────────────────

test('valid JSON with no files map is malformed, not usable', () => {
  for (const raw of ['{}', '{"files": null}', '{"files": "x"}', '[]', 'null', '"a string"', '42']) {
    const r = parseManifest(raw);
    assert.equal(r.source, 'malformed', `${raw} must not read as a manifest`);
    assert.deepEqual(r.manifest.files, {}, `${raw} must still yield a safe empty manifest`);
  }
});

// A manifest that sails through with no `files` would miss on every lookup —
// 'absent' wearing a costume, with none of absent's announcement.
test('a malformed manifest is still SAFE to use, just not silent', () => {
  const r = parseManifest('{"notfiles": 1}');
  assert.equal(typeof r.manifest.files, 'object');
  assert.equal(Object.keys(r.manifest.files).length, 0);
});

// ── the hold state is what actually has to survive ───────────────────────────

test('a hold and its full age round-trip through the manifest', () => {
  const held = {
    ...ENTRY,
    parseFailedAt: '2026-09-07T12:40:00.000Z',
    parseError: 'incorrect header check',
    parseFailedFirstAt: '2026-09-03T12:40:00.000Z',
    parseFailStreak: 5,
    parseFailVersions: 2,
    parseFailBytes: '226113984:1756800000',
  };
  // Exactly what saveManifest writes and the next run reads back.
  const r = parseManifest(JSON.stringify({ files: { '/x.txt.gz': held } }));
  assert.equal(r.source, 'disk');

  const v = holdVerdict(r.manifest.files['/x.txt.gz'], new Date('2026-09-08T12:00:00Z'));
  assert.equal(v.streak, 5);
  assert.equal(v.versions, 2);
  assert.equal(v.escalated, true, 'a five-night hold must still read as escalated after a round trip');
  assert.equal(v.firstAt, '2026-09-03T12:40:00.000Z');
  // 12:40 on the 3rd to 12:00 on the 8th is 4d23h20m, and days FLOORS. The
  // report would rather understate the age than claim a day that has not
  // finished — the streak is the count that drives escalation anyway.
  assert.equal(v.days, 4);
});

// This is the eviction, written down: the same feed, with the record gone.
test('losing the manifest resets an escalated hold — and must not do so quietly', () => {
  const lost = parseManifest(null);
  assert.equal(lost.manifest.files['/x.txt.gz'], undefined);
  assert.deepEqual(holdVerdict(lost.manifest.files['/x.txt.gz']), { held: false },
    'the five-night hold is simply gone');
  assert.notEqual(lost.source, 'disk',
    'so the ONLY thing standing between that and silence is this field — the caller logs on it ' +
    'and sftp-ingest.yml warns on manifest.source==disk');
});
