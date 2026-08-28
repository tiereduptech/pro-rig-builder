#!/usr/bin/env node
// =============================================================================
//  scripts/assert-retailer-freshness.cjs
//
//  Assert that every retailer in the catalog has been confirmed against its
//  retailer recently enough, and that the scheduled job responsible for doing
//  the confirming is actually still scheduled.
//
//  ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//  Best Buy prices froze for roughly four months and nothing noticed, because
//  the signal everyone was reading was manufactured. record-price-snapshot.js
//  reads src/data/parts.js and never contacts a retailer, so it appended a fresh
//  dated point every single day for retailers no job had touched since April:
//  139,080 Best Buy price points across 1,591 series, of which exactly one ever
//  changed value. Density was being read as liveness. It never was.
//
//  The lesson is not "watch Best Buy". It is that a frozen retailer is INVISIBLE
//  unless something asserts the absence of confirmation, because every derived
//  artifact downstream keeps looking healthy. Four more retailers were frozen the
//  same way and went unnoticed for the same reason.
//
//  So this gate measures the only thing that cannot be faked by a derivation:
//  the stamp a WRITE PATH leaves on a deal when it actually talked to a retailer.
//
//  ── WHY IT FAILS INSTEAD OF WARNING ─────────────────────────────────────────
//  Twice in August a real signal was emitted and ignored. refresh-newegg-prices
//  reported "0 updated" on every run from 2026-07-06 and kept deleting; the
//  Best Buy charts were visibly dead-flat in the UI for months. Both were
//  observable. Neither was actionable, because nothing had to be done about
//  them. A warning is a signal with no consequence attached, and this codebase
//  has now demonstrated twice that it will route around one. Exit code 1 is the
//  entire point of the file.
//
//  ── WHAT IS DERIVED VS STATED ───────────────────────────────────────────────
//  Following scripts/derive-constants.cjs: nothing about the schedule is
//  transcribed. Each retailer names the workflow and cron responsible for
//  confirming it, and this gate goes and READS that workflow to check the cron
//  is still live. The staleness budget is then computed from that cron's real
//  interval via one stated policy (MISSED_CYCLES_ALLOWED / MIN_BUDGET_DAYS)
//  rather than hand-written per retailer, so a schedule change cannot silently
//  invalidate the budget it justified.
//
//  That second layer is the one that would have caught Newegg. Its cron was
//  commented out on 2026-07-20 and the data took weeks to visibly rot; the
//  disabled schedule was detectable the same day.
//
//  Usage:
//    node scripts/assert-retailer-freshness.cjs           # assert, exit 1 on failure
//    node scripts/assert-retailer-freshness.cjs --json     # machine-readable tally
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Overridable so the gate can be PROVEN to fire against doctored inputs without
// touching the real tree — the same affordance, for the same reason, as WF_DIR in
// scripts/derive-constants.cjs and test/verify-main-writer-lock.cjs. A guard only
// ever seen passing is not known to be discriminating.
const DEFAULT_WF_DIR = path.join(ROOT, '.github', 'workflows');
const DEFAULT_PARTS = path.join(ROOT, 'src', 'data', 'parts.js');

// ── stamp vocabulary ────────────────────────────────────────────────────────
//
// A deal is "confirmed" only by a stamp a write path left on it after contacting
// the retailer. Verified against the live catalog rather than assumed — these are
// the only *At fields that actually occur on deal objects today:
//
//   priceConfirmedAt   amazon (2,810) · newegg (893) · bestbuy (9) · newegg_marketplace (31)
//   matchedAt          newegg (2,666) · newegg_openbox (60) · newegg_marketplace (37)
//   priceUnconfirmedAt amazon (777) — an explicit "we tried and could NOT confirm"
//
// refreshedAt is included below even though it is currently on ZERO rows. It is
// what refresh-newegg-prices.cjs:466 writes on a successful re-price, and the
// reason its own workflow cites "0 of 5,428 products carry refreshedAt" as
// evidence the job never worked. The moment that cron is re-enabled it becomes
// the live Newegg confirmation stamp, and a gate that did not count it would
// report a working re-pricer as a frozen retailer.
const CONFIRMATION_STAMPS = ['priceConfirmedAt', 'matchedAt', 'refreshedAt'];

