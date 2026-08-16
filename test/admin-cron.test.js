// Cron interval estimation — what the workflows panel's "overdue" badge means.
//
// The badge is a claim about the pipeline: "this has stopped running". A wrong
// interval produces either a false alarm (which trains you to ignore the badge)
// or a silent one (which is the failure the dashboard exists to prevent). So the
// estimator is a tested module rather than a helper buried in the page script.
//
// It is deliberately approximate — see admin/public/cron.js — and the UI only
// flags after TWICE the estimate, so these tests assert the right ballpark and
// the right ORDERING, not exact fire times.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { cronIntervalHours, describeCron } from '../admin/public/cron.js';

test('every cron actually present in this repo is parsed', () => {
  // If a real schedule returned null, its workflow would silently lose the
  // overdue check while still looking fully monitored.
  const real = {
    '0 3 * * *': 24,        // asin-identity-audit — daily
    '*/30 * * * *': 0.5,    // epik-watchdog — every 30 minutes
    '0 6 * * *': 24,        // prerender — daily
    '0 7 * * *': 24,        // price-history — daily
    '0 12 * * *': 24,       // sftp-ingest — daily
    '0 6,18 * * *': 12,     // refresh-newegg-prices (currently commented out)
    '0 8 */2 * *': 48,      // verify-catalog tier 1
    '0 9 */3 * *': 72,      // verify-catalog tier 2
    '0 10 * * 1': 168,      // verify-catalog tier 3 — Mondays
    '0 11 * * 1': 168,      // verify-catalog tier 4 — Mondays
  };
  for (const [expr, hours] of Object.entries(real)) {
    assert.equal(cronIntervalHours(expr), hours, `${expr} should be ~${hours}h`);
  }
});

test('tier intervals order correctly — the property the badge relies on', () => {
  // Tier 1 must never be flagged overdue before tier 3 for the same silence.
  const t1 = cronIntervalHours('0 8 */2 * *');
  const t2 = cronIntervalHours('0 9 */3 * *');
  const t3 = cronIntervalHours('0 10 * * 1');
  assert.ok(t1 < t2 && t2 < t3, `expected t1 < t2 < t3, got ${t1}/${t2}/${t3}`);
});

test('multiple hours in a day shorten the interval', () => {
  assert.equal(cronIntervalHours('0 * * * *'), 1);
  assert.equal(cronIntervalHours('0 0,12 * * *'), 12);
  assert.equal(cronIntervalHours('0 0,6,12,18 * * *'), 6);
});

test('a multi-day day-of-week pin divides the week', () => {
  assert.equal(cronIntervalHours('0 10 * * 1'), 168);
  assert.equal(cronIntervalHours('0 10 * * 1,4'), 84);
});

test('unparseable input returns null rather than a wrong number', () => {
  // Returning a plausible-looking guess for something we cannot read is how a
  // dashboard ends up confidently wrong.
  for (const bad of ['', null, undefined, 'not a cron', '0 8 * *', '0 8 * * * *', '*/0 * * * *', '0 8 */0 * *']) {
    assert.equal(cronIntervalHours(bad), null, `${bad} should be null`);
  }
});

test('describeCron renders the shapes the UI shows', () => {
  assert.equal(describeCron('*/30 * * * *'), 'every 30m');
  assert.equal(describeCron('0 6,18 * * *'), 'every 12h');
  assert.equal(describeCron('0 3 * * *'), 'daily');
  assert.equal(describeCron('0 8 */2 * *'), 'every 2d');
  assert.equal(describeCron('0 10 * * 1'), 'weekly');
});

test('describeCron falls back to the raw expression it cannot read', () => {
  assert.equal(describeCron('nonsense'), 'nonsense');
});

test('the estimator agrees with the schedules the derive script finds', async () => {
  // Ties the two halves together: every ACTIVE cron the dashboard will display
  // must be one the estimator can read.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const derive = require('./../scripts/derive-constants.cjs');
  for (const w of derive.deriveSchedules()) {
    for (const c of w.crons) {
      assert.notEqual(cronIntervalHours(c), null, `${w.file} cron '${c}' is unreadable to the overdue check`);
    }
  }
});
