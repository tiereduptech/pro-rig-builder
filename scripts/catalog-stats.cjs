#!/usr/bin/env node
// =============================================================================
//  scripts/catalog-stats.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Computes the catalog counts the admin dashboard shows, and writes them to
//  catalog-build/catalog-stats.json. See deploy/DESIGN-admin-dashboard.md §9.2.
//
//  WHY A COMMITTED FILE AND NOT A LIVE COMPUTATION: the catalog is ~8.4 MB
//  across 30 per-category modules. Parsing that inside a Pages Function on every
//  dashboard load is both over the CPU budget and pointless — the numbers only
//  change when a workflow commits to the catalog, so they are computed exactly
//  then. The Function fetches this one small file instead.
//
//  WHY A HISTORY ARRAY: the question that prompted this dashboard was
//  "the quarantine count went 1,251 -> 955 and I only knew because I asked".
//  A bare current count does not answer that. A delta does. History is keyed by
//  commit so re-running on the same commit corrects the entry rather than
//  inflating the series.
//
//  ── COUNTING RULES, AND WHY THEY ARE STATED OUT LOUD ────────────────────────
//  A count whose definition is invisible is a count nobody can trust. The rules
//  below are emitted INTO the JSON (`definitions`) and rendered in the UI, so
//  the dashboard can never mean something different from what it says.
//
//    live         !p.needsReview      — identical to the frontend filter at
//                                       App.jsx:355 and the indexability gate at
//                                       scripts/url-slugs.cjs:99. Truthiness,
//                                       not `=== true`, so this agrees with the
//                                       site even if a row carries a non-boolean.
//    quarantined  !!p.needsReview
//
//  live + quarantined === total is ASSERTED, not assumed.
//
//  ── THE BY-REASON BREAKDOWN, HONESTLY ───────────────────────────────────────
//  Two facts make a naive breakdown wrong, and both are handled here:
//
//  1. reviewFlags embeds the offending VALUE in the flag string, e.g.
//     "cpu_price:above_ceiling(2499$)". Counting raw strings gives every ceiling
//     breach its own unique "reason" with a count of 1 — noise, not a breakdown.
//     The parenthetical is stripped.
//
//  2. Most quarantined rows carry NO reason at all. Measured 2026-08-16: 1,013
//     of 1,469 (69%) have only needsReview + quarantinedAt. Those are reported
//     as unattributed rather than dropped, because a by-reason panel that does
//     not reconcile with the headline number is the exact class of quiet
//     inconsistency this dashboard exists to end.
//
//  A row may carry several flags, so per-reason row counts DO NOT sum to the
//  quarantine total and are not presented as if they do. What does reconcile is
//  `attribution` (withReason + withoutReason === quarantined), and that identity
//  is asserted too.
//
//  Usage:
//    node scripts/catalog-stats.cjs            # write catalog-build/catalog-stats.json
//    node scripts/catalog-stats.cjs --print    # compute and print, write nothing
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'catalog-build', 'catalog-stats.json');

// Keep roughly a quarter of a year of catalog-changing commits. Long enough to
// see a slow drift, short enough that the file stays a few KB and the Function
// fetch stays cheap.
const HISTORY_MAX = 120;

const DEFINITIONS = {
  total: 'every row in the catalog',
  live: '!needsReview — identical to App.jsx:355 and scripts/url-slugs.cjs:99',
  quarantined: '!!needsReview',
  byReason:
    'rows mentioning each reason; a row with several flags appears under each, ' +
    'so these DO NOT sum to the quarantine total',
  attribution:
    'withReason + withoutReason === quarantined — this is the breakdown that reconciles',
};

