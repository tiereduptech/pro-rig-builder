#!/usr/bin/env node
// =============================================================================
//  scripts/derive-constants.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Emits admin/public/constants.generated.json — the pipeline constants the
//  admin dashboard displays. See deploy/DESIGN-admin-dashboard.md §9.1.
//
//  ── THE POINT OF THIS SCRIPT IS THE ASSERTIONS, NOT THE JSON ────────────────
//  A dashboard that hard-codes these numbers drifts from the code and then lies,
//  which is worse than having no dashboard: you would be reading a confident
//  wrong number instead of going to look. So every value here is DERIVED, and
//  every derivation asserts it found exactly what it expected. Rename a
//  constant, move it, or delete it, and this script FAILS THE DEPLOY. It never
//  silently serves a stale value, and it never quietly omits one.
//
//  ── TWO STRATEGIES, CHOSEN PER MODULE ───────────────────────────────────────
//  IMPORT for the pure libraries. Verified side-effect-free on import:
//    normalize-product-name.js, drift-gate.js, verify-spend-guard.js,
//    price-sanity.js, newegg-match.js, scripts/write-catalog.cjs
//  Importing is the stronger strategy — it reads the actual runtime value — so
//  it is preferred wherever it is safe.
//
//  PARSE for the CLI entrypoints, because importing them has side effects:
//    verify-catalog-asins.js calls process.exit(1) at load without --tier,
//    record-price-snapshot.js writes a file, and the discovery scripts read
//    argv. Their constants are extracted from source text with an anchored
//    pattern per value, each asserted to match exactly once.
//
//  Even for imported values the source is still scanned, to attach a file:line —
//  which double-checks that the export lives where the dashboard says it does.
//
//  Usage:
//    node scripts/derive-constants.cjs           # write the JSON
//    node scripts/derive-constants.cjs --print   # derive and print, write nothing
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'admin', 'public', 'constants.generated.json');
// Overridable so the "no workflows found" guard can be PROVEN to fire against a
// doctored copy without touching the real tree — the same affordance, for the
// same reason, as WF_DIR in test/verify-main-writer-lock.cjs. A guard only ever
// seen passing is not known to be discriminating.
const wfDir = () => process.env.WF_DIR || path.join(ROOT, '.github', 'workflows');

const srcCache = new Map();
function source(rel) {
  if (!srcCache.has(rel)) srcCache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  return srcCache.get(rel);
}

/** 1-indexed line of the first line matching `re` in `rel`. Throws if absent. */
function lineOf(rel, re) {
  const lines = source(rel).split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  throw new Error(`derive-constants: no line matching ${re} in ${rel} — the constant moved or was renamed`);
}

/**
 * Exactly-once match. A regex that matches twice is as much a defect as one that
 * matches zero times: it means the anchor is ambiguous and the value picked is
 * whichever came first, which is a coin flip that would silently survive a
 * refactor.
 */
function matchOnce(rel, re, label) {
  const all = [...source(rel).matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (all.length !== 1)
    throw new Error(`derive-constants: ${label} matched ${all.length} times in ${rel} (expected exactly 1) — pattern ${re}`);
  return all[0];
}

/** Balanced-brace slice starting at the `{` that follows `anchor`. */
function braceSlice(rel, anchor, label) {
  const text = source(rel);
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error(`derive-constants: anchor for ${label} not found in ${rel}: ${anchor}`);
  let i = text.indexOf('{', at);
  if (i === -1) throw new Error(`derive-constants: no object literal after ${label} in ${rel}`);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  throw new Error(`derive-constants: unbalanced braces for ${label} in ${rel}`);
}

/** Evaluate an object/array literal lifted from our own source. */
function evalLiteral(text, label) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${text});`)();
  } catch (e) {
    throw new Error(`derive-constants: could not evaluate ${label}: ${e.message}`);
  }
}

/** `const NAME = <number|string|boolean>;` — asserted unique, value parsed. */
function scalarConst(rel, name) {
  const m = matchOnce(rel, new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`, 'm'), name);
  const raw = m[1].trim().replace(/\s*\/\/.*$/, '').trim();
  let value;
  if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
  else if (raw === 'true' || raw === 'false') value = raw === 'true';
  else if (/^'[^']*'$/.test(raw) || /^"[^"]*"$/.test(raw)) value = raw.slice(1, -1);
  else throw new Error(`derive-constants: ${name} in ${rel} is not a simple literal: ${raw}`);
  return { name, value, file: rel, line: lineOf(rel, new RegExp(`const\\s+${name}\\s*=`)) };
}

