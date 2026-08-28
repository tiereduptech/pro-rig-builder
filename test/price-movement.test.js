/**
 * test/price-movement.test.js
 *
 * The behaviour under test is the blind spot that let Best Buy freeze for four
 * months: a freshness number built as a MAX reports healthy while almost the
 * whole catalog behind it is frozen. One active SKU is not evidence about 156
 * others, and these tests exist to keep that from being true again.
 */

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const {
  movement, movementFor, watchEpoch, isPriced,
  MOVEMENT_WINDOW_DAYS, MIN_MOVED_SHARE,
} = require("../scripts/price-movement.cjs");

const TODAY = '2026-09-30';
// Far enough back that every case below is past warm-up unless it says otherwise.
const LONG_AGO = '2026-01-01';

/** A priced retailer row whose price last moved `agoDays` ago (null = never). */
function row(retailer, agoDays, extra = {}) {
  const deal = { price: 199.99, url: 'https://example.test/x', ...extra };
  if (agoDays != null) {
    const d = new Date(Date.parse(TODAY + 'T00:00:00Z') - agoDays * 86400000);
    deal.priceLastMovedAt = d.toISOString().slice(0, 10);
  }
  return { deals: { [retailer]: deal } };
}

function run(parts, over = {}) {
  return movement({ parts, retailer: 'msi', today: TODAY, watchStartedAt: LONG_AGO, ...over });
}

// ── the bug this file exists for ─────────────────────────────────────────────

test('one active SKU does not vouch for 156 frozen ones', () => {
  const parts = [row('msi', 0), ...Array.from({ length: 156 }, () => row('msi', 120))];
  const m = run(parts);

  // The old signal is perfectly happy: something moved today.
  assert.strictEqual(m.daysSinceAnyPriceMoved, 0);
  // The new one is not.
  assert.strictEqual(m.freezeAlarm, 1);
  assert.strictEqual(m.movedInWindow, 1);
  assert.strictEqual(m.pricedRows, 157);
  assert.match(m.freezeReason, /1 of 157 priced msi rows/);
  assert.match(m.freezeReason, /0\.6%/);
  // And it says where the bulk actually sits.
  assert.strictEqual(m.medianAgeDays, 120);
});

test('a total freeze is caught by both the share and the max', () => {
  const m = run(Array.from({ length: 50 }, () => row('msi', 200)));
  assert.strictEqual(m.freezeAlarm, 1);
  assert.strictEqual(m.movedInWindow, 0);
  assert.strictEqual(m.daysSinceAnyPriceMoved, 200);
});

test('a live retailer passes — 22% moved, the rate Best Buy actually runs at', () => {
  // 8-day observed union was 193/874; this is that shape at catalog scale.
  const moved = Array.from({ length: 193 }, (_, i) => row('msi', i % 8));
  const rest = Array.from({ length: 681 }, (_, i) => row('msi', 30 + (i % 90)));
  const m = run([...moved, ...rest]);

  assert.strictEqual(m.freezeAlarm, 0);
  assert.strictEqual(m.movedInWindow, 193);
  assert.ok(m.movedShare > MIN_MOVED_SHARE, `${m.movedShare} should clear the floor`);
});

test('the floor sits between the two — 10% passes, 9% fails', () => {
  const at = (n) => run([
    ...Array.from({ length: n }, () => row('msi', 1)),
    ...Array.from({ length: 100 - n }, () => row('msi', 300)),
  ]);
  assert.strictEqual(at(10).freezeAlarm, 0);
  assert.strictEqual(at(9).freezeAlarm, 1);
});

// ── the denominator ──────────────────────────────────────────────────────────

test('rows that have never moved are counted, not quietly dropped', () => {
  // 5 moving rows would be 100% of "rows that have ever moved" — the denominator
  // that drifts. Against all 105 priced rows it is 4.8%, which is the truth.
  const parts = [
    ...Array.from({ length: 5 }, () => row('msi', 2)),
    ...Array.from({ length: 100 }, () => row('msi', null)),
  ];
  const m = run(parts);
  assert.strictEqual(m.pricedRows, 105);
  assert.strictEqual(m.everMoved, 5);
  assert.strictEqual(m.neverMoved, 100);
  assert.strictEqual(m.freezeAlarm, 1);
});

test('a row the site cannot price is not part of the population', () => {
  // A deal with a url but no price — the shape a withdrawn price leaves behind.
  const parts = [
    ...Array.from({ length: 10 }, () => row('msi', 1)),
    ...Array.from({ length: 90 }, () => ({ deals: { msi: { url: 'https://example.test/x' } } })),
  ];
  const m = run(parts);
  assert.strictEqual(m.pricedRows, 10);
  assert.strictEqual(m.unpricedRows, 90);
  assert.strictEqual(m.movedShare, 1);
  assert.strictEqual(m.freezeAlarm, 0);
});

