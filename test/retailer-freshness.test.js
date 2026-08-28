// Proves the retailer-freshness gate actually FIRES on each defect class, and
// that the CADENCE table stays in sync with the live catalog.
//
// What this file deliberately does NOT assert: that the live catalog passes. It
// does not, today — bestbuy, msi, newegg_openbox and newegg_marketplace have no
// refresher and newegg's cron is commented out. Pinning those five failures here
// would mean the test needs editing every time one is FIXED, which is backwards.
// Live freshness is asserted by .github/workflows/retailer-freshness.yml, whose
// job is to go red. This file asserts the gate can tell the difference.
//
// The one live invariant that IS pinned: every retailer in parts.js has a
// CADENCE entry and vice versa. That is the check that fires when someone adds a
// retailer without deciding how it gets confirmed, which is exactly how msi came
// to sit unrefreshed for four months.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const gate = require("../scripts/assert-retailer-freshness.cjs");

// ── fixture helpers ─────────────────────────────────────────────────────────

let tmpRoot;
test.before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rfresh-")); });
test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

let seq = 0;
/** Write a throwaway parts.js exporting `products` and return its path. */
function partsFixture(products) {
  const p = path.join(tmpRoot, `parts-${seq++}.js`);
  fs.writeFileSync(p, `export const PARTS = ${JSON.stringify(products)};\nexport default PARTS;\n`);
  return p;
}

