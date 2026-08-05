// verify-spend-guard.js — spend guards for the paid catalog verifier.
//
// WHY THIS EXISTS: the old guard was a flat POST_HARD_CAP = 200. It was meant to
// catch a SCOPED run whose id-filter silently failed and resolved the whole tier.
// But it could not tell a broken scope from a legitimate full-tier nightly: tier 1
// is 2114 rows BY DESIGN, so every tier-1/2/3 nightly tripped the cap and aborted.
// The paid pipeline went dark for ~7 days (only tier 4, 167 rows, stayed under 200).
// See the verify-catalog.yml run history 2026-07-31..08-05.
//
// The thing we actually protect against is SPEND, not row count. So the flat cap is
// replaced by three guards, evaluated as one decision:
//
//   1. A universal per-run DOLLAR CEILING bounds projected WORST-CASE spend for BOTH
//      scoped and full-tier runs — including the variable --fix-asins ASIN searches,
//      bounded by their worst case (every resolved row a title mismatch). An
//      unbounded component would defeat the ceiling, so we assume the worst.
//   2. SCOPED runs (--only-ids) assert an EXACT resolved count (--expect-count,
//      defaulting to the id-list size). A mismatch means the id filter did not apply
//      as intended — the exact failure the 2,782-row overbill needed and lacked.
//      An --expect-count with NO --only-ids is an incoherent scope (intent to scope,
//      no allowlist applied → would bill the full tier) and also aborts.
//   3. FULL-TIER runs are bounded by a BAND derived from the tier's CURRENT catalog
//      population (computed at runtime, so it tracks the catalog and never goes
//      stale): the billable resolved set is always a subset of the tier's rows, so
//      resolving MORE than the tier contains means the tier filter widened.

// Empirical DataForSEO cost per /merchant/amazon/sellers advanced task_post.
// MEASURED from the 604-row re-verify's live task_post `cost`: $0.906/604 = $0.00150.
export const COST_PER_SELLERS_TASK = 0.0015;

// Worst-case cost per --fix-asins ASIN search (/merchant/amazon/products advanced
// task_post + polling). Same "advanced merchant amazon" family as a sellers task and
// not more expensive in this account, so we bound it at the sellers cost — a
// deliberately conservative upper bound. Charged at most once per resolved row, and
// only when --fix-asins is set.
export const COST_PER_ASIN_SEARCH = 0.0015;

// Per-run spend ceiling — the universal backstop for BOTH scoped and full-tier runs.
// $10 clears the largest legitimate run (full tier 1, 2114 rows, with --fix-asins:
// worst case 2114 × ($0.0015 sellers + $0.0015 ASIN) = $6.34) with headroom, while a
// blowup past ~3,300 fix-asins rows (or ~6,600 sellers-only) trips it.
export const DOLLAR_CEILING = 10;
// Stamp the cost basis like the price table. Past the max age the (non-fatal) age
// warning fires: a projection built on an un-reconfirmed cost can silently
// under-estimate a repriced API. Re-confirm DataForSEO task cost, then bump this.
export const DOLLAR_CEILING_CALIBRATED_AT = '2026-08-05';
export const DOLLAR_CEILING_MAX_AGE_DAYS = 90;

// Full-tier band: the billable resolved set is a SUBSET of the tier's catalog rows,
// so it must never exceed the tier's live population. bandMax = ceil(baseline × ratio)
// is computed from the CURRENT catalog every run — it grows with the catalog and
// cannot go stale. Ratio 1.0 = "resolving more than the tier holds is broken scope."
export const TIER_BAND_MAX_RATIO = 1.0;

function daysBetweenISO(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
}

/**
 * Project WORST-CASE spend for a run.
 *   resolvedCount — rows that would post a sellers task
 *   fixAsins      — whether --fix-asins is set (adds a bounded ASIN-search component)
 */
export function projectSpend(resolvedCount, fixAsins) {
  const sellers = resolvedCount * COST_PER_SELLERS_TASK;
  // --fix-asins fires at most one products-search per resolved row (a search only
  // happens for a title mismatch, and mismatches ⊆ resolved). Worst case: all miss.
  const asinSearches = fixAsins ? resolvedCount * COST_PER_ASIN_SEARCH : 0;
  return { sellers, asinSearches, total: sellers + asinSearches };
}

