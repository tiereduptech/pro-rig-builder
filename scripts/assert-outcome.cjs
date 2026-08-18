#!/usr/bin/env node
'use strict';
/**
 * scripts/assert-outcome.cjs — a job that produced nothing must go RED.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Every writer workflow in this repo ends the same way:
 *
 *     if [ -f catalog-build/<job>-summary.json ]; then
 *       ...read totals, commit, push...
 *     fi
 *
 * That `if` is the bug. When the summary is absent — because the job was
 * cancelled, timed out, or died mid-parse — the step body is skipped, the step
 * exits 0, and the job reports SUCCESS having ingested nothing. The shell is
 * doing exactly what it was told; nobody told it that "no artifact" is a
 * failure rather than a no-op.
 *
 * SFTP Ingest ran 99 times between 2026-05-14 and 2026-08-17 and left 1,882
 * catalog rows stranded behind those runs. The run list was not obviously wrong
 * at a glance, because "nothing to commit" and "never got far enough to have
 * anything to commit" print the same way and exit the same way.
 *
 * This script makes the difference explicit. It asserts, after the work step,
 * that the job actually reached the outcome it claims — and fails loudly when
 * it did not, because a red run is a notification and a passive signal is not
 * an alarm (same argument as newegg-feed-watch.yml and epik-watchdog.yml).
 *
 * ── WHAT IT CHECKS ───────────────────────────────────────────────────────────
 *   1. The artifact EXISTS.       Absence is the cancellation/timeout signature.
 *   2. The artifact is FRESH.     Guards against a stale summary restored from
 *                                 a cache or left behind by an earlier attempt
 *                                 being read as if this run had produced it.
 *   3. The artifact PARSES.       A truncated write is a dead job, not a pass.
 *   4. Declared invariants hold.  --require fails the job, --warn annotates it.
 *
 * ── WHAT IT CANNOT CHECK ─────────────────────────────────────────────────────
 * A step cannot run after the runner has been killed. When a job is cancelled
 * by its concurrency group — the failure mode that silently ate 55 of the last
 * 64 SFTP Ingest runs — this script never executes, and the run is recorded as
 * `cancelled`, which sends no notification. Catching THAT requires watching
 * from outside the job; ingest-outcome-watch.yml is that watcher. The two are
 * complementary and neither replaces the other.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/assert-outcome.cjs \
 *     --artifact=catalog-build/sftp-ingest-summary.json \
 *     --label="SFTP ingest" \
 *     --newer-than-epoch="$STEP_STARTED" \
 *     --require=totals.errors==0 \
 *     --warn=totals.feedRecords>0
 *
 * Expressions are `dotted.path OP value`, OP one of >= <= != == > < .
 * Numeric comparisons require a numeric value at that path; == and != also
 * accept booleans and strings (`dryRun==false`, `mode!=dry`).
 */

const fs = require('fs');

// Longest-first: '>=' must be found before '>', or '>=' parses as '>' with a
// value of '=0'.
const OP_ORDER = ['>=', '<=', '!=', '==', '>', '<'];

const NUMERIC_ONLY = new Set(['>=', '<=', '>', '<']);

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '!=': (a, b) => a !== b,
  '==': (a, b) => a === b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

/**
 * Split `totals.errors==0` into its parts. Throws on anything it cannot read,
 * because a malformed assertion that silently passes is the exact class of bug
 * this file exists to remove.
 */
function parseExpr(expr) {
  const raw = String(expr).trim();
  for (const op of OP_ORDER) {
    const at = raw.indexOf(op);
    if (at <= 0) continue; // <=0 also rejects a leading operator with no path
    const pathPart = raw.slice(0, at).trim();
    const valuePart = raw.slice(at + op.length).trim();
    if (!pathPart || !valuePart) break;
    return { path: pathPart, op, value: coerce(valuePart), raw };
  }
  throw new Error(`cannot parse assertion "${raw}" — expected <path><op><value>, op one of ${OP_ORDER.join(' ')}`);
}

function coerce(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text);
  return text;
}

/**
 * Read `totals.errors` out of a parsed summary. Returns `undefined` for a path
 * that does not exist — which callers must treat as a failure, never as 0.
 */
