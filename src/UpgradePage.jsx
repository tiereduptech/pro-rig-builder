// =============================================================================
//  UpgradePage.jsx — Pro Rig Builder
//  Landing page for Pro Rig Scanner results
//
//  Copyright © 2026 TieredUp Tech, Inc. — All rights reserved.
//  Proprietary and confidential. See project LICENSE for terms.
//
//  Auto-selects the best full build within budget (GPU + CPU + RAM + Storage),
//  with 10% overage allowed when it meaningfully improves the build.
//  Shows 2-3 alternatives per category + CPU cooler add-ons (separate budget)
//  ONLY when user's current cooler can't handle the recommended CPU's TDP.
//
//  Bench scale: 0-100 (PassMark G3D/CPU Mark calibrated, RTX 4090 = 100).
// =============================================================================

import React, { useState, useEffect, useMemo } from "react";
import { PARTS as RAW_PARTS } from "./data/parts.js";

const isWorkstationGPU = (p) => {
  if (p.c !== "GPU") return false;
  if (p.segment === "server" || p.segment === "workstation") return true;
  const n = (p.n || "").toUpperCase();
  if (/\b(QUADRO|TESLA|RTX\s*A\d{4}|NVIDIA\s*A\d+\b|RADEON\s*PRO\s*W|FIREPRO)\b/.test(n)) return true;
  return false;
};

const PARTS = RAW_PARTS.filter(p => !p.needsReview && !isWorkstationGPU(p));

// ─── CONFIG ─────────────────────────────────────────────────────────
const MIN_IMPROVEMENT = 0.10;
const BUDGET_OVERAGE  = 0.10;
const N_ALTERNATIVES  = 3;
const COOLER_TDP_HEADROOM = 1.15;

// Cooler type → estimated max TDP capacity (used to check if replacement needed)
const COOLER_TDP_CAPACITY = {
  "stock":       65,
  "budget_air":  120,
  "aio_120":     150,
  "aio_240":     220,
  "aio_360":     300,
  "unknown":     0,   // 0 = always recommend coolers (we don't know what they have)
};

const COOLER_LABELS = {
  "stock":       "your stock cooler (~65W)",
  "budget_air":  "your budget air cooler (~120W)",
  "aio_120":     "your 120mm AIO (~150W)",
  "aio_240":     "your 240mm AIO (~220W)",
  "aio_360":     "your 360mm AIO (~300W)",
  "unknown":     "your current cooler",
};

// ─── URL PARSING ────────────────────────────────────────────────────
function parseSpecs() {
  try {
    const hash = window.location.hash.split("?")[1] || "";
    const params = new URLSearchParams(hash);
    const raw = params.get("specs");
    if (!raw) return null;
    return JSON.parse(atob(decodeURIComponent(raw)));
  } catch (e) {
    console.error("parseSpecs failed:", e);
    return null;
  }
}

// ─── NAME EXTRACTION ────────────────────────────────────────────────
function extractGPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  let m = n.match(/RTX\s*(\d{4})\s*(TI\s*SUPER|TI|SUPER)?/);
  if (m) return `RTX ${m[1]}${m[2] ? " " + m[2].replace(/\s+/g, " ") : ""}`.trim();
  m = n.match(/GTX\s*(\d{3,4})\s*(TI)?/);
  if (m) return `GTX ${m[1]}${m[2] ? " TI" : ""}`.trim();
  m = n.match(/RX\s*(\d{4})\s*(XTX|XT)?/);
  if (m) return `RX ${m[1]}${m[2] ? " " + m[2] : ""}`.trim();
  m = n.match(/ARC\s*([AB]\d{3})/);
  if (m) return `Arc ${m[1]}`.trim();
  return null;
}

function extractCPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  let m = n.match(/CORE\s+(?:ULTRA\s+)?[IU]?[3579]-?(\d{3,5}[A-Z]{0,2})/);
  if (m) return { brand: "Intel", model: m[1] };
  m = n.match(/RYZEN\s*\d\s+(\d{4}[A-Z]{0,2})/);
  if (m) return { brand: "AMD", model: m[1] };
  return null;
}

function intelGeneration(model) {
  if (!model) return null;
  const m = model.match(/^(\d{2,5})/);
  if (!m) return null;
  const num = parseInt(m[1]);
  if (num >= 10000) return Math.floor(num / 1000);
  return Math.floor(num / 100);
}
function amdGeneration(model) {
  if (!model) return null;
  const m = model.match(/^(\d)/);
  return m ? parseInt(m[1]) : null;
}
function inferCPUSocket(model, brand) {
  if (!model) return null;
  if (brand === "Intel") {
    const gen = intelGeneration(model);
    if (gen === 6 || gen === 7 || gen === 8 || gen === 9) return "LGA1151";
    if (gen === 10 || gen === 11) return "LGA1200";
    if (gen === 12 || gen === 13 || gen === 14) return "LGA1700";
    if (gen >= 15) return "LGA1851";
  }
  if (brand === "AMD") {
    const gen = amdGeneration(model);
    if ([1, 2, 3, 5].includes(gen)) return "AM4";
    if ([7, 8, 9].includes(gen)) return "AM5";
  }
  return null;
}
function socketToDDR(socket) {
  if (socket === "AM5" || socket === "LGA1851") return "DDR5";
  if (socket === "AM4" || socket === "LGA1200" || socket === "LGA1151") return "DDR4";
  return null;
}

