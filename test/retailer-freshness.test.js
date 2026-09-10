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

// =============================================================================
//  A LANE MAY HAVE MORE THAN ONE WRITER
//
//  deals.newegg has two: refresh-newegg-prices confirms the rows it can address
//  by name/UPC, and sftp-ingest confirms the rows it structurally cannot, which
//  are keyed by newegg_item_number (see lanesSolelyOwned() in sftp-ingest.cjs).
//
//  Citing only the busier one would rebuild this file's own bug one level up:
//  the second job's schedule would go unwatched, and a cron commented out — the
//  exact thing that happened to refresh-newegg-prices on 2026-07-20 — would
//  leave the gate citing a live workflow while the rows that job confirms froze.
// =============================================================================

const twoCites = (a, b) => ({ shop: { confirmedBy: [a, b], why: "x" } });

test("both cites are checked, not just the first", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({
      "fast.yml": wfWithCron("0 7 * * *"),
      "slow.yml": wfWithDisabledCron("0 12 * * *"),
    }),
    cadence: twoCites({ workflow: "fast.yml", cron: "0 7 * * *" },
                      { workflow: "slow.yml", cron: "0 12 * * *" }),
  });
  assert.deepEqual(kinds(a), ["schedule-disabled"],
    "the SECOND writer's cron is off — a gate reading only the first would call this green");
  assert.equal(rowFor(a, "shop").verdict, "SCHEDULE OFF");
});

test("a drifted cite fails even when the other cite is live", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({
      "fast.yml": wfWithCron("0 7 * * *"),
      "slow.yml": wfWithCron("0 12 * * *"),
    }),
    cadence: twoCites({ workflow: "fast.yml", cron: "0 7 * * *" },
                      { workflow: "slow.yml", cron: "0 13 * * *" }),
  });
  assert.deepEqual(kinds(a), ["cite-drift"]);
});

test("the budget comes from the SLOWEST writer, not the fastest", async () => {
  // Taking the fastest would compute a budget no single writer's rows are held
  // to. Same rule the amazon entry already states for its four tiers.
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({
      "fast.yml": wfWithCron("0 7 * * *"),      // daily      -> 3d (floored)
      "slow.yml": wfWithCron("0 10 * * 1"),     // weekly     -> 14d
    }),
    cadence: twoCites({ workflow: "fast.yml", cron: "0 7 * * *" },
                      { workflow: "slow.yml", cron: "0 10 * * 1" }),
  });
  assert.equal(rowFor(a, "shop").budgetDays, 14, "the weekly writer sets it");
  assert.equal(gate.slowestIntervalDays([{ cron: "0 7 * * *" }, { cron: "0 10 * * 1" }]), 7);
});

test("both cites are named in the report, so the reader knows who to chase", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({
      "fast.yml": wfWithCron("0 7 * * *"),
      "slow.yml": wfWithCron("0 12 * * *"),
    }),
    cadence: twoCites({ workflow: "fast.yml", cron: "0 7 * * *" },
                      { workflow: "slow.yml", cron: "0 12 * * *" }),
  });
  const cite = rowFor(a, "shop").cite;
  assert.match(cite, /fast\.yml/);
  assert.match(cite, /slow\.yml/);
});

test("a bare confirmedBy object still works — every other entry is unchanged", async () => {
  assert.deepEqual(gate.citesFor({ confirmedBy: { workflow: "s.yml", cron: "0 7 * * *" } }),
    [{ workflow: "s.yml", cron: "0 7 * * *" }]);
});

test("MALFORMED: an incomplete cite in a list fails like a bare one", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1, priceConfirmedAt: "2026-08-16" })]),
    wfDir: wfFixture({ "fast.yml": wfWithCron("0 7 * * *") }),
    cadence: twoCites({ workflow: "fast.yml", cron: "0 7 * * *" }, { workflow: "slow.yml" }),
  });
  assert.deepEqual(kinds(a), ["malformed-entry"]);
});