function readPath(obj, dotted) {
  let cur = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function checkExpr(summary, expr) {
  const { path: p, op, value, raw } = expr;
  const actual = readPath(summary, p);

  if (actual === undefined) {
    return { ok: false, raw, detail: `${p} is missing from the summary` };
  }
  if (NUMERIC_ONLY.has(op) && typeof actual !== 'number') {
    return { ok: false, raw, detail: `${p} is ${JSON.stringify(actual)}, which ${op} cannot compare` };
  }
  const ok = OPS[op](actual, value);
  return { ok, raw, detail: `${p} is ${JSON.stringify(actual)}` };
}

/**
 * The whole check, as data. Returns failures and warnings rather than exiting,
 * so the tests can exercise every branch without spawning a process.
 *
 * @param {object}   o
 * @param {string}   o.artifact          path that the work step must have produced
 * @param {string}   [o.label]           accepted for symmetry; the CLI prefixes messages with it
 * @param {number}   [o.newerThanEpoch]  artifact mtime must be >= this (unix seconds)
 * @param {string[]} [o.require]         invariants that FAIL the job
 * @param {string[]} [o.warn]            invariants that only annotate it
 */
function assertOutcome(o) {
  const failures = [];
  const warnings = [];

  if (!fs.existsSync(o.artifact)) {
    failures.push(
      `produced no ${o.artifact} — the job never reached its outcome. ` +
      `An absent summary is a dead run, not an empty one.`
    );
    return { ok: false, failures, warnings, summary: null };
  }

  if (o.newerThanEpoch != null) {
    const mtime = Math.floor(fs.statSync(o.artifact).mtimeMs / 1000);
    if (mtime < o.newerThanEpoch) {
      const age = o.newerThanEpoch - mtime;
      failures.push(
        `${o.artifact} is ${age}s older than this run's work step — it is a leftover ` +
        `from an earlier attempt, so its totals describe a run that is not this one.`
      );
      return { ok: false, failures, warnings, summary: null };
    }
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(o.artifact, 'utf8'));
  } catch (e) {
    failures.push(`${o.artifact} is not readable JSON (${e.message}) — a truncated summary is a killed job.`);
    return { ok: false, failures, warnings, summary: null };
  }

  for (const expr of o.require || []) {
    const r = checkExpr(summary, parseExpr(expr));
    if (!r.ok) failures.push(`expected ${r.raw}, but ${r.detail}`);
  }
  for (const expr of o.warn || []) {
    const r = checkExpr(summary, parseExpr(expr));
    if (!r.ok) warnings.push(`expected ${r.raw}, but ${r.detail}`);
  }

  return { ok: failures.length === 0, failures, warnings, summary };
}

module.exports = { assertOutcome, parseExpr, readPath, checkExpr, coerce };

if (require.main === module) {
  const args = process.argv.slice(2);
  const one = (name) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const many = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

  const artifact = one('artifact');
  if (!artifact) {
    console.error('::error::assert-outcome.cjs requires --artifact=<path>');
    process.exit(2);
  }

  const newerThanRaw = one('newer-than-epoch');
  const newerThanEpoch = newerThanRaw ? Number(newerThanRaw) : undefined;
  if (newerThanRaw && !Number.isFinite(newerThanEpoch)) {
    console.error(`::error::--newer-than-epoch must be unix seconds, got "${newerThanRaw}"`);
    process.exit(2);
  }

  const label = one('label');
  let result;
  try {
    result = assertOutcome({
      artifact,
      label,
      newerThanEpoch,
      require: many('require'),
      warn: many('warn'),
    });
  } catch (e) {
    // A malformed --require must not be mistaken for a passing assertion.
    console.error(`::error::${e.message}`);
    process.exit(2);
  }

  for (const w of result.warnings) console.log(`::warning::${label || artifact}: ${w}`);
  for (const f of result.failures) console.log(`::error::${label || artifact}: ${f}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [`### Outcome: ${label || artifact} — ${result.ok ? 'asserted' : 'FAILED'}`];
    for (const w of result.warnings) lines.push(`- ⚠ ${w}`);
    for (const f of result.failures) lines.push(`- ✗ ${f}`);
    if (result.ok && !result.warnings.length) lines.push(`- ✓ ${artifact} present, fresh, and every invariant held.`);
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    } catch { /* the summary file is a convenience; never fail the gate over it */ }
  }

  if (!result.ok) process.exit(1);
  console.log(`Outcome asserted: ${artifact} present, fresh, and every invariant held.`);
}