// ─── BASELINE TABLES (PassMark-calibrated) ──────────────────────────
const GPU_BASELINE_BENCH = {
  "GTX 1030": 4, "GTX 1050": 6, "GTX 1050 TI": 9, "GTX 1060": 12,
  "GTX 1070": 17, "GTX 1070 TI": 20, "GTX 1080": 22, "GTX 1080 TI": 28,
  "GTX 1630": 7, "GTX 1650": 11, "GTX 1650 SUPER": 14, "GTX 1660": 15, "GTX 1660 SUPER": 18, "GTX 1660 TI": 19,
  "RTX 2060": 22, "RTX 2060 SUPER": 26, "RTX 2070": 27, "RTX 2070 SUPER": 30,
  "RTX 2080": 32, "RTX 2080 SUPER": 34, "RTX 2080 TI": 40,
  "RTX 3050": 25, "RTX 3060": 49, "RTX 3060 TI": 55, "RTX 3070": 60, "RTX 3070 TI": 63,
  "RTX 3080": 71, "RTX 3080 TI": 78, "RTX 3090": 73, "RTX 3090 TI": 80,
  "RTX 4060": 57, "RTX 4060 TI": 58, "RTX 4070": 81, "RTX 4070 SUPER": 80,
  "RTX 4070 TI": 85, "RTX 4070 TI SUPER": 85, "RTX 4080": 91, "RTX 4080 SUPER": 93, "RTX 4090": 100,
  "RTX 5050": 40, "RTX 5060": 55, "RTX 5060 TI": 62, "RTX 5070": 82, "RTX 5070 TI": 87,
  "RTX 5080": 95, "RTX 5090": 100,
  "RX 550": 3, "RX 560": 5, "RX 570": 9, "RX 580": 11, "RX 590": 13,
  "RX 5500 XT": 13, "RX 5600 XT": 18, "RX 5700": 22, "RX 5700 XT": 26,
  "RX 6500 XT": 18, "RX 6600": 30, "RX 6600 XT": 36, "RX 6650 XT": 38, "RX 6700 XT": 45,
  "RX 6750 XT": 48, "RX 6800": 55, "RX 6800 XT": 62, "RX 6900 XT": 66, "RX 6950 XT": 70,
  "RX 7600": 38, "RX 7600 XT": 42, "RX 7700 XT": 60, "RX 7800 XT": 64, "RX 7900 GRE": 72,
  "RX 7900 XT": 81, "RX 7900 XTX": 83,
  "ARC A310": 8, "ARC A380": 11, "ARC A580": 28, "ARC A750": 40, "ARC A770": 45,
  "ARC B580": 42, "ARC B570": 38,
  "UHD GRAPHICS": 2, "IRIS XE": 4, "RADEON GRAPHICS": 6, "VEGA": 8,
};

const CPU_BASELINE_BENCH = {
  "6100": 8, "6300": 10, "6500": 13, "6600": 15, "6700": 18, "6700K": 19,
  "7100": 9, "7300": 11, "7400": 13, "7500": 15, "7600": 17, "7700": 19, "7700K": 21,
  "8100": 12, "8300": 14, "8400": 17, "8500": 19, "8600": 21, "8600K": 23, "8700": 25, "8700K": 27,
  "9100": 14, "9300": 16, "9400": 19, "9500": 21, "9600K": 24, "9700K": 28, "9900K": 32,
  "10100": 15, "10105": 15, "10300": 18, "10400": 22, "10500": 24, "10600K": 28, "10700K": 32, "10900K": 38,
  "11400": 24, "11600K": 30, "11700K": 36, "11900K": 42,
  "12100": 20, "12400": 28, "12600K": 39, "12700K": 49, "12900K": 59,
  "13400": 35, "13600K": 53, "13700K": 65, "13900K": 83,
  "14400": 36, "14600K": 78, "14700K": 74, "14900K": 83,
  "245K": 62, "245KF": 62, "265K": 70, "265KF": 70, "285K": 85,
  "1600": 12, "1700": 14, "1800X": 16, "1600X": 13,
  "2600": 15, "2700": 18, "2700X": 20,
  "3600": 22, "3700X": 28, "3800X": 30, "3900X": 38, "3950X": 45,
  "5600": 28, "5600X": 31, "5700X": 36, "5800X": 39, "5800X3D": 72,
  "5900X": 48, "5950X": 56,
  "7600": 38, "7600X": 40, "7700": 48, "7700X": 51, "7800X3D": 70,
  "7900": 68, "7900X": 73, "7950X": 89, "7950X3D": 88,
  "9600X": 45, "9700X": 53, "9800X3D": 80, "9900X": 78, "9900X3D": 85,
  "9950X": 94, "9950X3D": 100,
};