test('saleprice alone makes a row priced', () => {
  assert.strictEqual(isPriced({ saleprice: 10 }), true);
  assert.strictEqual(isPriced({ price: 0, saleprice: 0 }), false);
  assert.strictEqual(isPriced({ url: 'x' }), false);
  assert.strictEqual(isPriced(null), false);
});

test('another retailer on the same product is ignored', () => {
  const parts = [
    { deals: { msi: { price: 1, priceLastMovedAt: '2026-09-29' }, bestbuy: { price: 1 } } },
    { deals: { bestbuy: { price: 1 } } },
  ];
  const m = run(parts);
  assert.strictEqual(m.pricedRows, 1);
  assert.strictEqual(m.movedInWindow, 1);
});

// ── warm-up ──────────────────────────────────────────────────────────────────

test('the share alarm is suppressed until a full window has been watched', () => {
  const parts = Array.from({ length: 100 }, () => row('msi', 300));
  const m = run(parts, { watchStartedAt: '2026-09-25' }); // 5 days watched

  assert.strictEqual(m.warmedUp, false);
  assert.strictEqual(m.warmupDaysRemaining, MOVEMENT_WINDOW_DAYS - 5);
  assert.strictEqual(m.freezeAlarm, 0);
  assert.match(m.note, /warming up — 5d of 14d/);
  // Suppressed, but not blind: the max is armed from the first stamp.
  assert.strictEqual(m.daysSinceAnyPriceMoved, 300);
});

test('warm-up clears on schedule and then fires — a freeze cannot hold itself in it', () => {
  const parts = Array.from({ length: 100 }, () => row('msi', 300));
  const dayBefore = run(parts, { watchStartedAt: '2026-09-17' }); // 13d
  const dayAfter = run(parts, { watchStartedAt: '2026-09-16' });  // 14d
  assert.strictEqual(dayBefore.freezeAlarm, 0);
  assert.strictEqual(dayAfter.freezeAlarm, 1);
});

// ── the epoch file ───────────────────────────────────────────────────────────

function tmpWatch(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-movement-'));
  const p = path.join(dir, 'price-movement-watch.json');
  if (contents != null) fs.writeFileSync(p, JSON.stringify(contents));
  return p;
}

test('a dry run does not start the warm-up clock', () => {
  const file = tmpWatch(null);
  const got = watchEpoch('msi', TODAY, { file, write: false });
  assert.strictEqual(got, TODAY);
  assert.strictEqual(fs.existsSync(file), false, 'a dry run must not write the epoch');
});

test('an apply run records the epoch once and never moves it', () => {
  const file = tmpWatch(null);
  assert.strictEqual(watchEpoch('msi', '2026-08-28', { file, write: true }), '2026-08-28');
  assert.strictEqual(watchEpoch('msi', '2026-09-30', { file, write: true }), '2026-08-28');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { msi: '2026-08-28' });
});

test('a missing or corrupt epoch file is a first run, not a crash', () => {
  const file = tmpWatch(null);
  fs.writeFileSync(file, '{ this is not json');
  assert.strictEqual(watchEpoch('msi', TODAY, { file, write: false }), TODAY);
});

test('movementFor threads the recorded epoch into the measurement', () => {
  const file = tmpWatch({ msi: '2026-01-01' });
  const m = movementFor({
    parts: Array.from({ length: 100 }, () => row('msi', 300)),
    retailer: 'msi', today: TODAY, apply: false, watchFile: file,
  });
  assert.strictEqual(m.watchStartedAt, '2026-01-01');
  assert.strictEqual(m.warmedUp, true);
  assert.strictEqual(m.freezeAlarm, 1);
});

// ── input handling ───────────────────────────────────────────────────────────

test('an unparseable stamp is not counted as evidence of movement', () => {
  const parts = [
    { deals: { msi: { price: 1, priceLastMovedAt: 'sometime last week' } } },
    ...Array.from({ length: 99 }, () => row('msi', 300)),
  ];
  const m = run(parts);
  assert.strictEqual(m.everMoved, 99);
  assert.strictEqual(m.movedInWindow, 0);
});

test('a future stamp reads as age 0 rather than a negative age', () => {
  const parts = [{ deals: { msi: { price: 1, priceLastMovedAt: '2027-01-01' } } }];
  const m = run(parts);
  assert.strictEqual(m.daysSinceAnyPriceMoved, 0);
  assert.strictEqual(m.movedInWindow, 1);
});

test('no rows for this retailer is not an alarm', () => {
  const m = run([{ deals: { bestbuy: { price: 1 } } }]);
  assert.strictEqual(m.pricedRows, 0);
  assert.strictEqual(m.freezeAlarm, 0);
});

test('malformed arguments throw rather than silently measuring nothing', () => {
  assert.throws(() => movement({ parts: null, retailer: 'msi', today: TODAY }), /parts array/);
  assert.throws(() => movement({ parts: [], retailer: '', today: TODAY }), /retailer/);
  assert.throws(() => movement({ parts: [], retailer: 'msi', today: 'yesterday' }), /YYYY-MM-DD/);
});
