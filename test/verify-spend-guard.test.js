// Spend guards for the paid catalog verifier. These pin the contract that replaced
// the flat POST_HARD_CAP=200 (which blacked out every full-tier nightly for a week):
//   1. universal dollar ceiling over WORST-CASE projected spend (sellers + fix-asins),
//   2. scoped runs assert an EXACT resolved count (--expect-count, default id-list size),
//   3. full-tier runs bounded by a band derived from the tier's CURRENT population.
import test from 'node:test';
import assert from 'node:assert';
import {
  evaluateSpendGuard, projectSpend,
  COST_PER_SELLERS_TASK, COST_PER_ASIN_SEARCH,
  DOLLAR_CEILING, DOLLAR_CEILING_CALIBRATED_AT, DOLLAR_CEILING_MAX_AGE_DAYS,
} from '../verify-spend-guard.js';

// ── projectSpend math ────────────────────────────────────────────────────────
test('projectSpend: sellers-only vs worst-case fix-asins', () => {
  const sellersOnly = projectSpend(1000, false);
  assert.strictEqual(sellersOnly.total, 1000 * COST_PER_SELLERS_TASK);
  assert.strictEqual(sellersOnly.asinSearches, 0);

  const withAsins = projectSpend(1000, true);
  // --fix-asins adds a bounded search per resolved row (worst case: all mismatch)
  assert.strictEqual(withAsins.asinSearches, 1000 * COST_PER_ASIN_SEARCH);
  assert.strictEqual(withAsins.total, 1000 * (COST_PER_SELLERS_TASK + COST_PER_ASIN_SEARCH));
});

