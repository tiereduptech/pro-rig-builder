#!/usr/bin/env node
// =============================================================================
//  scripts/assert-workflow-outcomes.cjs
//
//  Assert that every workflow with a live cron has actually SUCCEEDED recently.
//  Not that it is scheduled. Not that it ran. That it succeeded.
//
//  ── WHY THIS EXISTS: THE SAME MISTAKE, THREE TIMES ──────────────────────────
//  Each of these is a proxy that was read as the thing it stands for:
//
//    a dated price point   read as evidence a retailer was checked
//                          -> record-price-snapshot.js reads parts.js and never
//                             contacts a retailer. Best Buy froze for 4 months
//                             behind 139,080 fabricated points.
//
//    a cron                read as evidence a job succeeded
//                          -> sftp-ingest.yml has a daily cron, appears in
//                             Actions every day, and succeeded twice in 99 runs.
//                             The Newegg feed wrote nothing for 95 days.
//
//    a green run           read as evidence something deployed
//
//  scripts/assert-retailer-freshness.cjs closed the first two by measuring deal
//  stamps and checking cited crons are live. But a live cron is still a proxy: it
//  proves a job was invoked, not that it worked. This file measures the outcome.
//
//  ── WHY `cancelled` IS A FAILURE HERE ───────────────────────────────────────
//  88 of sftp-ingest's 99 runs were cancelled at the 60-minute timeout, and
//  cancellation is the quietest possible outcome — it is grey in the UI, sends no
//  notification, and reads as "someone stopped it on purpose". Nothing was
//  stopping it; it was dying. Only `conclusion === 'success'` counts as success
//  here. Everything else — failure, cancelled, timed_out, skipped,
//  startup_failure, still-running — counts as not-succeeded, and the full
//  distribution is printed so a wall of cancellations is legible as one.
//
//  ── WHAT IS DERIVED ────────────────────────────────────────────────────────
//  Nothing is transcribed and there is no table of workflows to maintain. The
//  set of jobs under assertion IS the set of workflow files carrying a live
//  cron, and each one's budget comes from its own fastest cron via the policy
//  already stated in assert-retailer-freshness.cjs. Add a scheduled workflow and
//  it is covered on the next run; comment a cron out and it drops to the
//  retailer gate's provenance check instead. Neither requires editing this file.
//
//  Usage:
//    node scripts/assert-workflow-outcomes.cjs          # assert, exit 1 on failure
//    node scripts/assert-workflow-outcomes.cjs --json
//
//  Requires a token with `actions: read` in GITHUB_TOKEN or GH_TOKEN. Absent
//  credentials exit 2 — a freshness gate that silently skips when it cannot see
//  is worse than no gate, because it also removes the reason to look.
// =============================================================================

const fs = require('fs');
const path = require('path');
const {
  cronIntervalDays, budgetDaysFor, readSchedule,
  MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS, DEFAULT_WF_DIR,
} = require('./assert-retailer-freshness.cjs');

const ROOT = path.resolve(__dirname, '..');
const DAY_MS = 86400000;

// The only conclusion that means the job did its work. Listed as an allow-list
// rather than a deny-list of bad outcomes on purpose: GitHub can add a new
// conclusion at any time, and an unknown outcome must read as not-succeeded
// rather than slipping through a deny-list as fine.
const SUCCESS = 'success';

// ── repo + transport ────────────────────────────────────────────────────────

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const cfg = fs.readFileSync(path.join(ROOT, '.git', 'config'), 'utf8');
    const m = cfg.match(/github\.com[/:]([^/\s]+\/[^/\s.]+)(\.git)?/);
    if (m) return m[1];
  } catch { /* fall through */ }
  return null;
}

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/**
 * Whether this run is evaluating the default branch. Only there can "GitHub has
 * no record of this cron" be a defect rather than a not-yet-merged file.
 * In Actions, a pull_request run reports the PR head via GITHUB_REF; outside
 * Actions, fall back to the checked-out branch.
 */
function isDefaultBranch() {
  const def = process.env.GITHUB_DEFAULT_BRANCH || 'main';
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') return false;
  const ref = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF;
  if (ref) return ref === def || ref === `refs/heads/${def}`;
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    return head === `ref: refs/heads/${def}`;
  } catch { return true; }   // unknown -> assert, never silently relax
}

