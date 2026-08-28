#!/usr/bin/env node
'use strict';
// =============================================================================
//  scripts/price-movement.cjs
//
//  Measure how much of a retailer's catalog is actually REPRICING, as a
//  distribution across rows rather than a single extreme.
//
//  ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//  refresh-msi-impact.mjs shipped `daysSinceAnyPriceMoved`: the age of the
//  NEWEST priceLastMovedAt across every MSI row. It was built to catch a frozen
//  Impact feed sailing through a green job, and against a TOTAL freeze it does.
//
//  Against a PARTIAL freeze it is blind, because it is a max. One SKU that
//  reprices weekly holds the number at 0 while the other 156 rows sit
//  untouched for months, and the job reports healthy the entire time. That is
//  not a hypothetical: it is the exact shape of the Best Buy freeze — prices
//  captured once at merge time and never refreshed, invisible for roughly four
//  months because every derived artifact downstream kept looking alive.
//
//  A single row is not evidence about a catalog. The population is.
//
//  ── WHAT IS MEASURED ────────────────────────────────────────────────────────
//  For one retailer, over the rows THE SITE ACTUALLY PRICES:
//
//    movedInWindow / pricedRows   `movedShare`  — the headline
//    medianAgeDays, p90AgeDays                  — where the bulk of rows sit
//    daysSinceAnyPriceMoved                     — the old max, kept, still useful
//
//  The denominator is every priced row, not every row that has ever moved.
//  That matters: a denominator of "rows that have ever moved" grows without
//  bound as the long tail of rarely-repriced SKUs each move once, so the share
//  drifts downward for a perfectly healthy retailer and the alarm eventually
//  fires on nothing. `pricedRows` is stable, so the threshold means the same
//  thing in six months as it does today.
//
//  "Priced" is `d.price || d.saleprice` — the same predicate src/App.jsx:771
//  uses to decide a deal is quotable. A retailer row the site cannot price is
//  not a row whose staleness can mislead anyone, so it is not counted. (This is
//  the counting rule the catalog-coverage work settled on for the same reason:
//  count what the reader reads, or a field in a shape nothing can read reports
//  as covered and hides the gap.)
//
//  ── THE THRESHOLD, AND WHY IT IS THIS NUMBER ────────────────────────────────
//  Measured, not felt. Eight consecutive Best Buy refresh runs (2026-08-21 to
//  2026-08-28, runs 32439433758..33170924880) over 1,040 catalog rows:
//
//    price moves per day     25, 44, 14, 99, 27, 17, 28, 23   (mean ~34/day)
//    distinct SKUs moved over the 8 days ....... 193 of 874   = 22.1%
//
//  So a live retailer clears 22% inside eight days, and a fourteen-day window
//  is wider still. The failure this gate must catch — one active SKU masking
//  the rest — sits at 1/874 = 0.11%.
//
//  MIN_MOVED_SHARE = 0.10 sits roughly 2x below observed-live behaviour and
//  ~90x above the failure. It is chosen for that separation, not to make
//  today's numbers pass. A threshold with no daylight on either side is one
//  that will either cry wolf or never fire, and this repo has already
//  demonstrated that an alarm which cries wolf gets commented out.
//
//  ── WARM-UP, AND WHY IT IS NOT A LOOPHOLE ───────────────────────────────────
//  A fourteen-day window cannot be measured until fourteen days of stamps
//  exist. Best Buy and Newegg start with zero — the stamp is new to them — so
//  on day 1 they would read 0% moved and the gate would fire on a retailer
//  that is working perfectly.
//
//  So the share alarm is suppressed until the retailer has been watched for a
//  full window, and the run says so out loud with the remaining day count. The
//  watch start is recorded per retailer in a COMMITTED file, for the same
//  reason the stamp itself lives in the catalog: catalog-build/ is gitignored
//  and cannot carry state from one Actions run to the next.
//
//  This is not a hole a freeze can hide in. Warm-up suppresses only the share
//  alarm; `daysSinceAnyPriceMoved` is armed from the first stamp and catches a
//  total freeze throughout. And warm-up is self-clearing on a fixed date, not
//  a condition a broken feed can hold itself in — a frozen retailer warms up
//  on exactly the same schedule as a healthy one, and then fails.
//
//  Usage:
//    const { movement } = require('./scripts/price-movement.cjs');
//    const m = movement({ parts, retailer: 'msi', today: '2026-08-28' });
//    if (m.freezeAlarm) console.log(m.freezeReason);
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The stamp only a real price change can advance. Written by every refresher
// that re-prices a retailer; see refresh-msi-impact.mjs, refresh-bestbuy-prices.mjs
// and refresh-newegg-prices.cjs. Deliberately NOT priceConfirmedAt, which
// advances every night the job runs and therefore proves only that we asked.
const MOVE_STAMP = 'priceLastMovedAt';

