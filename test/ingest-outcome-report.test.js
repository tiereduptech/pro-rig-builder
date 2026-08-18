/**
 * test/ingest-outcome-report.test.js
 *
 * The shape being tested is the one that hid for 95 days: a workflow that keeps
 * getting scheduled, keeps getting cancelled, and never once reports a failure.
 */

import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { judgeRuns } = require("../scripts/ingest-outcome-report.cjs");


const NOW = Date.parse('2026-08-18T18:00:00.000Z');
const DAY = 86400000;

const run = (conclusion, daysAgo, status = 'completed') => ({
  status,
  conclusion,
  created_at: new Date(NOW - daysAgo * DAY).toISOString(),
});

test('a healthy daily ingest is not red', () => {
  const v = judgeRuns({ runs: [run('success', 0.3), run('success', 1.3), run('success', 2.3)], now: NOW });
  assert.strictEqual(v.red, false);
  assert.deepStrictEqual(v.reasons, []);
  assert.ok(v.lastSuccessAgeDays < 1);
});

test('the cancellation storm goes red — the signature that sent no notification', () => {
  // 88 of 99 cancelled: here the recent tail, with a success still inside the
  // staleness window so that ONLY the streak rule can catch it.
  const runs = [run('cancelled', 0.3), run('cancelled', 1.3), run('cancelled', 2.3), run('success', 2.9)];
  const v = judgeRuns({ runs, now: NOW, staleDays: 3 });
  assert.strictEqual(v.red, true);
  assert.strictEqual(v.cancelStreak, 3);
  assert.ok(v.reasons.some((r) => /cancelled 3 times in a row/.test(r)), v.reasons.join('; '));
});

test('a stale ingest goes red even when nothing is being cancelled', () => {
  const v = judgeRuns({ runs: [run('failure', 1), run('success', 9)], now: NOW, staleDays: 3 });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /last succeeded 9\.0 days ago/.test(r)), v.reasons.join('; '));
});

test('never having succeeded at all is red and says so plainly', () => {
  const v = judgeRuns({ runs: [run('cancelled', 1), run('failure', 2)], now: NOW });
  assert.strictEqual(v.red, true);
  assert.strictEqual(v.lastSuccessAt, null);
  assert.ok(v.reasons.some((r) => /has not succeeded once/.test(r)), v.reasons.join('; '));
});

test('a workflow that is not running at all is red', () => {
  const v = judgeRuns({ runs: [], now: NOW });
  assert.strictEqual(v.red, true);
  assert.match(v.reasons[0], /no completed runs at all/);
});

test('in-progress runs do not count as a verdict either way', () => {
  // The nightly is mid-flight. That must neither satisfy staleness nor break
  // the cancellation streak, or the report flickers with the schedule.
  const runs = [
    { status: 'in_progress', conclusion: null, created_at: new Date(NOW).toISOString() },
    run('cancelled', 0.5),
    run('cancelled', 1.5),
    run('cancelled', 2.5),
  ];
  const v = judgeRuns({ runs, now: NOW, staleDays: 3 });
  assert.strictEqual(v.cancelStreak, 3);
  assert.strictEqual(v.red, true);
});

test('a cancellation streak below the threshold is only a note, not an alarm', () => {
  const v = judgeRuns({ runs: [run('cancelled', 0.2), run('success', 0.9)], now: NOW, cancelStreak: 3 });
  assert.strictEqual(v.red, false);
  assert.strictEqual(v.cancelStreak, 1);
  assert.ok(v.notes.some((n) => /succeeding, but wastefully/.test(n)), v.notes.join('; '));
});

test('the streak counts only the newest consecutive run, not cancellations in general', () => {
  const runs = [run('success', 0.2), run('cancelled', 1.2), run('cancelled', 2.2)];
  const v = judgeRuns({ runs, now: NOW, staleDays: 3, cancelStreak: 2 });
  assert.strictEqual(v.cancelStreak, 0);
  assert.strictEqual(v.red, false);
});

test('thresholds are configurable in both directions', () => {
  const runs = [run('success', 5)];
  assert.strictEqual(judgeRuns({ runs, now: NOW, staleDays: 3 }).red, true);
  assert.strictEqual(judgeRuns({ runs, now: NOW, staleDays: 7 }).red, false);
});

test('conclusion counts are reported for the window', () => {
  const runs = [run('cancelled', 1), run('cancelled', 2), run('success', 3), run('failure', 4)];
  const v = judgeRuns({ runs, now: NOW, staleDays: 30, cancelStreak: 5 });
  assert.strictEqual(v.counts.cancelled, 2);
  assert.strictEqual(v.counts.success, 1);
  assert.strictEqual(v.counts.failure, 1);
});
