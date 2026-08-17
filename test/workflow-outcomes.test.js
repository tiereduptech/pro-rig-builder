// Proves the scheduled-workflow outcome gate fires on each defect class.
//
// The gate closes the third instance of one mistake: reading a proxy as the
// thing. A dated price point was read as evidence a retailer was checked; a cron
// was read as evidence a job succeeded. sftp-ingest.yml had a daily cron, ran
// every day, and succeeded twice in 99 runs — 88 cancelled at a timeout, which
// is the quietest outcome GitHub produces. This asserts on conclusions.
//
// Fully hermetic: the run/meta fetchers are injected, so no token or network is
// involved and `npm test` stays green regardless of the live repo's state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const gate = require("../scripts/assert-workflow-outcomes.cjs");

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wfout-")); });
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
const NOW = "2026-08-17T12:00:00Z";

const yml = (crons, { dispatchOnly = false, commented = false } = {}) => {
  const list = crons.map((c) => `    - cron: '${c}'`).join("\n");
  const off = crons.map((c) => `  #   - cron: '${c}'`).join("\n");
  if (dispatchOnly) return `name: W\non:\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
  if (commented) return `name: W\non:\n  # schedule:\n${off}\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
  return `name: W\non:\n  schedule:\n${list}\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
};

function wfDir(files) {
  const d = path.join(tmp, `wf-${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}

/** n runs, one per day going back from `from`, each with the given conclusion. */
function runs(conclusions, from = "2026-08-17") {
  const base = Date.parse(from + "T12:00:00Z");
  return conclusions.map((c, i) => ({
    conclusion: c === "running" ? null : c,
    status: c === "running" ? "in_progress" : "completed",
    createdAt: new Date(base - i * 86400000).toISOString(),
  }));
}

const run = (opts) =>
  gate.audit({
    now: NOW,
    onDefaultBranch: true,
    ...opts,
    fetchWorkflowRuns: opts.fetchWorkflowRuns || (async () => ({ missing: false, runs: [] })),
  });

const kinds = (a) => a.failures.map((f) => f.kind).sort();
const row = (a, f) => a.rows.find((r) => r.file === f);

// ── scope: only live crons ──────────────────────────────────────────────────

test("dispatch-only workflows are out of scope", async () => {
  const a = await run({ wfDir: wfDir({ "d.yml": yml([], { dispatchOnly: true }) }) });
  assert.equal(a.scheduled, 0);
  assert.deepEqual(a.rows, []);
  assert.deepEqual(a.failures, []);
});

test("a commented-out cron is out of scope here — that belongs to the retailer gate", async () => {
  // Deliberate division of labour: a disabled schedule is caught by
  // assert-retailer-freshness's provenance check. Reporting it in both places
  // would double-count one defect.
  const a = await run({ wfDir: wfDir({ "c.yml": yml(["0 6 * * *"], { commented: true }) }) });
  assert.equal(a.scheduled, 0);
  assert.deepEqual(a.failures, []);
});

// ── the happy path ──────────────────────────────────────────────────────────

test("a workflow that succeeded inside its budget passes", async () => {
  const a = await run({
    wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success", "success"]) }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.deepEqual(a.failures, []);
  assert.equal(row(a, "w.yml").verdict, "OK");
  assert.equal(row(a, "w.yml").budgetDays, 3, "daily cron floored to the 3d minimum");
});

test("budget comes from the FASTEST cron when a workflow has several", async () => {
  // verify-catalog.yml fires tier 1 every 2 days and tiers 3-4 weekly. As a
  // whole it promises a success every 2 days, so 2 is the interval that binds.
  const a = await run({
    wfDir: wfDir({ "w.yml": yml(["0 8 */2 * *", "0 10 * * 1"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success"]) }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.equal(row(a, "w.yml").budgetDays, 4, "2-day cron x 2 missed cycles, not the weekly one");
});

// ── the requirement: cancelled is not success ───────────────────────────────

test("CANCELLED counts as not-succeeded — the sftp-ingest shape", async () => {
  // 96 scheduled runs, one success 95 days ago, the rest cancelled at a timeout.
  // Cancellation is grey in the UI and sends no notification, which is exactly
  // why 88 of them read as "nothing is wrong" for three months.
  const conclusions = [...Array(95).fill("cancelled"), "success"];
  const a = await run({
    wfDir: wfDir({ "sftp-ingest.yml": yml(["0 12 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(conclusions) }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.deepEqual(kinds(a), ["stale-success"]);
  const r = row(a, "sftp-ingest.yml");
  assert.equal(r.successes, 1);
  assert.equal(r.successAgeDays, 95);
  assert.equal(r.verdict, "STALE SUCCESS");
  assert.match(a.failures[0].detail, /95 scheduled run\(s\) since then, none of them successful/);
  assert.match(a.failures[0].detail, /95 cancelled/, "the wall of cancellations must be spelled out");
});

test("every non-success conclusion is treated as not-succeeded", async () => {
  for (const bad of ["cancelled", "failure", "timed_out", "skipped", "startup_failure", "neutral", "action_required", "running", "some_future_conclusion"]) {
    const a = await run({
      wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
      fetchWorkflowRuns: async () => ({ missing: false, runs: runs(Array(10).fill(bad)) }),
      fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
    });
    assert.deepEqual(kinds(a), ["never-succeeded"], `'${bad}' must not count as success`);
  }
});

test("a workflow that runs constantly and never succeeds fails as never-succeeded", async () => {
  const a = await run({
    wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(Array(50).fill("failure")) }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.deepEqual(kinds(a), ["never-succeeded"]);
  assert.match(a.failures[0].detail, /50 scheduled run\(s\), not one with conclusion=success/);
});

// ── boundary ────────────────────────────────────────────────────────────────

test("the staleness boundary fires at budget+1, not at budget", async () => {
  const at = async (lastSuccessDate) =>
    run({
      wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
      fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success"], lastSuccessDate) }),
      fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
    });
  assert.deepEqual((await at("2026-08-14")).failures, [], "exactly at the 3d budget passes");
  assert.deepEqual(kinds(await at("2026-08-13")), ["stale-success"], "4d fails");
});

// ── new-workflow grace ──────────────────────────────────────────────────────

test("a brand-new workflow gets a grace window equal to its budget", async () => {
  const a = await run({
    wfDir: wfDir({ "new.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: [] }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-08-16T00:00:00Z" }),
  });
  assert.deepEqual(a.failures, [], "1 day old, 3 day budget — cannot have succeeded yet");
  assert.match(row(a, "new.yml").verdict, /^NEW/);
});

test("the grace window expires on its own, with no suppression to remember", async () => {
  const a = await run({
    wfDir: wfDir({ "new.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(Array(5).fill("failure")) }),
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-08-01T00:00:00Z" }),
  });
  assert.deepEqual(kinds(a), ["never-succeeded"], "16 days old, past a 3 day grace");
});

// ── disabled + missing ──────────────────────────────────────────────────────

test("a workflow disabled in the UI fails — the cron cannot fire", async () => {
  const a = await run({
    wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success"]) }),
    fetchWorkflowMeta: async () => ({ state: "disabled_manually", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.deepEqual(kinds(a), ["workflow-disabled"]);
  assert.match(row(a, "w.yml").verdict, /DISABLED/);
});

test("a cron GitHub has no record of fails on the default branch", async () => {
  const a = await run({
    onDefaultBranch: true,
    wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: true, runs: [] }),
  });
  assert.deepEqual(kinds(a), ["not-on-remote"]);
});

test("...but only reports on a PR branch, so adding a scheduled job never reddens a PR", async () => {
  // An alarm that fires on routine work is one that gets switched off.
  const a = await gate.audit({
    now: NOW,
    onDefaultBranch: false,
    wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
    fetchWorkflowRuns: async () => ({ missing: true, runs: [] }),
  });
  assert.deepEqual(a.failures, []);
  assert.equal(row(a, "w.yml").verdict, "PENDING MERGE");
});

// ── bad input ───────────────────────────────────────────────────────────────

test("an unparseable cron fails rather than being skipped", async () => {
  const a = await run({
    wfDir: wfDir({ "w.yml": yml(["0 7 1 1 *"]) }),
    fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success"]) }),
  });
  assert.deepEqual(kinds(a), ["unparseable-cron"]);
});

test("audit() refuses to run without an injected fetcher", async () => {
  await assert.rejects(() => gate.audit({ wfDir: wfDir({}) }), /needs a fetchWorkflowRuns/);
});

// ── one healthy job never masks a broken one ────────────────────────────────

test("a healthy workflow does not mask a dead one", async () => {
  const a = await run({
    wfDir: wfDir({ "good.yml": yml(["0 7 * * *"]), "dead.yml": yml(["0 12 * * *"]) }),
    fetchWorkflowRuns: async (f) =>
      f === "good.yml"
        ? { missing: false, runs: runs(["success"]) }
        : { missing: false, runs: runs([...Array(90).fill("cancelled"), "success"]) },
    fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
  });
  assert.deepEqual(kinds(a), ["stale-success"]);
  assert.equal(row(a, "good.yml").verdict, "OK");
  assert.equal(row(a, "dead.yml").verdict, "STALE SUCCESS");
});

// ── report ──────────────────────────────────────────────────────────────────

test("report() exits non-zero on failure and zero on none", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const bad = await run({
      wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
      fetchWorkflowRuns: async () => ({ missing: false, runs: runs(Array(9).fill("cancelled")) }),
      fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
    });
    assert.equal(gate.report(bad), 1);

    const ok = await run({
      wfDir: wfDir({ "w.yml": yml(["0 7 * * *"]) }),
      fetchWorkflowRuns: async () => ({ missing: false, runs: runs(["success"]) }),
      fetchWorkflowMeta: async () => ({ state: "active", createdAt: "2026-01-01T00:00:00Z" }),
    });
    assert.equal(gate.report(ok), 0);
  } finally {
    console.log = log;
  }
});

test("pickFastest chooses the tightest cron and survives an unparseable sibling", () => {
  assert.equal(gate.pickFastest(["0 10 * * 1", "0 8 */2 * *"]), "0 8 */2 * *");
  assert.equal(gate.pickFastest(["0 7 1 1 *", "0 6,18 * * *"]), "0 6,18 * * *");
});

test("describeTally orders outcomes by frequency so the dominant one leads", () => {
  assert.equal(gate.describeTally({ success: 1, cancelled: 88 }), "88 cancelled, 1 success");
  assert.equal(gate.describeTally({}), "no runs");
});