// The window over which movement is counted. Same 14 days as the MSI quiet-days
// assert and PRICE_STALE_AFTER_DAYS in src/App.jsx: the slowest weekly tier x
// two missed cycles, which is the interval this codebase has already settled on
// for "long enough that it is not jitter".
const MOVEMENT_WINDOW_DAYS = 14;

// See the header for the derivation. Overridable per call so a retailer with a
// demonstrably different repricing cadence can state its own number rather than
// having this one quietly stretched to fit.
const MIN_MOVED_SHARE = 0.10;

// Committed, because it must survive between Actions runs. One line per
// retailer, written once.
const DEFAULT_WATCH_FILE = path.join(ROOT, 'src', 'data', 'price-movement-watch.json');

const DAY_MS = 86400000;

/**
 * The site's own test for "this deal can be quoted", from src/App.jsx:771.
 * Kept identical on purpose: a row the site cannot price cannot mislead a
 * reader with a stale price, so it is not part of the population at risk.
 */
function isPriced(deal) {
  return !!(deal && typeof deal === 'object' && (deal.price || deal.saleprice));
}

/** '2026-08-28T13:00:00Z' | '2026-08-28' -> '2026-08-28'; anything else -> null. */
function dayOnly(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function ageInDays(stampDay, todayDay) {
  const a = Date.parse(stampDay + 'T00:00:00Z');
  const b = Date.parse(todayDay + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[i];
}

// ── the watch epoch ──────────────────────────────────────────────────────────

function readWatch(file = DEFAULT_WATCH_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // Absent or unreadable is the normal first-run state, not an error. A
    // missing epoch means "not watched yet", which the caller handles.
    return {};
  }
}

/**
 * Return the day this retailer's movement watch started, recording today as
 * that day if it has never been recorded.
 *
 * `write` is false on a dry run — a dry run that created the epoch would start
 * the warm-up clock without having written a single stamp, so the window would
 * arm fourteen days later over data that does not exist.
 *
 * `write` must be decided by ONE question only: did this run write stamps?
 * Nothing else may gate it — see the note on movementFor's `wroteStamps`.
 */
function watchEpoch(retailer, todayDay, { file = DEFAULT_WATCH_FILE, write = false } = {}) {
  const watch = readWatch(file);
  const existing = dayOnly(watch[retailer]);
  if (existing) return existing;
  if (write) {
    watch[retailer] = todayDay;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sortKeys(watch), null, 2) + '\n');
  }
  return todayDay;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ── the measurement ──────────────────────────────────────────────────────────

/**
 * @param {object}   o
 * @param {object[]} o.parts            catalog rows (each may carry .deals)
 * @param {string}   o.retailer         deals key, e.g. 'msi'
 * @param {string}   o.today            'YYYY-MM-DD'
 * @param {number}   [o.windowDays]
 * @param {number}   [o.minMovedShare]
 * @param {string}   [o.watchStartedAt] pass to avoid touching the epoch file
 */
