// =============================================================================
//  src/bottleneck.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  How good is this CPU at gaming, and is it holding the GPU back?
//
//  ── Why these two live together ─────────────────────────────────────────────
//  The bottleneck verdict used to divide a CPU's `.bench` by a GPU's `.bench`.
//  Those are not the same measurement. CPU bench is PassMark CPU Mark — a
//  MULTITHREADED THROUGHPUT number — while GPU bench is G3D, a graphics number
//  normalised so an RTX 4090 is 100. Dividing one by the other is arithmetic on
//  unrelated units, and it came out wrong in the direction that costs money:
//  it called SIX of eight real-world pairings a CPU bottleneck, including every
//  genuinely balanced one, and told those users to buy a new CPU first.
//
//  The page already carries the right number — the curated gaming tier index,
//  which is what a CPU is worth for FRAMES rather than for throughput. A
//  Ryzen 7 5800X3D scores 40 on CPU Mark (its extra cache does nothing for
//  multithreaded throughput) and 78 on the gaming index. Against an RTX 4070
//  at 84 that is the difference between "CPU is your bottleneck" and "well
//  balanced".
//
//  So: gamingScore is the CPU's side of the comparison, and it lives next to
//  the verdict that depends on it.
// =============================================================================

// `with { type: "json" }` is required by Node's ESM loader (this module is
// imported directly by test/bottleneck.test.js) and is understood by Vite.
import GAMING_TIERS from "../gaming-cpu-tiers.json" with { type: "json" };

// Pre-uppercased once at module load. gamingScore runs inside sort() comparators
// over the whole CPU pool, so it is called thousands of times per analysis; a CPU
// profile of a platform-refresh analysis once put 70% of total time in this one
// function when it rebuilt Object.entries() + toUpperCase() per call.
const GAMING_TIERS_UC = Object.entries(GAMING_TIERS).map(([model, score]) => [model.toUpperCase(), score]);

// Brand-scoped model index, for CPUs that never resolved to a real catalog part.
//
// findCatalogMatch synthesises a placeholder for those — { n: "Current: 5600" } —
// and a name-substring search can never match "Ryzen 5 5600" inside that string.
// It is not a rare path: of a sample of 15 older CPUs a real scan would report,
// TEN resolved to a placeholder, and every one silently fell back to raw bench.
// Those are precisely the users an upgrade tool exists for, so the verdict has
// to work for them too.
//
// Scoped by brand because the last token is unique across the table EXCEPT for
// "7700", which is both "Ryzen 7 7700" and "i7-7700" — the same cross-brand
// collision findCatalogMatch already guards against.
const GAMING_TIERS_BY_MODEL = { AMD: Object.create(null), Intel: Object.create(null) };
for (const [key, score] of Object.entries(GAMING_TIERS)) {
  const brand = /RYZEN/i.test(key) ? "AMD" : "Intel";
  const token = key.split(/[\s-]+/).pop().toUpperCase();
  if (GAMING_TIERS_BY_MODEL[brand][token] === undefined) GAMING_TIERS_BY_MODEL[brand][token] = score;
}

const gamingScoreCache = new WeakMap();

/**
 * A CPU's gaming-performance index (0-100) from the curated tier table.
 *
 * Resolution order:
 *   1. the part's name contains a tier key   (real catalog parts)
 *   2. brand + model number hit the index    (synthesised "Current: X" placeholders)
 *   3. PassMark bench                        (Threadrippers, Xeons, obscure OEM chips)
 *
 * Step 3 is a genuine fallback, not a scale conversion — a CPU outside the table
 * is compared on the wrong units, same as before. It covers ~15% of the catalog,
 * mostly very new Core Ultra parts.
 */
export function gamingScore(cpu) {
  if (!cpu) return 0;
  const cached = gamingScoreCache.get(cpu);
  if (cached !== undefined) return cached;

  const name = (cpu.n || "").toUpperCase();
  let score = null;
  for (let i = 0; i < GAMING_TIERS_UC.length; i++) {
    if (name.includes(GAMING_TIERS_UC[i][0])) { score = GAMING_TIERS_UC[i][1]; break; }
  }
  if (score === null && cpu.brand && cpu.model) {
    const byBrand = GAMING_TIERS_BY_MODEL[cpu.brand];
    if (byBrand) {
      const hit = byBrand[String(cpu.model).toUpperCase()];
      if (hit !== undefined) score = hit;
    }
  }
  if (score === null) score = cpu.bench || 0;

  gamingScoreCache.set(cpu, score);
  return score;
}

// Verdict thresholds, on the gaming-index-vs-G3D ratio. Both indices top out at
// 100 for the fastest current part, so a balanced pairing sits near 1.0 and the
// band below is deliberately wide: a CPU only earns the "bottleneck" label when
// it is clearly the limiting part, because that verdict tells someone to spend.
const CPU_LIMITED_BELOW = 0.75;
const GPU_LIMITED_ABOVE = 1.4;

// Workloads where a bottleneck verdict is not meaningful advice.
//
// The card's own copy is gaming-framed ("especially at 1080p", "1440p/4K"), and
// for productivity the optimizer deliberately caps the GPU at 20% of budget and
// spends RAM-first — so a "GPU is your bottleneck, upgrade it" card sits directly
// above a recommended build that buys no GPU at all. Measured over 32 CPU/GPU
// pairings, that self-contradiction hits 15 of 32 productivity rigs and 0 of 32
// for gaming, content and AI, which do prioritise GPU spend. So it is suppressed
// for productivity only.
const NO_BOTTLENECK_VERDICT = new Set(["productivity"]);

/**
 * Which component is holding the system back, comparing the CPU's GAMING index
 * against the GPU's graphics bench. Returns null when either side is unknown, or
 * when the workload makes the verdict meaningless.
 */
export function analyzeBottleneck(currentCPU, currentGPU, useCase = "gaming") {
  if (!currentCPU || !currentGPU?.bench) return null;
  if (NO_BOTTLENECK_VERDICT.has(useCase)) return null;
  const cpuScore = gamingScore(currentCPU);
  if (!cpuScore) return null;

  const ratio = cpuScore / currentGPU.bench;
  if (ratio < CPU_LIMITED_BELOW) {
    return {
      who: "CPU",
      severity: Math.round((1 - ratio) * 100),
      text: "CPU is your bottleneck",
      detail: "Your CPU is holding back your GPU's potential. Prioritize a CPU upgrade for the biggest performance gain, especially at 1080p.",
    };
  }
  if (ratio > GPU_LIMITED_ABOVE) {
    return {
      who: "GPU",
      severity: Math.round((ratio - 1) * 100),
      text: "GPU is your bottleneck",
      detail: "Your CPU has more headroom than your GPU can use. A GPU upgrade will unlock significant gains, especially at 1440p/4K.",
    };
  }
  return {
    who: "Balanced",
    severity: 0,
    text: "System is well balanced",
    detail: "Your CPU and GPU are closely matched. Any category upgrade will give proportional gains.",
  };
}
