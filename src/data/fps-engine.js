// RigFinder FPS Estimation Engine
// Calibrated against published benchmarks from Tom's Hardware, TechPowerUp, Hardware Unboxed
// Last updated: 2026-03-28
//
// HOW IT WORKS:
// 1. Each GPU has a relative performance score (RTX 5090 = 290, RTX 4060 = 100 baseline)
// 2. Each game has a "base FPS" at 1080p Ultra on the baseline GPU (RTX 4060)
// 3. estimated_fps = (gpu_score / 100) × game_base_fps × resolution_factor
// 4. CPU bottleneck: if cpu_score < gpu_score × threshold, fps is capped
// 5. RAM speed gives a small bonus (0-5%) for fast memory

// ── GPU relative performance scores ──
// Baseline: RTX 4060 = 100 at 1080p
// Sources: Tom's Hardware GPU Hierarchy, TechPowerUp relative performance charts
export const GPU_SCORES = {
  // NVIDIA RTX 50 Series
  "RTX 5090":       290,
  "RTX 5080":       210,
  "RTX 5070 Ti":    175,
  "RTX 5070":       150,
  // NVIDIA RTX 40 Series
  "RTX 4090":       260,
  "RTX 4080 SUPER": 195,
  "RTX 4070 Ti SUPER": 170,
  "RTX 4070 SUPER": 148,
  "RTX 4070 Ti":    160,
  "RTX 4070":       135,
  "RTX 4060 Ti":    118,
  "RTX 4060":       100,  // BASELINE
  // AMD Radeon RX 7000
  "RX 7900 XTX":    205,
  "RX 7900 XT":     180,
  "RX 7800 XT":     140,
  "RX 7700 XT":     125,
  "RX 7600":         88,
  // Intel Arc
  "Arc B580":        85,
  "Arc A770":        92,
  "Arc A750":        80,
};

// ── CPU relative performance scores (gaming) ──
// Baseline: i5-14400F = 100
// Gaming perf is mostly single/quad-thread, so X3D chips score very high
export const CPU_SCORES = {
  // AMD Ryzen 9000
  "Ryzen 9 9950X":  118,
  "Ryzen 9 9900X":  115,
  "Ryzen 7 9700X":  110,
  "Ryzen 5 9600X":  108,
  // AMD Ryzen 7000
  "Ryzen 7 7800X3D": 125,  // 3D V-Cache king for gaming
  "Ryzen 9 7950X":  116,
  "Ryzen 7 7700":   105,
  "Ryzen 5 7600":   100,
  "Ryzen 5 8600G":   95,
  // Intel Arrow Lake
  "Core Ultra 9 285K": 112,
  "Core Ultra 7 265K": 108,
  "Core Ultra 5 245K": 103,
  // Intel Raptor Lake
  "Core i9-14900K": 120,
  "Core i7-14700K": 115,
  "Core i5-14600K": 110,
  "Core i5-14400F": 100,  // BASELINE
};

// ── Resolution scaling factors ──
// How much FPS drops at each resolution relative to 1080p
export const RES_SCALE = {
  "1080p": 1.0,
  "1440p": 0.72,
  "4K":    0.42,
};

// ── Quality preset multipliers ──
export const QUALITY_SCALE = {
  "Low":    1.80,
  "Medium": 1.35,
  "High":   1.10,
  "Ultra":  1.00,
  "RT Ultra": 0.60,  // Ray tracing enabled
};