function movement(o) {
  const {
    parts, retailer, today,
    windowDays = MOVEMENT_WINDOW_DAYS,
    minMovedShare = MIN_MOVED_SHARE,
    watchStartedAt = today,
    // Ids of the products this run actually looked at. Omit on a full run.
    // See PARTIAL RUNS below for why a limited run must pass it.
    scopeIds = null,
  } = o;

  if (!Array.isArray(parts)) throw new Error('movement() needs a parts array');
  if (!retailer) throw new Error('movement() needs a retailer');
  if (!dayOnly(today)) throw new Error(`movement() needs today as YYYY-MM-DD, got ${JSON.stringify(today)}`);

  // ── PARTIAL RUNS ───────────────────────────────────────────────────────────
  // movedShare is only a measurement when its numerator and denominator cover
  // the same rows. A run invoked with --limit moves prices on the rows it
  // sampled and on no others, so dividing those moves by the WHOLE catalog
  // produces a ratio of two different populations — one that reads as a
  // catalog health figure and is not one.
  //
  // Newegg run 33184569537 is the worked example: 37 of the 200 sampled rows
  // repriced — 19.5% of what it looked at, comfortably over the 10% floor — and
  // it reported 1.2%, because it divided by all 3,178 priced rows. The ceiling
  // on any 200-row run is 200/3178 = 6.3%, so a limited run could not clear the
  // floor even if every single row it touched moved. Once warm-up ends that is
  // not merely uninformative, it is a false PARTIAL FREEZE on a working feed.
  //
  // scopeIds narrows BOTH sides to the rows the run considered. The scheduled
  // crons pass no limit and no scopeIds, so their behaviour is unchanged.
  const scope = scopeIds == null ? null : (scopeIds instanceof Set ? scopeIds : new Set(scopeIds));

  let pricedRows = 0;
  let unpricedRows = 0;
  let catalogPricedRows = 0;
  const ages = [];          // ages of rows that have ever moved (priced rows only)
  let movedInWindow = 0;

  for (const p of parts) {
    const d = p && p.deals && p.deals[retailer];
    if (!d || typeof d !== 'object') continue;
    if (isPriced(d)) catalogPricedRows++;
    if (scope && !scope.has(p && p.id)) continue;
    if (!isPriced(d)) { unpricedRows++; continue; }
    pricedRows++;

    const stamp = dayOnly(d[MOVE_STAMP]);
    if (!stamp) continue;                    // never observed moving
    const age = ageInDays(stamp, today);
    if (age == null) continue;               // unparseable stamp is not evidence
    ages.push(age);
    if (age <= windowDays) movedInWindow++;
  }

  ages.sort((a, b) => a - b);

  const everMoved = ages.length;
  const movedShare = pricedRows ? movedInWindow / pricedRows : 0;
  const watchDays = ageInDays(watchStartedAt, today) ?? 0;
  const warmedUp = watchDays >= windowDays;

  const m = {
    retailer,
    windowDays,
    minMovedShare,
    // 'catalog' when every priced row was considered, 'sample' when the run was
    // limited. A consumer that treats a 'sample' share as a catalog figure is
    // reading the wrong number; nothing downstream arms an alarm on one.
    scope: scope ? 'sample' : 'catalog',
    scopedRows: pricedRows,
    catalogPricedRows,
    pricedRows,
    unpricedRows,
    everMoved,
    neverMoved: pricedRows - everMoved,
    movedInWindow,
    movedShare: Number(movedShare.toFixed(4)),
    stalled: pricedRows - movedInWindow,
    stalledShare: Number((pricedRows ? 1 - movedShare : 0).toFixed(4)),
    // Quantiles over the rows that have ever moved. Diagnostics: they say WHERE
    // the bulk sits when the share alarm fires, which is the first thing anyone
    // reading a red run wants to know.
    medianAgeDays: quantile(ages, 0.5),
    p90AgeDays: quantile(ages, 0.9),
    // The old max-shaped number. Kept because it is the one signal that is
    // armed during warm-up, and because a total freeze should still be
    // reportable as exactly that.
    daysSinceAnyPriceMoved: everMoved ? ages[0] : 0,
    watchStartedAt,
    watchDays,
    warmedUp,
    warmupDaysRemaining: warmedUp ? 0 : windowDays - watchDays,
    freezeAlarm: 0,
    freezeReason: null,
  };

  // A sample cannot arm the share alarm. Suppressed for the same reason warm-up
  // suppresses it — the number is real, it just is not evidence about the
  // catalog — and stated in the same place, so a reader of the block is told
  // why no alarm can fire here. daysSinceAnyPriceMoved stays armed: a total
  // freeze is still a total freeze in any sample that finds no movement at all.
  if (scope) {
    m.note =
      `SAMPLE ONLY — ${pricedRows} of ${catalogPricedRows} priced ${retailer} rows were ` +
      `considered by this run (--limit). movedShare describes those rows, NOT the catalog, ` +
      `and the share alarm cannot arm on it. Read the catalog figure from a full run.`;
    return m;
  }

  if (!warmedUp) {
    m.note =
      `warming up — ${watchDays}d of ${windowDays}d watched since ${watchStartedAt}; ` +
      `the share alarm arms in ${m.warmupDaysRemaining}d. daysSinceAnyPriceMoved is armed now.`;
    return m;
  }

  // A retailer with no priced rows has no prices to freeze. Saying nothing is
  // correct here; "this retailer has no rows" is a different alarm and belongs
  // to the retailer freshness gate, which does raise it.
  if (pricedRows === 0) return m;

  if (movedShare < minMovedShare) {
    m.freezeAlarm = 1;
    m.freezeReason =
      `${movedInWindow} of ${pricedRows} priced ${retailer} rows ` +
      `(${(movedShare * 100).toFixed(1)}%) moved price in the last ${windowDays}d, ` +
      `under the ${(minMovedShare * 100).toFixed(0)}% floor. ` +
      (everMoved
        ? `Median age of a row that has ever moved is ${m.medianAgeDays}d (p90 ${m.p90AgeDays}d); ` +
          `the newest move anywhere is ${m.daysSinceAnyPriceMoved}d old. `
        : `No ${retailer} row has ever been observed moving. `) +
      `A handful of active SKUs can hold daysSinceAnyPriceMoved at 0 while the ` +
      `catalog behind them is frozen — that is what this number is for.`;
  }

  return m;
}

