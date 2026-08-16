// =============================================================================
//  admin/functions/api/stats.js — "how many are live, how many are quarantined,
//  and why?"  Phase 0, question 2.
//
//  Reads catalog-build/catalog-stats.json from the default branch, which
//  scripts/catalog-stats.cjs recomputes whenever the catalog changes. Fetched
//  from GitHub rather than bundled into this deployment on purpose: the counts
//  change nightly, the admin project deploys rarely, and a number that is stale
//  by a week while looking current is the failure this dashboard exists to fix.
//
//  Parsing the catalog here instead was considered and rejected: it is ~8.4 MB
//  across 30 modules, which is over the CPU budget for a Function and pointless
//  work to repeat on every page load when the inputs only change on a commit.
// =============================================================================

import { fileContents } from '../../functions-lib/github.js';

const STATS_PATH = 'catalog-build/catalog-stats.json';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function onRequestGet(context) {
  let text;
  try {
    text = await fileContents(context.env, STATS_PATH);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }

  if (text === null)
    return json(
      {
        error: `${STATS_PATH} is not on the default branch yet — run the "Catalog stats" workflow once, or 'node scripts/catalog-stats.cjs' locally and commit the result.`,
      },
      404,
    );

  let stats;
  try {
    stats = JSON.parse(text);
  } catch (e) {
    return json({ error: `${STATS_PATH} is not valid JSON: ${e.message}` }, 502);
  }

  // Re-assert the identities the writer already checked. The dashboard renders
  // the headline and the breakdown from the same payload, and a payload that
  // does not reconcile would be displayed as two numbers that quietly disagree —
  // so refuse to render it rather than show it.
  const t = stats.totals || {};
  const a = stats.attribution || {};
  const problems = [];
  if (t.live + t.quarantined !== t.total) problems.push(`live ${t.live} + quarantined ${t.quarantined} !== total ${t.total}`);
  if (a.withReason + a.withoutReason !== t.quarantined)
    problems.push(`attribution ${a.withReason} + ${a.withoutReason} !== quarantined ${t.quarantined}`);
  if (problems.length) return json({ error: `catalog-stats.json does not reconcile: ${problems.join('; ')}` }, 502);

  return json(stats);
}
