// Verifies the price-delta distribution the Newegg refresh reports.
//
// WHY THIS MATTERS MORE THAN A USUAL REPORTING TEST
//   This distribution is the evidence a human uses to decide whether to put the
//   re-pricer on a cadence. The last time something was scheduled without seeing
//   the distribution, it wrote comp values twice a day. So the numbers have to be
//   verifiable rather than trusted, which is why priceDistribution() is pure and
//   exported and why the fixture below is a REAL recorded run
//   (32048509582, 2026-08-17, 50-product dry run) rather than invented data.
//
//   Two defects it pins, both of which would have corrupted that evidence:
//     1. `priceChanged` is true when the LINK or sale price moved, so 17 records
//        were labelled price-update when only 7 prices had moved. On a full
//        2,666-row run that noise buries the signal.
//     2. The report truncates `changes` to 100 records. The distribution is
//        computed over all of them first, so the shape survives the truncation.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { priceDistribution } = require("../refresh-newegg-prices.cjs");

// Verbatim from run 32048509582's newegg-refresh-summary.json, relabelled under
// the price-update vs link-update rule this module now applies.
const RECORDED = [
  { name: "Noctua NH-D15", change: "price-update", from: 121.09, to: 150.99 },
  { name: "ASUS ROG Crosshair X870E Hero", change: "link-update", from: 599.99, to: 599.99 },
  { name: "Crucial T700 2TB NVMe Gen5", change: "price-update", from: 421.02, to: 446.86 },
  { name: "DDR4 32GB 3200MHz", change: "link-update", from: 229.99, to: 229.99 },
  { name: "AMD Ryzen 9 9900X", change: "link-update", from: 499, to: 499 },
  { name: "be quiet! Dark Power 13 1000W", change: "link-update", from: 329.9, to: 329.9 },
  { name: "3-Pack 120mm Case Fans", change: "link-update", from: 11.99, to: 11.99 },
  { name: "Pinnacle Konduit 16GB DDR4", change: "price-update", from: 111.99, to: 109.99 },
  { name: "Lian Li A4-H2O", change: "price-update", from: 159.99, to: 168.99 },
  { name: "Noctua NF-A12x25 PWM", change: "price-update", from: 39.99, to: 38.79 },
  { name: "be quiet! Dark Rock Pro 5", change: "price-update", from: 124.9, to: 89.9 },
  { name: "Gigabyte X870E AORUS Master", change: "link-update", from: 599.99, to: 599.99 },
  { name: "Corsair SF750 SFX Platinum", change: "link-update", from: 199.99, to: 199.99 },
  { name: "AMD Ryzen 9 9900X3D", change: "link-update", from: 599, to: 599 },
  { name: "RS120 ARGB 120mm PWM Fan", change: "link-update", from: 19.99, to: 19.99 },
  { name: "AMD Ryzen 7 9800X3D", change: "price-update", from: 519, to: 479 },
  { name: "Nautilus 360 RS ARGB", change: "link-update", from: 129.99, to: 129.99 },
  // non-price records that must be ignored entirely
  { name: "AMD Ryzen 9 9950X", change: "migrated-to-firstparty", price: 649 },
  { name: "UNI Fan CL120 ARGB", change: "price-suspect-flagged", kept: 67.1, rejected: 82.16 },
];

test("reproduces the recorded run: 7 moves, 4 down, 3 up", () => {
  const d = priceDistribution(RECORDED, { linkOnly: 10, unchanged: 15 });
  assert.equal(d.rowsMoved, 7);
  assert.equal(d.drops, 4);
  assert.equal(d.rises, 3);
  assert.equal(d.rowsLinkOnly, 10);
  assert.equal(d.rowsUnchanged, 15);
});

