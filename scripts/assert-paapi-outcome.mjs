#!/usr/bin/env node
// =============================================================================
//  scripts/assert-paapi-outcome.mjs — a verify-catalog run PA API could not
//  serve must end RED, after its DataForSEO work has committed.
//
//  ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//  From 2026-09-12 22:01 UTC every verify-catalog run logged
//
//      PA API confirmed 0/2574 rows for $0 (PA API unavailable: associate_not_eligible)
//
//  and concluded SUCCESS. runPaapiGate() classed the 403 as Amazon's gate,
//  "EXPECTED right now", printed a yellow ::warning:: and carried on. Nobody
//  reads a warning on a green run. Published Amazon rows stayed fresh on the
//  paid pass, so the freshness gate had nothing to say. Hidden (needsReview)
//  rows, which the paid pass skips and only PA re-checks, got no check at all:
//  606 confirmed on 09-12, 2 on 09-13, 0 on 09-15. A run that confirmed nothing
//  through PA looked exactly like one that confirmed everything.
//
//  ── WHY AFTER THE COMMIT, NOT AT THE PREFLIGHT ──────────────────────────────
//  Failing at runPaapiGate (as our_bug does) would also stop the DataForSEO
//  fallback, and while PA is gated that fallback is the only thing still
//  pricing published rows. So the run does its work and commits it, and THEN
//  this step turns it red. Same shape as sftp-ingest: commit what landed, then
//  go red.
//
//  ── OUTCOMES — every path named, none shaped like another ───────────────────
//    ok             PA available at the END of the run                -> exit 0
//    degraded       transient token / network / 5xx                  -> exit 0, ::warning::
//    gated          associate_not_eligible | unauthorized             -> exit 1
//    our_bug        not_configured | credentials_rejected             -> exit 1
//    no-report      no report: the verifier never reached writeReports -> exit 1
//    unreadable     the report did not parse                          -> exit 1
//    no-pa-summary  it parsed but carries no usable meta.paapi        -> exit 1
//
//  The end-of-run status is what counts, not the preflight. A circuit that
//  opens mid-run on associate_not_eligible is the same lost eligibility, and
//  the next run would fail at the preflight anyway.
//
//  Which disabledReason is which state is amazon-paapi.js's classifyReason(),
//  imported rather than restated here.
//
//  ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//  degraded stays green. One transient blip opens the circuit for the rest of a
//  run and the next run retries, so a red there would mostly be noise. A
//  PERSISTENT degraded state is a cross-run question, and one run's report
//  cannot answer it.
//
//  Usage (verify-catalog.yml, after the commit step):
//    node scripts/assert-paapi-outcome.mjs "$(ls -t verify-reports/report-*.json | head -1)"
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyReason } from '../amazon-paapi.js';

export const OUTCOMES = ['ok', 'degraded', 'gated', 'our_bug', 'no-report', 'unreadable', 'no-pa-summary'];
const FAILS = new Set(['gated', 'our_bug', 'no-report', 'unreadable', 'no-pa-summary']);

const done = (outcome, message) => ({ outcome, fail: FAILS.has(outcome), message });

/**
 * Classify one verify-catalog report. Pure: takes the raw text (or null when
 * there is no file), returns exactly one named outcome. Never throws.
 */
export function paapiOutcome(raw) {
  if (raw == null || raw === '') {
    return done('no-report', 'no verify-catalog report — the verifier never reached writeReports, so nothing says PA API served this run');
  }
  let report;
  try { report = JSON.parse(raw); } catch (e) {
    return done('unreadable', `the verify-catalog report did not parse (${e.message}) — a truncated write is a dead run, not a pass`);
  }
  const pa = report && report.meta && report.meta.paapi;
  if (!pa || typeof pa !== 'object' || typeof pa.available !== 'boolean') {
    return done('no-pa-summary', 'the report carries no meta.paapi.available — cannot tell whether PA API served this run');
  }

  const counts = `PA confirmed ${pa.paConfirmed ?? '?'} row(s), ${pa.dfsFallback ?? '?'} billed to DataForSEO`;
  if (pa.available) return done('ok', `PA API served this run — ${counts}`);

  const state = classifyReason(pa.disabledReason);
  const hidden = `${pa.quarantineSkipped ?? '?'} hidden (needsReview) row(s) got no check at all`;
  if (state === 'gated') {
    return done('gated',
      `PA API gated by Amazon (${pa.disabledReason}) — ${counts}; ${hidden}. ` +
      'The DataForSEO work has committed; the run is red because PA eligibility has lapsed. Check Associates Central.');
  }
  if (state === 'our_bug') {
    return done('our_bug', `PA API unavailable (${pa.disabledReason}) — our wiring, not Amazon's gate. ${counts}; ${hidden}.`);
  }
  return done('degraded', `PA API degraded this run (${pa.disabledReason ?? 'no reason recorded'}) — ${counts}. Transient; the next run retries.`);
}

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) {
  const file = process.argv[2];
  let raw = null;
  if (file && existsSync(file)) {
    // A file that exists but cannot be read is not "no report": hand the
    // classifier something that will not parse, so it lands on `unreadable`.
    try { raw = readFileSync(file, 'utf8'); } catch (e) { raw = `<unreadable: ${e.message}>`; }
  }
  const r = paapiOutcome(raw);
  if (r.fail) console.log(`::error title=PA API ${r.outcome}::${r.message}`);
  else if (r.outcome === 'degraded') console.log(`::warning title=PA API degraded::${r.message}`);
  else console.log(`ok: ${r.message}`);
  process.exit(r.fail ? 1 : 0);
}