/** Write a throwaway workflow dir from {filename: yaml} and return its path. */
function wfFixture(files) {
  const d = path.join(tmpRoot, `wf-${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}

const wfWithCron = (cron) =>
  `name: W\non:\n  schedule:\n    - cron: '${cron}'\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;

const wfWithDisabledCron = (cron) =>
  `name: W\non:\n  # DISABLED because it ate the catalog\n  # schedule:\n  #   - cron: '${cron}'\n  workflow_dispatch:\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;

/** One product carrying one deal for `retailer` with the given fields. */
const product = (retailer, deal) => ({ n: `P${seq}`, deals: { [retailer]: deal } });

const NOW = "2026-08-17T00:00:00Z";

const kinds = (a) => a.failures.map((f) => f.kind).sort();
const rowFor = (a, r) => a.rows.find((x) => x.retailer === r);

// ── cron interval parsing ───────────────────────────────────────────────────

test("cronIntervalDays models the shapes this repo uses", () => {
  assert.equal(gate.cronIntervalDays("0 7 * * *"), 1, "daily");
  assert.equal(gate.cronIntervalDays("0 6,18 * * *"), 0.5, "twice daily");
  assert.equal(gate.cronIntervalDays("0 8 */2 * *"), 2, "every 2 days");
  assert.equal(gate.cronIntervalDays("0 9 */3 * *"), 3, "every 3 days");
  assert.equal(gate.cronIntervalDays("0 10 * * 1"), 7, "weekly");
  assert.equal(gate.cronIntervalDays("0 10 * * 1,4"), 3.5, "twice weekly");
  assert.equal(gate.cronIntervalDays("*/30 * * * *"), 30 / 1440, "every 30 min");
});

test("cronIntervalDays THROWS rather than guessing an unmodelled shape", () => {
  // Guessing would silently produce a budget nobody chose, and the gate would
  // keep passing against it. Failing loudly is the only safe response.
  assert.throws(() => gate.cronIntervalDays("0 7 * *"), /expected 5 fields/);
  assert.throws(() => gate.cronIntervalDays("0 7 1 * *"), /unsupported day-of-month/);
  assert.throws(() => gate.cronIntervalDays("0 7 * 3 *"), /month restrictions/);
  assert.throws(() => gate.cronIntervalDays("0 7 */2 * 1"), /both day-of-month and day-of-week/);
  assert.throws(() => gate.cronIntervalDays("H 7 * * *"), /unsupported minute/);
  assert.throws(() => gate.cronIntervalDays("0 MON * * *"), /unsupported hour/);
});

test("budgetDaysFor applies the missed-cycle policy and the floor", () => {
  assert.equal(gate.budgetDaysFor(7), 14, "weekly x2 missed cycles");
  assert.equal(gate.budgetDaysFor(2), 4, "every-2-days x2");
  assert.equal(gate.budgetDaysFor(0.5), gate.MIN_BUDGET_DAYS, "twice-daily is floored, not 1d");
  assert.equal(gate.budgetDaysFor(30 / 1440), gate.MIN_BUDGET_DAYS, "sub-daily is floored");
  assert.ok(gate.budgetDaysFor(7) > gate.MIN_BUDGET_DAYS, "the floor never overrides a real budget");
});

// ── the happy path ──────────────────────────────────────────────────────────

test("a retailer confirmed inside its budget by a live cron PASSES", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.deepEqual(a.failures, [], JSON.stringify(a.failures));
  assert.equal(rowFor(a, "shop").verdict, "OK");
  assert.equal(rowFor(a, "shop").budgetDays, 3, "daily cron, floored to the 3d minimum");
});

test("any of the three confirmation stamps counts, including refreshedAt", async () => {
  // refreshedAt is on zero rows today but is what refresh-newegg-prices.cjs
  // writes. If the gate ignored it, re-enabling that cron would produce a
  // working re-pricer that this gate still called frozen.
  for (const field of gate.CONFIRMATION_STAMPS) {
    const a = await gate.audit({
      now: NOW,
      partsPath: partsFixture([product("shop", { price: 1, [field]: "2026-08-16" })]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });
    assert.deepEqual(a.failures, [], `${field} should count as confirmation`);
  }
});

// ── each failure class ──────────────────────────────────────────────────────

test("STALE: newest confirmation past the budget fails", async () => {
  const a = await gate.audit({
    now: NOW,
    // weekly cron => 14d budget; 2026-07-01 is 47d before 2026-08-17
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-07-01" })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 10 * * 1") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 10 * * 1" }, why: "x" } },
  });
  assert.deepEqual(kinds(a), ["stale"]);
  const r = rowFor(a, "shop");
  assert.equal(r.verdict, "STALE");
  assert.equal(r.ageDays, 47);
  assert.equal(r.budgetDays, 14);
});

test("STALE fires at budget+1 and not at budget — the boundary is pinned", async () => {
  const at = async (confirmedAt) =>
    gate.audit({
      now: NOW,
      partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: confirmedAt })]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });
  // budget is 3d (daily cron, floored)
  assert.deepEqual((await at("2026-08-14")).failures, [], "exactly at budget (3d) passes");
  assert.deepEqual(kinds(await at("2026-08-13")), ["stale"], "one day past budget (4d) fails");
});

// ── the max shape, inside the gate that exists to catch the max shape ────────

test("one confirmed row does not vouch for a frozen catalog", async () => {
  // The Newegg shape on 2026-08-28: newest 1d, median 10d, p90 35d, because
  // sftp-ingest stamps matchedAt on newly attached deals while the re-pricer
  // has written nothing. A max reads that retailer as fresh.
  const products = [
    product("shop", { price: 1, priceConfirmedAt: "2026-08-17" }),
    ...Array.from({ length: 99 }, () =>
      product("shop", { price: 1, priceConfirmedAt: "2026-06-18" })), // 60d
  ];
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture(products),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });

  const r = rowFor(a, "shop");
  assert.equal(r.ageDays, 0, "the newest stamp is today — the old check saw only this");
  assert.equal(r.medianAgeDays, 60);
  assert.equal(r.p90AgeDays, 60);
  assert.deepEqual(kinds(a), ["stale"]);
  assert.equal(r.verdict, "STALE");
  assert.match(r.detail, /median confirmed row is 60d old/);
  // The report must say why the old reading disagreed, not just that it failed.
  assert.match(r.detail, /reading the newest\s+alone would have reported this retailer as fresh/);
});

test("one forgotten row does not condemn a healthy catalog", async () => {
  // Robust in the other direction too: the median is not a max on either end.
  const products = [
    ...Array.from({ length: 99 }, () =>
      product("shop", { price: 1, priceConfirmedAt: "2026-08-17" })),
    product("shop", { price: 1, priceConfirmedAt: "2025-10-21" }), // 300d
  ];
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture(products),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.deepEqual(a.failures, []);
  assert.equal(rowFor(a, "shop").medianAgeDays, 0);
  assert.equal(rowFor(a, "shop").p90AgeDays, 0);
});

test("the MEDIAN boundary is pinned at budget and budget+1", async () => {
  // Half the rows fresh, half at `old` — median lands on the older half.
  const at = async (old) =>
    gate.audit({
      now: NOW,
      partsPath: partsFixture([
        ...Array.from({ length: 50 }, () =>
          product("shop", { price: 1, priceConfirmedAt: "2026-08-17" })),
        ...Array.from({ length: 50 }, () =>
          product("shop", { price: 1, priceConfirmedAt: old })),
      ]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });
  assert.deepEqual((await at("2026-08-14")).failures, [], "median exactly at budget (3d) passes");
  assert.deepEqual(kinds(await at("2026-08-13")), ["stale"], "median one day past budget fails");
});

test("quantiles are null with no stamps, so NEVER CONFIRMED still wins over stale", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1 })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  const r = rowFor(a, "shop");
  assert.equal(r.medianAgeDays, null, "no stamps must not read as age 0");
  assert.equal(r.p90AgeDays, null);
  assert.deepEqual(kinds(a), ["no-stamps"]);
});

test("SCHEDULE OFF: a commented-out cron fails even when the data is fresh", async () => {
  // The load-bearing case. Newegg's cron was commented out on 2026-07-20 and the
  // data took weeks to visibly rot — this check would have fired the same day.
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "shop.yml": wfWithDisabledCron("0 6,18 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 6,18 * * *" }, why: "x" } },
  });
  assert.deepEqual(kinds(a), ["schedule-disabled"]);
  assert.equal(rowFor(a, "shop").verdict, "SCHEDULE OFF");
  assert.match(a.failures[0].detail, /COMMENTED OUT/);
});

test("CITE DRIFT: citing a cron the workflow no longer has fails", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 9 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.deepEqual(kinds(a), ["cite-drift"]);
  assert.match(a.failures[0].detail, /live crons: 0 9 \* \* \*/);
});

test("MISSING WORKFLOW: citing a workflow that does not exist fails", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "other.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.deepEqual(kinds(a), ["missing-workflow"]);
});

test("UNSCHEDULED: a stated gap is still a failure", async () => {
  // A documented gap is still a gap. Letting the table excuse a retailer would
  // turn this gate into the warning it exists to replace.
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({}),
    cadence: { shop: { unscheduled: "nothing refreshes this" } },
  });
  assert.deepEqual(kinds(a), ["unscheduled"]);
  assert.equal(rowFor(a, "shop").verdict, "UNSCHEDULED");
});

test("UNKNOWN: a retailer with no CADENCE entry fails", async () => {
  // How msi got four months of nothing: nobody had ever written down how it
  // was supposed to be confirmed, so nothing could notice it never was.
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("brand_new", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({}),
    cadence: {},
  });
  assert.deepEqual(kinds(a), ["unknown-retailer"]);
});

test("PHANTOM: a CADENCE entry for a retailer no longer in the catalog fails", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: {
      shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" },
      departed: { unscheduled: "gone" },
    },
  });
  assert.deepEqual(kinds(a), ["phantom-retailer"]);
});

test("NEVER CONFIRMED: rows with a live cron but zero stamps fails distinctly from stale", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1 })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.deepEqual(kinds(a), ["no-stamps"]);
  assert.equal(rowFor(a, "shop").verdict, "NEVER CONFIRMED");
  assert.equal(rowFor(a, "shop").ageDays, null, "there is no age to report, not an age of 0");
});

test("MALFORMED: an entry with neither unscheduled nor a complete confirmedBy fails", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({}),
    cadence: { shop: { why: "I forgot to say how it is confirmed" } },
  });
  assert.deepEqual(kinds(a), ["malformed-entry"]);
});

// ── negative-stamp precedence ───────────────────────────────────────────────

test("a priceUnconfirmedAt NEWER than the last success does not count as confirmation", async () => {
  const mk = (deal) =>
    gate.audit({
      now: NOW,
      partsPath: partsFixture([product("shop", deal)]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });

  const newerFailure = await mk({ price: 1, priceConfirmedAt: "2026-08-10", priceUnconfirmedAt: "2026-08-16" });
  assert.deepEqual(kinds(newerFailure), ["no-stamps"], "the most recent fact is a failure to confirm");
  assert.equal(rowFor(newerFailure, "shop").stamped, 0);
  assert.equal(rowFor(newerFailure, "shop").negative, 1);

  const olderFailure = await mk({ price: 1, priceConfirmedAt: "2026-08-16", priceUnconfirmedAt: "2026-08-10" });
  assert.deepEqual(olderFailure.failures, [], "a stale failure does not invalidate a newer success");
  assert.equal(rowFor(olderFailure, "shop").stamped, 1);
});

// ── multiple retailers, and the report ──────────────────────────────────────

test("one healthy retailer does not mask a frozen one", async () => {
  // The exact shape of the four-month miss: amazon looked fine, so the aggregate
  // looked fine. Per-retailer accounting is the whole point.
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([
      product("good", { price: 1, priceConfirmedAt: "2026-08-16" }),
      product("frozen", { price: 1, priceConfirmedAt: "2026-04-20" }),
    ]),
    wfDir: wfFixture({ "g.yml": wfWithCron("0 7 * * *"), "f.yml": wfWithCron("0 7 * * *") }),
    cadence: {
      good: { confirmedBy: { workflow: "g.yml", cron: "0 7 * * *" }, why: "x" },
      frozen: { confirmedBy: { workflow: "f.yml", cron: "0 7 * * *" }, why: "x" },
    },
  });
  assert.deepEqual(kinds(a), ["stale"]);
  assert.equal(rowFor(a, "good").verdict, "OK");
  assert.equal(rowFor(a, "frozen").verdict, "STALE");
});

test("report() returns a non-zero exit code on any failure and 0 on none", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const bad = await gate.audit({
      now: NOW,
      partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-01-01" })]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });
    assert.equal(gate.report(bad), 1);

    const ok = await gate.audit({
      now: NOW,
      partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
      wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
      cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
    });
    assert.equal(gate.report(ok), 0);
  } finally {
    console.log = log;
  }
});

// ── the live tree: table/catalog sync only ──────────────────────────────────

test("every retailer in the live catalog has a CADENCE entry, and vice versa", async () => {
  const a = await gate.audit({});
  const bookkeeping = a.failures.filter(
    (f) => f.kind === "unknown-retailer" || f.kind === "phantom-retailer" || f.kind === "malformed-entry"
  );
  assert.deepEqual(
    bookkeeping,
    [],
    "CADENCE is out of sync with parts.js — a retailer was added or removed without deciding " +
      "how it gets confirmed:\n" + bookkeeping.map((f) => `  ${f.kind}: ${f.retailer}`).join("\n")
  );
  assert.ok(a.rows.length >= 6, `expected >=6 retailers, saw ${a.rows.length}`);
});

test("every live CADENCE entry states a reason a human can act on", async () => {
  for (const [name, spec] of Object.entries(gate.CADENCE)) {
    const text = spec.unscheduled || spec.why;
    assert.ok(text && text.length > 60, `${name}: needs a real justification, not a label`);
    if (spec.confirmedBy) {
      assert.ok(spec.confirmedBy.workflow.endsWith(".yml"), `${name}: workflow must be a .yml filename`);
      assert.doesNotThrow(() => gate.cronIntervalDays(spec.confirmedBy.cron), `${name}: cited cron must parse`);
    }
  }
});