test("link-only rewrites are excluded from the moves — the defect that inflated 7 to 17", () => {
  const d = priceDistribution(RECORDED, {});
  assert.equal(d.rowsMoved, 7, "a record whose from === to is not a price move");
  const conflated = RECORDED.filter((c) => /price-update|link-update/.test(c.change)).length;
  assert.equal(conflated, 17, "the old label covered 17 records");
});

test("migrations and suspect-flags never enter the distribution", () => {
  const d = priceDistribution(RECORDED, {});
  const names = [...d.biggestDrops, ...d.biggestRises].map((m) => m.name);
  assert.ok(!names.includes("AMD Ryzen 9 9950X"), "a migration is not a price delta");
  assert.ok(!names.includes("UNI Fan CL120 ARGB"), "a withheld suspect price was never written");
});

test("percentiles and thresholds match the recorded run", () => {
  const d = priceDistribution(RECORDED, {});
  assert.equal(d.absMedianPct, 6.1);
  assert.equal(d.absMaxPct, 28);
  assert.equal(d.over10pct, 2, "only NH-D15 +24.7% and Dark Rock Pro 5 -28.0%");
  assert.equal(d.over25pct, 1);
  assert.equal(d.over50pct, 0);
});

test("the histogram accounts for every move exactly once", () => {
  const d = priceDistribution(RECORDED, {});
  const total = Object.values(d.histogram).reduce((a, b) => a + b, 0);
  assert.equal(total, d.rowsMoved, "buckets must partition the moves, not overlap or drop any");
  assert.deepEqual(d.histogram, {
    "0-1%": 0, "1-2%": 1, "2-5%": 1, "5-10%": 3, "10-20%": 0, "20-50%": 2, ">50%": 0,
  });
});

test("drops and rises lists never overlap", () => {
  // With 7 moves an uncapped slice(0,10)/slice(-10) returns all 7 in BOTH lists,
  // which reads as 14 outliers.
  const d = priceDistribution(RECORDED, {});
  const drops = new Set(d.biggestDrops.map((m) => m.name));
  const overlap = d.biggestRises.filter((m) => drops.has(m.name));
  assert.deepEqual(overlap, [], "a row cannot be both a biggest drop and a biggest rise");
  assert.ok(d.biggestDrops.length >= 1 && d.biggestRises.length >= 1);
});

test("outliers are ordered outward from the middle", () => {
  const d = priceDistribution(RECORDED, {});
  assert.equal(d.biggestDrops[0].name, "be quiet! Dark Rock Pro 5", "steepest drop first");
  assert.equal(d.biggestRises[0].name, "Noctua NH-D15", "steepest rise first");
});

test("the shape survives truncation of the record list", () => {
  // The report keeps only the first 100 change records. The distribution is
  // computed before that, so a 500-move run still reports 500.
  const many = [];
  for (let i = 0; i < 500; i++) {
    many.push({ name: `P${i}`, change: "price-update", from: 100, to: i % 2 ? 110 : 90 });
  }
  const d = priceDistribution(many, {});
  assert.equal(d.rowsMoved, 500);
  assert.equal(d.drops, 250);
  assert.equal(d.rises, 250);
  assert.equal(d.biggestDrops.length, 10, "outlier lists stay capped at 10");
});

test("degenerate inputs do not throw", () => {
  for (const input of [[], null, undefined]) {
    const d = priceDistribution(input, {});
    assert.equal(d.rowsMoved, 0);
    assert.equal(d.absMedianPct, null);
    assert.deepEqual(d.biggestDrops, []);
  }
  // a zero or missing `from` cannot yield a percentage
  const d = priceDistribution([{ name: "x", change: "price-update", from: 0, to: 10 }], {});
  assert.equal(d.rowsMoved, 0, "division by zero is excluded, not reported as Infinity%");
});

test("importing the module does not run the CLI or demand credentials", () => {
  // The CLI body and the RAKUTEN_* check are both gated on require.main. If that
  // regressed, `npm test` would exit 1 on a machine with no Rakuten credentials.
  assert.equal(typeof priceDistribution, "function");
});
