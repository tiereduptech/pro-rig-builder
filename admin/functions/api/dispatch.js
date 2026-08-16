// =============================================================================
//  admin/functions/api/dispatch.js — Phase 1, and the only write in v1.
//
//  It starts a run that was already startable from the Actions tab, with inputs
//  restricted by admin/functions-lib/allowlist.js, under the guards that already
//  exist inside each workflow. It does not add a new capability; it adds a
//  shorter path to an existing one.
//
//  GET  /api/dispatch  -> what may be dispatched (drives the UI, so the UI can
//                         never offer a button the server would refuse)
//  POST /api/dispatch  -> { workflow, inputs } -> 204-equivalent or an error
// =============================================================================

import { DISPATCH_ALLOWLIST, validateDispatch } from '../../functions-lib/allowlist.js';
import { dispatch } from '../../functions-lib/github.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** The allowlist, with RegExp values made serializable. */
export function onRequestGet() {
  return json({
    options: DISPATCH_ALLOWLIST.map((e) => ({
      workflow: e.workflow,
      label: e.label,
      description: e.description,
      writes: e.writes,
      cost: e.cost,
      inputs: Object.fromEntries(
        Object.entries(e.inputs || {}).map(([k, spec]) => [
          k,
          { required: !!spec.required, values: spec.values || null, default: spec.default ?? null, format: spec.pattern ? String(spec.pattern) : null },
        ]),
      ),
    })),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }

  const check = validateDispatch(body && body.workflow, body && body.inputs);
  if (!check.ok) return json({ error: check.error }, 400);

  // Always the default branch. A ref parameter would let the dashboard run
  // arbitrary branch code under the repository's secrets, which is a different
  // and much larger capability than "start tonight's job now".
  const ref = String(env.DISPATCH_REF || 'main');

  const result = await dispatch(env, check.entry.workflow, ref, check.inputs);
  if (!result.ok) return json({ error: result.error, status: result.status }, 502);

  return json({
    ok: true,
    workflow: check.entry.workflow,
    label: check.entry.label,
    ref,
    inputs: check.inputs,
    // GitHub answers a dispatch with 204 and no body, so there is no run id yet.
    // Say that plainly instead of inventing a link that might point at the
    // previous run.
    note: 'GitHub accepted the dispatch. It returns no run id, so the run appears in the list within a few seconds.',
  });
}