/** Strip the embedded value from a reviewFlag: "x:above_ceiling(2499$)" -> "x:above_ceiling". */
function normalizeFlag(flag) {
  return String(flag).replace(/\s*\(.*$/, '').trim();
}

/**
 * Every reason attributable to a row, normalized and namespaced by the field it
 * came from. Namespacing matters: `above_ceiling` occurs both as a bare
 * priceQuarantine.reason and inside a reviewFlag (`cpu_price:above_ceiling`),
 * and collapsing them would merge two different gates into one bar.
 */
function reasonsFor(part) {
  const out = [];
  const flags = part.reviewFlags;
  if (Array.isArray(flags)) {
    for (const f of flags) if (f) out.push(normalizeFlag(f));
  } else if (flags) {
    out.push(normalizeFlag(flags));
  }
  // priceQuarantine is an object: { reason, mult, cheapestSeen }.
  const pq = part.priceQuarantine;
  if (pq && pq.reason) out.push('priceQuarantine:' + normalizeFlag(pq.reason));
  // priceQuarantineReason is a one-off hand annotation and has been seen BOTH as
  // a string and as an object. Accept either rather than emitting "[object Object]".
  const pqr = part.priceQuarantineReason;
  if (pqr) {
    const r = typeof pqr === 'string' ? pqr : pqr.reason;
    if (r) out.push('priceQuarantineReason:' + normalizeFlag(r));
  }
  return [...new Set(out)];
}

/** Pure: catalog rows -> the stats payload (minus history/commit/timestamp). */
function computeStats(parts) {
  const byCategory = new Map();
  const byReason = new Map();
  let live = 0;
  let quarantined = 0;
  let withReason = 0;

  for (const p of parts) {
    const isQ = !!p.needsReview;
    if (isQ) quarantined++; else live++;

    const cat = p.c || '(uncategorized)';
    if (!byCategory.has(cat)) byCategory.set(cat, { category: cat, total: 0, live: 0, quarantined: 0 });
    const c = byCategory.get(cat);
    c.total++;
    if (isQ) c.quarantined++; else c.live++;

    if (!isQ) continue;
    const reasons = reasonsFor(p);
    if (reasons.length) withReason++;
    for (const r of reasons) {
      if (!byReason.has(r)) byReason.set(r, { reason: r, rows: 0 });
      byReason.get(r).rows++;
    }
  }

  const totals = { total: parts.length, live, quarantined };
  const attribution = { withReason, withoutReason: quarantined - withReason };

  // The two identities the UI depends on. If either breaks, the dashboard would
  // display numbers that disagree with each other — fail here instead.
  if (totals.live + totals.quarantined !== totals.total)
    throw new Error(`count identity broken: live ${live} + quarantined ${quarantined} !== total ${parts.length}`);
  if (attribution.withReason + attribution.withoutReason !== totals.quarantined)
    throw new Error(`attribution identity broken: ${attribution.withReason} + ${attribution.withoutReason} !== ${totals.quarantined}`);

  return {
    definitions: DEFINITIONS,
    totals,
    attribution,
    byCategory: [...byCategory.values()].sort((a, b) => b.total - a.total),
    byReason: [...byReason.values()].sort((a, b) => b.rows - a.rows),
  };
}

/**
 * Append this run to the series, keyed by commit. Re-running on the same commit
 * CORRECTS that entry rather than adding a duplicate — otherwise a re-run or a
 * retried job would show as a phantom zero-delta step in the chart.
 */
function mergeHistory(previous, entry) {
  const history = Array.isArray(previous) ? previous.slice() : [];
  const last = history[history.length - 1];
  if (last && last.commit === entry.commit) history[history.length - 1] = entry;
  else history.push(entry);
  return history.slice(-HISTORY_MAX);
}

function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function loadParts() {
  // The same loader prerender.cjs and scripts/url-slugs.cjs use, so the row set
  // counted here is by construction the row set the site renders.
  const url = 'file://' + path.join(ROOT, 'src/data/parts.js').replace(/\\/g, '/');
  const mod = await import(url);
  return mod.PARTS;
}

async function main() {
  const printOnly = process.argv.includes('--print');
  const parts = await loadParts();
  const stats = computeStats(parts);

  const commit = headCommit();
  const generatedAt = new Date().toISOString();
  const entry = { at: generatedAt, commit: commit.slice(0, 12), ...stats.totals };

  let previous = null;
  if (fs.existsSync(OUT)) {
    try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')); }
    catch (e) { console.warn(`WARN: existing ${path.basename(OUT)} unreadable (${e.message}) — starting a fresh history`); }
  }

  const history = mergeHistory(previous && previous.history, entry);
  // The delta the dashboard headline needs. Compared against the previous
  // DISTINCT commit, so a corrected same-commit entry never reads as "no change".
  const prior = history.length > 1 ? history[history.length - 2] : null;
  const delta = prior
    ? { since: prior.at, sinceCommit: prior.commit, total: entry.total - prior.total, live: entry.live - prior.live, quarantined: entry.quarantined - prior.quarantined }
    : null;

  const payload = { $schemaVersion: 1, generatedAt, commit, ...stats, delta, history };

  console.log(`total ${stats.totals.total}  live ${stats.totals.live}  quarantined ${stats.totals.quarantined}`);
  console.log(`quarantine attribution: ${stats.attribution.withReason} with a reason, ${stats.attribution.withoutReason} without`);
  if (delta) console.log(`delta vs ${delta.sinceCommit}: total ${delta.total >= 0 ? '+' : ''}${delta.total}, quarantined ${delta.quarantined >= 0 ? '+' : ''}${delta.quarantined}`);
  for (const r of stats.byReason.slice(0, 10)) console.log(`  ${String(r.rows).padStart(5)}  ${r.reason}`);

  if (printOnly) return;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)} (${history.length} history points)`);
}

module.exports = { computeStats, reasonsFor, normalizeFlag, mergeHistory, DEFINITIONS, HISTORY_MAX };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
