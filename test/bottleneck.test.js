// =============================================================================
//  test/bottleneck.test.js
//
//  The bug these cover: analyzeBottleneck divided a CPU's PassMark CPU Mark
//  (multithreaded THROUGHPUT) by a GPU's G3D (graphics). Different units. It
//  called six of eight real-world pairings a CPU bottleneck — including every
//  balanced one — and the card tells the user to go buy a CPU.
//
//  The pairing table below is the real assertion. Benches are pinned inline so
//  a catalog price/bench refresh cannot quietly move the verdicts.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { gamingScore, analyzeBottleneck } from "../src/bottleneck.js";

// Minimal stand-ins shaped like what findCatalogMatch returns.
const catalogCPU = (n, bench) => ({ n, bench });
const placeholderCPU = (model, brand, bench) => ({ n: `Current: ${model}`, bench, brand, model, isBaseline: true });
const gpu = (bench) => ({ bench });

test("balanced real-world pairings are not called a CPU bottleneck", () => {
  // Every one of these returned "CPU is your bottleneck" before the fix.
  const cases = [
    ["AMD Ryzen 7 9800X3D", 57, 100], // + RTX 4090
    ["AMD Ryzen 7 9800X3D", 57, 85],  // + RTX 5070 Ti
    ["AMD Ryzen 7 7800X3D", 49, 84],  // + RTX 4070
    ["AMD Ryzen 7 5800X3D", 40, 84],  // + RTX 4070
    ["Intel Core i5-12400F", 33, 45], // + RTX 3060
  ];
  for (const [name, cpuBench, gpuBench] of cases) {
    const v = analyzeBottleneck(catalogCPU(name, cpuBench), gpu(gpuBench));
    assert.equal(v.who, "Balanced", `${name} + GPU(${gpuBench}) should be balanced, got "${v.text}"`);
  }
});

test("a genuine CPU bottleneck is still reported", () => {
  // Ryzen 5 1600 (gaming index 24) under an RTX 4090.
  const v = analyzeBottleneck(catalogCPU("AMD Ryzen 5 1600", 12), gpu(100));
  assert.equal(v.who, "CPU");
  assert.ok(v.severity > 50, `expected a severe reading, got ${v.severity}`);
});

test("a genuine GPU bottleneck is still reported", () => {
  // 9800X3D pushing a GTX 1650.
  const v = analyzeBottleneck(catalogCPU("AMD Ryzen 7 9800X3D", 57), gpu(11));
  assert.equal(v.who, "GPU");
});

test("the X3D cache gap — throughput bench vs gaming index", () => {
  // A 5800X3D's extra cache does nothing for multithreaded throughput, so its
  // CPU Mark is near a plain 5800X. For FRAMES it is far ahead. This gap is the
  // whole bug: 40/84 = 0.48 ("CPU bottleneck") vs 78/84 = 0.93 ("balanced").
  const chip = catalogCPU("AMD Ryzen 7 5800X3D", 40);
  assert.equal(chip.bench, 40);
  assert.equal(gamingScore(chip), 78);
  assert.equal(analyzeBottleneck(chip, gpu(84)).who, "Balanced");
});

test("placeholder CPUs resolve through the brand-scoped model index", () => {
  // findCatalogMatch synthesises { n: "Current: 5600" } when a scanned CPU has
  // no catalog part. A name-substring search can never match "Ryzen 5 5600" in
  // that, so these used to fall back to raw bench — and ten of fifteen older
  // CPUs a real scan reports take this path.
  const p = placeholderCPU("5600", "AMD", 28);
  assert.equal(gamingScore(p), 62, "should resolve via the model index, not fall back to bench 28");
  assert.equal(analyzeBottleneck(p, gpu(45)).who, "Balanced");
});

test("the model index is brand-scoped so 7700 does not cross brands", () => {
  // "7700" is the only last-token collision in the tier table: it is both
  // "Ryzen 7 7700" and "i7-7700", two very different processors.
  const amd = gamingScore(placeholderCPU("7700", "AMD", 48));
  const intel = gamingScore(placeholderCPU("7700", "Intel", 22));
  assert.notEqual(amd, intel, "AMD and Intel 7700 must not resolve to the same score");
});

test("CPUs outside the tier table fall back to bench rather than scoring zero", () => {
  const exotic = catalogCPU("AMD Ryzen Threadripper 7980X", 100);
  assert.equal(gamingScore(exotic), 100);
});

test("unknown sides return null instead of a verdict", () => {
  assert.equal(analyzeBottleneck(null, gpu(85)), null);
  assert.equal(analyzeBottleneck(catalogCPU("AMD Ryzen 7 9800X3D", 57), null), null);
  assert.equal(analyzeBottleneck(catalogCPU("AMD Ryzen 7 9800X3D", 57), {}), null);
  assert.equal(analyzeBottleneck({ n: "Mystery Chip" }, gpu(85)), null);
});

test("gamingScore is stable across repeat calls (memoised per part)", () => {
  const chip = catalogCPU("AMD Ryzen 7 9800X3D", 57);
  assert.equal(gamingScore(chip), gamingScore(chip));
  assert.equal(gamingScore(chip), 100);
});

test("the verdict is suppressed for productivity, where it would contradict the build", () => {
  // For use_case=productivity the optimizer caps the GPU at 20% of budget and
  // spends RAM-first, so a "GPU is your bottleneck, upgrade it" card would sit
  // directly above a build that buys no GPU. Measured across 32 CPU/GPU
  // pairings: 15/32 productivity rigs hit that contradiction, 0/32 for gaming,
  // content and AI.
  const cpu = catalogCPU("AMD Ryzen 9 5900X", 48); // gaming index 70
  assert.equal(analyzeBottleneck(cpu, gpu(45), "productivity"), null);
  // The workloads that do prioritise GPU spend still get a verdict.
  for (const uc of ["gaming", "content", "ai"]) {
    assert.ok(analyzeBottleneck(cpu, gpu(45), uc), `${uc} should still get a verdict`);
  }
  // Defaults to gaming when no use case is supplied.
  assert.ok(analyzeBottleneck(cpu, gpu(45)));
});
