// =============================================================================
//  test/cpu-model.test.js
//
//  Regression cover for CPU model extraction. The bug that prompted these:
//  the AMD pattern captured at most two trailing letters, so "Ryzen 7 5800X3D"
//  came back as "5800X" — the name of a real, slower, non-3D processor. The
//  upgrade page then matched THAT part in the catalog and recommended the user
//  buy a 5800X3D for $370, which is the chip already in their machine.
//
//  The X3D assertions below are the ones that matter; the rest guard against
//  fixing X3D by loosening the pattern until it over-captures.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCPUModel } from "../src/cpu-model.js";

const amd = (name) => extractCPUModel(name);
const model = (name) => extractCPUModel(name)?.model ?? null;

test("X3D suffix survives extraction — the regression this file exists for", () => {
  // Every X3D part currently in the catalog.
  assert.equal(model("AMD Ryzen 7 9800X3D"), "9800X3D");
  assert.equal(model("AMD Ryzen 7 7800X3D"), "7800X3D");
  assert.equal(model("AMD Ryzen 7 5800X3D"), "5800X3D");
  assert.equal(model("AMD Ryzen 5 7600X3D"), "7600X3D");
  assert.equal(model("AMD Ryzen 9 9950X3D"), "9950X3D");
  assert.equal(model("AMD Ryzen 9 9900X3D"), "9900X3D");
  assert.equal(model("AMD Ryzen 9 7950X3D"), "7950X3D");
  assert.equal(model("AMD Ryzen 9 7900X3D"), "7900X3D");
});

test("an X3D chip never collapses onto its non-3D sibling", () => {
  // The exact failure mode: these pairs must not produce the same model.
  for (const [threeD, plain] of [
    ["AMD Ryzen 7 5800X3D", "AMD Ryzen 7 5800X"],
    ["AMD Ryzen 5 7600X3D", "AMD Ryzen 5 7600X"],
    ["AMD Ryzen 9 9950X3D", "AMD Ryzen 9 9950X"],
    ["AMD Ryzen 9 7950X3D", "AMD Ryzen 9 7950X"],
  ]) {
    assert.notEqual(model(threeD), model(plain), `${threeD} must not read as ${plain}`);
  }
});

test("scanner-style long names still resolve", () => {
  // The WPF scanner reports the full marketing string, not the short name.
  assert.equal(
    model("AMD - Ryzen 7 9800X3D 8-Core - 16-Thread 4.7 GHz (5.2 GHz Max Boost) Socket AM5 120W Unlocked Desktop Processor - Silver"),
    "9800X3D",
  );
  assert.equal(model("AMD Ryzen 9 7950X3D 16-Core 4.2 GHz Socket AM5 Processor"), "7950X3D");
});

test("other AMD suffixes are preserved, not truncated", () => {
  assert.equal(model("AMD Ryzen 7 9700X"), "9700X");
  assert.equal(model("AMD Ryzen 9 3900XT"), "3900XT");
  assert.equal(model("AMD Ryzen 5 5600G"), "5600G");
  assert.equal(model("AMD Ryzen 5 4600GT"), "4600GT");
  assert.equal(model("AMD Ryzen 5 3500F"), "3500F");
  assert.equal(model("AMD Ryzen 5 5600"), "5600");
});

test("the widened pattern does not over-capture into the next word", () => {
  // "8-Core" / "16-Thread" must not be dragged into the model number.
  assert.equal(model("AMD Ryzen 5 5600 6-Core Processor"), "5600");
  assert.equal(model("AMD Ryzen 7 5800X 8-Core Processor"), "5800X");
  // A trailing token that merely starts with a suffix letter is not a suffix.
  assert.equal(model("AMD Ryzen 7 5700 Gaming Desktop Processor"), "5700");
});

test("brand is reported correctly", () => {
  assert.equal(amd("AMD Ryzen 7 9800X3D").brand, "AMD");
  assert.equal(amd("Intel Core i7-14700K").brand, "Intel");
  assert.equal(amd("Intel Core i5-12400F").brand, "Intel");
});

test("Intel parsing is unchanged", () => {
  assert.equal(model("Intel Core i7-14700K"), "14700K");
  assert.equal(model("Intel Core i9-14900KS"), "14900KS");
  assert.equal(model("Intel Core i5-12400F"), "12400F");
  assert.equal(model("Intel Core i7-7700K"), "7700K");
  assert.equal(model("Intel Core i5-13600"), "13600");
});

// SEPARATE PRE-EXISTING BUG, deliberately not fixed here — different concern.
//
// "Core Ultra 9 285K" puts a SPACE between the tier digit and the model number,
// and the Intel pattern has no allowance for one, so every Core Ultra Series 2
// chip extracts as null and the upgrade page cannot identify it. The catalog
// carries 7 of them on LGA1851 with real benches, and intelGeneration() already
// has a branch written for exactly these models ("3-digit bare numbers (Core
// Ultra 245/265) ... treat as gen 15") that is currently unreachable.
//
// Marked todo so the gap is recorded and this starts passing the moment the
// pattern is widened, rather than asserting the broken result as correct.
test("Core Ultra Series 2 models extract", { todo: "Intel pattern does not allow a space before the model number" }, () => {
  assert.equal(model("Intel Core Ultra 9 285K"), "285K");
  assert.equal(model("Intel Core Ultra 7 265K"), "265K");
  assert.equal(model("Intel Core Ultra 5 245K"), "245K");
});

test("Intel is matched before AMD so cross-brand strings do not collide", () => {
  // Both brands' patterns can hit a string mentioning the other vendor.
  assert.equal(amd("Intel Core i5-7500").brand, "Intel");
  assert.equal(amd("AMD Ryzen 5 7500F").brand, "AMD");
  assert.equal(model("AMD Ryzen 5 7500F"), "7500F");
});

test("unparseable names return null rather than a partial model", () => {
  assert.equal(extractCPUModel(""), null);
  assert.equal(extractCPUModel(null), null);
  assert.equal(extractCPUModel(undefined), null);
  assert.equal(extractCPUModel("Intel Xeon E5-2680 v4"), null);
  assert.equal(extractCPUModel("AMD Threadripper 3970X"), null);
  assert.equal(extractCPUModel("Some Unknown Processor"), null);
});