// An explicit failure NEWER than the last success means the most recent thing we
// know is that we could not confirm the price. Mirrors priceFreshness() in
// src/App.jsx, which applies the same precedence rule for the same reason.
const NEGATIVE_STAMP = 'priceUnconfirmedAt';

// ── staleness policy ────────────────────────────────────────────────────────
//
// Two stated numbers, applied uniformly, instead of a hand-picked budget per
// retailer. Per-retailer magic numbers are how a threshold ends up defensible to
// nobody: it is picked by feel, the schedule it was picked against changes, and
// the number stays.

// A retailer may miss this many of its own scheduled confirmation cycles before
// the gate fails. TWO, not one: a single miss is ordinary — a skipped run, a
// rebase collision on the main-writer lock, a retry that lands after midnight.
// Two consecutive misses is not jitter, it is a job that has stopped working.
// Same reasoning, and the same answer, as PRICE_STALE_AFTER_DAYS in src/App.jsx:
// weekly slowest tier x 2 missed cycles = the 14 days that file settled on.
const MISSED_CYCLES_ALLOWED = 2;

// Floor under the computed budget. Without it, a twice-daily job like
// refresh-newegg-prices ('0 6,18 * * *') gets a 1-day budget, and any single
// weekend of queue backlog reads as a frozen retailer. Three days is the
// smallest window that survives a Friday-evening failure plus a weekend without
// crying wolf — and an alarm that cries wolf is an alarm that gets commented out,
// which is the specific outcome this whole file exists to prevent.
const MIN_BUDGET_DAYS = 3;