/** Scheduled runs for one workflow file, newest first. */
function makeFetcher(repo, tok) {
  return async function fetchWorkflowRuns(file) {
    const url =
      `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(file)}` +
      `/runs?event=schedule&per_page=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return { missing: true, runs: [] };
    if (!res.ok) throw new Error(`${file}: GitHub API ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    const j = await res.json();
    return {
      missing: false,
      runs: (j.workflow_runs || []).map((r) => ({
        conclusion: r.conclusion,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  };
}

/** Workflow metadata, for the created_at grace window. */
function makeMetaFetcher(repo, tok) {
  return async function fetchWorkflowMeta(file) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(file)}`,
      { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    return { state: j.state, createdAt: j.created_at };
  };
}

// ── audit ───────────────────────────────────────────────────────────────────

/**
 * opts.fetchWorkflowRuns / opts.fetchWorkflowMeta are injectable so the gate is
 * testable without a network or a token — the same reason WF_DIR is overridable.
 */
async function audit(opts = {}) {
  const wfDir = opts.wfDir || process.env.WF_DIR || DEFAULT_WF_DIR;
  const now = opts.now ? new Date(opts.now) : new Date();
  const fetchRuns = opts.fetchWorkflowRuns;
  const fetchMeta = opts.fetchWorkflowMeta || (async () => null);
  if (typeof fetchRuns !== 'function') throw new Error('audit() needs a fetchWorkflowRuns function');
  const onDefaultBranch = opts.onDefaultBranch !== undefined ? opts.onDefaultBranch : isDefaultBranch();

  const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml')).sort();
  const rows = [];
  const failures = [];
  let scheduled = 0;

  for (const file of files) {
    const sched = readSchedule(wfDir, file);
    if (!sched || !sched.live.length) continue;   // dispatch-only, or cron disabled
    scheduled++;

    // A workflow fires on every one of its crons, so the tightest promise it
    // makes is its SHORTEST interval. verify-catalog.yml runs tier 1 every 2
    // days and tiers 3-4 weekly; as a whole it should succeed every 2 days.
    let interval = Infinity;
    let bad = null;
    for (const c of sched.live) {
      try { interval = Math.min(interval, cronIntervalDays(c)); }
      catch (e) { bad = e.message; }
    }
    if (bad) {
      rows.push({ file, crons: sched.live, verdict: 'UNPARSEABLE CRON', detail: bad });
      failures.push({ file, kind: 'unparseable-cron', detail: bad });
      continue;
    }

    const budgetDays = budgetDaysFor(interval);
    const { missing, runs } = await fetchRuns(file);
    const meta = await fetchMeta(file);

    const tally = {};
    for (const r of runs) tally[r.conclusion || r.status || 'unknown'] = (tally[r.conclusion || r.status || 'unknown'] || 0) + 1;

    const lastSuccess = runs.find((r) => r.conclusion === SUCCESS) || null;
    const successAgeDays = lastSuccess
      ? Math.floor((now - Date.parse(lastSuccess.createdAt)) / DAY_MS)
      : null;

    const row = {
      file,
      crons: sched.live,
      intervalDays: Number(interval.toFixed(4)),
      budgetDays,
      scheduledRuns: runs.length,
      successes: runs.filter((r) => r.conclusion === SUCCESS).length,
      lastSuccess: lastSuccess ? lastSuccess.createdAt.slice(0, 10) : null,
      successAgeDays,
      state: meta ? meta.state : null,
      tally,
      verdict: null,
      detail: null,
    };

    // GitHub does not know this workflow. On the default branch that is a real
    // defect: a cron that GitHub has no record of will never fire, which is the
    // silent-no-op case this gate exists for. On a PR branch it is simply the
    // normal state of a workflow that has not merged yet, and failing there
    // would redden every PR that adds a scheduled job — an alarm that fires on
    // routine work is one that gets switched off, so it reports and passes.
    if (missing) {
      if (onDefaultBranch) {
        row.verdict = 'NOT ON REMOTE';
        row.detail = `${file} has a live cron on the default branch but GitHub does not know it — it was renamed, or the file was never pushed`;
        failures.push({ file, kind: 'not-on-remote', detail: row.detail });
      } else {
        row.verdict = 'PENDING MERGE';
        row.detail = `${file} is not on GitHub yet; its cron starts firing once this merges`;
      }
      rows.push(row);
      continue;
    }

    // Disabled in the UI. An explicit human decision, and still a job that is
    // not succeeding — reported as its own class rather than excused.
    if (meta && meta.state && meta.state !== 'active') {
      row.verdict = `DISABLED (${meta.state})`;
      row.detail = `${file} carries a live cron but the workflow is ${meta.state} on GitHub, so the cron never fires`;
      failures.push({ file, kind: 'workflow-disabled', detail: row.detail });
      rows.push(row);
      continue;
    }

    // Grace window for a genuinely new workflow: it cannot have succeeded before
    // its first cron fired. Measured from GitHub's own created_at, so it expires
    // on its own rather than needing a suppression someone has to remember.
    const ageDays = meta && meta.createdAt
      ? Math.floor((now - Date.parse(meta.createdAt)) / DAY_MS)
      : null;
    if (!lastSuccess && ageDays != null && ageDays <= budgetDays) {
      row.verdict = `NEW (${ageDays}d, grace ${budgetDays}d)`;
      rows.push(row);
      continue;
    }

    if (!lastSuccess) {
      row.verdict = 'NEVER SUCCEEDED';
      row.detail =
        `${runs.length} scheduled run(s), not one with conclusion=success ` +
        `(${describeTally(tally)}) — the cron fires and the job never completes`;
      failures.push({ file, kind: 'never-succeeded', detail: row.detail });
      rows.push(row);
      continue;
    }

    if (successAgeDays > budgetDays) {
      const since = runs.filter((r) => Date.parse(r.createdAt) > Date.parse(lastSuccess.createdAt));
      const sinceTally = {};
      for (const r of since) sinceTally[r.conclusion || r.status || 'unknown'] = (sinceTally[r.conclusion || r.status || 'unknown'] || 0) + 1;
      row.verdict = 'STALE SUCCESS';
      row.detail =
        `last success ${row.lastSuccess} is ${successAgeDays}d ago, over the ${budgetDays}d budget ` +
        `(fastest cron '${pickFastest(sched.live)}' x ${MISSED_CYCLES_ALLOWED} missed cycles). ` +
        `${since.length} scheduled run(s) since then, none of them successful: ${describeTally(sinceTally)}`;
      failures.push({ file, kind: 'stale-success', detail: row.detail });
      rows.push(row);
      continue;
    }

    row.verdict = 'OK';
    rows.push(row);
  }

  return {
    rows, failures, scheduled,
    policy: { MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS, successConclusion: SUCCESS },
  };
}

function pickFastest(crons) {
  let best = crons[0], bestI = Infinity;
  for (const c of crons) {
    try { const i = cronIntervalDays(c); if (i < bestI) { bestI = i; best = c; } } catch { /* skip */ }
  }
  return best;
}

function describeTally(t) {
  const e = Object.entries(t).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, v]) => `${v} ${k}`).join(', ') : 'no runs';
}

// ── report ──────────────────────────────────────────────────────────────────

function report(a) {
  const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
  const padL = (s, n) => String(s == null ? '-' : s).padStart(n);

  console.log('SCHEDULED WORKFLOW OUTCOMES');
  console.log(`policy: only conclusion='${a.policy.successConclusion}' counts; ` +
              `${a.policy.MISSED_CYCLES_ALLOWED} missed cycles allowed, ${a.policy.MIN_BUDGET_DAYS}d floor`);
  console.log(`scope:  ${a.scheduled} workflow(s) with a live cron\n`);

  console.log(pad('WORKFLOW', 30) + padL('RUNS', 6) + padL('OK', 5) + padL('LAST OK', 12) +
              padL('AGE', 6) + padL('BUDGET', 8) + '  VERDICT');
  console.log('-'.repeat(96));
  for (const r of a.rows) {
    console.log(
      pad(r.file, 30) + padL(r.scheduledRuns, 6) + padL(r.successes, 5) + padL(r.lastSuccess, 12) +
      padL(r.successAgeDays == null ? '-' : r.successAgeDays + 'd', 6) +
      padL(r.budgetDays == null ? '-' : r.budgetDays + 'd', 8) + '  ' + r.verdict
    );
    if (r.tally && Object.keys(r.tally).length) {
      console.log(' '.repeat(30) + 'outcomes: ' + describeTally(r.tally));
    }
  }

  if (!a.failures.length) {
    console.log(`\nPASS — all ${a.rows.length} scheduled workflow(s) have succeeded within their cadence.`);
    return 0;
  }

  console.log(`\nFAIL — ${a.failures.length} scheduled workflow(s) are not succeeding:\n`);
  for (const f of a.failures) {
    console.log(`  [${f.kind}] ${f.file}`);
    for (const line of wrap(f.detail, 92)) console.log(`      ${line}`);
    console.log('');
  }
  console.log("A cron proves a job was invoked, not that it worked. Every workflow above is");
  console.log('being invoked on schedule and is not completing. Fix the job, or remove the cron.');
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

module.exports = { audit, report, resolveRepo, describeTally, pickFastest, SUCCESS };

if (require.main === module) {
  const tok = token();
  const repo = resolveRepo();
  if (!tok) {
    console.error('✗ No GITHUB_TOKEN / GH_TOKEN. This gate reads Actions run conclusions and');
    console.error('  cannot assert anything without them. Refusing to pass by default.');
    process.exit(2);
  }
  if (!repo) {
    console.error('✗ Could not determine the repository (set GITHUB_REPOSITORY).');
    process.exit(2);
  }
  console.log(`repo: ${repo}\n`);
  audit({ fetchWorkflowRuns: makeFetcher(repo, tok), fetchWorkflowMeta: makeMetaFetcher(repo, tok) })
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
