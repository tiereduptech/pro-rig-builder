// =============================================================================
//  admin/functions-lib/github.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  The GitHub calls the dashboard makes, and nothing else.
//
//  The token is a fine-grained PAT scoped to this repo with `Contents: read` and
//  `Actions: read and write`. It deliberately has NO `workflows` scope, which is
//  what would be needed to edit a cron schedule — see DESIGN-admin-dashboard.md
//  §4. That is enforcement at the credential layer rather than a promise not to
//  write the code.
// =============================================================================

const API = 'https://api.github.com';
const UA = 'prb-admin-dashboard';

function requireEnv(env) {
  const token = String(env.GITHUB_TOKEN || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  if (!token) throw new Error('GITHUB_TOKEN is not set on the admin Pages project');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO must be set as owner/name');
  return { token, repo };
}

async function gh(env, path, init = {}) {
  const { token, repo } = requireEnv(env);
  const res = await fetch(`${API}/repos/${repo}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
}

/**
 * Workflow definitions, keyed by file name. `state` matters more than it looks:
 * GitHub disables scheduled workflows after 60 days of repository inactivity,
 * and a disabled schedule is indistinguishable from a quiet one unless it is
 * shown.
 */
export async function listWorkflows(env) {
  const res = await gh(env, '/actions/workflows?per_page=100');
  if (!res.ok) throw new Error(`listWorkflows: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const byFile = {};
  for (const w of body.workflows || []) {
    byFile[String(w.path || '').replace(/^\.github\/workflows\//, '')] = { id: w.id, name: w.name, state: w.state };
  }
  return byFile;
}

/**
 * The most recent run of one workflow.
 *
 * Queried per workflow rather than by pulling the last N runs repo-wide and
 * grouping: epik-watchdog runs every 30 minutes, so 100 repo-wide runs covers
 * barely two days and would report every weekly workflow as "never run". The
 * question this dashboard exists to answer is "when did each workflow last run",
 * and the cheap version of that query answers it wrong.
 */
export async function lastRun(env, file) {
  const res = await gh(env, `/actions/workflows/${encodeURIComponent(file)}/runs?per_page=1&exclude_pull_requests=true`);
  if (res.status === 404) return { file, run: null, missing: true };
  if (!res.ok) return { file, run: null, error: `${res.status}` };
  const body = await res.json();
  const r = (body.workflow_runs || [])[0];
  if (!r) return { file, run: null };
  return {
    file,
    run: {
      id: r.id,
      number: r.run_number,
      status: r.status,             // queued | in_progress | completed
      conclusion: r.conclusion,     // success | failure | cancelled | skipped | null
      event: r.event,
      startedAt: r.run_started_at || r.created_at,
      updatedAt: r.updated_at,
      url: r.html_url,
      actor: r.actor && r.actor.login,
    },
  };
}

/** A file's contents from the default branch, as text. */
export async function fileContents(env, path) {
  const res = await gh(env, `/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fileContents(${path}): ${res.status} ${await res.text()}`);
  return await res.text();
}

/**
 * Start a run. Returns { ok } or { ok: false, status, error }.
 *
 * GitHub answers 204 with an empty body, so there is no run id to return and no
 * way to link straight to the run. The caller re-reads the run list instead;
 * that is a GitHub API limitation, not something worth faking a link over.
 */
export async function dispatch(env, file, ref, inputs) {
  const res = await gh(env, `/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  // 403 here is worth naming precisely: the most likely cause is a token missing
  // `Actions: write`, and the raw GitHub message ("Resource not accessible by
  // personal access token") does not say which permission.
  const hint =
    res.status === 403
      ? ' — the admin token likely lacks Actions: read and write on this repository'
      : res.status === 422
        ? ' — the workflow may not exist on the default branch, or an input name is wrong'
        : '';
  return { ok: false, status: res.status, error: `${text}${hint}` };
}