// =============================================================================
//  THE TABLE
//
//  One entry per retailer that appears in src/data/parts.js. Every entry either
//  names the scheduled job that confirms it, or states plainly that no such job
//  exists. There is no third option and no default — a retailer missing from
//  this table fails the gate (see 'unknown-retailer'), which is what stops the
//  next silently-added retailer from repeating msi's four months of nothing.
// =============================================================================
const CADENCE = {
  amazon: {
    confirmedBy: { workflow: 'verify-catalog.yml', cron: '0 11 * * *' },
    why:
      'verify-catalog.yml runs verify-catalog-asins.js in four tiers. The cadence was rewritten ' +
      'on 2026-08-25 (01008c23c79): tier 1 — the primary build components — twice a day at 08:00 ' +
      'and 20:00, and tiers 2, 3 and 4 once a day at 09:00, 10:00 and 11:00. The old citation ' +
      'here was the pre-rewrite weekly tier (0 10 * * 1) and this gate correctly reported it as ' +
      'cite-drift once the schedule moved underneath it. ' +
      'Tier 4 at 11:00 is cited because the SLOWEST tier sets the budget for every Amazon row, ' +
      'and all four are now daily — so the budget is a daily one. This is the retailer ' +
      'demonstrably working: 3,140 of 3,755 rows confirmed, newest stamp today, median age 0d.',
  },

  newegg: {
    confirmedBy: { workflow: 'refresh-newegg-prices.yml', cron: '0 6,18 * * *' },
    why:
      'refresh-newegg-prices.cjs is the designated re-pricer — its own header calls it the ' +
      'daily Newegg re-price / re-match. Cited deliberately even though its cron is currently ' +
      'commented out: it is the job that SHOULD confirm Newegg, so citing anything else would ' +
      'paper over the gap. While it stays disabled this gate fails with schedule-disabled, ' +
      'which is correct and is the alarm working. sftp-ingest.yml is not the right cite — it ' +
      'stamps matchedAt only on newly attached deals (sftp-ingest.cjs:411), so it refreshes ' +
      'nothing for a row already in the catalog.',
  },

  bestbuy: {
    confirmedBy: { workflow: 'refresh-bestbuy-prices.yml', cron: '0 1 * * *' },
    why:
      'This entry used to read "NO REFRESHER EXISTS", and it was right: Best Buy prices were ' +
      'captured once at merge time by bestbuy-merge.js and never touched again. The fix it asked ' +
      'for — "a refresher that reads SKUs from parts.js and writes priceConfirmedAt" — was built ' +
      'and its cron went on with the first watched apply run on 2026-08-19 (cf8337013a7: 561 ' +
      'prices, 39 stock flips, 175 held). 885 of 1,040 rows now carry priceConfirmedAt at a ' +
      'median age of 0 days. ' +
      'The refresher HOLDS a price it will not vouch for rather than laundering it — an upstream ' +
      'stamp older than 90 days, a peer retailer contradicting the number, a sku that names a ' +
      'different product — and a held row is deliberately not stamped, so the age this gate reads ' +
      'stays the age of the last CONFIRMED price. That is why the 155 unstamped rows are the gate ' +
      'working rather than the job failing.',
  },

  msi: {
    confirmedBy: { workflow: 'refresh-msi-prices.yml', cron: '0 2 * * *' },
    why:
      'The retailer this gate was written about. deals.msi was written once on 2026-05-27 and ' +
      'never re-read: 157 rows, not one stamp of any kind, the only retailer in the catalog with ' +
      'none. It reached that state because it had a link and no updater, which is the ' +
      'unknown-retailer case this table exists to make impossible. ' +
      'refresh-msi-impact.mjs is the updater; refresh-msi-prices.yml runs it daily at 02:00, ' +
      'after the Best Buy refresh finishes and before the 06:00 prerender. ' +
      'NOTE the ingest is deliberately NOT cited here. ingest-msi-impact-v2.cjs decides which ' +
      'catalog row an MSI item belongs to, and a scheduled job must not be able to relink the ' +
      'catalog — the refresher only moves price and stock on rows whose identity is already ' +
      'settled, which is the same reason sftp-ingest.yml is not the right cite for newegg. ' +
      'Impact returns no per-item upstream timestamp, so MSI rows cannot get the 90-day upstream ' +
      'hold Best Buy rows get. The compensating check is daysSinceAnyPriceMoved, asserted in the ' +
      'workflow against a stamp only a real price change can advance, because a frozen Impact ' +
      'feed would otherwise produce a green run and a fresh priceConfirmedAt on a May price.',
  },

  newegg_openbox: {
    unscheduled:
      'Written only by one-off scripts (phase2-name-match-newegg.cjs, case-gate-audit.cjs, ' +
      'dedupe-case-batch.cjs) — no scheduled job touches it. Newest matchedAt is 2026-05-15. ' +
      'This is the most volatile inventory in the catalog: open-box listings are single-unit and ' +
      'disappear fast, so a three-month-old open-box price is likelier to be wrong than any other ' +
      'row here. Either bring these 60 rows into the Newegg re-pricer or drop them.',
  },

  newegg_marketplace: {
    unscheduled:
      'Written only by dedupe-case-batch.cjs — no scheduled job. Newest stamp 2026-08-10, and its ' +
      'price history begins 2026-08-12 with no value ever changing. Newest of the frozen retailers ' +
      'and the cheapest to fix: 37 rows, and they share the Newegg feed, so folding them into the ' +
      're-pricer alongside newegg is the natural home.',
  },
};

// =============================================================================
//  cron interval
// =============================================================================

const DAY_MS = 86400000;

/**
 * Interval between consecutive firings of a cron expression, in days.
 *
 * Deliberately handles ONLY the shapes this repo actually uses and THROWS on
 * anything else. Guessing an interval would silently produce a wrong budget,
 * which is worse than failing: the gate would keep passing with a threshold
 * nobody chose. Same principle as matchOnce() in derive-constants.cjs — an
 * ambiguous parse is a defect, not a fallback.
 *
 * Supported: 'M H * * *' daily · 'M H,H,... * * *' n-times-daily ·
 *            'M H *\/N * *' every N days · 'M H * * D' weekly · '*\/N * * * *' every N minutes
 */