/**
 * The single spend-safety decision. Pure: takes the resolved count and the run's
 * shape, returns { abort, reason, warnings, projected, ... }. Never touches process
 * or the network — the caller prints and exits — so it is fully unit-testable.
 *
 *   resolvedCount — products.length after the scope/tier filter
 *   opts:
 *     scoped        — true when --only-ids was supplied
 *     onlyIdsSize   — size of the --only-ids allowlist (for the expect-count default)
 *     expectCount   — --expect-count value, or null
 *     tier          — tier label (for messages)
 *     tierBaseline  — count of CURRENT catalog rows in this tier's categories
 *                     (full-tier band reference; ignored for scoped runs)
 *     fixAsins      — whether --fix-asins is set
 *     ceiling       — dollar ceiling (defaults to DOLLAR_CEILING)
 *     todayISO      — YYYY-MM-DD for the ceiling-age warning
 */
export function evaluateSpendGuard(resolvedCount, opts = {}) {
  const {
    scoped = false, onlyIdsSize = null, expectCount = null,
    tier = '?', tierBaseline = null, fixAsins = false,
    ceiling = DOLLAR_CEILING, todayISO = null,
  } = opts;

  const warnings = [];
  const projected = projectSpend(resolvedCount, fixAsins);

  // Ceiling staleness (non-fatal) — same lesson as the price table: a cost basis
  // un-reconfirmed for > MAX_AGE days may under-project a repriced API.
  const ceilingAgeDays = todayISO ? daysBetweenISO(DOLLAR_CEILING_CALIBRATED_AT, todayISO) : null;
  if (ceilingAgeDays != null && ceilingAgeDays > DOLLAR_CEILING_MAX_AGE_DAYS)
    warnings.push(`SPEND CEILING STALE: cost basis calibrated ${DOLLAR_CEILING_CALIBRATED_AT}, ${ceilingAgeDays}d ago (> ${DOLLAR_CEILING_MAX_AGE_DAYS}d). Re-confirm DataForSEO task cost, then bump DOLLAR_CEILING_CALIBRATED_AT.`);

  const base = { warnings, projected, ceiling, ceilingAgeDays, calibratedAt: DOLLAR_CEILING_CALIBRATED_AT };
  const abort = (reason) => ({ ...base, abort: true, reason });

  // (1) Scope coherence: --expect-count with NO --only-ids means the caller intended
  // to scope but supplied no allowlist — the run would silently process the whole
  // tier. Abort rather than bill the full tier under a scoped intent.
  if (!scoped && expectCount != null)
    return abort(`SCOPE INCOHERENT: --expect-count ${expectCount} given without --only-ids. A scope was intended but no id allowlist was applied — the run would bill the full tier. Aborting, no spend.`);

  if (scoped) {
    // (2) Scoped run: assert EXACT resolved count. --expect-count is mandatory; it
    // defaults to the id-list size when omitted, so the guard is never skippable.
    const effectiveExpect = expectCount != null ? expectCount : onlyIdsSize;
    if (effectiveExpect == null)
      return abort(`SCOPE UNVERIFIABLE: scoped run (--only-ids) with no --expect-count and unknown id-list size — cannot assert scope. Aborting, no spend.`);
    if (resolvedCount !== effectiveExpect)
      return abort(`SCOPE MISMATCH: resolved ${resolvedCount} rows, expected ${effectiveExpect}${expectCount == null ? ' (defaulted from --only-ids size)' : ''}. The id filter did not apply as intended. Aborting — no fallback to a wider tier, no spend.`);
  } else {
    // (3) Full-tier run: band derived from the tier's CURRENT catalog population.
    if (tierBaseline == null)
      return abort(`TIER BAND UNKNOWN: full-tier run with no tier baseline to check against. Aborting, no spend.`);
    const bandMax = Math.ceil(tierBaseline * TIER_BAND_MAX_RATIO);
    if (resolvedCount > bandMax)
      return abort(`TIER BAND: resolved ${resolvedCount} rows > tier ${tier} population ${tierBaseline} (band max ${bandMax}). The tier filter resolved more rows than the tier contains — scope is broken. Aborting, no spend.`);
    if (resolvedCount === 0)
      return abort(`EMPTY RUN: full-tier run resolved 0 rows (tier ${tier} baseline ${tierBaseline}) — nothing to verify. Aborting, no spend.`);
  }

  // (4) Universal dollar ceiling — the backstop for BOTH paths, over WORST-CASE spend.
  if (projected.total > ceiling)
    return abort(`SPEND CEILING: projected worst-case $${projected.total.toFixed(2)} (sellers $${projected.sellers.toFixed(2)}${fixAsins ? ` + ASIN-search worst case $${projected.asinSearches.toFixed(2)}` : ''}) > ceiling $${ceiling.toFixed(2)} for ${resolvedCount} rows. Aborting before posting, no spend.`);

  return { ...base, abort: false, reason: null };
}
