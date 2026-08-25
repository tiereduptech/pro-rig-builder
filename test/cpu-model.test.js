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

// Core Ultra (Series 2, LGA1851) puts a separator between the tier digit and the
// model number, which the classic Intel pattern had no allowance for — so every
// one extracted as null and the page could not identify the CPU at all. Three
// other places were already written for these models and were unreachable:
// intelGeneration()'s gen-15 branch, inferCPUSocket's LGA1851 mapping, and the
// "245K"/"265K"/"285K" rows in CPU_BASELINE_INTEL.
test("Core Ultra Series 2 models extract", () => {
  assert.equal(model("Intel Core Ultra 9 285K"), "285K");
  assert.equal(model("Intel Core Ultra 7 265K"), "265K");
  assert.equal(model("Intel Core Ultra 7 265KF"), "265KF");
  assert.equal(model("Intel Core Ultra 5 245K"), "245K");
  assert.equal(model("Intel Core Ultra 5 245KF"), "245KF");
  assert.equal(model("Intel Core Ultra 5 225F"), "225F");
  assert.equal(model("Intel Core Ultra 9 285"), "285");
  assert.equal(amd("Intel Core Ultra 9 285K").brand, "Intel");
});

test("the Core Ultra naming variants that actually ship all parse", () => {
  // Every distinct shape present in the catalog and in scanner output.
  // No space after "Ultra":
  assert.equal(model("(Amazon.co.jp Exclusive) Intel CPU Core Ultra5 225F Processor (20 M Cache)"), "225F");
  // A word between the tier digit and the model:
  assert.equal(model("Intel - Core Ultra 7 Processor 270K Plus 24 cores (8 P-cores + 16 E-cores)"), "270K");
  assert.equal(model("Intel® Core™ Ultra 5 Processor 250KF Plus 18 cores"), "250KF");
  // Two words, plus trademark marks the scanner does not always strip:
  assert.equal(model("Core™ Ultra 5 Desktop Processor 225 10 cores (6 P-cores + 4 E-cores)"), "225");
  assert.equal(model("Intel® Core™ Ultra 9 Desktop Processor 285 24 cores"), "285");
  assert.equal(model("Intel® Core™ Ultra 7 Desktop Processor 265F 20 cores"), "265F");
  // Trailing spec text must not be dragged into the model:
  assert.equal(model("Intel - Core Ultra 9 285K 24-Cores 24-Threads - 4.6GHz (5.7 GHz Turbo) Socket LGA1851"), "285K");
});

test("the Core Ultra pattern does not disturb classic Intel parsing", () => {
  // The classic pattern is tried first and is unchanged; these must be untouched.
  assert.equal(model("Intel Core i7-14700K"), "14700K");
  assert.equal(model("Intel Core i9-14900KS"), "14900KS");
  assert.equal(model("Intel Core i5-12400F"), "12400F");
  assert.equal(model("Intel Core i7-7700K"), "7700K");
  // A non-Ultra name mentioning "processor" must not pick up a stray number.
  assert.equal(model("Intel Core i5-13600 Desktop Processor 14 cores"), "13600");
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
