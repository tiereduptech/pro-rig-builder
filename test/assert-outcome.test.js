/**
 * test/assert-outcome.test.js
 *
 * The behaviour under test is the one that cost 1,882 stranded rows: a job that
 * produced nothing must FAIL, and must not be confused with a job that
 * correctly had nothing to do.
 */

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { assertOutcome, parseExpr, readPath, coerce } = require("../scripts/assert-outcome.cjs");


function tmpSummary(obj, { mtimeEpoch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-outcome-'));
  const p = path.join(dir, 'summary.json');
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  if (mtimeEpoch != null) fs.utimesSync(p, mtimeEpoch, mtimeEpoch);
  return p;
}

const HEALTHY = {
  startedAt: '2026-08-18T12:00:00.000Z',
  dryRun: false,
  totals: { feedRecords: 6000000, matched: 2100, updated: 1882, exclusives: 40, errors: 0 },
};

// ── the failure that started all this ────────────────────────────────────────

test('an absent summary fails — a dead run is not an empty one', () => {
  const r = assertOutcome({ artifact: '/nonexistent/does-not-exist.json', label: 'SFTP ingest' });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /never reached its outcome/);
});

test('a healthy summary passes', () => {
  const r = assertOutcome({
    artifact: tmpSummary(HEALTHY),
    require: ['totals.errors==0'],
    warn: ['totals.feedRecords>0'],
  });
  assert.strictEqual(r.ok, true, r.failures.join('; '));
  assert.deepStrictEqual(r.warnings, []);
});

test('a run that parsed nothing warns but does not fail — the manifest cache skips unchanged feeds', () => {
  const idle = { totals: { feedRecords: 0, matched: 0, updated: 0, exclusives: 0, errors: 0 } };
  const r = assertOutcome({
    artifact: tmpSummary(idle),
    require: ['totals.errors==0'],
    warn: ['totals.feedRecords>0'],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /feedRecords is 0/);
});

test('a run where every feed failed to parse fails, even though the script exited 0', () => {
  const broken = { totals: { feedRecords: 0, matched: 0, updated: 0, exclusives: 0, errors: 2 } };
  const r = assertOutcome({ artifact: tmpSummary(broken), require: ['totals.errors==0'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /expected totals\.errors==0, but totals\.errors is 2/);
});

// ── staleness ────────────────────────────────────────────────────────────────

test('a summary older than the work step is refused as a leftover', () => {
  const started = Math.floor(Date.now() / 1000);
  const p = tmpSummary(HEALTHY, { mtimeEpoch: started - 600 });
  const r = assertOutcome({ artifact: p, newerThanEpoch: started, require: ['totals.errors==0'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /leftover from an earlier attempt/);
});

test('a summary written during the run is accepted', () => {
  const started = Math.floor(Date.now() / 1000) - 60;
  const p = tmpSummary(HEALTHY, { mtimeEpoch: started + 30 });
  const r = assertOutcome({ artifact: p, newerThanEpoch: started, require: ['totals.errors==0'] });
  assert.strictEqual(r.ok, true, r.failures.join('; '));
});

// ── malformed input must never read as success ───────────────────────────────

test('a truncated summary fails rather than throwing', () => {
  const r = assertOutcome({ artifact: tmpSummary('{"totals": {"upda'), require: ['totals.errors==0'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /not readable JSON/);
});

test('a path that is missing fails — it must not be read as zero', () => {
  const r = assertOutcome({ artifact: tmpSummary({ totals: {} }), require: ['totals.errors==0'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /totals\.errors is missing/);
});

test('a numeric comparison against a non-number fails rather than coercing', () => {
  const r = assertOutcome({ artifact: tmpSummary({ totals: { updated: 'lots' } }), require: ['totals.updated>0'] });
  assert.strictEqual(r.ok, false);
  assert.match(r.failures[0], /which > cannot compare/);
});

test('a malformed assertion throws instead of silently passing', () => {
  assert.throws(
    () => assertOutcome({ artifact: tmpSummary(HEALTHY), require: ['totals.errors'] }),
    /cannot parse assertion/
  );
});

// ── expression parsing ───────────────────────────────────────────────────────

test('>= is parsed as >=, not as > followed by =', () => {
  assert.deepStrictEqual(parseExpr('totals.updated>=1882'), {
    path: 'totals.updated', op: '>=', value: 1882, raw: 'totals.updated>=1882',
  });
});

test('booleans and strings work with == and !=', () => {
  const p = tmpSummary({ dryRun: false, mode: 'live' });
  assert.strictEqual(assertOutcome({ artifact: p, require: ['dryRun==false'] }).ok, true);
  assert.strictEqual(assertOutcome({ artifact: p, require: ['mode!=dry'] }).ok, true);
  assert.strictEqual(assertOutcome({ artifact: p, require: ['mode==dry'] }).ok, false);
});

test('coerce maps the literals it should and leaves everything else a string', () => {
  assert.strictEqual(coerce('true'), true);
  assert.strictEqual(coerce('false'), false);
  assert.strictEqual(coerce('null'), null);
  assert.strictEqual(coerce('12'), 12);
  assert.strictEqual(coerce('dry'), 'dry');
});

test('readPath does not confuse a missing key with a falsy value', () => {
  assert.strictEqual(readPath({ a: { b: 0 } }, 'a.b'), 0);
  assert.strictEqual(readPath({ a: { b: 0 } }, 'a.c'), undefined);
  assert.strictEqual(readPath({ a: null }, 'a.b'), undefined);
});

test('every failing invariant is reported, not just the first', () => {
  const bad = { totals: { errors: 3, updated: 0 } };
  const r = assertOutcome({ artifact: tmpSummary(bad), require: ['totals.errors==0', 'totals.updated>0'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failures.length, 2);
});