/** A CLI default, e.g. arg('price-mult', '3'). The default IS the setting. */
function argDefault(rel, flag, name, cast = Number) {
  const m = matchOnce(rel, new RegExp(`arg\\(\\s*['"]${flag}['"]\\s*,\\s*['"]([^'"]*)['"]\\s*\\)`), `${name} (--${flag} default)`);
  return {
    name,
    value: cast === Number ? Number(m[1]) : m[1],
    file: rel,
    line: lineOf(rel, new RegExp(`arg\\(\\s*['"]${flag}['"]`)),
  };
}

/** A named export read from the live module, with its declaration line attached. */
function fromModule(mod, rel, name, transform) {
  if (!(name in mod)) throw new Error(`derive-constants: ${rel} does not export ${name}`);
  const value = transform ? transform(mod[name]) : mod[name];
  if (value === undefined) throw new Error(`derive-constants: ${rel} exports ${name} as undefined`);
  return { name, value, file: rel, line: lineOf(rel, new RegExp(`export\\s+const\\s+${name}\\b`)) };
}

async function derive() {
  const npn = await import('file://' + path.join(ROOT, 'normalize-product-name.js').replace(/\\/g, '/'));
  const drift = await import('file://' + path.join(ROOT, 'drift-gate.js').replace(/\\/g, '/'));
  const spend = await import('file://' + path.join(ROOT, 'verify-spend-guard.js').replace(/\\/g, '/'));
  const sanity = await import('file://' + path.join(ROOT, 'price-sanity.js').replace(/\\/g, '/'));
  const nmatch = await import('file://' + path.join(ROOT, 'newegg-match.js').replace(/\\/g, '/'));
  const wcat = require(path.join(ROOT, 'scripts', 'write-catalog.cjs'));

  const VCA = 'verify-catalog-asins.js';
  const RNP = 'refresh-newegg-prices.cjs';
  const AND = 'apply-newegg-discoveries.cjs';
  const DND = 'discover-newegg-dry.cjs';
  const WC = 'scripts/write-catalog.cjs';

  // TIERS is a multi-line object literal in a module that cannot be imported
  // (it process.exit()s without --tier), so it is lifted by balanced braces and
  // evaluated. The category-count assertion below is what makes that safe: an
  // empty or mis-sliced object fails here rather than rendering as "0 categories".
  const tiersLiteral = braceSlice(VCA, 'const TIERS =', 'TIERS');
  const TIERS = evalLiteral(tiersLiteral, 'TIERS');
  const tierKeys = Object.keys(TIERS);
  if (tierKeys.length !== 4) throw new Error(`derive-constants: expected 4 tiers, got ${tierKeys.length}`);
  for (const k of tierKeys)
    if (!Array.isArray(TIERS[k]) || TIERS[k].length === 0)
      throw new Error(`derive-constants: tier ${k} is not a non-empty category array`);

  // SPEC_BAR holds predicate FUNCTIONS. Only its keys are meaningful to a
  // dashboard — and per DESIGN §3.3 the predicates themselves must never become
  // editable text — so only the keys are exported.
  const specBarKeys = [...braceSlice(AND, 'const SPEC_BAR =', 'SPEC_BAR').matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
  if (!specBarKeys.length) throw new Error('derive-constants: SPEC_BAR yielded no categories');

  const heldLiteral = matchOnce(AND, /const HELD = new Set\((\[[^\]]*\])\)/, 'HELD');
  const HELD = evalLiteral(heldLiteral[1], 'HELD');

  const groups = [
    {
      id: 'tiers',
      title: 'Verification tiers',
      exposure: 'green',
      note: 'Tier membership is the Phase 2 candidate: pure data, bounded by the known category list.',
      entries: [
        { name: 'TIERS', value: TIERS, file: VCA, line: lineOf(VCA, /const TIERS =/) },
        scalarConst(VCA, 'ASIN_FIX_MIN_SCORE'),
      ],
    },
    {
      id: 'spend',
      title: 'Spend guards',
      exposure: 'mixed',
      note: 'DOLLAR_CEILING is green with a hard schema maximum. The cost constants are measured facts, not policy, and the band ratio is a logical truth — both red.',
      entries: [
        fromModule(spend, 'verify-spend-guard.js', 'DOLLAR_CEILING'),
        fromModule(spend, 'verify-spend-guard.js', 'COST_PER_SELLERS_TASK'),
        fromModule(spend, 'verify-spend-guard.js', 'COST_PER_ASIN_SEARCH'),
        fromModule(spend, 'verify-spend-guard.js', 'TIER_BAND_MAX_RATIO'),
      ],
    },
    {
      id: 'price-bands',
      title: 'Absolute price ceilings and floors',
      exposure: 'amber',
      note: 'Out of v1 by decision — DESIGN-admin-dashboard.md §7. The table quarantines rather than drops; any future editor inherits that property or does not ship.',
      entries: [
        fromModule(npn, 'normalize-product-name.js', 'PRICE_TABLE'),
        fromModule(npn, 'normalize-product-name.js', 'STALE_CEILING_FAILURE_RATE'),
        fromModule(npn, 'normalize-product-name.js', 'CEILINGS_LAST_REVIEWED'),
      ],
    },
    {
      id: 'drift',
      title: 'Price-drift gate',
      exposure: 'amber',
      note: 'drift-gate.js:14 — "A loose drift trigger is safe only because the ceilings backstop it. Never loosen both."',
      entries: [
        fromModule(drift, 'drift-gate.js', 'RISE_TRIGGER'),
        fromModule(drift, 'drift-gate.js', 'DRIFT_STALE_FAILURE_RATE'),
        fromModule(drift, 'drift-gate.js', 'PRICE_REFRESH_MIN'),
      ],
    },
    {
      id: 'sanity',
      title: 'Cross-retailer price sanity',
      exposure: 'amber',
      entries: [
        fromModule(sanity, 'price-sanity.js', 'LOW_THRESH'),
        fromModule(sanity, 'price-sanity.js', 'HIGH_THRESH'),
        fromModule(sanity, 'price-sanity.js', 'DISAGREE_THRESH'),
        fromModule(sanity, 'price-sanity.js', 'LOW_FLOOR'),
        fromModule(sanity, 'price-sanity.js', 'PRIMARY_RETAILERS'),
      ],
    },
    {
      id: 'discovery',
      title: 'Discovery gates and spec bars',
      exposure: 'mixed',
      note: 'Category, limit, sample size and PRICE_MULT are green. SPEC_BAR shows category coverage only — the predicates are red and never become editable text.',
      entries: [
        argDefault(AND, 'category', 'discovery default --category', String),
        argDefault(AND, 'limit', 'discovery default --limit'),
        argDefault(AND, 'price-mult', 'PRICE_MULT'),
        argDefault(DND, 'sample', 'dry-run --sample'),
        { name: 'HELD (quarantined on ingest for backfill)', value: HELD, file: AND, line: lineOf(AND, /const HELD = new Set/) },
        { name: 'SPEC_BAR categories', value: specBarKeys, file: AND, line: lineOf(AND, /const SPEC_BAR =/) },
      ],
    },
    {
      id: 'brakes',
      title: 'Catalog write brakes',
      exposure: 'red',
      note: 'The last brake before a catalog-destroying write. case-ingest.mjs:336 asserts MAX_GROWTH === 0.15 and throws otherwise.',
      entries: [
        { name: 'MAX_SHRINK', value: wcat.MAX_SHRINK, file: WC, line: lineOf(WC, /const MAX_SHRINK\s*=/) },
        { name: 'MAX_GROWTH', value: wcat.MAX_GROWTH, file: WC, line: lineOf(WC, /const MAX_GROWTH\s*=/) },
      ],
    },
    {
      id: 'breakers',
      title: 'Newegg refresh circuit breakers',
      exposure: 'red',
      note: 'A breaker you can raise from a web form is not a breaker.',
      entries: [
        scalarConst(RNP, 'MAX_LOOKUP_FAILURE_RATE'),
        scalarConst(RNP, 'MAX_REMOVAL_RATE'),
        scalarConst(RNP, 'MAX_REMOVAL_FLOOR'),
        scalarConst(RNP, 'MIN_HEALTHY_CANDIDATES'),
        scalarConst(RNP, 'MIN_ABSENT_STREAK'),
        scalarConst(RNP, 'MIN_STALE_DAYS'),
        scalarConst(RNP, 'PRICE_SUSPECT_QUARANTINE_STREAK'),
        scalarConst(RNP, 'REMOVALS_ENABLED'),
        fromModule(nmatch, 'newegg-match.js', 'MIN_MIGRATE_SIM'),
      ],
    },
    {
      id: 'pacing',
      title: 'Pacing and batching',
      exposure: 'red',
      note: 'Vendor rate-limit contracts. A slider gets you 429-ed.',
      entries: [
        scalarConst(VCA, 'BATCH_SIZE'),
        scalarConst(VCA, 'POST_DELAY_MS'),
        scalarConst(VCA, 'TASK_POLL_DELAY_MS'),
        scalarConst(VCA, 'TASK_POLL_INTERVAL_MS'),
        scalarConst(VCA, 'MAX_POLL_WAIT_MS'),
        scalarConst(VCA, 'GET_CONCURRENCY'),
        scalarConst(RNP, 'RATE_DELAY_MS'),
      ],
    },
    {
      id: 'retention',
      title: 'Retention',
      exposure: 'green',
      note: 'Green, but a one-way ratchet: lowering it permanently trims history on the next run.',
      entries: [scalarConst('record-price-snapshot.js', 'RETENTION_DAYS')],
    },
  ];

  // Calibration stamps, paired with their max age so the UI can show staleness
  // without knowing which stamp belongs to which threshold. These are
  // DISPLAY-ONLY forever: DESIGN §3.4 — a stamp never moves on its own.
  const calibration = [
    { label: 'Price table', calibratedAt: npn.PRICE_TABLE_CALIBRATED_AT, maxAgeDays: npn.PRICE_TABLE_MAX_AGE_DAYS, file: 'normalize-product-name.js' },
    { label: 'Drift gate', calibratedAt: drift.DRIFT_GATE_CALIBRATED_AT, maxAgeDays: drift.DRIFT_GATE_MAX_AGE_DAYS, file: 'drift-gate.js' },
    { label: 'Spend ceiling', calibratedAt: spend.DOLLAR_CEILING_CALIBRATED_AT, maxAgeDays: spend.DOLLAR_CEILING_MAX_AGE_DAYS, file: 'verify-spend-guard.js' },
  ];
  for (const c of calibration)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.calibratedAt)) || !(c.maxAgeDays > 0))
      throw new Error(`derive-constants: calibration stamp for ${c.label} is malformed (${c.calibratedAt} / ${c.maxAgeDays})`);

  return { groups, calibration, schedules: deriveSchedules(), tiers: TIERS };
}

