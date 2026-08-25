// =============================================================================
//  src/build-optimizer.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Picks the best complete upgrade within a budget.
//
//  ── The greedy-chain trap ───────────────────────────────────────────────────
//  Budget is allocated down a use-case priority chain, so whichever slot goes
//  first claims the money. A single GPU ceiling cannot serve both ends of that:
//
//    too low   the GPU is capped out on its turn, a lower-priority slot spends
//              the money, and a rig whose ONLY worthwhile upgrade is the GPU
//              gets that card filed under "optional" with up to 81% of the
//              budget left unspent. A 9800X3D + RTX 5070 Ti at $1500 was told
//              to buy $375 of marginally faster RAM and keep $1,125.
//
//    too high  the GPU eats the budget and guts a CPU pick the user needed. At
//              $600 a raised ceiling swapped a Ryzen 7 5800XT (gaming index 70)
//              for a Ryzen 3 4100 (36) to afford a bigger card.
//
//  Tuning the constant only moves the damage between rigs. So it is not tuned:
//  both allocations are run and the build that actually SCORES higher wins.
//  Ties go to the conservative one, so nothing changes unless relaxing the
//  ceiling genuinely produces a better system.
// =============================================================================

import { gamingScore } from "./bottleneck.js";

// Allowed overspend when it meaningfully improves the build.
export const BUDGET_OVERAGE = 0.10;

export function bestPrice(p) {
  const amazonPrice = Number(p?.deals?.amazon?.price);
  if (amazonPrice > 0) return amazonPrice;
  const bestbuyPrice = Number(p?.deals?.bestbuy?.price);
  if (bestbuyPrice > 0) return bestbuyPrice;
  return Number(p?.pr) || 0;
}

export const USE_CASE_WEIGHTS = {
  gaming:       { cpu: 0.6, gpu: 1.0 },
  content:      { cpu: 1.0, gpu: 1.0 },
  ai:           { cpu: 0.9, gpu: 1.2 },
  productivity: { cpu: 1.2, gpu: 0.6 },
};
export function useCaseWeights(useCase) { return USE_CASE_WEIGHTS[useCase] || { cpu: 0.8, gpu: 1.0 }; }

// cpuScoreForUseCase: gaming -> gaming index; else -> PassMark bench.
export function cpuScoreForUseCase(cpu, useCase) {
  if (!cpu) return 0;
  if (useCase === "gaming") return gamingScore(cpu);
  // Productivity / content creation / AI are throughput workloads: they scale with
  // cores & threads, not single-thread gaming clocks. Blend raw bench with a modest
  // multi-core bonus so high-core chips rank above high-clock low-core ones — but
  // bench stays the dominant term so we never recommend a 16-core HEDT for light work
  // purely on core count. Falls back to bench when cores/threads are absent.
  const bench = cpu.bench || 0;
  if (useCase === "productivity" || useCase === "content" || useCase === "ai") {
    const threads = cpu.threads || cpu.cores || 0;
    if (threads > 0) {
      // up to +25% for very high thread counts, scaled gently (sqrt) so it tapers off
      const mcBonus = Math.min(0.25, (Math.sqrt(threads) - Math.sqrt(8)) * 0.05);
      return bench * (1 + Math.max(0, mcBonus));
    }
  }
  return bench;
}

export const LEFTOVER_PRIORITY = {
  productivity: ["ram", "gpu"],          // multitasking is capacity-bound; GPU barely used
  gaming:       ["gpu", "cpu", "ram"],   // frames first
  content:      ["gpu", "cpu", "ram"],   // renders use GPU + CPU heavily
  ai:           ["gpu", "ram", "cpu"],   // GPU/VRAM first, then memory
};

// Max share of the budget a GPU may consume, by use case.
//
// This is a WORKLOAD CEILING, not a reservation for the other components — the
// priority chain below already handles ordering, so holding budget back for
// lower-priority slots just strands it. It used to do exactly that: a rig whose
// only worthwhile upgrade was the GPU got the card filed under "optional" and a
// build that left up to 81% of the budget unspent, because the cap reserved
// money for a CPU and RAM it then never bought.
//
// No single value works. Raising the ceiling fixes the stranding but wrecks
// low-budget rigs where the CPU also needs replacing: at $600 a raised ceiling
// bought a bigger GPU by dropping the CPU pick from a 5800XT (gaming index 70)
// to a Ryzen 3 4100 (36). Lowering it strands the budget again. Tuning the
// constant just moves the damage between rigs.
//
// So the constant is NOT tuned. It stays the conservative reservation it always
// was, and optimizeBuild additionally tries a GPU-max allocation, scoring both
// complete builds and keeping the better one — see GPU_CEILING_RELAXED below.
export const GPU_BUDGET_SHARE = { productivity: 0.20, gaming: 0.65, content: 0.55, ai: 0.60 };

// The relaxed ceiling tried as a SECOND candidate allocation. A GPU may use the
// whole nominal budget; spending is still bounded by budget * (1 + OVERAGE), so
// the overage headroom stays available for the other slots.
//
// Productivity is deliberately excluded: there the cap is a genuine taste ceiling
// ("an office machine should not be handed a gaming card") rather than a
// reservation, and the weighted score would happily buy a $1,200 card for a
// workload that barely touches the GPU. That is a product judgement, not an
// optimisation, so it is left alone.
export const GPU_CEILING_RELAXED = 1.00;
const RELAX_GPU_CEILING = (useCase) => useCase !== "productivity";

