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
// Lazy parts: PARTS starts empty and grows as category chunks arrive.
// UpgradePage always needs the full catalog, so the component calls
// loadAllParts() in a useEffect and re-renders via subscribeToParts.
// The analysis useMemo includes partsRev in its deps so it re-runs when
// new categories land.
import { PARTS as RAW_PARTS, loadAllParts, subscribe as subscribeToParts } from "./data/parts-frontend.js";
import GAMING_TIERS from "../gaming-cpu-tiers.json";

const isWorkstationGPU = (p) => {
  if (p.c !== "GPU") return false;
  if (p.segment === "server" || p.segment === "workstation") return true;
  const n = (p.n || "").toUpperCase();
  if (/\b(QUADRO|TESLA|RTX\s*A\d{4}|NVIDIA\s*A\d+\b|RADEON\s*PRO\s*W|FIREPRO)\b/.test(n)) return true;
  return false;
};

// PARTS is a derived view of RAW_PARTS. Re-derived whenever a new category
// chunk lands so all the helper functions below (candidateGPUs, etc.) see
// the fresh data on the next render.
let PARTS = RAW_PARTS.filter(p => !p.needsReview && !isWorkstationGPU(p));
let partsRev = 0;
subscribeToParts(() => {
  PARTS = RAW_PARTS.filter(p => !p.needsReview && !isWorkstationGPU(p));
  partsRev++;
});

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
    // Path routing: ?specs=... lives in the query string now (was in hash before)
    const queryParams = new URLSearchParams(window.location.search);
    const hashAfterQ  = window.location.hash.split("?")[1] || "";
    const hashParams  = new URLSearchParams(hashAfterQ);
    const raw = queryParams.get("specs") || hashParams.get("specs");
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
  // Intel desktop model numbering: generation = digits before the final 3.
  //   4-digit  i5-7500  -> 7    (7500 / 1000 = 7)
  //   5-digit  i7-14700 -> 14   (14700 / 1000 = 14)
  // 3-digit bare numbers (Core Ultra 245/265) are Series 2 on LGA1851; treat as gen 15.
  if (num >= 1000) return Math.floor(num / 1000);
  if (num >= 100)  return 15;  // Core Ultra Series 2 (e.g. 245K, 265K)
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
// LGA1700 uniquely supports BOTH DDR4 and DDR5 (board-dependent). All other
// modern sockets are single-type. Returns the list of DDR types to try.
function socketDDRTypes(socket) {
  if (socket === "LGA1700") return ["DDR4", "DDR5"];
  const single = socketToDDR(socket);
  return single ? [single] : ["DDR5"];
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
  "HD GRAPHICS": 1, "UHD GRAPHICS": 2, "IRIS XE": 4, "IRIS PLUS": 3, "IRIS": 3, "RADEON GRAPHICS": 6, "VEGA": 8, "RADEON VEGA": 8,
};

const CPU_BASELINE_INTEL = {
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
};