/**
 * Schedules, read from the workflow YAML rather than restated. Regex rather than
 * a YAML parser on purpose: `- cron:` is unambiguous, and js-yaml is only a
 * transitive dependency here — a dashboard build should not fail on someone
 * else's dependency tree.
 */
function deriveSchedules() {
  const dir = wfDir();
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const name = (text.match(/^name:\s*(.+)$/m) || [, file])[1].trim();
    // Only uncommented schedule lines. refresh-newegg-prices.yml has its cron
    // commented out, and showing a disabled schedule as active is exactly the
    // "expected every 12h, last ran in July" confusion this panel prevents.
    const crons = [...text.matchAll(/^\s{4,}- cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const commented = [...text.matchAll(/^\s*#\s*- cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    out.push({
      file,
      name,
      crons,
      disabledCrons: commented,
      dispatchable: /^\s{2}workflow_dispatch:/m.test(text),
      pushesMain: /group:\s*main-writer/.test(text),
    });
  }
  if (!out.length) throw new Error('derive-constants: no workflows found');

  // verify-catalog.yml maps each cron to a tier by EXACT STRING MATCH (see
  // DESIGN §4). Surface that mapping so the UI can say which tier a schedule
  // runs — and assert every scheduled cron is mapped, because an unmapped cron
  // silently falls through to tier 1.
  const vc = out.find((w) => w.file === 'verify-catalog.yml');
  if (!vc) throw new Error('derive-constants: verify-catalog.yml not found');
  const text = fs.readFileSync(path.join(dir, 'verify-catalog.yml'), 'utf8');
  const map = {};
  for (const m of text.matchAll(/"([^"]+)"\)\s*echo\s+"tier=(\d)"/g)) map[m[1]] = Number(m[2]);
  for (const c of vc.crons)
    if (!(c in map))
      throw new Error(`derive-constants: cron '${c}' in verify-catalog.yml is not mapped to a tier — it would fall through to the tier-1 default`);
  vc.tierMap = map;
  return out;
}

async function main() {
  const printOnly = process.argv.includes('--print');
  const derived = await derive();
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* not a repo */ }

  const payload = { $schemaVersion: 1, generatedAt: new Date().toISOString(), commit, ...derived };
  const count = derived.groups.reduce((n, g) => n + g.entries.length, 0);
  console.log(`derived ${count} constants across ${derived.groups.length} groups, ${derived.schedules.length} workflows, ${derived.calibration.length} calibration stamps`);

  if (printOnly) { console.log(JSON.stringify(payload, null, 2)); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}

module.exports = { derive, deriveSchedules, scalarConst, matchOnce, braceSlice, argDefault };

if (require.main === module) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}