// ── Game profiles ──
// base_fps = expected FPS at 1080p Ultra on RTX 4060 (our baseline GPU)
// weight: "heavy" = demanding AAA, "medium" = typical, "light" = esports/older
// cpu_sens: how CPU-sensitive the game is (0.0 = pure GPU, 1.0 = very CPU dependent)
export const GAMES = [
  // AAA Heavy
  {name:"Cyberpunk 2077",        base_fps:55,  weight:"heavy",  cpu_sens:0.3, icon:"🌆", year:2020},
  {name:"Alan Wake 2",           base_fps:45,  weight:"heavy",  cpu_sens:0.2, icon:"🔦", year:2023},
  {name:"Hogwarts Legacy",       base_fps:60,  weight:"heavy",  cpu_sens:0.3, icon:"🧙", year:2023},
  {name:"Starfield",             base_fps:50,  weight:"heavy",  cpu_sens:0.4, icon:"🚀", year:2023},
  {name:"Star Wars Outlaws",     base_fps:52,  weight:"heavy",  cpu_sens:0.3, icon:"⭐", year:2024},
  {name:"Black Myth: Wukong",    base_fps:48,  weight:"heavy",  cpu_sens:0.2, icon:"🐒", year:2024},
  {name:"Indiana Jones & GCoT",  base_fps:50,  weight:"heavy",  cpu_sens:0.3, icon:"🎩", year:2024},
  {name:"Dragon Age: Veilguard", base_fps:65,  weight:"heavy",  cpu_sens:0.3, icon:"🐉", year:2024},
  {name:"GTA VI",                base_fps:55,  weight:"heavy",  cpu_sens:0.4, icon:"🌴", year:2025},
  {name:"Assassin's Creed Shadows",base_fps:52,weight:"heavy",  cpu_sens:0.3, icon:"⚔️", year:2025},

  // AAA Medium
  {name:"Call of Duty: MW III",  base_fps:100, weight:"medium", cpu_sens:0.4, icon:"🔫", year:2023},
  {name:"Spider-Man 2",          base_fps:70,  weight:"medium", cpu_sens:0.3, icon:"🕷️", year:2024},
  {name:"Elden Ring",            base_fps:58,  weight:"medium", cpu_sens:0.3, icon:"💍", year:2022},
  {name:"God of War Ragnarök",   base_fps:70,  weight:"medium", cpu_sens:0.3, icon:"🪓", year:2024},
  {name:"Baldur's Gate 3",       base_fps:75,  weight:"medium", cpu_sens:0.5, icon:"🎲", year:2023},
  {name:"Horizon Forbidden West",base_fps:65,  weight:"medium", cpu_sens:0.3, icon:"🏹", year:2024},
  {name:"Red Dead Redemption 2", base_fps:68,  weight:"medium", cpu_sens:0.3, icon:"🤠", year:2019},
  {name:"The Witcher 3 (Next Gen)",base_fps:80,weight:"medium", cpu_sens:0.3, icon:"🐺", year:2022},

  // Esports / Competitive (Light)
  {name:"Fortnite",              base_fps:140, weight:"light",  cpu_sens:0.5, icon:"🏗️", year:2017},
  {name:"Valorant",              base_fps:280, weight:"light",  cpu_sens:0.7, icon:"🎯", year:2020},
  {name:"Counter-Strike 2",      base_fps:220, weight:"light",  cpu_sens:0.7, icon:"💣", year:2023},
  {name:"Apex Legends",          base_fps:145, weight:"light",  cpu_sens:0.5, icon:"🏆", year:2019},
  {name:"Overwatch 2",           base_fps:170, weight:"light",  cpu_sens:0.5, icon:"🛡️", year:2022},
  {name:"League of Legends",     base_fps:300, weight:"light",  cpu_sens:0.6, icon:"⚡", year:2009},
  {name:"Minecraft (Modded)",    base_fps:120, weight:"light",  cpu_sens:0.8, icon:"⛏️", year:2011},
  {name:"Roblox",                base_fps:200, weight:"light",  cpu_sens:0.6, icon:"🧱", year:2006},
];