const CPU_BASELINE_AMD = {
  "1600": 12, "1700": 14, "1800X": 16, "1600X": 13,
  "2600": 15, "2700": 18, "2700X": 20,
  "3600": 22, "3700X": 28, "3800X": 30, "3900X": 38, "3950X": 45,
  "5600": 28, "5600X": 31, "5700X": 36, "5800X": 39, "5800X3D": 72,
  "5900X": 48, "5950X": 56,
  "7600": 38, "7600X": 40, "7700": 48, "7700X": 51, "7800X3D": 70,
  "7900": 68, "7900X": 73, "7950X": 89, "7950X3D": 88,
  "9600X": 45, "9700X": 53, "9800X3D": 80, "9900X": 78, "9900X3D": 85,
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
function lookupCPUBaseline(model, brand) {
  if (!model) return null;
  const m = model.toUpperCase();
  const b = (brand || "").toUpperCase();
  const table = (b.includes("AMD") || b.includes("RYZEN")) ? CPU_BASELINE_AMD : CPU_BASELINE_INTEL;
  let bestKey = null;
  for (const key of Object.keys(table)) {
    if ((m.startsWith(key) || m === key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? { bench: table[bestKey], name: bestKey } : null;
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
      // Brand-scoped match. Bare model-number substring search collides cross-brand
      // (Intel i5-7500 vs AMD Ryzen 5 7500F both contain "7500"). Require same brand
      // AND a word-boundary model token before trusting a catalog hit.
      const wantIntel = cpu.brand === "Intel";
      const wantAMD   = cpu.brand === "AMD";
      const modelRe = new RegExp("(?:^|[^0-9A-Z])" + cpu.model + "(?:[^0-9A-Z]|$)");
      const hit = pool.find(p => {
        if (p.bench == null) return false;
        const N = p.n.toUpperCase();
        const isIntel = /\bINTEL\b|\bCORE\b|\bI[3579]-/.test(N);
        const isAMD   = /\bAMD\b|\bRYZEN\b/.test(N);
        if (wantIntel && !isIntel) return false;
        if (wantAMD && !isAMD) return false;
        return modelRe.test(N);
      });
      if (hit) return hit;
      const b = lookupCPUBaseline(cpu.model, cpu.brand);
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
  if (!p?.deals || typeof p.deals !== 'object') return null;
  const labels = { amazon: 'Amazon', bestbuy: 'Best Buy', newegg: 'Newegg', bhphoto: 'B&H', antonline: 'Antonline' };
  const candidates = Object.entries(p.deals)
    .filter(([k,v]) => v && typeof v === 'object' && (v.url || v.linkurl) && (v.price || v.saleprice))
    .map(([k,v]) => {
      const url = v.url || v.linkurl;
      const price = v.saleprice && Number(v.saleprice) > 0 ? Number(v.saleprice) : Number(v.price);
      const inStock = v.inStock !== false;
      return { url, price, inStock, name: labels[k] || (k.charAt(0).toUpperCase() + k.slice(1)) };
    })
    .filter(r => r.url && r.price > 0);
  if (!candidates.length) return null;
  candidates.sort((a,b) => (b.inStock - a.inStock) || (a.price - b.price));
  return { url: candidates[0].url, name: candidates[0].name };
}

// ─── PLATFORM REFRESH ───────────────────────────────────────────────
function needsPlatformRefresh(currentCPU, cpuModel, rawSocket) {
  // Known dead/obsolete sockets => refresh REGARDLESS of whether we can parse the CPU
  // model (FX, Phenom, Athlon, old Core2 often fail model extraction but are clearly dead).
  if (rawSocket && /^AM[123]$|^FM[12]$|^939|^754|^AM3\+|^LGA77[156]$|^LGA1366$|^LGA115[56]$/.test(rawSocket)) {
    return { refresh: true, reason: `${rawSocket} socket is obsolete — a modern platform is needed` };
  }
  if (!cpuModel) return { refresh: false };
  if (cpuModel.brand === "Intel") {
    const gen = intelGeneration(cpuModel.model);
    if (gen && gen < 8) return { refresh: true, reason: `Intel ${gen}th gen is outdated — newer socket required` };
    if (gen === 8 || gen === 9) {
      const has = PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1151" && p.bench != null);
      if (!has) return { refresh: true, reason: `LGA1151 has no upgrade path in our catalog` };
    }
    if (gen === 10 || gen === 11) {
      // Require a meaningful upgrade (15%+ bench gain over current)
      const currBench = currentCPU?.bench || 0;
      const has = currBench > 0
        ? PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1200" && p.bench != null && p.bench >= currBench * 1.15)
        : PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1200" && p.bench != null);
      if (!has) return { refresh: true, reason: `LGA1200 has no meaningful upgrade path — LGA1700 or LGA1851 recommended` };
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

// --- Gaming-aware CPU scoring -------------------------------------
// gamingScore: looks up a CPU's gaming-performance index (0-100) from
// the curated gaming tier table. Falls back to PassMark bench when the
// CPU is not in the table (Threadrippers, Xeons, obscure OEM chips).
function gamingScore(cpu) {
  if (!cpu) return 0;
  const name = (cpu.n || "").toUpperCase();
  for (const [model, score] of Object.entries(GAMING_TIERS)) {
    if (name.includes(model.toUpperCase())) return score;
  }
  return cpu.bench || 0;
}
// cpuScoreForUseCase: gaming -> gaming index; else -> PassMark bench.
function cpuScoreForUseCase(cpu, useCase) {
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

function candidateCPUs(currentCPU, maxPrice, useCase) {
  if (!currentCPU?.bench || !currentCPU.socket) return [];
  const currentScore = cpuScoreForUseCase(currentCPU, useCase);
  const target = currentScore * (1 + MIN_IMPROVEMENT);
  const pool = PARTS.filter(p => {
    if (p.c !== "CPU" || p.bundle) return false;
    if (p.bench == null) return false;
    if (p.socket !== currentCPU.socket) return false;
    const pScore = cpuScoreForUseCase(p, useCase);
    if (pScore < target) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    return true;
  });
  pool.sort((a, b) => (cpuScoreForUseCase(b, useCase) / bestPrice(b)) - (cpuScoreForUseCase(a, useCase) / bestPrice(a)));
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

// Desktop builds require DIMM/UDIMM modules. Laptop SODIMM / SO-DIMM memory is
// physically incompatible with desktop motherboards, so exclude it everywhere.
function isDesktopRAM(p) {
  const n = p.n || "";
  // Reject laptop SODIMM.
  if (/\bSO-?DIMM\b|\blaptop\b|\bnotebook\b/i.test(n)) return false;
  // Reject server/workstation memory: Registered (RDIMM), Load-Reduced (LRDIMM), "Server".
  if (/\bR-?DIMM\b|\bLR-?DIMM\b|REGISTERED|\bSERVER\b/i.test(n)) return false;
  // Reject true ECC — but KEEP consumer "Non-ECC" kits (negative lookbehind for "non-").
  if (/(?<!NON-?)\bECC\b/i.test(n)) return false;
  return true;
}

function candidateRAMs(specs, maxPrice) {
  const currentSticks = parseInt(specs.ram_sticks) || 0;
  const currentUsed   = parseInt(specs.ram_used_slots) || currentSticks;
  const currentTotal  = parseInt(specs.ram_total_slots) || currentSticks;
  const currentCapGB  = parseInt(specs.ram_total) || 0;
  const currentSpeed  = parseInt(specs.ram_speed) || 0;
  const currentType   = specs.ram_type || "";
  const emptySlots = Math.max(0, currentTotal - currentUsed);

  const pool = PARTS.filter(p => {
    if (p.c !== "RAM" || p.bundle) return false;
    if (!isDesktopRAM(p)) return false;  // no laptop SODIMM in desktop builds
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;

    // DDR type must match
    const nameDdr = /DDR5/i.test(p.n) ? "DDR5" : /DDR4/i.test(p.n) ? "DDR4" : null;
    const partType = p.ramType || nameDdr;
    if (currentType && partType && partType !== currentType) return false;

    // Total capacity must be at least current
    if (p.cap != null && p.cap < currentCapGB) return false;

    // Stick count rules — core compatibility logic.
    // Reject items where we can't verify stick count since slot fit matters.
    if (p.sticks == null) return false;

    const kitSticks = p.sticks;

    // CASE A: Additive — kit fits in empty slots alongside existing sticks.
    // Works only if speeds match (mixing speeds = slower stick wins, often unstable).
    const isAdditive = kitSticks <= emptySlots;
    const speedMatches = currentSpeed > 0 && p.speed != null && p.speed === currentSpeed;

    // CASE B: Replacement — kit fills enough slots to replace the current setup.
    // Must be strictly faster than current (otherwise it's not an upgrade).
    // Kit stick count must be ≥ currentUsed (so user isn't losing capacity
    // from populated channels) and ≤ currentTotal (can't exceed slots).
    const isReplacement =
      kitSticks >= currentUsed &&
      kitSticks <= currentTotal &&
      p.speed != null && currentSpeed > 0 && p.speed > currentSpeed;

    if (isAdditive && speedMatches) return true;
    if (isReplacement) return true;
    return false;
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

// Map the user's motherboard string to the PCIe generation we can safely assume
// for an NVMe drive on that board. CONSERVATIVE by design: a board "supports
// Gen5" only if every SKU on that chipset guarantees a Gen5 M.2 slot; if it's
// per-board (e.g. Z890, X670, B650), we floor to Gen4 so we never recommend an
// unusable Gen5 drive on a Gen4-only motherboard. Default Gen3 on any unknown
// or OEM string (Dell/HP/Lenovo) — same principle: never overpay.
function inferMoboGen(moboStr) {
  if (!moboStr || typeof moboStr !== "string") return 3;
  const s = moboStr.toUpperCase();
  // Gen4 chipsets — modern AM4/AM5 and recent Intel platforms (conservative floor)
  // Trailing letter is optional ("B650" / "B650M" / "B650E" / "B650M-A") — a
  // simple \b boundary won't match because the next char is a word char.
  const hit = (pat) => new RegExp("\\b(?:" + pat + ")[A-Z]?\\b").test(s);
  if (hit("B550|X570")) return 4;
  if (hit("A620|B650|X670|B850")) return 4;
  if (hit("H510|B560|H570|Z590")) return 4;
  if (hit("B660|H670|Z690|B760|H770|Z790")) return 4;
  if (hit("B860|Z890")) return 4;
  // Gen3 chipsets — older AM4, all LGA1151/1200 entry, and AM5 B840
  if (hit("A320|B350|X370|B450|X470|A520")) return 3;
  if (hit("B840")) return 3;
  if (hit("H110|B150|H170|Z170|B250|H270|Z270")) return 3;
  if (hit("H310|B360|B365|H370|Z370|Z390")) return 3;
  if (hit("H410|B460|H470|Z490")) return 3;
  if (hit("H610")) return 3;
  return 3;
}

function candidateStorages(wantGB, wantType, maxPrice, moboGen = 3) {
  if (!wantGB || !wantType) return [];
  const isHDD = wantType === "HDD";
  const isSSD = wantType === "SSD";
  const isAny = wantType === "ANY" || wantType === "";

  // Raw NVMe gen detected from the product name (0 = HDD, 2 = SATA SSD).
  const nvmeGenOf = (p) => {
    const n = p.n.toUpperCase();
    if (/\bHDD\b|hard drive/i.test(p.n)) return 0;
    if (/\bGEN\s*5\b|PCIE\s*5\.?0/.test(n)) return 5;
    if (/\bGEN\s*4\b|PCIE\s*4\.?0/.test(n)) return 4;
    if (/\bGEN\s*3\b|PCIE\s*3\.?0|NVMe/.test(n)) return 3;
    if (/\bSSD\b/.test(n)) return 2;
    return 1;
  };

  const passes = (p) => {
    if (p.c !== "Storage" || p.bundle) return false;
    if (p.cap == null || p.cap < wantGB) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > maxPrice) return false;
    const isHddProduct = /\bHDD\b|hard drive/i.test(p.n);
    const isSsdProduct = /\bSSD\b|NVMe/i.test(p.n);
    if (isHDD && !isHddProduct) return false;
    if (isSSD && !isSsdProduct) return false;
    if (isAny && !isHddProduct && !isSsdProduct) return false;
    return true;
  };

  // Conservative gen cap: a drive whose NVMe gen exceeds the board's PCIe gen
  // is wasted money (it'll throttle to the board's gen anyway). Filter those
  // out first. Fall back to the unfiltered pool ONLY if the cap empties it.
  const allEligible = PARTS.filter(passes);
  const capped = allEligible.filter(p => nvmeGenOf(p) <= moboGen);
  const pool = capped.length ? capped : allEligible;

  // After the gen filter, tier-order remaining drives normally.
  const tierOf = (p) => {
    const t = nvmeGenOf(p);
    return t === 0 ? 0 : t; // HDD=0; SATA SSD=2; NVMe gen-N stays its gen
  };

  // For ANY type: rank by value-per-dollar (price/GB), with SSDs slightly favored
  // when price is comparable. Otherwise keep the original tier-first ranking.
  pool.sort((a, b) => {
    if (isAny) {
      // Best bang-for-buck: minimize price/GB first, then prefer higher tier on tie
      const ppGB_a = bestPrice(a) / a.cap;
      const ppGB_b = bestPrice(b) / b.cap;
      if (Math.abs(ppGB_a - ppGB_b) > 0.005) return ppGB_a - ppGB_b;
      return tierOf(b) - tierOf(a);
    }
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

// Universal use-case weighting. Every workload is the same scoring function with
// different CPU/GPU emphasis. Used by both the refresh-bundle optimizer and (later)
// the same-socket optimizer so behavior is identical across all use cases.
const USE_CASE_WEIGHTS = {
  gaming:       { cpu: 0.6, gpu: 1.0 },
  content:      { cpu: 1.0, gpu: 1.0 },
  ai:           { cpu: 0.9, gpu: 1.2 },
  productivity: { cpu: 1.2, gpu: 0.6 },
};
function useCaseWeights(useCase) { return USE_CASE_WEIGHTS[useCase] || { cpu: 0.8, gpu: 1.0 }; }

// VRM / power-delivery safety. Chipset tier is a reliable proxy for sustained power
// capability (manufacturers segment VRM quality by chipset). A budget board CAN boot a
// high-TDP CPU, but its VRM may overheat, throttle, and fail prematurely. So we REQUIRE
// the board chipset tier to match the CPU TDP, and adjust the build if budget forces it.
const CHIPSET_TIER = {
  // budget VRM — safe to ~65W
  A620:0, A520:0, B450:0, H110:0, H410:0, H470:0, H610:0, H810:0, H97:0,
  // mid VRM — safe to ~125W
  B550:1, B650:1, B660:1, B760:1, B840:1, B850:1, B860:1, Q670:1,
  // high VRM — handles >125W
  X570:2, X670:2, "X670E":2, X870:2, "X870E":2, Z390:2, Z490:2, Z690:2, Z790:2, Z890:2, X299:2, WRX90:2, C612:2,
};
function chipsetTier(chipset) {
  if (!chipset) return null;  // unknown => cannot verify => exclude from new builds
  const t = CHIPSET_TIER[chipset];
  return t == null ? null : t;
}
// Minimum chipset tier required to safely sustain a given CPU TDP.
function requiredTierForTDP(tdp) {
  const w = tdp || 65;
  if (w > 125) return 2;   // high-end VRM only
  if (w > 65)  return 1;   // mid or high
  return 0;                // any
}
function moboSupportsCPU(mobo, cpu) {
  const tier = chipsetTier(mobo.chipset);
  if (tier == null) return false;  // unknown chipset => not safe to recommend
  return tier >= requiredTierForTDP(cpu?.tdp);
}

// Per-use-case leftover-budget priority. After the base platform is chosen, spend
// remaining budget on the parts that actually help THIS workload, in this order.
const LEFTOVER_PRIORITY = {
  productivity: ["ram", "gpu"],          // multitasking is capacity-bound; GPU barely used
  gaming:       ["gpu", "cpu", "ram"],   // frames first
  content:      ["gpu", "cpu", "ram"],   // renders use GPU + CPU heavily
  ai:           ["gpu", "ram", "cpu"],   // GPU/VRAM first, then memory
};
// Sensible RAM capacity ceilings by use case (no 128GB for an office PC).
const RAM_CAP_CEILING = { productivity: 64, gaming: 32, content: 128, ai: 128 };
// Max share of budget a GPU may consume, by use case (keeps productivity from grabbing a gaming card).
const GPU_BUDGET_SHARE = { productivity: 0.20, gaming: 0.65, content: 0.55, ai: 0.60 };

// ─── BUILD OPTIMIZER ────────────────────────────────────────────────
// Recommended ratio: GPU bench ≤ ~3.5x CPU bench for balanced gaming.
// Past that, CPU becomes the limiting factor and GPU performance is wasted.
const MAX_GPU_CPU_BENCH_RATIO = 2.0;

// Same-socket / non-refresh build. Uses the SAME budget-filling engine as the refresh
// path: pick the best CPU & GPU within budget, then spend leftover by the use-case
// priority chain. RAM is OPTIONAL here (user keeps existing RAM unless a kit helps).
function optimizeBuild(currentGPU, currentCPU, candidates, budget) {
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
      const g = gpus.filter(x => bestPrice(x) <= budgetForGpu && bestPrice(x) <= budget * gpuShare && (!chosenGpu || x.bench > chosenGpu.bench) && x.bench > curG)
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
}

// ─── REFRESH BUNDLE ─────────────────────────────────
// Dead-end platform => user needs CPU + motherboard + RAM on a modern socket. Builds a
// complete bundle (GPU from remaining budget) for a GIVEN socket + DDR type. Null if
// the socket cannot be fully built within budget.
function buildRefreshBundleFor(currentGPU, useCase, budget, socket, ddr) {
  if (!socket || !ddr) return null;
  const maxBudget = budget * (1 + BUDGET_OVERAGE);
  const ramCeiling = RAM_CAP_CEILING[useCase] || 64;
  const gpuShare = GPU_BUDGET_SHARE[useCase] ?? 0.5;
  const priority = LEFTOVER_PRIORITY[useCase] || ["gpu", "cpu", "ram"];

  // Cheapest compatible motherboard (platform necessity).
  // Cheapest motherboard for this socket+DDR whose chipset VRM tier safely supports a given CPU.
  const cheapestSafeMobo = (cpu) => PARTS
    .filter(p => p.c === "Motherboard" && !p.bundle && p.socket === socket && p.memType === ddr && bestPrice(p) > 0 && moboSupportsCPU(p, cpu))
    .sort((a, b) => bestPrice(a) - bestPrice(b))[0] || null;
  // Provisional cheapest board ignoring CPU (used only to sanity-check the socket is buildable).
  const anyMobo = PARTS.filter(p => p.c === "Motherboard" && !p.bundle && p.socket === socket && p.memType === ddr && bestPrice(p) > 0 && chipsetTier(p.chipset) != null).sort((a,b)=>bestPrice(a)-bestPrice(b))[0];
  if (!anyMobo) return null;

  // Desktop RAM of the right DDR type. Fresh builds should run DUAL-CHANNEL (2 sticks)
  // — single-stick halves memory bandwidth. Prefer 2-stick kits; fall back to any only
  // if no 2-stick kit exists at all. Sort ascending capacity, then dual-channel, then price.
  const ramMatches = (p) => p.c === "RAM" && !p.bundle && isDesktopRAM(p) &&
    (p.ramType === ddr || new RegExp(ddr, "i").test(p.n)) && p.sticks != null &&
    (p.cap == null || p.cap >= 16) && (p.cap == null || p.cap <= ramCeiling) && bestPrice(p) > 0;
  const ramSort = (a, b) => (a.cap || 16) - (b.cap || 16) ||
    ((b.sticks >= 2 ? 1 : 0) - (a.sticks >= 2 ? 1 : 0)) ||  // dual-channel first at equal capacity
    bestPrice(a) - bestPrice(b);
  const dualKits = PARTS.filter(p => ramMatches(p) && p.sticks >= 2).sort(ramSort);
  const ramPool = dualKits.length ? dualKits : PARTS.filter(ramMatches).sort(ramSort);
  if (!ramPool.length) return null;
  const baseRam = ramPool[0];  // cheapest dual-channel entry kit

  // CPU pool on this socket (ranked by use-case score).
  const cpuPool = PARTS
    .filter(p => p.c === "CPU" && !p.bundle && p.socket === socket && p.bench != null && bestPrice(p) > 0)
    .sort((a, b) => cpuScoreForUseCase(b, useCase) - cpuScoreForUseCase(a, useCase));
  if (!cpuPool.length) return null;

  // GPU pool ranked by bench (value within share-cap applied later).
  const gpuPool = PARTS
    .filter(p => p.c === "GPU" && !p.bundle && p.bench != null && bestPrice(p) > 0)
    .sort((a, b) => b.bench - a.bench);

  const w = useCaseWeights(useCase);
  // Pick the best CPU whose cheapest VRM-SAFE board + base RAM fits the budget. cpuPool is
  // sorted best-first, so this steps DOWN to a CPU we can pair with an adequate board.
  let chosenCpu = null, chosenMobo = null;
  for (const c of cpuPool) {
    const m = cheapestSafeMobo(c);
    if (!m) continue;  // no board on this socket can safely handle this CPU TDP
    if (bestPrice(m) + bestPrice(baseRam) + bestPrice(c) <= maxBudget) { chosenCpu = c; chosenMobo = m; break; }
  }
  if (!chosenCpu || !chosenMobo) return null;
  let moboCost = bestPrice(chosenMobo);

  let chosenRam = baseRam;
  let chosenGpu = null;

  // Helper: current spend.
  const spend = () => moboCost + bestPrice(chosenCpu) + bestPrice(chosenRam) + (chosenGpu ? bestPrice(chosenGpu) : 0);

  // Allocate remaining budget by the use-case priority chain. Each step spends what it
  // can WITHOUT exceeding maxBudget; we never force a part that wastes money for the workload.
  for (const slot of priority) {
    const remaining = maxBudget - spend();
    if (remaining <= 0) break;
    if (slot === "ram") {
      // Upgrade to the largest-capacity kit that still fits (capacity helps multitasking).
      const better = ramPool.filter(r => bestPrice(r) - bestPrice(chosenRam) <= remaining && (r.cap || 0) > (chosenRam.cap || 0))
                            .sort((a, b) => (b.cap || 0) - (a.cap || 0) || bestPrice(a) - bestPrice(b))[0];
      if (better) chosenRam = better;
    } else if (slot === "cpu") {
      // Bump CPU only if a SAFE board still fits the new (possibly higher) TDP within budget.
      for (const c of cpuPool) {
        if (cpuScoreForUseCase(c, useCase) <= cpuScoreForUseCase(chosenCpu, useCase)) continue;
        const m = cheapestSafeMobo(c);
        if (!m) continue;
        const delta = (bestPrice(c) - bestPrice(chosenCpu)) + (bestPrice(m) - moboCost);
        if (delta <= remaining) { chosenCpu = c; chosenMobo = m; moboCost = bestPrice(m); break; }
      }
    } else if (slot === "gpu") {
      const gpuCap = Math.min(remaining + (chosenGpu ? bestPrice(chosenGpu) : 0), budget * gpuShare);
      const better = gpuPool.filter(g => bestPrice(g) <= gpuCap && (!chosenGpu || g.bench > chosenGpu.bench))[0];
      if (better) chosenGpu = better;
    }
  }

  const cost = spend();
  const score = cpuScoreForUseCase(chosenCpu, useCase) * w.cpu + (chosenGpu?.bench || 0) * w.gpu;
  const ppd = score / cost;
  return { gpu: chosenGpu, cpu: chosenCpu, mobo: chosenMobo, ram: chosenRam, sto: null, ddr, socket, coreTotal: moboCost + bestPrice(chosenCpu), cost, ppd, isRefresh: true, overPct: Math.max(0, (cost - budget) / budget) };
}

// Build the best bundle for a socket across ALL DDR types it supports (LGA1700 = DDR4+DDR5).
function buildRefreshBundle(currentGPU, useCase, budget, socket) {
  const variants = socketDDRTypes(socket)
    .map(ddr => buildRefreshBundleFor(currentGPU, useCase, budget, socket, ddr))
    .filter(Boolean);
  if (!variants.length) return null;
  // Best value-per-dollar variant for this socket.
  return variants.sort((a, b) => b.ppd - a.ppd)[0];
}

// Candidate refresh sockets per brand, ordered [older/value-ish, newest].
function refreshSocketsForBrand(brand) {
  if (brand === "AMD") return { all: ["AM4", "AM5"], newest: "AM5" };
  return { all: ["LGA1700", "LGA1851"], newest: "LGA1851" };  // Intel default
}

// Build BOTH a value bundle (best price/performance across sockets) and a
// futureproof bundle (newest socket). Returns {value, future, sameSocket}.
function computeRefreshPaths(currentGPU, useCase, budget, brand) {
  const { all, newest } = refreshSocketsForBrand(brand);
  const bundles = all.map(s => buildRefreshBundle(currentGPU, useCase, budget, s)).filter(Boolean);
  if (!bundles.length) return null;
  const value = bundles.slice().sort((a, b) => b.ppd - a.ppd)[0];        // best perf-per-dollar
  const future = bundles.find(b => b.socket === newest) || null;          // newest socket if buildable
  const sameSocket = !future || value.socket === future.socket;
  return { value, future, sameSocket };
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

// Practical recommended PSU minimums by GPU model.
// Sources: AMD/NVIDIA official specs, cross-referenced with real-world guides
// (Tom's Hardware, GamersNexus, PCPartPicker, overclock.net). Values include
// +~50W headroom over manufacturer "bare minimum" to safely cover transient
// power spikes and provide efficiency margin (PSUs run best at 50-80% load).
const GPU_PSU_MIN = {
  // NVIDIA RTX 50 series
  "RTX 5090": 1000, "RTX 5080": 850, "RTX 5070 TI": 750, "RTX 5070": 750,
  "RTX 5060 TI": 600, "RTX 5060": 600, "RTX 5050": 550,
  // NVIDIA RTX 40 series
  "RTX 4090": 1000, "RTX 4080 SUPER": 850, "RTX 4080": 850,
  "RTX 4070 TI SUPER": 750, "RTX 4070 TI": 750, "RTX 4070 SUPER": 750, "RTX 4070": 700,
  "RTX 4060 TI": 600, "RTX 4060": 600,
  // NVIDIA RTX 30 series
  "RTX 3090 TI": 1000, "RTX 3090": 850, "RTX 3080 TI": 850, "RTX 3080": 800,
  "RTX 3070 TI": 800, "RTX 3070": 700, "RTX 3060 TI": 650, "RTX 3060": 600, "RTX 3050": 600,
  // NVIDIA RTX 20 series
  "RTX 2080 TI": 750, "RTX 2080 SUPER": 700, "RTX 2080": 700,
  "RTX 2070 SUPER": 700, "RTX 2070": 600, "RTX 2060 SUPER": 600, "RTX 2060": 550,
  // NVIDIA GTX 16 series
  "GTX 1660 TI": 500, "GTX 1660 SUPER": 500, "GTX 1660": 500,
  "GTX 1650 SUPER": 400, "GTX 1650": 350, "GTX 1630": 350,
  // NVIDIA GTX 10 series
  "GTX 1080 TI": 650, "GTX 1080": 550, "GTX 1070 TI": 550, "GTX 1070": 550,
  "GTX 1060": 450, "GTX 1050 TI": 350, "GTX 1050": 350, "GTX 1030": 300,
  // AMD RX 7000
  "RX 7900 XTX": 900, "RX 7900 XT": 850, "RX 7900 GRE": 800,
  "RX 7800 XT": 750, "RX 7700 XT": 750, "RX 7600 XT": 600, "RX 7600": 600,
  // AMD RX 6000
  "RX 6950 XT": 900, "RX 6900 XT": 900, "RX 6800 XT": 800, "RX 6800": 700,
  "RX 6750 XT": 700, "RX 6700 XT": 700, "RX 6700": 600,
  "RX 6650 XT": 550, "RX 6600 XT": 550, "RX 6600": 500, "RX 6500 XT": 450,
  // AMD RX 5000
  "RX 5700 XT": 650, "RX 5700": 650, "RX 5600 XT": 600, "RX 5500 XT": 500,
  // AMD RX 500
  "RX 590": 550, "RX 580": 550, "RX 570": 500, "RX 560": 450, "RX 550": 400,
  // Intel Arc
  "ARC B580": 650, "ARC B570": 600, "ARC A770": 650, "ARC A750": 600,
  "ARC A580": 600, "ARC A380": 450, "ARC A310": 400,
};

function lookupGPUPSUMin(gpuName) {
  if (!gpuName) return 0;
  const n = gpuName.toUpperCase();
  let bestKey = null;
  for (const key of Object.keys(GPU_PSU_MIN)) {
    if (n.includes(key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? GPU_PSU_MIN[bestKey] : 0;
}

// Compute recommended PSU wattage accounting for:
//   1) CPU TDP (sustained draw)
//   2) GPU TDP × 1.8 (transient spikes can hit ~2x rated TDP)
//   3) 100W overhead (fans, drives, RAM, motherboard, USB)
//   4) Manufacturer-recommended minimum (whichever is higher)
// Final number rounded up to nearest 50W.
function calculatePSU(cpuTDP, gpuTDP, gpuName) {
  const cpu = cpuTDP || 100;
  const gpu = gpuTDP || 200;
  const mathBased = (gpu * 1.8) + cpu + 100;
  const roundedMath = Math.ceil(mathBased / 50) * 50;
  const manufacturerMin = lookupGPUPSUMin(gpuName);
  return Math.max(roundedMath, manufacturerMin);
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────
export default function UpgradePage() {
  const [specs, setSpecs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshPath, setRefreshPath] = useState("value");  // "value" | "future" toggle for dead-end refreshes

  useEffect(() => { setSpecs(parseSpecs()); setLoading(false); }, []);

  // Ensure the entire catalog is in memory before we run the analysis.
  // loadAllParts is idempotent so this is safe to call on every mount.
  // _bumpTick forces a re-render whenever a category chunk lands; the
  // analysis useMemo below has partsRev in its deps so it re-derives.
  const [, _bumpTick] = useState(0);
  useEffect(() => {
    loadAllParts();
    return subscribeToParts(() => _bumpTick(partsRev));
  }, []);

  const analysis = useMemo(() => {
    if (!specs) return null;

    const budget = Number(specs.budget) || 1000;
    const maxBudget = budget * (1 + BUDGET_OVERAGE);
    const currentGPU = findCatalogMatch("GPU", specs.gpu);
    const currentCPU = findCatalogMatch("CPU", specs.cpu);
    const cpuModel = extractCPUModel(specs.cpu);
    const refresh = needsPlatformRefresh(currentCPU, cpuModel, specs.cpu_socket);

    const gpus = candidateGPUs(currentGPU, maxBudget);
    const useCase = specs.use_case || "gaming";
    const cpus = candidateCPUs(currentCPU, maxBudget, useCase);
    const rams = candidateRAMs(specs, maxBudget);
    const storageWant = Number(specs.add_storage_gb) || 0;
    const storageType = specs.add_storage_type || "";
    const moboGen = inferMoboGen(specs.mobo);
    const storages = storageWant > 0 ? candidateStorages(storageWant, storageType, maxBudget, moboGen) : [];

    const recommendedBuild = optimizeBuild(currentGPU, currentCPU, { gpus, cpus, rams, storages, useCase }, budget);
    // Brand for refresh targeting: prefer parsed model brand; else infer from raw socket
    // (AM*/FM* => AMD, LGA*/Intel name => Intel) so old AMD chips get AM4/AM5, not Intel.
    const refreshBrand = cpuModel?.brand || (/^AM|^FM/.test(specs.cpu_socket || "") || /\bAMD\b|\bFX\b|\bPHENOM\b|\bATHLON\b|\bRYZEN\b/i.test(specs.cpu || "") ? "AMD" : "Intel");
    const refreshPaths = refresh.refresh ? computeRefreshPaths(currentGPU, useCase, budget, refreshBrand) : null;
    const bottleneck = analyzeBottleneck(currentCPU, currentGPU);

    const newCpuTDP = recommendedBuild?.cpu?.tdp ?? currentCPU?.tdp ?? 125;
    const newGpuTDP = recommendedBuild?.gpu?.tdp ?? currentGPU?.tdp ?? 200;
    const newGpuName = recommendedBuild?.gpu?.n ?? currentGPU?.n ?? "";
    const psuWattsNeeded = calculatePSU(newCpuTDP, newGpuTDP, newGpuName);

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
        refresh: refresh, useCase, refreshPaths: refreshPaths ? { sameSocket: refreshPaths.sameSocket, value: refreshPaths.value ? { socket: refreshPaths.value.socket, ddr: refreshPaths.value.ddr, cpu: refreshPaths.value.cpu.n, mobo: refreshPaths.value.mobo.n, ram: refreshPaths.value.ram.n, gpu: refreshPaths.value.gpu?.n || null, cost: refreshPaths.value.cost } : null, future: refreshPaths.future ? { socket: refreshPaths.future.socket, ddr: refreshPaths.future.ddr, cpu: refreshPaths.future.cpu.n, mobo: refreshPaths.future.mobo.n, ram: refreshPaths.future.ram.n, gpu: refreshPaths.future.gpu?.n || null, cost: refreshPaths.future.cost } : null } : null,
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
      recommendedBuild, refreshPaths,
      storageWant, storageType, moboGen,
    };
  }, [specs, partsRev]);

  if (loading) return <div style={{padding:40, textAlign:"center", color:"var(--dim)"}}>Loading your specs…</div>;
  if (!specs)  return <MissingSpecsView />;

  // Lite scanner omits the user-question fields (budget / add_storage_gb /
  // add_storage_type / cooler_type) — they're collected here instead. The old
  // WPF scanner always includes them, so its URLs skip this flow and render
  // exactly as before. Sentinel = budget TRULY ABSENT (undefined/null). The
  // scanners serialize every value as a string, so an old-scanner budget of 0
  // arrives as "0" (not absent) and correctly does NOT trigger questions.
  const needsQuestions = specs.budget === undefined || specs.budget === null;
  if (needsQuestions) {
    return (
      <div style={{minHeight:"100vh", background:"var(--bg)"}}>
        <div style={{maxWidth:680, margin:"0 auto", padding:"48px 32px"}}>
          <Header />
          <QuestionFlow onComplete={(ans) => setSpecs(prev => ({ ...prev, ...ans }))} />
        </div>
      </div>
    );
  }

  const a = analysis;
  // When a platform refresh applies, the recommendation IS the selected refresh bundle
  // (value vs futureproof). Otherwise use the normal same-socket optimizer build.
  const rp = a.refreshPaths;
  const selectedRefresh = rp ? (refreshPath === "future" && rp.future ? rp.future : rp.value) : null;
  const rb = selectedRefresh || a.recommendedBuild;
  const allSlotsFilled = Number(specs.ram_used_slots) >= Number(specs.ram_total_slots) && Number(specs.ram_total_slots) > 0;

  const gpuAlts = (rb?.gpu ? a.gpus.filter(p => p.id !== rb.gpu.id) : a.gpus).slice(0, N_ALTERNATIVES);
  const cpuAlts = (rb?.cpu ? a.cpus.filter(p => p.id !== rb.cpu.id) : a.cpus).slice(0, N_ALTERNATIVES);
  const ramAlts = (rb?.ram ? a.rams.filter(p => p.id !== rb.ram.id) : a.rams).slice(0, N_ALTERNATIVES);
  const stoAlts = (rb?.sto ? a.storages.filter(p => p.id !== rb.sto.id) : a.storages).slice(0, N_ALTERNATIVES);

  // Build the section list dynamically — in-build (auto-selected) items first,
  // optional (not selected by optimizer but still available) at the bottom under
  // a divider. This keeps the most actionable recommendations top-of-page.
  const gpuSection = (
    <UpgradeSection key="gpu" title="GPU" color="#4ADE80" icon="🟢"
      selected={rb?.gpu} alternatives={gpuAlts} baseline={a.currentGPU}
      effectiveCpuBench={rb?.cpu?.bench || a.currentCPU?.bench || 0} checkBottleneck={true}
      emptyMsg="No GPU upgrades within budget offer 10%+ improvement over your current card."/>
  );
  // Motherboard section is only relevant during a platform refresh (new socket).
  const moboSection = (selectedRefresh && selectedRefresh.mobo) ? (
    <MotherboardSection key="mobo" mobo={selectedRefresh.mobo} ddr={selectedRefresh.ddr} socket={selectedRefresh.socket} />
  ) : null;

  const cpuSection = (
    <UpgradeSection key="cpu" title="CPU" color="#F87171" icon="🔴"
      selected={rb?.cpu} alternatives={cpuAlts} baseline={a.currentCPU}
      description={selectedRefresh ? `New ${selectedRefresh.socket} platform CPU (your old socket has no upgrade path).` : (a.currentCPU?.socket ? `Filtered to ${a.currentCPU.socket}-compatible CPUs.` : null)}
      emptyMsg="No same-socket CPU upgrades within budget offer 10%+ improvement."/>
  );
  const ramSection = (() => {
    const used = Number(specs.ram_used_slots) || 0;
    const total = Number(specs.ram_total_slots) || 0;
    const sticks = Number(specs.ram_sticks) || 0;
    const speed = Number(specs.ram_speed) || 0;
    let descText;
    if (selectedRefresh) {
      // Fresh platform: the user gets a brand-new dual-channel kit on the new socket,
      // not an addition to their old RAM (which will not fit the new motherboard).
      const kit = selectedRefresh.ram;
      const cap = kit?.cap ? `${kit.cap}GB` : "a new";
      descText = `Your new ${selectedRefresh.socket} platform needs ${selectedRefresh.ddr} memory. We picked a ${cap} dual-channel kit sized to your budget and workload.`;
    } else if (allSlotsFilled) {
      descText = `All ${total} slots are in use. Only showing ${sticks}-stick kits that fully replace your current setup with faster RAM.`;
    } else if (used > 0 && total > used) {
      descText = `${used} of ${total} slots are used. Showing matching-speed kits (${speed}MHz) that add to your existing RAM, plus faster full-replacement kits.`;
    } else {
      descText = `Faster RAM improves CPU-bound games.`;
    }
    return (
      <UpgradeSection key="ram" title="RAM" color="#FFB020" icon="⚡"
        selected={rb?.ram} alternatives={ramAlts}
        description={descText}
        warning={selectedRefresh ? `New platform uses ${selectedRefresh.ddr}. Your old ${specs.ram_type} RAM will NOT fit the new motherboard.` : `RAM must match your motherboard\u2019s supported type (${specs.ram_type}).`}
        emptyMsg={allSlotsFilled
          ? `No faster ${specs.ram_type} ${sticks}-stick replacement kits at ≥${specs.ram_total}GB within budget.`
          : "No compatible RAM upgrade kits found within budget."}/>
    );
  })();
  const storageSection = a.storageWant > 0 ? (
    <UpgradeSection key="storage" title="Storage" color="#C084FC" icon="💾"
      selected={rb?.sto} alternatives={stoAlts}
      description={`You asked for ${a.storageWant >= 1000 ? (a.storageWant/1000)+"TB" : a.storageWant+"GB"}${a.storageType === "ANY" || a.storageType === "" ? " (any type — showing best value)" : " " + a.storageType}. Will run at your board's PCIe Gen${a.moboGen} speed.`}
      warning={a.storageType === "SSD" ? "Your motherboard needs a free M.2 slot for NVMe drives." : null}
      emptyMsg={`No matching storage within budget.`}/>
  ) : null;

  // Classify each section by whether the optimizer picked something
  const allSections = [
    { el: gpuSection, inBuild: !!rb?.gpu },
    { el: cpuSection, inBuild: !!rb?.cpu },
    ...(moboSection ? [{ el: moboSection, inBuild: true }] : []),
    { el: ramSection, inBuild: !!rb?.ram },
    ...(storageSection ? [{ el: storageSection, inBuild: !!rb?.sto }] : []),
  ];
  const inBuildSections = allSections.filter(s => s.inBuild).map(s => s.el);
  const optionalSections = allSections.filter(s => !s.inBuild).map(s => s.el);

  return (
    <div style={{minHeight:"100vh", background:"var(--bg)"}}>
      <div style={{maxWidth:1100, margin:"0 auto", padding:"48px 32px"}}>
        <Header />
        <CurrentSystemCard specs={specs} analysis={a} />
        {a.refresh.refresh && <PlatformRefreshAlert reason={a.refresh.reason} />}
        {rp && !rp.sameSocket && rp.future && (
          <RefreshPathToggle selected={refreshPath} onSelect={setRefreshPath} value={rp.value} future={rp.future} />
        )}
        {rp && rp.sameSocket && rp.value && (
          <FutureproofBadge socket={rp.value.socket} />
        )}
        <RecommendedBuildBanner budget={a.budget} build={rb} />
        {a.bottleneck && <BottleneckAnalysisCard bn={a.bottleneck} />}
        <UpgradeStrategyExplanation analysis={a}/>
        <PSUWarning watts={a.psuWattsNeeded} />

        {/* In-build sections (components auto-selected for the recommended build) */}
        {inBuildSections}

        {/* Ancillary cards that belong with the in-build components */}
        {rb?.cpu && a.coolerNeeded && a.coolerRecs.length > 0 && (
          <CoolerAddOnSection newCpu={rb.cpu} coolers={a.coolerRecs}
            userCoolerType={a.userCoolerType} userCoolerCapacity={a.userCoolerCapacity} requiredTDP={a.requiredTDP}/>
        )}
        {rb?.cpu && !a.coolerNeeded && a.userCoolerType !== "unknown" && (
          <CoolerOkBanner userCoolerType={a.userCoolerType} newCpu={rb.cpu} userCoolerCapacity={a.userCoolerCapacity}/>
        )}

        {/* Optional upgrades — not selected by the optimizer but still shown so user can browse */}
        {optionalSections.length > 0 && (
          <>
            <OptionalUpgradesDivider />
            {optionalSections}
          </>
        )}
      </div>
    </div>
  );
}

// Form-factor-aware case-fit guidance. Expansion-slot count is the most reliable
// visual signal a non-expert can check, so we lead with that.
function caseFitGuidance(ff) {
  const f = (ff || "").toUpperCase();
  if (f.includes("E-ATX")) return { label: "E-ATX", text: "This is an oversized E-ATX board. It needs a full-tower (or E-ATX-rated) case. Quick visual check: count the horizontal expansion-slot openings on the back of your PC \u2014 you need 7+ AND extra internal width. If unsure, check your case\u2019s spec page for \u201cE-ATX\u201d support before buying." };
  if (f.includes("MICRO") || f === "MATX" || f.includes("M-ATX")) return { label: "Micro-ATX", text: "This is a Micro-ATX board \u2014 it fits most mid-tower and full-size cases. Quick visual check: look at the back of your PC and count the horizontal expansion-slot openings (where cards screw in). 4 or more = this board fits. Only very small Mini-ITX cases (2 slots) are too small." };
  if (f.includes("MINI") || f === "ITX" || f.includes("MINI-ITX")) return { label: "Mini-ITX", text: "This is a tiny Mini-ITX board \u2014 it fits ANY case (mid-tower, full-tower, or small-form-factor). You cannot go wrong on size here." };
  // default ATX
  return { label: "ATX", text: "This is a standard ATX board. Quick visual check: count the horizontal expansion-slot openings on the back of your PC \u2014 a full-size case has 7. If you see 7 slots, this board fits. If you only see 4, your case is Micro-ATX and this ATX board will NOT fit \u2014 you\u2019d need a larger case or a Micro-ATX board instead." };
}

function MotherboardSection({mobo, ddr, socket}) {
  const fit = caseFitGuidance(mobo.ff);
  const price = bestPrice(mobo);
  const retailer = retailerUrl(mobo);
  return (
    <div style={{background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:20, marginBottom:20}}>
      <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:6}}>
        <span style={{fontSize:16}}>🔌</span>
        <div style={{fontFamily:"var(--ff)", fontSize:18, fontWeight:700, color:"var(--txt)"}}>Motherboard</div>
      </div>
      <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5, marginBottom:12}}>
        A new {socket} CPU needs a new {socket} motherboard. This board supports {ddr} memory (matching the RAM below).
      </div>
      <div style={{background:"var(--bg3)", borderRadius:10, padding:"12px 16px", display:"flex", alignItems:"center", gap:12, marginBottom:12}}>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:600, color:"var(--txt)"}}>{mobo.n}</div>
          <div style={{display:"flex", gap:10, marginTop:3, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", flexWrap:"wrap"}}>
            {mobo.chipset && <span>{mobo.chipset}</span>}
            {mobo.socket && <span>{mobo.socket}</span>}
            {mobo.ff && <span>{fit.label}</span>}
            {mobo.memType && <span>{mobo.memType}</span>}
          </div>
        </div>
        <div style={{textAlign:"right", flexShrink:0}}>
          <div style={{fontFamily:"var(--ff)", fontSize:16, fontWeight:800, color:"var(--accent)"}}>${price}</div>
          {retailer && <a href={retailer.url} target="_blank" rel="noopener noreferrer" style={{display:"inline-block", marginTop:4, padding:"4px 10px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:6, fontFamily:"var(--ff)", fontSize:10, fontWeight:700}}>Buy on {retailer.name} →</a>}
        </div>
      </div>
      <div style={{background:"rgba(255,176,32,.1)", border:"1px solid #FFB020", borderRadius:10, padding:"12px 14px", display:"flex", gap:10, alignItems:"flex-start"}}>
        <span style={{fontSize:16, flexShrink:0}}>⚠️</span>
        <div>
          <div style={{fontFamily:"var(--ff)", fontSize:12, fontWeight:700, color:"#FFB020", marginBottom:3}}>Check your case size — {fit.label} board</div>
          <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.55}}>{fit.text}</div>
        </div>
      </div>
    </div>
  );
}

function FutureproofBadge({socket}) {
  return (
    <div style={{marginBottom:20, display:"flex", alignItems:"center", gap:10, background:"rgba(52,211,153,.08)", border:"1px solid #34D399", borderRadius:10, padding:"12px 16px"}}>
      <span style={{fontSize:16}}>✅</span>
      <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>
        This build uses the <strong style={{color:"var(--txt)"}}>{socket}</strong> platform — the newest socket available. It’s both our <strong style={{color:"var(--txt)"}}>best price-to-performance</strong> pick AND the <strong style={{color:"var(--txt)"}}>most futureproof</strong> choice, so there’s no tradeoff to weigh here.
      </div>
    </div>
  );
}

function RefreshPathToggle({selected, onSelect, value, future}) {
  const Btn = ({id, label, sub, bundle}) => {
    const active = selected === id;
    return (
      <button onClick={() => onSelect(id)} style={{flex:1, textAlign:"left", cursor:"pointer", background: active ? "rgba(255,138,61,.1)" : "var(--bg3)", border: active ? "1px solid var(--accent)" : "1px solid var(--bdr)", borderRadius:10, padding:"12px 14px"}}>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:700, color: active ? "var(--accent)" : "var(--txt)", marginBottom:2}}>{label}</div>
        <div style={{fontFamily:"var(--ff)", fontSize:11, color:"var(--dim)", marginBottom:4}}>{sub}</div>
        <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)"}}>{bundle.socket} · {bundle.ddr} · ${bundle.cost.toLocaleString()}</div>
      </button>
    );
  };
  return (
    <div style={{marginBottom:20}}>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:700, letterSpacing:1, marginBottom:8}}>CHOOSE YOUR UPGRADE PATH</div>
      <div style={{display:"flex", gap:10}}>
        <Btn id="value" label="Best Value" sub="Most performance per dollar" bundle={value} />
        <Btn id="future" label="Futureproof" sub="Newest platform, longer upgrade runway" bundle={future} />
      </div>
    </div>
  );
}

function OptionalUpgradesDivider() {
  return (
    <div style={{margin:"30px 0 20px", display:"flex", alignItems:"center", gap:14}}>
      <div style={{flex:1, height:1, background:"var(--bdr)"}}/>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:700, letterSpacing:2}}>
        OPTIONAL UPGRADES
      </div>
      <div style={{flex:1, height:1, background:"var(--bdr)"}}/>
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

function UpgradeStrategyExplanation({analysis}) {
  const a = analysis;
  const rb = a.recommendedBuild;
  const bn = a.bottleneck;
  // Decide strategy message
  let title = null;
  let body = null;
  let color = "var(--sky, #38BDF8)";
  if (a.refresh && a.refresh.refresh) {
    // Platform refresh case handled by its own banner
    return null;
  }
  // Case 1: CPU bottleneck + recommendation only includes CPU (no GPU)
  if (bn && bn.who === "CPU" && rb && rb.cpu && !rb.gpu) {
    title = "Why we recommend a CPU upgrade only";
    body = "Your GPU is already strong enough that pairing it with a faster CPU will unlock real-world gaming performance. Spending budget on a bigger GPU right now would be wasted — your CPU can't feed it. A CPU upgrade is the most impactful use of your $" + a.budget.toLocaleString() + " budget.";
    color = "#F87171";
  }
  // Case 2: CPU bottleneck + recommendation includes GPU upgrade
  else if (bn && bn.who === "CPU" && rb && rb.gpu) {
    title = "Note: Your CPU is the bottleneck";
    body = "We've included a GPU recommendation, but be aware that your CPU is currently limiting performance. The CPU upgrade in this build will help, but if budget is tight, prioritize the CPU over the GPU for the biggest gaming gains.";
    color = "#FFB020";
  }
  // Case 3: GPU bottleneck + recommendation includes GPU
  else if (bn && bn.who === "GPU" && rb && rb.gpu) {
    title = "Why we recommend a GPU upgrade";
    body = "Your CPU has more headroom than your GPU can use. A GPU upgrade will give you the biggest performance gain, especially at higher resolutions (1440p/4K).";
    color = "#4ADE80";
  }
  // Case 4: Balanced - any upgrade works
  else if (bn && bn.who === "Balanced" && rb && (rb.gpu || rb.cpu)) {
    title = "Your system is well balanced";
    body = "Your CPU and GPU are matched well. Either upgrade will give proportional gains — we picked the best value within your budget.";
    color = "#FFB020";
  }
  if (!title) return null;
  return (
    <div style={{background:"rgba(56,189,248,0.06)", border:`1px solid ${color}`, borderRadius:12, padding:"14px 18px", marginBottom:20, display:"flex", gap:10, alignItems:"flex-start"}}>
      <span style={{fontSize:18, flexShrink:0}}>💡</span>
      <div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, fontWeight:700, color, marginBottom:4}}>{title}</div>
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", lineHeight:1.5}}>{body}</div>
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

function UpgradeSection({title, color, icon, selected, alternatives, baseline, description, warning, emptyMsg, effectiveCpuBench, checkBottleneck}) {
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
          <UpgradeRow part={selected} color={color} baseline={baseline} highlighted={true} effectiveCpuBench={effectiveCpuBench} checkBottleneck={checkBottleneck}/>
        </div>
      )}
      {alternatives && alternatives.length > 0 && (
        <>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, marginTop:selected ? 14 : 0, marginBottom:6, letterSpacing:1.5}}>OTHER OPTIONS</div>
          <div style={{display:"flex", flexDirection:"column", gap:6}}>
            {alternatives.map((p, i) => <UpgradeRow key={p.id || i} part={p} color={color} baseline={baseline} effectiveCpuBench={effectiveCpuBench} checkBottleneck={checkBottleneck}/>)}
          </div>
        </>
      )}
    </div>
  );
}

function UpgradeRow({part, color, baseline, highlighted, effectiveCpuBench, checkBottleneck}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  const improvement = (baseline?.bench != null && baseline.bench > 0 && part.bench != null)
    ? Math.round(((part.bench - baseline.bench) / baseline.bench) * 100) : null;

  // Bottleneck check (only applied to GPUs via checkBottleneck prop)
  let bottleneckSeverity = null;   // null | "mild" | "severe"
  if (checkBottleneck && part?.bench && effectiveCpuBench > 0) {
    const ratio = part.bench / effectiveCpuBench;
    if (ratio > MAX_GPU_CPU_BENCH_RATIO * 1.5) bottleneckSeverity = "severe";
    else if (ratio > MAX_GPU_CPU_BENCH_RATIO) bottleneckSeverity = "mild";
  }

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
        <div style={{display:"flex", gap:10, marginTop:3, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", flexWrap:"wrap", alignItems:"center"}}>
          {part.cap != null && <span>{part.cap >= 1000 ? (part.cap/1000)+"TB" : part.cap+"GB"}</span>}
          {part.sticks != null && <span>{part.sticks}×{part.cap ? Math.round(part.cap/part.sticks)+"GB" : ""}</span>}
          {part.speed && <span>{part.speed}MHz</span>}
          {part.socket && <span>{part.socket}</span>}
          {part.tdp && <span>{part.tdp}W</span>}
          {part.bench != null && <span>bench {part.bench}</span>}
          {improvement != null && improvement > 0 && <span style={{color:"var(--accent)", fontWeight:700}}>+{improvement}% faster</span>}
          {bottleneckSeverity === "mild" && (
            <span style={{color:"#FFB020", fontWeight:700, background:"rgba(255,176,32,.12)", padding:"2px 6px", borderRadius:4}}>
              ⚠ CPU BOTTLENECK
            </span>
          )}
          {bottleneckSeverity === "severe" && (
            <span style={{color:"#F87171", fontWeight:700, background:"rgba(248,113,113,.12)", padding:"2px 6px", borderRadius:4}}>
              ⚠ SEVERE CPU BOTTLENECK
            </span>
          )}
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
// ─── QUESTION FLOW (lite scanner) ───────────────────────────────────
// Collects the four build-context answers the lite scanner no longer gathers:
// budget, optional extra storage (size + type), and current cooler type.
// Mirrors the old WPF scanner's pages 1-3 exactly (same budget curve, same
// type-dependent storage sizes, same six cooler options). On submit it merges
// the answers into `specs` so the existing analysis runs unchanged.

// Old exe budget curve: $300–$8000, eased so low budgets get finer control.
function sliderPctToBudget(pct) {
  const t = pct / 100;
  const raw = 300 + Math.pow(t, 2.5) * (8000 - 300);
  return Math.round(raw / 25) * 25;  // snap to $25, matching the exe
}

const COOLER_OPTIONS = [
  { tag: "stock",      label: "Stock Cooler",      note: "~65W TDP capacity" },
  { tag: "budget_air", label: "Budget Air Cooler", note: "~120W TDP capacity" },
  { tag: "aio_120",    label: "120mm AIO",         note: "~150W TDP capacity" },
  { tag: "aio_240",    label: "240mm AIO",         note: "~220W TDP capacity" },
  { tag: "aio_360",    label: "360mm AIO",         note: "~300W TDP capacity" },
  { tag: "unknown",    label: "Not sure",          note: "We'll recommend options based on your new CPU" },
];

// Size lists are type-dependent, same as the exe:
//   HDD / ANY: 1/2/4/8 TB   ·   SSD: 500GB/1/2/4 TB
const STORAGE_SIZES = {
  HDD: [{ gb: 1000, label: "1 TB" }, { gb: 2000, label: "2 TB" }, { gb: 4000, label: "4 TB" }, { gb: 8000, label: "8 TB" }],
  SSD: [{ gb: 500, label: "500 GB" }, { gb: 1000, label: "1 TB" }, { gb: 2000, label: "2 TB" }, { gb: 4000, label: "4 TB" }],
  ANY: [{ gb: 1000, label: "1 TB" }, { gb: 2000, label: "2 TB" }, { gb: 4000, label: "4 TB" }, { gb: 8000, label: "8 TB" }],
};

function QFOptionCard({ active, title, sub, onClick }) {
  return (
    <button onClick={onClick} style={{flex:1, minWidth:0, textAlign:"center", cursor:"pointer",
      background: active ? "rgba(255,138,61,.1)" : "var(--bg3)",
      border: active ? "1px solid var(--accent)" : "1px solid var(--bdr)",
      borderRadius:10, padding:"12px 10px"}}>
      <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color: active ? "var(--accent)" : "var(--txt)"}}>{title}</div>
      {sub && <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", marginTop:3, lineHeight:1.4}}>{sub}</div>}
    </button>
  );
}

function QFSectionLabel({ children }) {
  return <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:700, letterSpacing:1, marginBottom:10}}>{children}</div>;
}

function QuestionFlow({ onComplete }) {
  const [sliderVal, setSliderVal]         = useState(383);  // 0-1000 raw; 383 → $1000 default
  const [storageChoice, setStorageChoice] = useState("no"); // "yes" | "no"
  const [storageType, setStorageType]     = useState(null); // "HDD" | "SSD" | "ANY"
  const [storageGB, setStorageGB]         = useState(0);
  const [coolerType, setCoolerType]       = useState(null);

  const budget = sliderPctToBudget(sliderVal / 10);  // raw 0-1000 → 0-100 pct for the curve
  const storageReady = storageChoice === "no" || (storageType && storageGB > 0);
  const canSubmit = budget > 0 && !!coolerType && storageReady;

  const pickStorageType = (t) => { setStorageType(t); setStorageGB(0); };
  const submit = () => {
    if (!canSubmit) return;
    onComplete({
      budget: String(budget),
      add_storage_gb: String(storageChoice === "yes" ? storageGB : 0),
      add_storage_type: storageChoice === "yes" ? storageType : "",
      cooler_type: coolerType,
    });
  };

  const card = { background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:24, marginBottom:20 };

  return (
    <div>
      <div style={{textAlign:"center", marginBottom:24}}>
        <p style={{fontFamily:"var(--ff)", fontSize:14, color:"var(--dim)", margin:0, lineHeight:1.6}}>
          A few quick questions so we can tailor your upgrade path to your budget and setup.
        </p>
      </div>

      {/* Q1 — BUDGET */}
      <div style={card}>
        <QFSectionLabel>YOUR UPGRADE BUDGET</QFSectionLabel>
        <div style={{fontFamily:"var(--ff)", fontSize:32, fontWeight:800, color:"var(--accent)", textAlign:"center", marginBottom:14}}>
          ${budget.toLocaleString()}
        </div>
        <input type="range" min={0} max={1000} value={sliderVal}
          onChange={(e) => setSliderVal(Number(e.target.value))}
          style={{width:"100%", accentColor:"var(--accent)", cursor:"pointer"}} />
        <div style={{display:"flex", justifyContent:"space-between", fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", marginTop:6}}>
          <span>$300</span><span>$8,000</span>
        </div>
      </div>

      {/* Q2 — EXTRA STORAGE */}
      <div style={card}>
        <QFSectionLabel>ADD STORAGE?</QFSectionLabel>
        <div style={{display:"flex", gap:10, marginBottom: storageChoice === "yes" ? 16 : 0}}>
          <QFOptionCard active={storageChoice === "yes"} title="Yes" sub="Add a new drive" onClick={() => setStorageChoice("yes")} />
          <QFOptionCard active={storageChoice === "no"}  title="No"  sub="Keep current drives" onClick={() => { setStorageChoice("no"); setStorageType(null); setStorageGB(0); }} />
        </div>

        {storageChoice === "yes" && (
          <>
            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1, margin:"4px 0 8px"}}>TYPE</div>
            <div style={{display:"flex", gap:10, marginBottom: storageType ? 16 : 0}}>
              <QFOptionCard active={storageType === "HDD"} title="HDD" sub="cheapest per TB" onClick={() => pickStorageType("HDD")} />
              <QFOptionCard active={storageType === "SSD"} title="SSD" sub="fastest" onClick={() => pickStorageType("SSD")} />
              <QFOptionCard active={storageType === "ANY"} title="Any" sub="best value" onClick={() => pickStorageType("ANY")} />
            </div>

            {storageType && (
              <>
                <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1, margin:"4px 0 8px"}}>SIZE</div>
                <div style={{display:"flex", gap:10}}>
                  {STORAGE_SIZES[storageType].map((s) => (
                    <QFOptionCard key={s.gb} active={storageGB === s.gb} title={s.label}
                      sub={storageType === "ANY" ? "any type" : storageType}
                      onClick={() => setStorageGB(s.gb)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Q3 — CPU COOLER */}
      <div style={card}>
        <QFSectionLabel>YOUR CURRENT CPU COOLER</QFSectionLabel>
        <div style={{display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:10}}>
          {COOLER_OPTIONS.map((c) => (
            <QFOptionCard key={c.tag} active={coolerType === c.tag} title={c.label} sub={c.note} onClick={() => setCoolerType(c.tag)} />
          ))}
        </div>
      </div>

      <button onClick={submit} disabled={!canSubmit}
        style={{width:"100%", padding:"14px 24px", marginTop:4,
          background: canSubmit ? "var(--accent)" : "var(--bg3)",
          color: canSubmit ? "#fff" : "var(--dim)",
          border:"none", borderRadius:10, fontFamily:"var(--ff)", fontSize:15, fontWeight:700,
          cursor: canSubmit ? "pointer" : "not-allowed"}}>
        See my upgrades →
      </button>
      {!canSubmit && (
        <div style={{textAlign:"center", fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", marginTop:10}}>
          {!coolerType ? "Select your current cooler to continue." : "Pick a storage size to continue."}
        </div>
      )}
    </div>
  );
}

function MissingSpecsView() {
  return (
    <div style={{minHeight:"60vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:40, textAlign:"center"}}>
      <h1 style={{fontFamily:"var(--ff)", fontSize:24, color:"var(--txt)", marginBottom:12}}>Your PC Upgrade Path</h1>
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