function lookupGPUBaseline(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  let bestKey = null;
  for (const key of Object.keys(GPU_BASELINE_BENCH)) {
    if (n.includes(key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? { bench: GPU_BASELINE_BENCH[bestKey], name: bestKey } : null;
}
function lookupCPUBaseline(model) {
  if (!model) return null;
  const m = model.toUpperCase();
  let bestKey = null;
  for (const key of Object.keys(CPU_BASELINE_BENCH)) {
    if ((m.startsWith(key) || m === key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? { bench: CPU_BASELINE_BENCH[bestKey], name: bestKey } : null;
}

// ─── CATALOG LOOKUP ─────────────────────────────────────────────────
function findCatalogMatch(type, scannerName) {
  if (!scannerName) return null;
  const pool = PARTS.filter(p => p.c === type && !p.bundle);
  if (type === "GPU") {
    const model = extractGPUModel(scannerName);
    if (model) {
      const modelUpper = model.toUpperCase();
      const hit = pool.find(p => p.n.toUpperCase().includes(modelUpper) && p.bench != null);
      if (hit) return hit;
    }
    const b = lookupGPUBaseline(scannerName);
    if (b && b.bench > 0) return { n: "Current: " + b.name, bench: b.bench, isBaseline: true };
    return null;
  }
  if (type === "CPU") {
    const cpu = extractCPUModel(scannerName);
    if (!cpu) return null;
    const hit = pool.find(p => p.n.toUpperCase().includes(cpu.model) && p.bench != null);
    if (hit) return hit;
    const b = lookupCPUBaseline(cpu.model);
    const inferredSocket = inferCPUSocket(cpu.model, cpu.brand);
    if (b && b.bench > 0) return { n: "Current: " + b.name, bench: b.bench, socket: inferredSocket, brand: cpu.brand, isBaseline: true };
    return null;
  }
  return null;
}

// ─── PRICE / RETAILER ───────────────────────────────────────────────
function bestPrice(p) {
  const amazonPrice = Number(p?.deals?.amazon?.price);
  if (amazonPrice > 0) return amazonPrice;
  const bestbuyPrice = Number(p?.deals?.bestbuy?.price);
  if (bestbuyPrice > 0) return bestbuyPrice;
  return Number(p?.pr) || 0;
}
function retailerUrl(p) {
  if (p?.deals?.amazon?.url) return { url: p.deals.amazon.url, name: "Amazon" };
  if (p?.deals?.bestbuy?.url) return { url: p.deals.bestbuy.url, name: "Best Buy" };
  return null;
}

// ─── PLATFORM REFRESH ───────────────────────────────────────────────
function needsPlatformRefresh(currentCPU, cpuModel, rawSocket) {
  if (!cpuModel) return { refresh: false };
  if (rawSocket && /^AM[123]$|^FM[12]$|^939|^754|^AM3\+/.test(rawSocket)) {
    return { refresh: true, reason: `${rawSocket} socket is obsolete — AM5 platform needed` };
  }
  if (cpuModel.brand === "Intel") {
    const gen = intelGeneration(cpuModel.model);
    if (gen && gen < 8) return { refresh: true, reason: `Intel ${gen}th gen is outdated — newer socket required` };
    if (gen === 8 || gen === 9) {
      const has = PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1151" && p.bench != null);
      if (!has) return { refresh: true, reason: `LGA1151 has no upgrade path in our catalog` };
    }
    if (gen === 10 || gen === 11) {
      const has = PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1200" && p.bench != null);
      if (!has) return { refresh: true, reason: `LGA1200 is dead-end — LGA1700 or LGA1851 recommended` };
    }
  }
  return { refresh: false };
}

// ─── CANDIDATE POOLS ────────────────────────────────────────────────
function candidateGPUs(currentGPU, maxPrice) {
  if (!currentGPU?.bench) return [];
  const target = currentGPU.bench * (1 + MIN_IMPROVEMENT);
  const pool = PARTS.filter(p => {
    if (p.c !== "GPU" || p.bundle) return false;
    if (p.bench == null || p.bench < target) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    return true;
  });
  pool.sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)));
  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const key = extractGPUModel(p.n) || p.n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function candidateCPUs(currentCPU, maxPrice) {
  if (!currentCPU?.bench || !currentCPU.socket) return [];
  const target = currentCPU.bench * (1 + MIN_IMPROVEMENT);
  const pool = PARTS.filter(p => {
    if (p.c !== "CPU" || p.bundle) return false;
    if (p.bench == null || p.bench < target) return false;
    if (p.socket !== currentCPU.socket) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    return true;
  });
  pool.sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)));
  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const key = extractCPUModel(p.n)?.model || p.n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function candidateRAMs(specs, maxPrice) {
  const currentSticks = parseInt(specs.ram_sticks) || 0;
  const currentUsed   = parseInt(specs.ram_used_slots) || currentSticks;
  const currentTotal  = parseInt(specs.ram_total_slots) || currentSticks;
  const currentCapGB  = parseInt(specs.ram_total) || 0;
  const currentSpeed  = parseInt(specs.ram_speed) || 0;
  const currentType   = specs.ram_type || "";
  const allSlotsFilled = currentUsed >= currentTotal && currentTotal > 0;

  const pool = PARTS.filter(p => {
    if (p.c !== "RAM" || p.bundle) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    const nameDdr = /DDR5/i.test(p.n) ? "DDR5" : /DDR4/i.test(p.n) ? "DDR4" : null;
    const partType = p.ramType || nameDdr;
    if (currentType && partType && partType !== currentType) return false;
    if (p.cap != null && p.cap < currentCapGB) return false;
    if (allSlotsFilled && p.sticks != null && p.sticks !== currentSticks) return false;
    if (currentSpeed && p.speed != null && p.speed <= currentSpeed) return false;
    return true;
  });

  pool.sort((a, b) => {
    if (a.bench != null && b.bench != null) return (b.bench / bestPrice(b)) - (a.bench / bestPrice(a));
    return ((b.speed || 0) / bestPrice(b)) - ((a.speed || 0) / bestPrice(a));
  });

  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const key = `${p.cap}-${p.sticks}-${p.speed}-${p.b || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function candidateStorages(wantGB, wantType, maxPrice) {
  if (!wantGB || !wantType) return [];
  const isHDD = wantType === "HDD";
  const pool = PARTS.filter(p => {
    if (p.c !== "Storage" || p.bundle) return false;
    if (p.cap == null || p.cap < wantGB) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    const isHddProduct = /\bHDD\b|hard drive/i.test(p.n);
    const isSsdProduct = /\bSSD\b|NVMe/i.test(p.n);
    if (isHDD && !isHddProduct) return false;
    if (!isHDD && !isSsdProduct) return false;
    return true;
  });
  const tierOf = (p) => {
    if (isHDD) return 0;
    const n = p.n.toUpperCase();
    if (/\bGEN\s*5\b|PCIE\s*5\.?0/.test(n)) return 5;
    if (/\bGEN\s*4\b|PCIE\s*4\.?0/.test(n)) return 4;
    if (/\bGEN\s*3\b|PCIE\s*3\.?0|NVMe/.test(n)) return 3;
    if (/\bSSD\b/.test(n)) return 2;
    return 1;
  };
  pool.sort((a, b) => {
    const t = tierOf(b) - tierOf(a);
    if (t !== 0) return t;
    if (a.bench != null && b.bench != null) return (b.bench / bestPrice(b)) - (a.bench / bestPrice(a));
    if (a.bench != null) return -1;
    if (b.bench != null) return 1;
    return bestPrice(a) - bestPrice(b);
  });
  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const key = `${p.cap}-${p.b || ""}-${p.n.slice(0, 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ─── COOLER RECOMMENDER ─────────────────────────────────────────────
function recommendCoolers(newCPU) {
  if (!newCPU || !newCPU.socket || !newCPU.tdp) return [];
  const requiredTDP = Math.ceil(newCPU.tdp * COOLER_TDP_HEADROOM);
  const pool = PARTS.filter(p => {
    if (p.c !== "CPUCooler" || p.bundle) return false;
    const price = bestPrice(p);
    if (price <= 0) return false;
    if (!Array.isArray(p.sockets) || !p.sockets.includes(newCPU.socket)) return false;
    if (p.tdp_rating == null || p.tdp_rating < requiredTDP) return false;
    return true;
  });
  if (!pool.length) return [];

  const classify = (p) => {
    const isAir = p.coolerType === "Air";
    const price = bestPrice(p);
    if (isAir && price < 60) return "cheap-air";
    if (isAir) return "premium-air";
    const n = p.n.toUpperCase();
    if (/\b360\b|\b420\b/.test(n)) return "enthusiast-aio";
    if (/\b240\b|\b280\b/.test(n)) return "entry-aio";
    return "entry-aio";
  };
  const byClass = { "cheap-air": [], "premium-air": [], "entry-aio": [], "enthusiast-aio": [] };
  for (const p of pool) byClass[classify(p)].push(p);
  for (const cls of Object.keys(byClass)) {
    byClass[cls].sort((a, b) => {
      const pa = bestPrice(a), pb = bestPrice(b);
      if (pa !== pb) return pa - pb;
      return (b.tdp_rating || 0) - (a.tdp_rating || 0);
    });
  }
  const picks = [];
  for (const cls of ["cheap-air", "premium-air", "entry-aio", "enthusiast-aio"]) {
    if (byClass[cls].length) picks.push({ cooler: byClass[cls][0], tier: cls });
  }
  if (picks.length < 3) {
    const poolByPrice = [...pool].sort((a, b) => bestPrice(a) - bestPrice(b));
    for (const p of poolByPrice) {
      if (picks.length >= 4) break;
      if (!picks.find(pick => pick.cooler.id === p.id)) picks.push({ cooler: p, tier: classify(p) });
    }
  }
  return picks.slice(0, 4);
}

const COOLER_TIER_LABELS = {
  "cheap-air": "Budget Air",
  "premium-air": "Premium Air",
  "entry-aio": "Entry AIO (240/280mm)",
  "enthusiast-aio": "Enthusiast AIO (360/420mm)",
};

// ─── BUILD OPTIMIZER ────────────────────────────────────────────────
function optimizeBuild(currentGPU, currentCPU, candidates, budget) {
  const maxBudget = budget * (1 + BUDGET_OVERAGE);
  const K_GPU = 8, K_CPU = 8, K_RAM = 5, K_STOR = 5;

  const gpuPool = [null, ...candidates.gpus.slice(0, K_GPU)];
  const cpuPool = [null, ...candidates.cpus.slice(0, K_CPU)];
  const ramPool = [null, ...candidates.rams.slice(0, K_RAM)];
  const stoPool = [null, ...candidates.storages.slice(0, K_STOR)];

  const curG = currentGPU?.bench || 0;
  const curC = currentCPU?.bench || 0;

  let best = null;
  for (const gpu of gpuPool) {
    for (const cpu of cpuPool) {
      for (const ram of ramPool) {
        for (const sto of stoPool) {
          const cost = (gpu ? bestPrice(gpu) : 0) + (cpu ? bestPrice(cpu) : 0) +
                       (ram ? bestPrice(ram) : 0) + (sto ? bestPrice(sto) : 0);
          if (cost <= 0 || cost > maxBudget) continue;
          const gpuGain = gpu && curG > 0 ? ((gpu.bench - curG) / curG) * 100 : 0;
          const cpuGain = cpu && curC > 0 ? ((cpu.bench - curC) / curC) * 100 : 0;
          const score = gpuGain * 1.0 + cpuGain * 0.6 + (ram ? 5 : 0) + (sto ? 3 : 0);
          const overPct = Math.max(0, (cost - budget) / budget);
          const adjustedScore = score * (1 - overPct * 2);
          if (!best || adjustedScore > best.adjustedScore) {
            best = { gpu, cpu, ram, sto, cost, score, adjustedScore, overPct };
          }
        }
      }
    }
  }
  return best;
}

// ─── PLATFORM SWAP ──────────────────────────────────────────────────
function findPlatformSwap(currentCPU, budget, sameSocketBest) {
  if (!currentCPU || !currentCPU.bench) return null;
  const swapSockets = currentCPU.brand === "Intel" ? ["AM5"]
                    : currentCPU.brand === "AMD" ? ["LGA1700", "LGA1851"] : [];
  let best = null;
  for (const socket of swapSockets) {
    const cpu = PARTS.filter(p => p.c === "CPU" && !p.bundle && p.socket === socket && p.bench != null && bestPrice(p) > 0)
                     .sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)))[0];
    if (!cpu) continue;
    const ddr = socketToDDR(socket) || "DDR5";
    const mobo = PARTS.filter(p => p.c === "Motherboard" && !p.bundle && p.socket === socket && (!p.memType || p.memType === ddr) && bestPrice(p) > 0)
                      .sort((a, b) => bestPrice(a) - bestPrice(b))[0];
    if (!mobo) continue;
    const ram = PARTS.filter(p => p.c === "RAM" && new RegExp(ddr, "i").test(p.n) && p.cap >= 16 && bestPrice(p) > 0)
                     .sort((a, b) => bestPrice(a) - bestPrice(b))[0];
    if (!ram) continue;
    const total = bestPrice(cpu) + bestPrice(mobo) + bestPrice(ram);
    if (total > budget) continue;
    const ppd = cpu.bench / total;
    if (!best || ppd > best.ppd) best = { cpu, mobo, ram, total, ppd, socket, ddr };
  }
  if (!best) return null;
  const sameSocketPPD = sameSocketBest ? (sameSocketBest.bench / bestPrice(sameSocketBest)) : 0;
  if (sameSocketPPD > 0 && best.ppd < sameSocketPPD * 1.30) return null;
  return best;
}

function analyzeBottleneck(currentCPU, currentGPU) {
  if (!currentCPU?.bench || !currentGPU?.bench) return null;
  const ratio = currentCPU.bench / currentGPU.bench;
  if (ratio < 0.75) {
    const severity = Math.round((1 - ratio) * 100);
    return { who: "CPU", severity, text: "CPU is your bottleneck", detail: "Your CPU is holding back your GPU's potential. Prioritize a CPU upgrade for the biggest performance gain, especially at 1080p." };
  }
  if (ratio > 1.4) {
    const severity = Math.round((ratio - 1) * 100);
    return { who: "GPU", severity, text: "GPU is your bottleneck", detail: "Your CPU has more headroom than your GPU can use. A GPU upgrade will unlock significant gains, especially at 1440p/4K." };
  }
  return { who: "Balanced", severity: 0, text: "System is well balanced", detail: "Your CPU and GPU are closely matched. Any category upgrade will give proportional gains." };
}

function calculatePSU(cpuTDP, gpuTDP) {
  const raw = (cpuTDP || 100) + (gpuTDP || 200) + 150;
  return Math.ceil(raw / 100) * 100;
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────
export default function UpgradePage() {
  const [specs, setSpecs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { setSpecs(parseSpecs()); setLoading(false); }, []);

  const analysis = useMemo(() => {
    if (!specs) return null;

    const budget = Number(specs.budget) || 1000;
    const maxBudget = budget * (1 + BUDGET_OVERAGE);
    const currentGPU = findCatalogMatch("GPU", specs.gpu);
    const currentCPU = findCatalogMatch("CPU", specs.cpu);
    const cpuModel = extractCPUModel(specs.cpu);
    const refresh = needsPlatformRefresh(currentCPU, cpuModel, specs.cpu_socket);

    const gpus = candidateGPUs(currentGPU, maxBudget);
    const cpus = candidateCPUs(currentCPU, maxBudget);
    const rams = candidateRAMs(specs, maxBudget);
    const storageWant = Number(specs.add_storage_gb) || 0;
    const storageType = specs.add_storage_type || "";
    const storages = storageWant > 0 ? candidateStorages(storageWant, storageType, maxBudget) : [];

    const recommendedBuild = optimizeBuild(currentGPU, currentCPU, { gpus, cpus, rams, storages }, budget);
    const platformSwap = !refresh.refresh ? findPlatformSwap(currentCPU, budget, cpus[0]) : null;
    const bottleneck = analyzeBottleneck(currentCPU, currentGPU);

    const newCpuTDP = recommendedBuild?.cpu?.tdp ?? currentCPU?.tdp ?? 125;
    const newGpuTDP = recommendedBuild?.gpu?.tdp ?? currentGPU?.tdp ?? 200;
    const psuWattsNeeded = calculatePSU(newCpuTDP, newGpuTDP);

    // Cooler logic: only show add-ons when a new CPU is recommended AND user's current
    // cooler is insufficient (or they don't know what they have).
    const userCoolerType = specs.cooler_type || "unknown";
    const userCoolerCapacity = COOLER_TDP_CAPACITY[userCoolerType] ?? 0;
    const requiredTDP = recommendedBuild?.cpu ? Math.ceil(recommendedBuild.cpu.tdp * COOLER_TDP_HEADROOM) : 0;
    const coolerNeeded = recommendedBuild?.cpu && (userCoolerCapacity === 0 || userCoolerCapacity < requiredTDP);
    const coolerRecs = coolerNeeded ? recommendCoolers(recommendedBuild.cpu) : [];

    if (typeof window !== "undefined") {
      window.__upgradeAnalysis = {
        budget, maxBudget,
        userCoolerType, userCoolerCapacity, requiredTDP, coolerNeeded,
        currentGPU: currentGPU ? { name: currentGPU.n, bench: currentGPU.bench } : null,
        currentCPU: currentCPU ? { name: currentCPU.n, bench: currentCPU.bench, socket: currentCPU.socket } : null,
        poolCounts: { gpu: gpus.length, cpu: cpus.length, ram: rams.length, storage: storages.length, coolers: coolerRecs.length },
        recommendedBuild: recommendedBuild ? {
          cost: recommendedBuild.cost, overPct: (recommendedBuild.overPct * 100).toFixed(1) + "%",
          gpu: recommendedBuild.gpu ? { n: recommendedBuild.gpu.n, bench: recommendedBuild.gpu.bench, price: bestPrice(recommendedBuild.gpu) } : null,
          cpu: recommendedBuild.cpu ? { n: recommendedBuild.cpu.n, bench: recommendedBuild.cpu.bench, price: bestPrice(recommendedBuild.cpu), tdp: recommendedBuild.cpu.tdp } : null,
          ram: recommendedBuild.ram ? { n: recommendedBuild.ram.n, price: bestPrice(recommendedBuild.ram) } : null,
          sto: recommendedBuild.sto ? { n: recommendedBuild.sto.n, price: bestPrice(recommendedBuild.sto) } : null,
        } : null,
      };
    }

    return {
      budget, maxBudget, refresh, bottleneck, psuWattsNeeded,
      currentGPU, currentCPU,
      gpus, cpus, rams, storages, coolerRecs, coolerNeeded,
      userCoolerType, userCoolerCapacity, requiredTDP,
      recommendedBuild, platformSwap,
      storageWant, storageType,
    };
  }, [specs]);

  if (loading) return <div style={{padding:40, textAlign:"center", color:"var(--dim)"}}>Loading your specs…</div>;
  if (!specs)  return <MissingSpecsView />;

  const a = analysis;
  const rb = a.recommendedBuild;
  const allSlotsFilled = Number(specs.ram_used_slots) >= Number(specs.ram_total_slots) && Number(specs.ram_total_slots) > 0;

  const gpuAlts = (rb?.gpu ? a.gpus.filter(p => p.id !== rb.gpu.id) : a.gpus).slice(0, N_ALTERNATIVES);
  const cpuAlts = (rb?.cpu ? a.cpus.filter(p => p.id !== rb.cpu.id) : a.cpus).slice(0, N_ALTERNATIVES);
  const ramAlts = (rb?.ram ? a.rams.filter(p => p.id !== rb.ram.id) : a.rams).slice(0, N_ALTERNATIVES);
  const stoAlts = (rb?.sto ? a.storages.filter(p => p.id !== rb.sto.id) : a.storages).slice(0, N_ALTERNATIVES);

  return (
    <div style={{minHeight:"100vh", background:"var(--bg)"}}>
      <div style={{maxWidth:1100, margin:"0 auto", padding:"48px 32px"}}>
        <Header />
        <CurrentSystemCard specs={specs} analysis={a} />
        {a.refresh.refresh && <PlatformRefreshAlert reason={a.refresh.reason} />}
        <RecommendedBuildBanner budget={a.budget} build={rb} />
        {a.bottleneck && <BottleneckAnalysisCard bn={a.bottleneck} />}
        <PSUWarning watts={a.psuWattsNeeded} />

        <UpgradeSection title="GPU" color="#4ADE80" icon="🟢"
          selected={rb?.gpu} alternatives={gpuAlts} baseline={a.currentGPU}
          emptyMsg="No GPU upgrades within budget offer 10%+ improvement over your current card."/>

        <UpgradeSection title="CPU" color="#F87171" icon="🔴"
          selected={rb?.cpu} alternatives={cpuAlts} baseline={a.currentCPU}
          description={a.currentCPU?.socket ? `Filtered to ${a.currentCPU.socket}-compatible CPUs.` : null}
          emptyMsg="No same-socket CPU upgrades within budget offer 10%+ improvement."/>

        {rb?.cpu && a.coolerNeeded && a.coolerRecs.length > 0 && (
          <CoolerAddOnSection newCpu={rb.cpu} coolers={a.coolerRecs}
            userCoolerType={a.userCoolerType} userCoolerCapacity={a.userCoolerCapacity} requiredTDP={a.requiredTDP}/>
        )}

        {rb?.cpu && !a.coolerNeeded && a.userCoolerType !== "unknown" && (
          <CoolerOkBanner userCoolerType={a.userCoolerType} newCpu={rb.cpu} userCoolerCapacity={a.userCoolerCapacity}/>
        )}

        {a.platformSwap && <PlatformSwapCard swap={a.platformSwap} currentBrand={a.currentCPU?.brand}/>}

        <UpgradeSection title="RAM" color="#FFB020" icon="⚡"
          selected={rb?.ram} alternatives={ramAlts}
          description={allSlotsFilled
            ? `All ${specs.ram_total_slots} slots are filled — only showing ${specs.ram_sticks}-stick kits.`
            : `Faster RAM improves CPU-bound games.`}
          warning={`RAM must match your motherboard's supported type (${specs.ram_type}).`}
          emptyMsg={allSlotsFilled
            ? `No faster ${specs.ram_type} ${specs.ram_sticks}-stick kits at ≥${specs.ram_total}GB within budget.`
            : "No faster RAM kits found within budget."}/>

        {a.storageWant > 0 && (
          <UpgradeSection title="Storage" color="#C084FC" icon="💾"
            selected={rb?.sto} alternatives={stoAlts}
            description={`You asked for ${a.storageWant >= 1000 ? (a.storageWant/1000)+"TB" : a.storageWant+"GB"} ${a.storageType}.`}
            warning={a.storageType !== "HDD" ? "Your motherboard needs a free M.2 slot." : null}
            emptyMsg={`No matching storage within budget.`}/>
        )}
      </div>
    </div>
  );
}

// ─── UI SUB-COMPONENTS ──────────────────────────────────────────────
function Header() {
  return (
    <div style={{marginBottom:32, textAlign:"center"}}>
      <h1 style={{fontFamily:"var(--ff)", fontSize:36, fontWeight:800, color:"var(--txt)", margin:"0 0 8px"}}>Your Upgrade Path</h1>
      <p style={{fontFamily:"var(--ff)", fontSize:15, color:"var(--dim)", margin:0}}>Based on your current hardware, here are the best upgrades for performance and value.</p>
    </div>
  );
}

function CurrentSystemCard({specs, analysis}) {
  const disks = [];
  for (let i = 0; i < 4; i++) {
    if (specs[`disk${i}_model`]) disks.push({ model: specs[`disk${i}_model`], size: specs[`disk${i}_size`], type: specs[`disk${i}_type`] });
  }
  return (
    <div style={{background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:24, marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:14}}>
        <span style={{fontSize:16}}>🖥️</span>
        <div style={{fontFamily:"var(--ff)", fontSize:16, fontWeight:700, color:"var(--txt)"}}>Your Current System</div>
      </div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:12}}>
        <SpecRow label="CPU" value={specs.cpu} detail={`${specs.cpu_cores}C/${specs.cpu_threads}T · ${specs.cpu_clock} GHz`} color="var(--sky, #38BDF8)" bench={analysis.currentCPU?.bench}/>
        <SpecRow label="GPU" value={specs.gpu} detail={`${specs.gpu_vram} GB VRAM`} color="#4ADE80" bench={analysis.currentGPU?.bench}/>
        <SpecRow label="RAM" value={`${specs.ram_total}GB ${specs.ram_type}`} detail={`${specs.ram_speed}MHz · ${specs.ram_sticks} sticks · ${specs.ram_used_slots}/${specs.ram_total_slots} slots`} color="#FFB020"/>
        <SpecRow label="Motherboard" value={specs.mobo} detail={specs.mobo_mfr} color="#9090A0"/>
      </div>
      {disks.length > 0 && (
        <div style={{marginTop:16, paddingTop:14, borderTop:"1px solid var(--bdr)"}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, marginBottom:8, letterSpacing:1.5}}>STORAGE</div>
          <div style={{display:"flex", flexWrap:"wrap", gap:8}}>
            {disks.map((d, i) => (
              <div key={i} style={{background:"var(--bg3)", padding:"6px 12px", borderRadius:6, fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)"}}>
                <span style={{color:"var(--txt)", fontWeight:600}}>{d.model}</span> · {d.size}GB · {d.type}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SpecRow({label, value, detail, color, bench}) {
  return (
    <div style={{background:"var(--bg3)", borderRadius:8, padding:"10px 14px"}}>
      <div style={{fontFamily:"var(--mono)", fontSize:9, color, fontWeight:700, letterSpacing:1, marginBottom:3}}>{label}</div>
      <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:600, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{value}</div>
      <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", marginTop:2}}>{detail}{bench != null && <> · <span style={{color:"var(--accent)"}}>bench {bench}</span></>}</div>
    </div>
  );
}

function PlatformRefreshAlert({reason}) {
  return (
    <div style={{background:"rgba(255,176,32,.1)", border:"1px solid #FFB020", borderRadius:12, padding:"14px 18px", marginBottom:20, display:"flex", gap:10, alignItems:"flex-start"}}>
      <span style={{fontSize:18}}>⚠️</span>
      <div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:700, color:"var(--txt)", marginBottom:3}}>Platform Refresh Required</div>
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>{reason}. Upgrade will include a new motherboard and RAM.</div>
      </div>
    </div>
  );
}

function RecommendedBuildBanner({budget, build}) {
  const cost = build?.cost || 0;
  const over = cost > budget;
  const overPct = budget > 0 ? ((cost - budget) / budget) * 100 : 0;
  const unused = budget - cost;
  return (
    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"16px 20px", marginBottom:20}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:12}}>
        <div>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>YOUR BUDGET</div>
          <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color:"var(--accent)"}}>${budget.toLocaleString()}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>RECOMMENDED BUILD TOTAL</div>
          <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color: over ? "#FFB020" : "var(--txt)"}}>
            ${cost.toLocaleString()}
            {over && <span style={{fontSize:12, marginLeft:8, fontWeight:600}}>(+{overPct.toFixed(0)}% over)</span>}
            {!over && unused > 50 && <span style={{fontSize:12, marginLeft:8, fontWeight:500, color:"var(--dim)"}}>(${unused.toLocaleString()} unused)</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function BottleneckAnalysisCard({bn}) {
  const color = bn.who === "CPU" ? "#F87171" : bn.who === "GPU" ? "#4ADE80" : "#FFB020";
  return (
    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"16px 20px", marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
        <span style={{fontSize:16}}>🔬</span>
        <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)"}}>Bottleneck Analysis</div>
      </div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16, flexWrap:"wrap"}}>
        <div style={{flex:1, minWidth:240}}>
          <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color, marginBottom:4}}>{bn.text}</div>
          <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>{bn.detail}</div>
        </div>
        {bn.who !== "Balanced" && (
          <div style={{background:"rgba(255,176,32,.1)", border:"1px solid #FFB020", borderRadius:6, padding:"6px 10px", fontFamily:"var(--mono)", fontSize:11, color:"#FFB020", fontWeight:700, whiteSpace:"nowrap"}}>
            {bn.who} Limited · {bn.severity}%
          </div>
        )}
      </div>
    </div>
  );
}