// ── FPS Estimation Function ──
export function estimateFPS(gpuName, cpuName, game, resolution = "1080p", quality = "Ultra", ramInfo = null) {
  // Find GPU score — try exact match first, then fuzzy
  let gpuScore = GPU_SCORES[gpuName];
  if (!gpuScore) {
    const key = Object.keys(GPU_SCORES).find(k => gpuName.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(gpuName.toLowerCase()));
    gpuScore = key ? GPU_SCORES[key] : 100;
  }

  // Find CPU score
  let cpuScore = CPU_SCORES[cpuName];
  if (!cpuScore) {
    const key = Object.keys(CPU_SCORES).find(k => cpuName.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(cpuName.toLowerCase()));
    cpuScore = key ? CPU_SCORES[key] : 100;
  }

  // Get game profile
  const gameProfile = typeof game === "string"
    ? GAMES.find(g => g.name.toLowerCase() === game.toLowerCase())
    : game;
  if (!gameProfile) return null;

  const resFactor = RES_SCALE[resolution] || 1.0;
  const qualFactor = QUALITY_SCALE[quality] || 1.0;

  // ── RAM impact calculation ──
  // RAM speed: faster memory helps CPU-bound scenarios (especially AMD Ryzen)
  // Baseline: DDR5-5600 = 1.0x multiplier
  // RAM capacity: <16GB can bottleneck at high quality, <8GB is severe
  let ramSpeedMult = 1.0;
  let ramCapPenalty = 1.0;
  let ramBottleneck = null;

  if (ramInfo) {
    const speed = ramInfo.speed || 5600;
    const capacity = ramInfo.capacity || 32;
    const memType = ramInfo.memType || "DDR5";

    // Speed multiplier: scales from ~0.94 (DDR5-4800) to ~1.06 (DDR5-7200)
    // Only matters in CPU-sensitive games. DDR4 has a lower baseline.
    if (memType === "DDR5") {
      ramSpeedMult = 0.94 + (Math.min(speed, 8000) - 4800) / 8000 * 0.12;
    } else {
      // DDR4 is inherently ~5% slower than DDR5 baseline
      ramSpeedMult = 0.89 + (Math.min(speed, 4000) - 2400) / 4000 * 0.08;
    }

    // Capacity penalty: affects games that use lots of VRAM + system RAM at high res/quality
    if (capacity < 8) {
      ramCapPenalty = 0.65; // severe stuttering
      ramBottleneck = "RAM (only " + capacity + "GB — need 16GB+)";
    } else if (capacity < 16 && (resolution === "4K" || quality === "Ultra")) {
      ramCapPenalty = 0.85; // some asset streaming issues
      ramBottleneck = "RAM (16GB recommended for " + resolution + " " + quality + ")";
    } else if (capacity < 16 && gameProfile.weight === "heavy") {
      ramCapPenalty = 0.90;
      ramBottleneck = "RAM (heavy games prefer 16GB+)";
    }
  }

  // Raw GPU-driven FPS
  let rawFPS = (gpuScore / 100) * gameProfile.base_fps * resFactor * qualFactor;

  // CPU bottleneck check (RAM speed affects this)
  // At lower resolutions, CPU matters more. At 4K, GPU is almost always the limiter.
  const cpuWeight = gameProfile.cpu_sens * (resolution === "4K" ? 0.3 : resolution === "1440p" ? 0.6 : 1.0);
  const cpuCap = (cpuScore / 100) * gameProfile.base_fps * qualFactor * (1 + cpuWeight) * ramSpeedMult;

  // Apply RAM capacity penalty to both paths
  rawFPS *= ramCapPenalty;
  const cpuCapAdj = cpuCap * ramCapPenalty;

  // The actual FPS is the minimum of GPU-limited and CPU-limited
  const estimatedFPS = Math.min(rawFPS, cpuCapAdj);

  // Determine bottleneck
  let bottleneck = rawFPS > cpuCapAdj * 1.05 ? "CPU" : cpuCapAdj > rawFPS * 1.05 ? "GPU" : "Balanced";
  if (ramBottleneck && ramCapPenalty < 0.9) bottleneck = "RAM";
  const bottleneckPct = bottleneck === "CPU"
    ? Math.round((1 - cpuCapAdj / rawFPS) * 100)
    : bottleneck === "GPU"
    ? Math.round((1 - rawFPS / cpuCapAdj) * 100)
    : bottleneck === "RAM"
    ? Math.round((1 - ramCapPenalty) * 100)
    : 0;

  return {
    fps: Math.round(estimatedFPS),
    gpu: gpuName,
    cpu: cpuName,
    game: gameProfile.name,
    resolution,
    quality,
    bottleneck,
    bottleneckPct,
    gpuScore,
    cpuScore,
    ramSpeedMult: Math.round(ramSpeedMult * 100) / 100,
    ramNote: ramBottleneck,
    tier: estimatedFPS >= 144 ? "Excellent" : estimatedFPS >= 100 ? "Great" : estimatedFPS >= 60 ? "Smooth" : estimatedFPS >= 30 ? "Playable" : "Slideshow",
  };
}

// ── Estimate FPS across all games for a given GPU+CPU+RAM ──
export function estimateAllGames(gpuName, cpuName, resolution = "1080p", quality = "Ultra", ramInfo = null) {
  return GAMES.map(g => estimateFPS(gpuName, cpuName, g, resolution, quality, ramInfo)).filter(Boolean);
}

// ── Match GPU name from parts database to score lookup ──
export function matchGPU(partName) {
  const normalized = partName.replace(/ASUS|MSI|Gigabyte|EVGA|SAPPHIRE|PowerColor|XFX|ZOTAC|PNY|Dual|TUF|Strix|AORUS|Ventus|MERC310|Nitro\+?|Pulse|Speedster|Gaming|OC|Red Devil|XC|Master/gi, "").trim();
  for (const key of Object.keys(GPU_SCORES)) {
    if (normalized.toLowerCase().includes(key.toLowerCase())) return key;
  }
  return null;
}

// ── Match CPU name from parts database to score lookup ──
export function matchCPU(partName) {
  for (const key of Object.keys(CPU_SCORES)) {
    if (partName.toLowerCase().includes(key.toLowerCase())) return key;
  }
  return null;
}