function cronIntervalDays(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron '${expr}': expected 5 fields, got ${f.length}`);
  const [min, hour, dom, mon, dow] = f;

  if (mon !== '*') throw new Error(`cron '${expr}': month restrictions are not modelled`);

  // */N in the minute field — sub-daily polling (epik-watchdog).
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && dow === '*') {
    return Number(min.slice(2)) / (24 * 60);
  }
  if (!/^\d+$/.test(min)) throw new Error(`cron '${expr}': unsupported minute field '${min}'`);

  // Weekly (or n-times-weekly) via day-of-week.
  if (dow !== '*') {
    if (dom !== '*') throw new Error(`cron '${expr}': both day-of-month and day-of-week set`);
    const days = dow.split(',');
    if (!days.every((d) => /^\d+$/.test(d))) throw new Error(`cron '${expr}': unsupported day-of-week '${dow}'`);
    return 7 / days.length;
  }

  // Every N days via */N in day-of-month. Approximate by construction: month
  // boundaries reset the cycle, so the true worst-case gap is larger than N.
  // Erring long here would shrink the budget and cause false alarms, so the
  // nominal N is used and the month-boundary slack is absorbed by
  // MISSED_CYCLES_ALLOWED.
  if (/^\*\/\d+$/.test(dom)) {
    const n = Number(dom.slice(2));
    if (!(n > 0)) throw new Error(`cron '${expr}': bad day step '${dom}'`);
    return n * hoursPerDayFactor(hour, expr);
  }
  if (dom !== '*') throw new Error(`cron '${expr}': unsupported day-of-month '${dom}'`);

  return hoursPerDayFactor(hour, expr);
}

/** Days between firings within a single day, from the hour field. */
function hoursPerDayFactor(hour, expr) {
  if (hour === '*') return 1 / 24;
  const hours = hour.split(',');
  if (!hours.every((h) => /^\d+$/.test(h))) throw new Error(`cron '${expr}': unsupported hour field '${hour}'`);
  return 1 / hours.length;
}

/** The stated policy, applied. */
function budgetDaysFor(intervalDays) {
  return Math.max(MIN_BUDGET_DAYS, Math.ceil(intervalDays * MISSED_CYCLES_ALLOWED));
}

// =============================================================================
//  workflow schedule reading
// =============================================================================

/**
 * Live and disabled crons for one workflow file.
 *
 * The commented-cron pattern is the load-bearing half. derive-constants.cjs
 * carries the same distinction for the same reason: showing a disabled schedule
 * as active is exactly the "expected every 12h, last ran in July" confusion
 * being prevented here.
 */
function readSchedule(wfDir, file) {
  const p = path.join(wfDir, file);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return {
    file,
    live: [...text.matchAll(/^\s{4,}- cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    disabled: [...text.matchAll(/^\s*#\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  };
}

// =============================================================================
//  catalog reading
// =============================================================================

const dayOnly = (t) => (t ? String(t).slice(0, 10) : null);

/** Per-retailer stamp rollup from parts.js. */
async function readCatalog(partsPath) {
  if (!fs.existsSync(partsPath)) throw new Error(`parts.js not found at ${partsPath}`);
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) throw new Error(`${partsPath} did not export a PARTS array`);

  const retailers = {};
  for (const p of parts) {
    const deals = (p && p.deals) || {};
    for (const [name, d] of Object.entries(deals)) {
      if (!d || typeof d !== 'object') continue;
      const r = (retailers[name] ??= { rows: 0, stamped: 0, negative: 0, newest: null, byStamp: {} });
      r.rows++;

      const found = [];
      for (const field of CONFIRMATION_STAMPS) {
        const v = dayOnly(d[field]);
        if (v) { found.push(v); r.byStamp[field] = (r.byStamp[field] || 0) + 1; }
      }
      if (d[NEGATIVE_STAMP]) r.negative++;

      if (!found.length) continue;
      const best = found.sort()[found.length - 1];

      // A negative stamp newer than every positive one means the newest thing we
      // know is a failure to confirm. It must not count as confirmation.
      const failedAt = dayOnly(d[NEGATIVE_STAMP]);
      if (failedAt && failedAt > best) continue;

      r.stamped++;
      if (!r.newest || best > r.newest) r.newest = best;
    }
  }
  return { total: parts.length, retailers };
}

// =============================================================================
//  audit
// =============================================================================

async function audit(opts = {}) {
  const partsPath = opts.partsPath || DEFAULT_PARTS;
  const wfDir = opts.wfDir || process.env.WF_DIR || DEFAULT_WF_DIR;
  const now = opts.now ? new Date(opts.now) : new Date();
  const cadence = opts.cadence || CADENCE;

  const { total, retailers } = await readCatalog(partsPath);
  const rows = [];
  const failures = [];

  const seen = new Set(Object.keys(retailers));

  // A table entry for a retailer that is no longer in the catalog is stale
  // documentation asserting a fact about nothing. Fail so the table stays honest.
  for (const name of Object.keys(cadence)) {
    if (!seen.has(name)) {
      failures.push({
        retailer: name,
        kind: 'phantom-retailer',
        detail: `CADENCE has an entry for '${name}' but no deal in the catalog uses it — remove the entry or restore the retailer`,
      });
    }
  }

  for (const name of Object.keys(retailers).sort()) {
    const r = retailers[name];
    const spec = cadence[name];
    const row = {
      retailer: name,
      rows: r.rows,
      stamped: r.stamped,
      negative: r.negative,
      byStamp: r.byStamp,
      newest: r.newest,
      ageDays: r.newest == null ? null : Math.floor((now - Date.parse(r.newest + 'T00:00:00Z')) / DAY_MS),
      budgetDays: null,
      cite: null,
      verdict: null,
      detail: null,
    };

    // 1. Unknown retailer. The gate refuses to have an opinion it was not given,
    //    and refuses to stay silent — the msi failure mode was precisely a
    //    retailer nobody had ever written a cadence for.
    if (!spec) {
      row.verdict = 'UNKNOWN';
      row.detail = 'no CADENCE entry — add one naming the job that confirms it, or state that none exists';
      failures.push({ retailer: name, kind: 'unknown-retailer', detail: row.detail });
      rows.push(row);
      continue;
    }

    // 2. Explicitly unscheduled. Stated in the table, and still a failure: a
    //    documented gap is still a gap, and publishing prices nothing refreshes
    //    is the thing being prevented, not the thing being excused.
    if (spec.unscheduled) {
      row.verdict = 'UNSCHEDULED';
      row.detail = spec.unscheduled;
      failures.push({ retailer: name, kind: 'unscheduled', detail: spec.unscheduled });
      rows.push(row);
      continue;
    }

    if (!spec.confirmedBy || !spec.confirmedBy.workflow || !spec.confirmedBy.cron) {
      row.verdict = 'MALFORMED';
      row.detail = `CADENCE entry for '${name}' has neither unscheduled nor a complete confirmedBy {workflow, cron}`;
      failures.push({ retailer: name, kind: 'malformed-entry', detail: row.detail });
      rows.push(row);
      continue;
    }

    const { workflow, cron } = spec.confirmedBy;
    row.cite = `${workflow} [${cron}]`;
    const sched = readSchedule(wfDir, workflow);

    // 3. Provenance. Checked BEFORE staleness, because it is the earlier and
    //    more actionable signal: a disabled cron is detectable the day it is
    //    commented out, whereas the data it stops refreshing takes weeks to
    //    visibly rot. Newegg's cron was disabled 2026-07-20; this is the check
    //    that would have said so on 2026-07-20.
    if (!sched) {
      row.verdict = 'NO WORKFLOW';
      row.detail = `${workflow} does not exist in ${path.relative(ROOT, wfDir) || wfDir}`;
      failures.push({ retailer: name, kind: 'missing-workflow', detail: row.detail });
      rows.push(row);
      continue;
    }
    if (!sched.live.includes(cron)) {
      const why = sched.disabled.includes(cron)
        ? `cron '${cron}' in ${workflow} is COMMENTED OUT — the schedule that justifies this retailer's budget is not running`
        : `cron '${cron}' is not present in ${workflow} (live crons: ${sched.live.join(', ') || 'none'}) — the citation drifted from the workflow`;
      row.verdict = sched.disabled.includes(cron) ? 'SCHEDULE OFF' : 'CITE DRIFT';
      row.detail = why;
      failures.push({
        retailer: name,
        kind: sched.disabled.includes(cron) ? 'schedule-disabled' : 'cite-drift',
        detail: why,
      });
      rows.push(row);
      continue;
    }

    row.budgetDays = budgetDaysFor(cronIntervalDays(cron));

    // 4. No confirmation at all, despite having a live scheduled job. Distinct
    //    from staleness: there is no age to report, and the job has never once
    //    demonstrably worked.
    if (r.stamped === 0) {
      row.verdict = 'NEVER CONFIRMED';
      row.detail = `${r.rows} rows, zero confirmation stamps, though ${workflow} [${cron}] is scheduled — the job runs but is not confirming anything`;
      failures.push({ retailer: name, kind: 'no-stamps', detail: row.detail });
      rows.push(row);
      continue;
    }

    // 5. Staleness.
    if (row.ageDays > row.budgetDays) {
      row.verdict = 'STALE';
      row.detail =
        `newest confirmation ${row.newest} is ${row.ageDays}d old, over the ${row.budgetDays}d budget ` +
        `(${workflow} [${cron}] x ${MISSED_CYCLES_ALLOWED} missed cycles) — the job is scheduled but not landing`;
      failures.push({ retailer: name, kind: 'stale', detail: row.detail });
      rows.push(row);
      continue;
    }

    row.verdict = 'OK';
    rows.push(row);
  }

  return { total, rows, failures, policy: { MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS, CONFIRMATION_STAMPS } };
}

