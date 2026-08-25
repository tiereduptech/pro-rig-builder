// =============================================================================
//  test/build-optimizer.test.js
//
//  The bug these cover: budget is allocated down a greedy priority chain under a
//  fixed GPU ceiling, and no single ceiling works.
//
//    too low   a rig whose only worthwhile upgrade is the GPU gets that card
//              demoted to "optional" and keeps up to 81% of the budget.
//    too high  the GPU eats the budget and guts a CPU pick the user needed.
//
//  The fix runs both allocations and keeps whichever build scores higher, so the
//  property to protect is: NEVER WORSE THAN THE CONSERVATIVE ALLOCATION.
//
//  Parts here are synthetic and priced inline — these assert the allocation
//  RULE, not the catalog, so a price refresh cannot move them.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeBuild, bestPrice, GPU_BUDGET_SHARE, GPU_CEILING_RELAXED } from "../src/build-optimizer.js";

// bestPrice reads deals.amazon.price, then deals.bestbuy.price, then .pr
const part = (n, price, extra = {}) => ({ n, pr: price, ...extra });
const gpu = (n, price, bench) => part(n, price, { c: "GPU", bench });
const cpu = (n, price, bench, threads = 8) => part(n, price, { c: "CPU", bench, threads });
const ram = (n, price) => part(n, price, { c: "RAM" });

test("bestPrice prefers amazon, then bestbuy, then the list price", () => {
  assert.equal(bestPrice({ pr: 100 }), 100);
  assert.equal(bestPrice({ pr: 100, deals: { bestbuy: { price: 90 } } }), 90);
  assert.equal(bestPrice({ pr: 100, deals: { amazon: { price: 80 }, bestbuy: { price: 90 } } }), 80);
  assert.equal(bestPrice(null), 0);
  assert.equal(bestPrice({}), 0);
});

test("a GPU-only upgrade no longer strands the budget", () => {
  // The reported shape: strong CPU with no same-socket upgrade available, and
  // the only worthwhile GPU costs more than the conservative 65% ceiling.
  const currentGPU = gpu("Current GPU", 0, 85);
  const currentCPU = cpu("Strong CPU", 0, 95);
  const build = optimizeBuild(currentGPU, currentCPU, {
    gpus: [gpu("Much Faster GPU", 1470, 96)],
    cpus: [],                                  // nothing to upgrade to
    rams: [ram("Marginally Faster RAM", 375)], // the old code bought this instead
    storages: [],
    useCase: "gaming",
  }, 1500);

  assert.ok(build.gpu, "the GPU should be in the build, not demoted to optional");
  assert.equal(build.gpu.n, "Much Faster GPU");
  assert.ok(build.cost > 1400, `should use the budget, spent only $${build.cost}`);
});

test("a bigger GPU never comes at the cost of a much weaker CPU", () => {
  // The opposite failure: at a low budget an unconditionally raised ceiling
  // bought the bigger card by dropping the CPU to a far worse part.
  const build = optimizeBuild(gpu("Current GPU", 0, 40), cpu("Current CPU", 0, 30), {
    gpus: [gpu("Modest GPU", 250, 56), gpu("Big GPU", 590, 66)],
    cpus: [cpu("Good CPU", 330, 70), cpu("Weak CPU", 60, 36)],
    rams: [],
    storages: [],
    useCase: "gaming",
  }, 600);

  assert.notEqual(build.cpu?.n, "Weak CPU", "must not downgrade the CPU pick to afford a bigger GPU");
});

test("the winning build is never worse than the conservative allocation", () => {
  // The core property. Randomised pools, compared against a build forced to the
  // conservative ceiling by making the relaxed pass unreachable.
  let rngState = 12345;
  const rnd = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let trial = 0; trial < 300; trial++) {
    const budget = 400 + Math.floor(rnd() * 4000);
    const mk = (kind, count, make) =>
      Array.from({ length: count }, (_, i) => make(`${kind}${i}`, Math.floor(50 + rnd() * budget * 1.2), Math.floor(10 + rnd() * 90)));
    const candidates = {
      gpus: mk("gpu", 1 + Math.floor(rnd() * 4), gpu),
      cpus: mk("cpu", Math.floor(rnd() * 4), cpu),
      rams: mk("ram", Math.floor(rnd() * 3), (n, p) => ram(n, p)),
      storages: [],
      useCase: ["gaming", "content", "ai"][trial % 3],
    };
    const curGPU = gpu("cur", 0, 5), curCPU = cpu("cur", 0, 5);

    const chosen = optimizeBuild(curGPU, curCPU, candidates, budget);
    // Same inputs, but every GPU priced above the conservative ceiling removed —
    // which is exactly what the conservative allocation could ever have picked.
    const ceil = budget * GPU_BUDGET_SHARE[candidates.useCase];
    const conservative = optimizeBuild(curGPU, curCPU,
      { ...candidates, gpus: candidates.gpus.filter((g) => bestPrice(g) <= ceil) }, budget);

    if (!conservative) continue;
    assert.ok(chosen, "a build existed conservatively, so one must exist now");
    assert.ok(
      chosen.score >= conservative.score - 1e-9,
      `trial ${trial}: score regressed ${conservative.score.toFixed(2)} -> ${chosen.score.toFixed(2)}`,
    );
  }
});

test("spending never breaches the 10% overage contract", () => {
  let rngState = 999;
  const rnd = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 200; trial++) {
    const budget = 400 + Math.floor(rnd() * 4000);
    const build = optimizeBuild(gpu("cur", 0, 5), cpu("cur", 0, 5), {
      gpus: Array.from({ length: 4 }, (_, i) => gpu(`g${i}`, Math.floor(50 + rnd() * budget * 1.3), Math.floor(10 + rnd() * 90))),
      cpus: Array.from({ length: 3 }, (_, i) => cpu(`c${i}`, Math.floor(50 + rnd() * budget), Math.floor(10 + rnd() * 90))),
      rams: [ram("r0", Math.floor(50 + rnd() * 400))],
      storages: [],
      useCase: "gaming",
    }, budget);
    if (!build) continue;
    assert.ok(build.cost <= budget * 1.1 + 1e-9, `trial ${trial}: $${build.cost} exceeds 110% of $${budget}`);
  }
});

test("productivity keeps its taste ceiling and is not offered the relaxed pass", () => {
  // An office machine should not be handed a gaming card even when the weighted
  // score would take it. GPU here is well above 20% of budget.
  const build = optimizeBuild(gpu("Current GPU", 0, 30), cpu("Current CPU", 0, 40), {
    gpus: [gpu("Expensive GPU", 1200, 95)],
    cpus: [],
    rams: [ram("More RAM", 200)],
    storages: [],
    useCase: "productivity",
  }, 1500);
  assert.equal(build?.gpu, null, "productivity must not pick a GPU above its 20% ceiling");
});

test("the relaxed ceiling is above every conservative share, or it would be a no-op", () => {
  for (const [useCase, share] of Object.entries(GPU_BUDGET_SHARE)) {
    if (useCase === "productivity") continue;
    assert.ok(GPU_CEILING_RELAXED > share, `${useCase}: relaxed ${GPU_CEILING_RELAXED} must exceed ${share}`);
  }
});

test("returns null only when nothing at all is affordable", () => {
  const nothing = optimizeBuild(gpu("cur", 0, 50), cpu("cur", 0, 50), {
    gpus: [gpu("too dear", 99999, 99)], cpus: [], rams: [], storages: [], useCase: "gaming",
  }, 500);
  assert.equal(nothing, null);
});