function PSUWarning({watts}) {
  return (
    <div style={{background:"rgba(255,138,61,.06)", border:"1px solid var(--accent)", borderRadius:12, padding:"14px 18px", marginBottom:20, display:"flex", gap:10, alignItems:"flex-start"}}>
      <span style={{fontSize:18}}>⚡</span>
      <div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:700, color:"var(--accent)", marginBottom:3}}>Check Your Power Supply Before Upgrading</div>
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>
          Look at the label on your PSU for the wattage rating. Your upgraded system will need at least <strong style={{color:"var(--txt)"}}>{watts}W</strong>. If your PSU doesn't have enough power, you'll need to upgrade it too.
        </div>
      </div>
    </div>
  );
}

function UpgradeSection({title, color, icon, selected, alternatives, baseline, description, warning, emptyMsg}) {
  if (!selected && (!alternatives || alternatives.length === 0)) {
    return (
      <div style={{background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:20, marginBottom:20}}>
        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6}}>
          <span style={{fontSize:16}}>{icon}</span>
          <div style={{fontFamily:"var(--ff)", fontSize:18, fontWeight:700, color:"var(--txt)"}}>{title}</div>
        </div>
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", fontStyle:"italic", padding:"12px 0"}}>{emptyMsg}</div>
      </div>
    );
  }
  return (
    <div style={{background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:20, marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6}}>
        <span style={{fontSize:16}}>{icon}</span>
        <div style={{fontFamily:"var(--ff)", fontSize:18, fontWeight:700, color:"var(--txt)"}}>{title}</div>
      </div>
      {description && <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5, marginBottom:12}}>{description}</div>}
      {warning && (
        <div style={{fontFamily:"var(--ff)", fontSize:11, color:"#FFB020", marginBottom:12, display:"flex", gap:6, alignItems:"flex-start"}}>
          <span>⚠️</span><span>{warning}</span>
        </div>
      )}
      {selected && (
        <div style={{marginBottom:12}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)", fontWeight:700, marginBottom:6, letterSpacing:1.5}}>RECOMMENDED</div>
          <UpgradeRow part={selected} color={color} baseline={baseline} highlighted={true}/>
        </div>
      )}
      {alternatives && alternatives.length > 0 && (
        <>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, marginTop:selected ? 14 : 0, marginBottom:6, letterSpacing:1.5}}>OTHER OPTIONS</div>
          <div style={{display:"flex", flexDirection:"column", gap:6}}>
            {alternatives.map((p, i) => <UpgradeRow key={p.id || i} part={p} color={color} baseline={baseline}/>)}
          </div>
        </>
      )}
    </div>
  );
}