test("the live newegg entry names BOTH of its writers", () => {
  // The regression that matters on the real table: sftp-ingest now certifies the
  // rows the re-pricer never reaches, so dropping it from this cite would leave
  // its schedule unwatched for this lane.
  const cites = gate.citesFor(gate.CADENCE.newegg).map((c) => c.workflow);
  assert.ok(cites.includes("refresh-newegg-prices.yml"), "the re-pricer");
  assert.ok(cites.includes("sftp-ingest.yml"), "the writer for the rows it cannot reach");
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
  assert.match(r.detail, /median measured row is 60d old/);
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

test("a row with no stamps reads as maximally stale, and NEVER CONFIRMED still wins over stale", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([product("shop", { price: 1 })]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  const r = rowFor(a, "shop");
  assert.equal(r.medianAgeDays, Infinity, "no stamps must never read as age 0 — it is the stalest a row can be");
  assert.equal(r.p90AgeDays, Infinity);
  assert.equal(r.never, 1);
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

// The test above passes on the BROKEN behaviour too, and that is the point worth
// keeping: with one row in the lane, dropping it takes `stamped` to 0 and the
// NEVER CONFIRMED verdict fires anyway, so the row has nowhere to hide. The
// defect only appears once there are confirmed rows to hide BEHIND — which is
// every real lane. newegg_openbox read OK on 82 of 225 rows for exactly this
// reason while its true p90 was 117 days.
test("an unconfirmed row is counted as stale, not deleted from the quantiles", async () => {
  const shop = (deal) => product("shop", deal);
  const a = await gate.audit({
    now: NOW, // 2026-08-17
    partsPath: partsFixture([
      // Nine rows confirmed today: on their own, a spotless 0d median and p90.
      ...Array.from({ length: 9 }, () => shop({ price: 1, priceConfirmedAt: "2026-08-17" })),
      // One row last confirmed 100 days ago, which we then TRIED to re-confirm
      // today and could not. Under the old rule this row vanished and the lane
      // read p90 0d — stamping the failure made the numbers better.
      shop({ price: 1, priceConfirmedAt: "2026-05-09", priceUnconfirmedAt: "2026-08-17" }),
    ]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });

  const r = rowFor(a, "shop");
  assert.equal(r.rows, 10);
  assert.equal(r.stamped, 9, "the failed row is not CONFIRMED");
  assert.equal(r.unconfirmed, 1, "but it is counted, and reported separately");
  assert.equal(r.measured, 10, "and it is behind the quantiles");
  assert.equal(r.p90AgeDays, 100, "measured at its last real confirmation, not deleted");
  assert.equal(r.staleRows, 1);
  assert.deepEqual(kinds(a), ["stale-tail"], "the lane goes red instead of reading OK");

  // The negative stamp must not be able to IMPROVE the lane. Same catalog with
  // the failure never recorded: identical age, so the verdict is identical too.
  const unstamped = await gate.audit({
    now: NOW,
    partsPath: partsFixture([
      ...Array.from({ length: 9 }, () => shop({ price: 1, priceConfirmedAt: "2026-08-17" })),
      shop({ price: 1, priceConfirmedAt: "2026-05-09" }),
    ]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.equal(rowFor(unstamped, "shop").p90AgeDays, r.p90AgeDays,
    "recording a failed confirmation attempt cannot make a retailer look fresher");
  assert.deepEqual(kinds(unstamped), kinds(a));
});

test("`newest` stays confirmed-only — a failed row cannot make a lane look touched", async () => {
  const a = await gate.audit({
    now: NOW,
    partsPath: partsFixture([
      product("shop", { price: 1, priceConfirmedAt: "2026-08-01" }),
      // Confirmed more recently than the row above, but its latest news is a
      // failure. It must not become the retailer's `newest`.
      product("shop", { price: 1, priceConfirmedAt: "2026-08-15", priceUnconfirmedAt: "2026-08-17" }),
    ]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } },
  });
  assert.equal(rowFor(a, "shop").newest, "2026-08-01");
  assert.equal(rowFor(a, "shop").measured, 2, "still measured, just not the newest");
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
  // 5, not 6: newegg_marketplace and its 37 deals were dropped on 2026-08-28
  // (drop-newegg-marketplace.cjs). The floor exists to catch the audit silently
  // seeing nothing — a catalog load returning [] would otherwise pass every
  // assertion above it — so it tracks the real retailer count rather than
  // ratcheting down whenever one is removed.
  assert.ok(a.rows.length >= 5, `expected >=5 retailers, saw ${a.rows.length}`);
});

test("every live CADENCE entry states a reason a human can act on", async () => {
  for (const [name, spec] of Object.entries(gate.CADENCE)) {
    const text = spec.unscheduled || spec.why;
    assert.ok(text && text.length > 60, `${name}: needs a real justification, not a label`);
    if (spec.confirmedBy) {
      // A lane may name more than one writer (deals.newegg has two); every cite
      // has to stand on its own, so they are all checked rather than the first.
      for (const c of gate.citesFor(spec)) {
        assert.ok(c.workflow.endsWith(".yml"), `${name}: workflow must be a .yml filename`);
        assert.doesNotThrow(() => gate.cronIntervalDays(c.cron), `${name}: cited cron must parse`);
      }
    }
  }
});

// =============================================================================
//  THE TAIL
//
//  The median replaced the newest stamp because a max is held at 0d by one
//  active row. The median has the mirror weakness one quantile up: it is held at
//  0d by any MAJORITY. A retailer whose sweep reaches two thirds of its rows and
//  never touches the other third reports 0d forever.
//
//  Not hypothetical. refresh-newegg-prices reaches 2,102 of 3,189 rows on every
//  run and the other 1,064 are reached by nothing — a strictly nested set, not a
//  rate: comparing consecutive runs, zero rows reached by the earlier one were
//  missed by the later one. deals.newegg only read STALE because a later job was
//  erasing the re-pricer's stamps; with that fixed the median goes to 0d and this
//  gate would have gone green over all 1,064.
// =============================================================================

const tailCadence = { shop: { confirmedBy: { workflow: "shop.yml", cron: "0 7 * * *" }, why: "x" } };

/** `fresh` rows confirmed today, `stale` rows confirmed on `old`. */
const withTail = async (fresh, stale, old) =>
  gate.audit({
    now: NOW,
    partsPath: partsFixture([
      ...Array.from({ length: fresh }, () =>
        product("shop", { price: 1, priceConfirmedAt: "2026-08-17" })),
      ...Array.from({ length: stale }, () =>
        product("shop", { price: 1, priceConfirmedAt: old })),
    ]),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: tailCadence,
  });

test("THE BUG: a healthy median does not vouch for an unreachable third", async () => {
  // The exact shape of newegg on 2026-09-02, scaled: 66% reached every run, 34%
  // reached by nothing. Median 0d, and before this check that was a PASS.
  const a = await withTail(66, 34, "2026-07-01");
  const r = rowFor(a, "shop");
  assert.equal(r.medianAgeDays, 0, "the median is genuinely fine — that is the point");
  assert.ok(r.p90AgeDays > r.p90BudgetDays);
  assert.deepEqual(kinds(a), ["stale-tail"]);
  assert.equal(r.verdict, "STALE TAIL");
});

test("the tail is reported as a COUNT, not only a quantile", async () => {
  // 'p90 47d' describes 4 forgotten rows and 1,064 unreachable ones identically.
  const a = await withTail(66, 34, "2026-07-01");
  assert.equal(rowFor(a, "shop").staleRows, 34, "the number someone has to go and fix");
});

test("STALE TAIL is a DISTINCT failure from STALE", async () => {
  // Different defect, different fix. STALE means the job is not keeping up;
  // STALE TAIL means something is permanently outside its reach — an unmapped
  // category, a query the feed never answers. "Run it more often" fixes one.
  const a = await withTail(10, 90, "2026-07-01");
  assert.deepEqual(kinds(a), ["stale"], "a majority past budget is ordinary staleness");
  assert.equal(rowFor(a, "shop").verdict, "STALE");
});

test("the P90 boundary is pinned at the tail budget and one day past it", async () => {
  // Budget 3d (daily cron, floored), so the tail budget is 12d.
  // 85/15 so the MEDIAN stays fresh and the p90 check is what is being pinned.
  const at = async (old) => withTail(85, 15, old);
  assert.deepEqual((await at("2026-08-05")).failures, [], "p90 exactly at 12d passes");
  assert.deepEqual(kinds(await at("2026-08-04")), ["stale-tail"], "p90 one day past fails");
});

test("the tail budget derives from the cite's cron, not a hand-written number", async () => {
  // Same property the median budget has: a schedule change cannot silently
  // invalidate the threshold it justified.
  const a = await withTail(66, 34, "2026-07-01");
  const r = rowFor(a, "shop");
  assert.equal(r.p90BudgetDays, r.budgetDays * gate.P90_BUDGET_MULTIPLE);
});

test("a genuinely healthy catalog still passes both quantiles", async () => {
  // The false-alarm direction. An alarm that cries wolf is one that gets
  // commented out, which is what this whole file exists to prevent.
  assert.deepEqual((await withTail(90, 10, "2026-08-15")).failures, []);
});

test("one forgotten row still does not condemn a healthy catalog", async () => {
  // p90 is a quantile, so a handful of stragglers cannot reach it. This is the
  // property that makes the tail check safe to fail on.
  assert.deepEqual((await withTail(99, 1, "2026-01-01")).failures, []);
});

// =============================================================================
//  THE GATE'S OWN TRIGGER
//
//  This gate reads committed state, so its verdict depends on where in the daily
//  pipeline it samples. That ordering was expressed as a clock time — 13:00, one
//  hour after sftp-ingest's 12:00 — and Actions queue delay measured 0.2h to
//  9.6h on the ingest against 3.9h to 6.3h here. A one-hour nominal gap orders
//  nothing under that variance, and when it inverted this gate spent 5
//  consecutive days sampling the ~4h window in which sftp-ingest had erased the
//  re-pricer's stamps, reporting a failure the same catalog did not have six
//  hours either side.
//
//  The ordering is now stated as workflow_run. This test is what stops the
//  watched list drifting from the table that justifies it — the same rule the
//  gate applies to every OTHER workflow's schedule, finally applied to its own.
// =============================================================================

test("the gate watches exactly the workflows CADENCE cites", () => {
  const wf = fs.readFileSync(
    path.join(gate.DEFAULT_WF_DIR, "retailer-freshness.yml"), "utf8");

  // The display names, read from each cited workflow rather than transcribed —
  // workflow_run matches on `name:`, not on filename, so a renamed workflow
  // silently stops triggering this gate.
  const cited = [...new Set(Object.values(gate.CADENCE)
    .filter((s) => s.confirmedBy)
    .flatMap((s) => gate.citesFor(s).map((c) => c.workflow)))];

  const wfDir = gate.DEFAULT_WF_DIR;
  for (const file of cited) {
    const name = (fs.readFileSync(path.join(wfDir, file), "utf8").match(/^name:\s*(.+)$/m) || [])[1];
    assert.ok(name, `${file} has no name:`);
    assert.ok(
      new RegExp(`^\\s+- ${name.trim()}\\s*(#.*)?$`, "m").test(wf),
      `${file} is cited in CADENCE but '${name.trim()}' is not in retailer-freshness.yml's ` +
      `workflow_run list — the gate would not re-check after it writes`);
  }
});

test("the cron survives as the absence backstop", () => {
  // workflow_run cannot fire when NO writer runs, and that is the exact failure
  // this gate was written for: Best Buy froze for four months and every derived
  // artifact stayed healthy. Losing the cron would blind the gate to the one
  // case it cannot afford to miss.
  const wf = fs.readFileSync(
    path.join(gate.DEFAULT_WF_DIR, "retailer-freshness.yml"), "utf8");
  assert.match(wf, /^\s+schedule:$/m);
  assert.match(wf, /^\s+- cron: '[^']+'$/m);
});

// =============================================================================
//  HIDDEN ROWS
//
//  A quarantined product (needsReview) is shown nowhere, and verify-catalog
//  deliberately stops paying to re-check it, so it ages into the tail by
//  construction. On main 2026-09-10, 559 of amazon's 655 rows past budget were
//  hidden. The quantiles now measure what the site PUBLISHES, and hidden rows get
//  their own count and alarm — they are not dropped, because dropping them would
//  let quarantine delete a stale row from the gate, the negative-stamp hole in a
//  different hat.
// =============================================================================

const shopRow = (deal, hidden = false) =>
  hidden ? { ...product("shop", deal), needsReview: true } : product("shop", deal);
const today = () => ({ price: 1, priceConfirmedAt: "2026-08-17" });
const july = () => ({ price: 1, priceConfirmedAt: "2026-07-01" });
const n = (k, f) => Array.from({ length: k }, f);
const laneOf = (rows) =>
  gate.audit({
    now: NOW,
    partsPath: partsFixture(rows),
    wfDir: wfFixture({ "shop.yml": wfWithCron("0 7 * * *") }),
    cadence: tailCadence,
  });

test("a hidden row is outside the published quantiles, and still counted", async () => {
  const a = await laneOf([...n(90, () => shopRow(today())), ...n(10, () => shopRow(july(), true))]);
  const r = rowFor(a, "shop");
  assert.equal(r.rows, 100, "the lane's row count is unchanged");
  assert.equal(r.published, 90);
  assert.equal(r.hidden, 10);
  assert.equal(r.measured, 90, "only published rows are behind the quantiles");
  assert.equal(r.p90AgeDays, 0);
  assert.equal(r.hiddenStaleRows, 10);
  assert.equal(r.hiddenAllowance, 10);
  assert.deepEqual(a.failures, [], "10 of 100 is inside the allowance");
});

test("THE HOLE: quarantining the stale rows cannot green the lane", async () => {
  // The exact move this alarm exists to catch. Same 34 stale rows, first
  // published, then quarantined — the failure changes NAME, it does not go away.
  const shown = await laneOf([...n(66, () => shopRow(today())), ...n(34, () => shopRow(july()))]);
  assert.deepEqual(kinds(shown), ["stale-tail"]);

  const hidden = await laneOf([...n(66, () => shopRow(today())), ...n(34, () => shopRow(july(), true))]);
  assert.deepEqual(kinds(hidden), ["hidden-tail"], "quarantine moved the rows to the other alarm");
  assert.equal(rowFor(hidden, "shop").verdict, "OK", "what the site publishes really is fine");
  assert.equal(rowFor(hidden, "shop").hiddenVerdict, "HIDDEN TAIL");
  assert.equal(rowFor(hidden, "shop").hiddenStaleRows, rowFor(shown, "shop").staleRows);
});

test("the hidden allowance is fixed by LANE size — boundary pinned", async () => {
  // 10% of 100 rows. Quarantining more rows must not raise the allowance, which
  // is why the denominator is the whole lane and not the hidden population.
  const at = await laneOf([...n(90, () => shopRow(today())), ...n(10, () => shopRow(july(), true))]);
  assert.deepEqual(at.failures, [], "exactly at the allowance passes");
  const over = await laneOf([...n(89, () => shopRow(today())), ...n(11, () => shopRow(july(), true))]);
  assert.deepEqual(kinds(over), ["hidden-tail"], "one row over fails");
  assert.equal(rowFor(over, "shop").hiddenAllowance, 10);
});

test("hidden rows are judged against the TAIL budget, not the median one", async () => {
  // 5 days is past the 3d budget but inside the 12d tail budget: a quarantine
  // that is merely a few days behind is not a backlog nothing re-checks.
  const a = await laneOf([
    ...n(50, () => shopRow(today())),
    ...n(50, () => shopRow({ price: 1, priceConfirmedAt: "2026-08-12" }, true)),
  ]);
  assert.equal(rowFor(a, "shop").hiddenStaleRows, 0);
  assert.deepEqual(a.failures, []);
});

test("neither alarm masks the other", async () => {
  // 120 rows -> allowance 12. The published side is STALE TAIL on its own and the
  // hidden side is over its allowance on its own; both must be reported.
  const a = await laneOf([
    ...n(66, () => shopRow(today())),
    ...n(34, () => shopRow(july())),
    ...n(20, () => shopRow(july(), true)),
  ]);
  assert.deepEqual(kinds(a), ["hidden-tail", "stale-tail"]);
  assert.equal(rowFor(a, "shop").verdict, "STALE TAIL");
  assert.equal(rowFor(a, "shop").hiddenVerdict, "HIDDEN TAIL");
});

test("a lane with nothing published is not NEVER CONFIRMED", async () => {
  // Every row hidden and recently confirmed: nothing is published stale, and
  // nothing hidden is past the tail budget.
  assert.deepEqual((await laneOf(n(5, () => shopRow(today(), true)))).failures, []);
  // Every row hidden and old: the hidden alarm is what fires, and only it.
  assert.deepEqual(kinds(await laneOf(n(5, () => shopRow(july(), true)))), ["hidden-tail"]);
});

test("a hidden row with no confirmation at all counts against the hidden allowance", async () => {
  const a = await laneOf([...n(9, () => shopRow(today())), shopRow({ price: 1 }, true)]);
  const r = rowFor(a, "shop");
  assert.equal(r.hidden, 1);
  assert.equal(r.hiddenNever, 1);
  assert.equal(r.hiddenMeasured, 1, "measured as maximally stale, not left out");
  assert.equal(r.hiddenStaleRows, 1);
  assert.deepEqual(a.failures, [], "1 of 10 is inside the allowance");
});

test("report() prints the hidden verdict beside the published one", async () => {
  const a = await laneOf([...n(66, () => shopRow(today())), ...n(34, () => shopRow(july(), true))]);
  const lines = [];
  const log = console.log;
  console.log = (s = "") => lines.push(String(s));
  try {
    assert.equal(gate.report(a), 1);
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((l) => /\bOK \+ HIDDEN TAIL\b/.test(l)), "the table row names both verdicts");
  assert.ok(lines.some((l) => l.includes("[hidden-tail] shop")));
  assert.ok(!lines.some((l) => l.includes("publishing prices nothing is refreshing")),
    "a hidden-only failure must not claim the site is publishing stale prices");
});

// ── rows nothing has ever confirmed ─────────────────────────────────────────
// Dropped by `if (!found.length) continue` until 2026-09-10, which is how 13
// sponsored-ad links the verifier cannot even select stayed out of every alarm.

test("THE HOLE: a row nothing ever confirmed is maximally stale, not absent", async () => {
  // Nine rows confirmed today and one never confirmed. Dropped, the lane read a
  // spotless p90 of 0d; measured, the never-confirmed row IS the slowest decile.
  const a = await laneOf([...n(9, () => shopRow(today())), shopRow({ price: 1 })]);
  const r = rowFor(a, "shop");
  assert.equal(r.never, 1);
  assert.equal(r.measured, 10, "every published row is behind the quantiles");
  assert.equal(r.p90AgeDays, Infinity);
  assert.equal(r.staleRows, 1);
  assert.deepEqual(kinds(a), ["stale-tail"]);
});

test("never confirming a row cannot make a lane look fresher than confirming it once", async () => {
  const never = await laneOf([...n(9, () => shopRow(today())), shopRow({ price: 1 })]);
  const ancient = await laneOf([...n(9, () => shopRow(today())), shopRow({ price: 1, priceConfirmedAt: "2021-01-01" })]);
  assert.ok(rowFor(never, "shop").p90AgeDays >= rowFor(ancient, "shop").p90AgeDays);
  assert.deepEqual(kinds(never), kinds(ancient));
});

test("a handful of never-confirmed rows do not condemn a healthy lane", async () => {
  // Still a quantile: robustness in the false-alarm direction is unchanged.
  assert.deepEqual((await laneOf([...n(99, () => shopRow(today())), shopRow({ price: 1 })])).failures, []);
});

test("a never-confirmed age prints as 'never' — not 'Infinityd', and not null in JSON", async () => {
  const a = await laneOf([...n(9, () => shopRow(today())), shopRow({ price: 1 })]);
  const lines = [];
  const log = console.log;
  console.log = (s = "") => lines.push(String(s));
  try { gate.report(a); } finally { console.log = log; }
  assert.ok(!lines.some((l) => l.includes("Infinity")), "the report must not print Infinity");
  assert.ok(lines.some((l) => /\bnever\b/.test(l)));

  // JSON.stringify writes Infinity as null, and null means "no rows at all".
  const json = JSON.parse(gate.toJson(a));
  assert.equal(json.rows.find((x) => x.retailer === "shop").p90AgeDays, "never");
});

test("the live catalog: every row is either published or hidden — none leave the count", async () => {
  const a = await gate.audit({});
  for (const r of a.rows) {
    assert.equal(r.published + r.hidden, r.rows, `${r.retailer}: published + hidden must equal rows`);
  }
  assert.ok(a.rows.some((r) => r.hidden > 0), "no hidden rows at all would mean needsReview is not being read");
});
