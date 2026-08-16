// =============================================================================
//  admin/functions/api/runs.js — "when did each workflow last run, and did it
//  succeed?"  Phase 0, question 1.
//
//  Queried live on every load rather than cached, because a cached answer to
//  "did last night's run succeed" is the one kind of answer that is worse than
//  no answer.
// =============================================================================

import { listWorkflows, lastRun } from '../../functions-lib/github.js';
import { DISPATCH_ALLOWLIST } from '../../functions-lib/allowlist.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function onRequestGet(context) {
  const { env } = context;

  let defs;
  try {
    defs = await listWorkflows(env);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }

  const files = Object.keys(defs).sort();
  // Parallel: 17 subrequests well inside the per-invocation limit, and serially
  // this would be ~17 round trips on every page load.
  const results = await Promise.all(files.map((f) => lastRun(env, f).catch((e) => ({ file: f, run: null, error: String(e.message || e) }))));

  const dispatchable = new Set(DISPATCH_ALLOWLIST.map((e) => e.workflow));

  return json({
    generatedAt: new Date().toISOString(),
    workflows: results.map((r) => ({
      ...r,
      name: (defs[r.file] || {}).name || r.file,
      // 'disabled_inactivity' is the one that matters: GitHub turns scheduled
      // workflows off after 60 days of repository inactivity, and a disabled
      // schedule looks exactly like a quiet one until someone says so.
      state: (defs[r.file] || {}).state || 'unknown',
      dispatchable: dispatchable.has(r.file),
    })),
  });
}