function UpgradeRow({part, color, baseline, highlighted}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  const improvement = (baseline?.bench != null && baseline.bench > 0 && part.bench != null)
    ? Math.round(((part.bench - baseline.bench) / baseline.bench) * 100) : null;
  const rowStyle = highlighted
    ? {background:"var(--bg3)", borderRadius:10, padding:"14px 16px", display:"flex", alignItems:"center", gap:14, borderLeft:`4px solid ${color}`, boxShadow:`0 0 0 1px ${color}40`}
    : {background:"var(--bg3)", borderRadius:8, padding:"10px 14px", display:"flex", alignItems:"center", gap:12, borderLeft:`2px solid ${color}80`, opacity:0.85};
  const nameStyle = highlighted
    ? {fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}
    : {fontFamily:"var(--ff)", fontSize:13, fontWeight:600, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"};
  const priceStyle = highlighted
    ? {fontFamily:"var(--ff)", fontSize:20, fontWeight:800, color:"var(--accent)"}
    : {fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--accent)"};
  return (
    <div style={rowStyle}>
      <div style={{flex:1, minWidth:0}}>
        <div style={nameStyle}>{part.n}</div>
        <div style={{display:"flex", gap:10, marginTop:3, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", flexWrap:"wrap"}}>
          {part.cap != null && <span>{part.cap >= 1000 ? (part.cap/1000)+"TB" : part.cap+"GB"}</span>}
          {part.sticks != null && <span>{part.sticks}×{part.cap ? Math.round(part.cap/part.sticks)+"GB" : ""}</span>}
          {part.speed && <span>{part.speed}MHz</span>}
          {part.socket && <span>{part.socket}</span>}
          {part.tdp && <span>{part.tdp}W</span>}
          {part.bench != null && <span>bench {part.bench}</span>}
          {improvement != null && improvement > 0 && <span style={{color:"var(--accent)", fontWeight:700}}>+{improvement}% faster</span>}
        </div>
      </div>
      <div style={{textAlign:"right", flexShrink:0}}>
        <div style={priceStyle}>${price}</div>
        {retailer && (
          <a href={retailer.url} target="_blank" rel="noopener noreferrer"
             style={{display:"inline-block", marginTop:4, padding: highlighted ? "6px 14px" : "4px 10px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:6, fontFamily:"var(--ff)", fontSize: highlighted ? 11 : 10, fontWeight:700}}>
            Buy on {retailer.name} →
          </a>
        )}
      </div>
    </div>
  );
}

// Cooler add-on shown when user's current cooler can't handle the new CPU
function CoolerAddOnSection({newCpu, coolers, userCoolerType, userCoolerCapacity, requiredTDP}) {
  const userLabel = COOLER_LABELS[userCoolerType] || "your current cooler";
  const capacityText = userCoolerCapacity > 0 ? `${userCoolerCapacity}W` : "unknown capacity";
  return (
    <div style={{background:"rgba(56,189,248,.06)", border:"1px solid var(--sky, #38BDF8)", borderRadius:12, padding:18, marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
        <span style={{fontSize:16}}>❄️</span>
        <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)"}}>CPU Cooler — Add-On (Not In Budget)</div>
      </div>
      <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.6, marginBottom:14}}>
        The recommended <strong style={{color:"var(--txt)"}}>{newCpu.n}</strong> has a <strong style={{color:"var(--txt)"}}>{newCpu.tdp}W TDP</strong> and needs a cooler rated for at least <strong style={{color:"var(--txt)"}}>{requiredTDP}W</strong> with safety margin. {userCoolerType !== "unknown" ? <>Since you told us you have {userLabel} ({capacityText} capacity), you'll need a new cooler.</> : <>Since we don't know what cooler you have, here are safe options.</>} These coolers are <strong style={{color:"var(--accent)"}}>separate from your main build budget</strong>.
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:6}}>
        {coolers.map((rec, i) => <CoolerRow key={rec.cooler.id || i} rec={rec}/>)}
      </div>
    </div>
  );
}

// Confirmation banner when user's existing cooler is sufficient
function CoolerOkBanner({userCoolerType, newCpu, userCoolerCapacity}) {
  const userLabel = COOLER_LABELS[userCoolerType] || "your current cooler";
  return (
    <div style={{background:"rgba(74,222,128,.06)", border:"1px solid #4ADE80", borderRadius:12, padding:"14px 18px", marginBottom:20, display:"flex", gap:10, alignItems:"flex-start"}}>
      <span style={{fontSize:18}}>✓</span>
      <div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:700, color:"#4ADE80", marginBottom:3}}>Your Cooler Is Good to Go</div>
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>
          {userLabel} (up to {userCoolerCapacity}W) can handle the recommended <strong style={{color:"var(--txt)"}}>{newCpu.n}</strong> ({newCpu.tdp}W). No cooler upgrade needed.
        </div>
      </div>
    </div>
  );
}

