// =============================================================================
//  admin/functions-lib/allowlist.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  What the dashboard is permitted to dispatch. See DESIGN-admin-dashboard.md §10.
//
//  ── WHY AN ALLOWLIST AND NOT "THE WORKFLOW'S INPUTS ARE THE SCHEMA" ─────────
//  That claim is only true if the caller cannot invent inputs. verify-catalog.yml
//  carries a `force_paapi_unconfigured` self-test input whose entire purpose is
//  to blank the PA API credentials and prove the fail-loud gate fires. It is
//  correct for a human at the Actions tab and must never be reachable from a web
//  button. An allowlist is how it is not.
//
//  It also lets the dashboard be NARROWER than the workflow. asin-identity-audit
//  defaults `apply` to true — it quarantines confirmed-dead ASINs. The button
//  below can only ever send `false`. The dry run is dispatchable from here; the
//  applying run stays at the Actions tab, where the person clicking it has read
//  the input description.
//
//  ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
//    apply-newegg.yml        writes discovered rows into the catalog
//    sftp-ingest.yml         bulk catalog ingest
//    deploy-*, publish-*     ship code to production
//    refresh-newegg-prices   rewrites prices catalog-wide
//  None of these are things to start from a dashboard without reading the run's
//  own inputs first. Adding one is a deliberate edit to this file, reviewed like
//  code — which is the point.
//
//  `writes` drives a typed confirmation in the UI. `cost` is a plain-language
//  warning, not a limit: the real spend guard is verify-spend-guard.js and it is
//  not replaced or duplicated here.
// =============================================================================

export const DISPATCH_ALLOWLIST = [
  {
    workflow: 'verify-catalog.yml',
    label: 'Catalog verification (one tier)',
    description: 'Price/stock/ASIN sweep for a single tier, then commit the fixes.',
    writes: true,
    cost: 'paid — DataForSEO tasks, bounded by the $10 per-run spend ceiling',
    inputs: {
      tier: { required: true, values: ['1', '2', '3', '4'] },
      fix_asins: { required: false, values: ['true', 'false'], default: 'true' },
    },
  },
  {
    workflow: 'discover-newegg-dry.yml',
    label: 'Newegg discovery — dry run',
    description: 'Read-only: reports what discovery WOULD add for a category. Writes nothing.',
    writes: false,
    cost: 'free',
    inputs: {
      category: { required: true, values: ['RAM', 'PSU', 'Storage', 'Motherboard', 'CPU', 'GPU', 'Case', 'Monitor'] },
      sample: { required: false, pattern: /^\d{1,3}$/, default: '60' },
    },
  },
  {
    workflow: 'asin-identity-audit.yml',
    label: 'ASIN identity audit — dry run',
    description:
      'Read-only. The workflow defaults apply=true (which quarantines dead ASINs); this button can only send false.',
    writes: false,
    cost: 'free',
    inputs: {
      apply: { required: false, values: ['false'], default: 'false' },
    },
  },
  {
    workflow: 'case-sweep-newegg.yml',
    label: 'Newegg case sweep (read-only)',
    description: 'Phase 1 sweep. Writes nothing.',
    writes: false,
    cost: 'free',
    inputs: {},
  },
  {
    workflow: 'feed-overlap-audit.yml',
    label: 'Newegg feed overlap audit',
    description: 'Read-only feed coverage report.',
    writes: false,
    cost: 'free',
    inputs: {},
  },
  {
    workflow: 'price-history.yml',
    label: 'Price history snapshot',
    description: 'Records today’s prices into the 90-day series and commits.',
    writes: true,
    cost: 'free',
    inputs: {},
  },
  {
    workflow: 'prerender.yml',
    label: 'Prerender SEO pages',
    description: 'Rebuilds dist/ and commits it. The recovery action when the nightly prerender fails.',
    writes: true,
    cost: 'long — headless Chrome, up to ~3 hours',
    inputs: {},
  },
];

export function findEntry(workflow) {
  return DISPATCH_ALLOWLIST.find((e) => e.workflow === workflow) || null;
}

/**
 * Validate a dispatch request against the allowlist.
 * Returns { ok: true, inputs } with ONLY allowlisted keys, or { ok: false, error }.
 *
 * Unknown keys are rejected rather than dropped. Silently discarding an input the
 * caller believed it was sending is how you get a run that did something other
 * than what the operator asked for and still looked successful.
 */
export function validateDispatch(workflow, rawInputs) {
  const entry = findEntry(workflow);
  if (!entry) return { ok: false, error: `workflow '${workflow}' is not in the dispatch allowlist` };

  const given = rawInputs && typeof rawInputs === 'object' ? rawInputs : {};
  const allowed = entry.inputs || {};

  for (const key of Object.keys(given))
    if (!(key in allowed))
      return { ok: false, error: `input '${key}' is not permitted for ${workflow}` };

  const inputs = {};
  for (const [key, spec] of Object.entries(allowed)) {
    let value = given[key];
    if (value === undefined || value === null || value === '') {
      if (spec.required) return { ok: false, error: `input '${key}' is required for ${workflow}` };
      if (spec.default === undefined) continue;
      value = spec.default;
    }
    value = String(value);
    if (spec.values && !spec.values.includes(value))
      return { ok: false, error: `input '${key}'='${value}' is not one of ${spec.values.join(', ')}` };
    if (spec.pattern && !spec.pattern.test(value))
      return { ok: false, error: `input '${key}'='${value}' has an unexpected format` };
    inputs[key] = value;
  }

  return { ok: true, entry, inputs };
}