// =============================================================================
//  report
// =============================================================================

/**
 * Prints a TALLY, not a boolean. Following test/verify-main-writer-lock.cjs: a
 * gate that only says FAIL cannot be sanity-checked, and the number that matters
 * when this fires is which retailer and how far past its budget — not the
 * exit code.
 */
function report(a) {
  const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
  const padL = (s, n) => String(s == null ? '-' : s).padStart(n);

  console.log(`RETAILER CONFIRMATION FRESHNESS — ${a.total} products`);
  console.log(`policy: ${a.policy.MISSED_CYCLES_ALLOWED} missed cycles allowed, ${a.policy.MIN_BUDGET_DAYS}d floor`);
  console.log(`stamps: ${a.policy.CONFIRMATION_STAMPS.join(', ')}\n`);

  console.log(
    pad('RETAILER', 20) + padL('ROWS', 6) + padL('CONFIRMED', 11) + padL('NEWEST', 13) +
    padL('AGE', 6) + padL('BUDGET', 8) + '  VERDICT'
  );
  console.log('-'.repeat(88));
  for (const r of a.rows) {
    console.log(
      pad(r.retailer, 20) + padL(r.rows, 6) + padL(r.stamped, 11) + padL(r.newest, 13) +
      padL(r.ageDays == null ? '-' : r.ageDays + 'd', 6) +
      padL(r.budgetDays == null ? '-' : r.budgetDays + 'd', 8) + '  ' + r.verdict
    );
    if (r.cite) console.log(' '.repeat(20) + 'confirmed by: ' + r.cite);
  }

  if (!a.failures.length) {
    console.log(`\nPASS — all ${a.rows.length} retailers confirmed within their stated cadence.`);
    return 0;
  }

  console.log(`\nFAIL — ${a.failures.length} retailer(s) not confirmed within cadence:\n`);
  for (const f of a.failures) {
    console.log(`  [${f.kind}] ${f.retailer}`);
    for (const line of wrap(f.detail, 92)) console.log(`      ${line}`);
    console.log('');
  }
  console.log('A retailer here is publishing prices nothing is refreshing. Fix the job, or');
  console.log('drop the retailer — those are the only two outcomes that make this pass.');
  return 1;
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

module.exports = {
  audit, report, cronIntervalDays, budgetDaysFor, readSchedule, readCatalog,
  CADENCE, CONFIRMATION_STAMPS, NEGATIVE_STAMP, MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS,
  DEFAULT_WF_DIR, DEFAULT_PARTS,
};

if (require.main === module) {
  audit()
    .then((a) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(a, null, 2));
        return a.failures.length ? 1 : 0;
      }
      return report(a);
    })
    .then((code) => process.exit(code))
    .catch((e) => { console.error(String((e && e.message) || e)); process.exit(2); });
}