function CoolerRow({rec}) {
  const { cooler, tier } = rec;
  const price = bestPrice(cooler);
  const retailer = retailerUrl(cooler);
  const tierLabel = COOLER_TIER_LABELS[tier] || "Cooler";
  return (
    <div style={{background:"var(--bg3)", borderRadius:8, padding:"10px 14px", display:"flex", alignItems:"center", gap:12}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{display:"flex", gap:8, alignItems:"center", marginBottom:2}}>
          <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--sky, #38BDF8)", fontWeight:700, letterSpacing:1, padding:"2px 6px", background:"rgba(56,189,248,0.12)", borderRadius:4}}>{tierLabel}</span>
        </div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:600, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{cooler.n}</div>
        <div style={{display:"flex", gap:10, marginTop:2, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", flexWrap:"wrap"}}>
          {cooler.tdp_rating && <span>rated {cooler.tdp_rating}W</span>}
          {cooler.noise && <span>{cooler.noise} dBA</span>}
          {cooler.height && <span>{cooler.height}mm tall</span>}
        </div>
      </div>
      <div style={{textAlign:"right", flexShrink:0}}>
        <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--accent)"}}>${price}</div>
        {retailer && (
          <a href={retailer.url} target="_blank" rel="noopener noreferrer"
             style={{display:"inline-block", marginTop:4, padding:"4px 10px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:6, fontFamily:"var(--ff)", fontSize:10, fontWeight:700}}>
            Buy on {retailer.name} →
          </a>
        )}
      </div>
    </div>
  );
}

function PlatformSwapCard({swap, currentBrand}) {
  return (
    <div style={{background:"rgba(56,189,248,.06)", border:"1px solid var(--sky, #38BDF8)", borderRadius:12, padding:18, marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
        <span style={{fontSize:16}}>🔄</span>
        <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)"}}>Platform Swap — Bigger Jump</div>
      </div>
      <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5, marginBottom:14}}>
        Switching from {currentBrand === "Intel" ? "Intel" : "AMD"} to the {swap.socket} platform gives you better performance-per-dollar than staying on your current socket. This requires a new CPU, motherboard, and RAM.
      </div>
      <div style={{display:"flex", flexDirection:"column", gap:6, marginBottom:12}}>
        <SwapLine label="CPU" part={swap.cpu} />
        <SwapLine label="Motherboard" part={swap.mobo} />
        <SwapLine label="RAM" part={swap.ram} />
      </div>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", paddingTop:10, borderTop:"1px solid var(--bdr)"}}>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:600, color:"var(--dim)"}}>Platform swap total</div>
        <div style={{fontFamily:"var(--ff)", fontSize:20, fontWeight:800, color:"var(--accent)"}}>${swap.total.toLocaleString()}</div>
      </div>
    </div>
  );
}

function SwapLine({label, part}) {
  const retailer = retailerUrl(part);
  return (
    <div style={{background:"var(--bg3)", borderRadius:6, padding:"8px 12px", display:"flex", alignItems:"center", gap:10}}>
      <div style={{minWidth:90, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:700}}>{label.toUpperCase()}</div>
      <div style={{flex:1, minWidth:0, fontFamily:"var(--ff)", fontSize:12, fontWeight:600, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{part.n}</div>
      <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--accent)"}}>${bestPrice(part)}</div>
      {retailer && <a href={retailer.url} target="_blank" rel="noopener noreferrer" style={{fontFamily:"var(--ff)", fontSize:10, color:"var(--accent)", textDecoration:"none", whiteSpace:"nowrap"}}>Buy →</a>}
    </div>
  );
}

function MissingSpecsView() {
  return (
    <div style={{minHeight:"60vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40, textAlign:"center"}}>
      <h2 style={{fontFamily:"var(--ff)", fontSize:24, color:"var(--txt)", marginBottom:12}}>No scan data found</h2>
      <p style={{fontFamily:"var(--ff)", fontSize:14, color:"var(--dim)", maxWidth:480, lineHeight:1.6, marginBottom:24}}>
        This page shows personalized upgrade recommendations based on your PC's hardware.
        Download the Pro Rig Scanner to get started.
      </p>
      <a href="/downloads/ProRigScanner.exe"
         style={{padding:"12px 24px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:10, fontFamily:"var(--ff)", fontSize:14, fontWeight:700}}>
        Download Pro Rig Scanner →
      </a>
    </div>
  );
}