// ─── BUILD OPTIMIZER ────────────────────────────────────────────────
// Recommended ratio: GPU bench ≤ ~3.5x CPU bench for balanced gaming.
// Past that, CPU becomes the limiting factor and GPU performance is wasted.
export const MAX_GPU_CPU_BENCH_RATIO = 2.0;

// Same-socket / non-refresh build. Uses the SAME budget-filling engine as the refresh
// path: pick the best CPU & GPU within budget, then spend leftover by the use-case
// priority chain. RAM is OPTIONAL here (user keeps existing RAM unless a kit helps).
export function optimizeBuild(currentGPU, currentCPU, candidates, budget) {
  const maxBudget = budget * (1 + BUDGET_OVERAGE);
  const useCase = candidates.useCase || "gaming";
  const w = useCaseWeights(useCase);
  const priority = LEFTOVER_PRIORITY[useCase] || ["gpu", "cpu", "ram"];
  const gpuShare = GPU_BUDGET_SHARE[useCase] ?? 0.5;

  const curC = currentCPU?.bench || 0;
  const curG = currentGPU?.bench || 0;

  const cpus = candidates.cpus || [];
  const gpus = candidates.gpus || [];
  const rams = candidates.rams || [];
  const stors = candidates.storages || [];

  // Use-case weighted absolute performance, with CPU-bottleneck guard.
  const scoreBuild = (cpu, gpu) => {
    const cpuScore = cpu ? cpuScoreForUseCase(cpu, useCase) : curC;
    const gpuBench = gpu ? gpu.bench : curG;
    let s = cpuScore * w.cpu + gpuBench * w.gpu;
    if (gpuBench > 0 && cpuScore > 0) {
      const ratio = gpuBench / cpuScore;
      if (ratio > MAX_GPU_CPU_BENCH_RATIO) {
        const over = ratio / MAX_GPU_CPU_BENCH_RATIO;
        s *= (1 - Math.min(0.5, (over - 1) * 0.6));
      }
    }
    return s;
  };

  // One greedy pass down the priority chain, under a given GPU ceiling.
  const allocate = (ceilingShare) => {
    let chosenCpu = null, chosenGpu = null, chosenRam = null, chosenSto = null;
    const spend = () => (chosenCpu ? bestPrice(chosenCpu) : 0) + (chosenGpu ? bestPrice(chosenGpu) : 0) +
                        (chosenRam ? bestPrice(chosenRam) : 0) + (chosenSto ? bestPrice(chosenSto) : 0);

    // Honor an explicit storage request first (user asked for it).
    if (stors.length) { const s = stors.find(x => bestPrice(x) <= maxBudget); if (s) chosenSto = s; }

    // Allocate budget by use-case priority chain.
    for (const slot of priority) {
      const remaining = maxBudget - spend();
      if (remaining <= 0) break;
      if (slot === "gpu") {
        const budgetForGpu = remaining + (chosenGpu ? bestPrice(chosenGpu) : 0);
        const g = gpus.filter(x => bestPrice(x) <= budgetForGpu && bestPrice(x) <= budget * ceilingShare && (!chosenGpu || x.bench > chosenGpu.bench) && x.bench > curG)
                      .sort((a, b) => b.bench - a.bench)[0];
        if (g) chosenGpu = g;
      } else if (slot === "cpu") {
        const budgetForCpu = remaining + (chosenCpu ? bestPrice(chosenCpu) : 0);
        const c = cpus.filter(x => bestPrice(x) <= budgetForCpu && (!chosenCpu || cpuScoreForUseCase(x, useCase) > cpuScoreForUseCase(chosenCpu, useCase)))
                      .sort((a, b) => cpuScoreForUseCase(b, useCase) - cpuScoreForUseCase(a, useCase))[0];
        if (c) chosenCpu = c;
      } else if (slot === "ram") {
        const r = rams.filter(x => bestPrice(x) <= remaining)[0];
        if (r) chosenRam = r;
      }
    }

    if (!chosenCpu && !chosenGpu && !chosenRam && !chosenSto) return null;
    const cost = spend();
    const score = scoreBuild(chosenCpu, chosenGpu);
    return { gpu: chosenGpu, cpu: chosenCpu, ram: chosenRam, sto: chosenSto, cost, score, adjustedScore: score, overPct: Math.max(0, (cost - budget) / budget) };
  };

  // The chain is greedy, so whichever slot goes first claims the money. Under the
  // conservative ceiling that strands budget when the GPU is the only worthwhile
  // upgrade; under a relaxed one the GPU can gut a CPU pick the user needed. Both
  // failures are real, so run BOTH allocations and keep the build that actually
  // scores higher — scoreBuild already weights by use case and penalises a GPU
  // too far ahead of its CPU.
  const builds = [allocate(gpuShare)];
  if (RELAX_GPU_CEILING(useCase) && GPU_CEILING_RELAXED > gpuShare) builds.push(allocate(GPU_CEILING_RELAXED));

  const viable = builds.filter(Boolean);
  if (!viable.length) return null;
  // Ties go to the first (conservative) build, so nothing changes unless relaxing
  // the ceiling genuinely produces a better system.
  return viable.reduce((best, b) => (b.score > best.score ? b : best));
}
