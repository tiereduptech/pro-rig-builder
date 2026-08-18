#!/usr/bin/env node
'use strict';
/**
 * scripts/ingest-outcome-report.cjs — decide whether a writer workflow has
 * actually been producing outcomes, judged from OUTSIDE the job.
 *
 * ── WHY OUTSIDE ──────────────────────────────────────────────────────────────
 * assert-outcome.cjs runs inside the job, so it cannot speak for a job that was
 * killed before it got a turn. That is not a corner case here — it is the
 * dominant one:
 *
 *   - 88 of 99 SFTP Ingest runs were cancelled mid-parse.
 *   - 55 of the last 64 were cancelled by the `main-writer` concurrency group,
 *     which cancels without failing.
 *
 * A cancelled run is recorded as `cancelled`, not `failure`. GitHub notifies on
 * failed scheduled workflows; it does not notify on cancelled ones. So the
 * catalog froze for 95 days while the run list filled with grey circles that
 * nobody had any reason to open. Nothing was broken enough to complain.
 *
 * This report is the complaint. It goes RED on the two shapes that mean "the
 * job has stopped producing outcomes even though it keeps being scheduled":
 *
 *   STALE   no successful run inside the staleness window
 *   EATEN   a run of consecutive cancellations — the concurrency-lock signature
 *
 * The second matters on its own because it fires while there is still a recent
 * success. It is the early warning; STALE is the eventual one.
 *
 * Pure judgement lives in judgeRuns() so it can be tested against fixed run
 * lists instead of against the live API.
 */

const TERMINAL = new Set(['success', 'failure', 'cancelled', 'timed_out', 'startup_failure', 'neutral', 'skipped', 'action_required', 'stale']);

/**
 * @param {object}   o
 * @param {object[]} o.runs               newest-first, as the Actions API returns them
 * @param {number}   o.now                unix ms
 * @param {number}   [o.staleDays=3]      go red with no success in this many days
 * @param {number}   [o.cancelStreak=3]   go red on this many consecutive cancellations
 * @param {string}   [o.label]
 */
function judgeRuns(o) {
  const staleDays = o.staleDays == null ? 3 : o.staleDays;
  const cancelStreak = o.cancelStreak == null ? 3 : o.cancelStreak;
  const label = o.label || 'workflow';

  // Only finished runs carry a verdict. An in-progress run is neither a success
  // nor a cancellation yet, and counting it as either would make the report
  // flicker with the schedule.
  const finished = (o.runs || []).filter(
    (r) => r.status === 'completed' && TERMINAL.has(r.conclusion)
  );

  const reasons = [];
  const notes = [];

  if (!finished.length) {
    return {
      red: true,
      label,
      lastSuccessAt: null,
      lastSuccessAgeDays: null,
      cancelStreak: 0,
      reasons: [`${label} has no completed runs at all in the window examined — it is not running.`],
      notes,
      counts: {},
    };
  }

  const counts = {};
  for (const r of finished) counts[r.conclusion] = (counts[r.conclusion] || 0) + 1;

  const lastSuccess = finished.find((r) => r.conclusion === 'success');
  const lastSuccessAt = lastSuccess ? lastSuccess.created_at : null;
  const lastSuccessAgeDays = lastSuccess
    ? (o.now - Date.parse(lastSuccess.created_at)) / 86400000
    : null;

  if (!lastSuccess) {
    reasons.push(
      `${label} has not succeeded once in the last ${finished.length} completed runs. ` +
      `Conclusions seen: ${describe(counts)}.`
    );
  } else if (lastSuccessAgeDays > staleDays) {
    reasons.push(
      `${label} last succeeded ${lastSuccessAgeDays.toFixed(1)} days ago (${lastSuccessAt}), ` +
      `past the ${staleDays}-day window. It is still being scheduled, so this is an absence, not a pause.`
    );
  }

  // Consecutive cancellations, newest first. Counted separately from staleness
  // because it fires while a recent success can still mask the problem.
  let streak = 0;
  for (const r of finished) {
    if (r.conclusion === 'cancelled') streak++;
    else break;
  }
  if (streak >= cancelStreak) {
    reasons.push(
      `${label} has been cancelled ${streak} times in a row. Cancellation sends no ` +
      `notification, so this is the shape that hides — check the concurrency group before the window runs out.`
    );
  }

  if (counts.cancelled && !reasons.length) {
    notes.push(`${counts.cancelled} of the last ${finished.length} runs were cancelled — succeeding, but wastefully.`);
  }

  return {
    red: reasons.length > 0,
    label,
    lastSuccessAt,
    lastSuccessAgeDays,
    cancelStreak: streak,
    reasons,
    notes,
    counts,
  };
}

function describe(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}

module.exports = { judgeRuns, describe };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const one = (n, d) => {
      const hit = args.find((a) => a.startsWith(`--${n}=`));
      return hit ? hit.slice(n.length + 3) : d;
    };

    const workflow = one('workflow', 'sftp-ingest.yml');
    const label = one('label', workflow);
    const staleDays = Number(one('stale-days', '3'));
    const cancelStreak = Number(one('cancel-streak', '3'));
    const perPage = Number(one('per-page', '50'));

    const repo = process.env.GITHUB_REPOSITORY;
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    const token = process.env.GITHUB_TOKEN;
    if (!repo || !token) {
      console.error('::error::GITHUB_REPOSITORY and GITHUB_TOKEN are required');
      process.exit(2);
    }

    const url = `${api}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=${perPage}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // A watcher that cannot see is not a watcher that is happy. Fail loudly.
      console.error(`::error::could not list runs for ${workflow}: HTTP ${res.status} ${await res.text()}`);
      process.exit(2);
    }
    const body = await res.json();

    const verdict = judgeRuns({
      runs: body.workflow_runs || [],
      now: Date.now(),
      staleDays,
      cancelStreak,
      label,
    });

    const lines = [`### ${verdict.label} — ${verdict.red ? 'NO RECENT OUTCOME' : 'producing outcomes'}`];
    lines.push(
      verdict.lastSuccessAt
        ? `Last success: ${verdict.lastSuccessAt} (${verdict.lastSuccessAgeDays.toFixed(1)} days ago)`
        : 'Last success: never, in the window examined'
    );
    lines.push(`Conclusions in window: ${describe(verdict.counts) || 'none'}`);
    for (const n of verdict.notes) { console.log(`::notice::${n}`); lines.push(`- ${n}`); }
    for (const r of verdict.reasons) { console.log(`::error::${r}`); lines.push(`- ✗ ${r}`); }

    console.log(lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = require('fs');
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch { /* non-fatal */ }
    }

    if (verdict.red) process.exit(1);
  })().catch((e) => {
    console.error(`::error::${e.stack || e.message}`);
    process.exit(2);
  });
}