// ── PATH 3: full-tier band ───────────────────────────────────────────────────
test('full-tier: legit tier-1 nightly passes (the run the flat 200-cap wrongly blocked)', () => {
  // 2114 rows, --fix-asins, tier population 2114 → worst case $6.34 < $10 ceiling.
  const g = evaluateSpendGuard(2114, {
    scoped: false, tier: '1', tierBaseline: 2114, fixAsins: true, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(g.abort, false, g.reason || '');
  assert.ok(Math.abs(g.projected.total - 6.342) < 1e-6, `projected ${g.projected.total}`);
});

test('full-tier: resolving MORE than the tier holds aborts (broken tier filter)', () => {
  // Catalog-parse blowup: tier map widens, resolves 6000 vs a 2114-row tier.
  const g = evaluateSpendGuard(6000, {
    scoped: false, tier: '1', tierBaseline: 2114, fixAsins: false, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /TIER BAND/);
});

test('full-tier: band tracks CURRENT population — a grown catalog is not stale-blocked', () => {
  // Same 6000 rows, but the tier legitimately grew to 6000 → within band, spend gate decides.
  const g = evaluateSpendGuard(6000, {
    scoped: false, tier: '1', tierBaseline: 6000, fixAsins: false, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  // 6000 × $0.0015 = $9.00 < $10 → passes (would have been impossible under a flat 200 cap)
  assert.strictEqual(g.abort, false, g.reason || '');
});

test('full-tier: 0 rows aborts (nothing to verify)', () => {
  const g = evaluateSpendGuard(0, { scoped: false, tier: '2', tierBaseline: 877, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /EMPTY RUN/);
});

test('full-tier: missing tier baseline aborts (cannot verify scope)', () => {
  const g = evaluateSpendGuard(2114, { scoped: false, tier: '1', tierBaseline: null });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /TIER BAND UNKNOWN/);
});

// ── PATH 4: universal dollar ceiling ─────────────────────────────────────────
test('ceiling: a projected-overspend run aborts BEFORE posting', () => {
  // Derived from DOLLAR_CEILING rather than hard-coded: this test used to say
  // "4000 rows × $0.003 = $12 > $10" and silently stopped testing anything when the
  // ceiling moved to $12 — 4000 rows then projected EXACTLY the ceiling, and the
  // boundary is a strict >. Sized from the constant, it cannot rot that way again.
  const rows = Math.ceil((DOLLAR_CEILING + 0.01) / (COST_PER_SELLERS_TASK + COST_PER_ASIN_SEARCH));
  const g = evaluateSpendGuard(rows, {
    scoped: false, tier: '1', tierBaseline: rows * 2, fixAsins: true, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /SPEND CEILING/);
  assert.ok(g.projected.total > DOLLAR_CEILING);
});

test('ceiling: exact-$10 passes, a cent over aborts (boundary is strict >)', () => {
  const ceiling = 10;
  const atCeiling = evaluateSpendGuard(6666, {          // 6666 × $0.0015 = $9.999
    scoped: false, tier: '1', tierBaseline: 7000, fixAsins: false, ceiling, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(atCeiling.abort, false, atCeiling.reason || '');
  const overCeiling = evaluateSpendGuard(6667, {        // 6667 × $0.0015 = $10.0005
    scoped: false, tier: '1', tierBaseline: 7000, fixAsins: false, ceiling, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(overCeiling.abort, true);
  assert.match(overCeiling.reason, /SPEND CEILING/);
});

// ── PATH 2: scoped exact-count ───────────────────────────────────────────────
test('scoped: exact match passes', () => {
  const g = evaluateSpendGuard(5, { scoped: true, onlyIdsSize: 5, expectCount: 5, fixAsins: true, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(g.abort, false, g.reason || '');
});

test('scoped: resolved != expected aborts (the id filter silently failed)', () => {
  // The 2,782-row overbill shape: asked for 5, resolved the whole tier.
  const g = evaluateSpendGuard(2114, { scoped: true, onlyIdsSize: 5, expectCount: 5, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /SCOPE MISMATCH/);
});

test('scoped: --expect-count defaults to the --only-ids size when omitted', () => {
  // No explicit expectCount → defaults to onlyIdsSize=5, so 5 passes and 6 aborts.
  const ok = evaluateSpendGuard(5, { scoped: true, onlyIdsSize: 5, expectCount: null, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(ok.abort, false, ok.reason || '');
  const bad = evaluateSpendGuard(6, { scoped: true, onlyIdsSize: 5, expectCount: null, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(bad.abort, true);
  assert.match(bad.reason, /SCOPE MISMATCH/);
  assert.match(bad.reason, /defaulted from --only-ids size/);
});

// ── PATH 1: scope coherence (required: scoped run missing --only-ids) ─────────
test('--expect-count WITHOUT --only-ids aborts (scope intended, no allowlist applied)', () => {
  // The caller signalled a scope but supplied no id list — the run would bill the
  // full tier. Must abort even though, count-wise, the tier band would pass.
  const g = evaluateSpendGuard(2114, {
    scoped: false, onlyIdsSize: null, expectCount: 5, tier: '1', tierBaseline: 2114, todayISO: DOLLAR_CEILING_CALIBRATED_AT,
  });
  assert.strictEqual(g.abort, true);
  assert.match(g.reason, /SCOPE INCOHERENT/);
});

// ── ceiling calibration staleness (non-fatal, mirrors the price table) ───────
test('ceiling age warning fires past MAX_AGE, but does not itself abort', () => {
  const stale = new Date(Date.parse(DOLLAR_CEILING_CALIBRATED_AT) + (DOLLAR_CEILING_MAX_AGE_DAYS + 10) * 86400000)
    .toISOString().slice(0, 10);
  const g = evaluateSpendGuard(100, { scoped: false, tier: '1', tierBaseline: 2114, todayISO: stale });
  assert.strictEqual(g.abort, false, g.reason || '');
  assert.ok(g.warnings.some(w => /SPEND CEILING STALE/.test(w)), 'expected a staleness warning');
});

test('no age warning on the calibration date itself', () => {
  const g = evaluateSpendGuard(100, { scoped: false, tier: '1', tierBaseline: 2114, todayISO: DOLLAR_CEILING_CALIBRATED_AT });
  assert.strictEqual(g.warnings.length, 0);
});