/**
 * One block, ready to drop into a summary artifact under `movement`.
 *
 * `wroteStamps` answers exactly one question: did this run persist
 * priceLastMovedAt to the catalog? True on any live run, false on a dry run.
 * It was called `apply`, and both refreshers read that name as "did this run
 * apply cleanly" and passed `apply && !breakers.length`. That is the bug this
 * parameter is now named to prevent:
 *
 *   A tripped breaker blocks REMOVALS. It does not block stamps — Newegg run
 *   33189471054 tripped the 20% feed-failure breaker and still wrote 482
 *   priceLastMovedAt stamps — but it did block the epoch. So the warm-up clock
 *   restarted at 0d, and on the next run it restarted at 0d again. The alarm
 *   that exists to detect an unhealthy feed could not start its clock while the
 *   feed was unhealthy, which is the one condition it is for.
 *
 * The epoch is a timestamp recording that a live run happened. Health findings
 * from that run must never decide whether it gets recorded.
 */
function movementFor({ parts, retailer, today, wroteStamps = false, watchFile = DEFAULT_WATCH_FILE, ...rest }) {
  const watchStartedAt = watchEpoch(retailer, today, { file: watchFile, write: wroteStamps });
  return movement({ parts, retailer, today, watchStartedAt, ...rest });
}

/** The lines a refresher prints. Kept here so all three read identically. */
function report(m) {
  const lines = [];
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const sampled = m.scope === 'sample';
  lines.push(`  price movement (${m.retailer}, ${m.windowDays}d window)${sampled ? ' — SAMPLE ONLY, not a catalog figure' : ''}`);
  lines.push(`      priced rows ................. ${m.pricedRows}${sampled ? ` of ${m.catalogPricedRows} in catalog` : ''}${m.unpricedRows ? `  (+${m.unpricedRows} unpriced, not counted)` : ''}`);
  lines.push(`      moved in window ............. ${m.movedInWindow}  (${pct(m.movedShare)}${sampled ? ' of sample' : ''}, floor ${pct(m.minMovedShare)}${sampled ? ' — not applied' : ''})`);
  lines.push(`      never observed moving ....... ${m.neverMoved}`);
  lines.push(`      median / p90 age ............ ${m.medianAgeDays == null ? '-' : m.medianAgeDays + 'd'} / ${m.p90AgeDays == null ? '-' : m.p90AgeDays + 'd'}`);
  lines.push(`      newest move anywhere ........ ${m.everMoved ? m.daysSinceAnyPriceMoved + 'd' : 'never'}`);
  if (m.note) lines.push(`      ${m.note}`);
  if (m.freezeAlarm) lines.push(`      PARTIAL FREEZE — ${m.freezeReason}`);
  return lines;
}

module.exports = {
  movement, movementFor, report,
  watchEpoch, readWatch, isPriced, dayOnly, ageInDays,
  MOVE_STAMP, MOVEMENT_WINDOW_DAYS, MIN_MOVED_SHARE, DEFAULT_WATCH_FILE,
};
