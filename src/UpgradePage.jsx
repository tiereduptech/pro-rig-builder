// =============================================================================
//  UpgradePage.jsx — Pro Rig Builder
//  Landing page for Pro Rig Scanner results
//
//  Copyright © 2026 TieredUp Tech, Inc. — All rights reserved.
//  Proprietary and confidential. See project LICENSE for terms.
//
//  Reads URL hash (#upgrade?specs=base64(json)) from the scanner,
//  analyzes the user's current hardware against the live catalog,
//  and returns ranked, budget-aware upgrade recommendations.
//
//  Bench scale: 0-100, calibrated against PassMark G3D Mark (GPUs) and
//  PassMark CPU Mark (CPUs). RTX 4090 = 100, Ryzen 9 9950X3D = 100 anchor.
//  Storage/RAM bench may be undefined — all code guards for this.
// =============================================================================

import React, { useState, useEffect, useMemo } from "react";
import { PARTS as RAW_PARTS } from "./data/parts.js";

// Filter out quarantined and non-gaming GPUs once at load time.
// segment:"server"|"workstation" + name-based fallback (Quadro, Tesla, A-series, Pro W)
const isWorkstationGPU = (p) => {
  if (p.c !== "GPU") return false;
  if (p.segment === "server" || p.segment === "workstation") return true;
  const n = (p.n || "").toUpperCase();
  if (/\b(QUADRO|TESLA|RTX\s*A\d{4}|NVIDIA\s*A\d+\b|RADEON\s*PRO\s*W|FIREPRO)\b/.test(n)) return true;
  return false;
};

const PARTS = RAW_PARTS.filter(p => !p.needsReview && !isWorkstationGPU(p));

// ─── CONFIG ─────────────────────────────────────────────────────────
const TOP_N_GPU      = 4;
const TOP_N_CPU      = 4;
const TOP_N_RAM      = 3;
const TOP_N_STORAGE  = 3;
const MIN_IMPROVEMENT = 0.10;   // 10% bench gain required for GPU/CPU recs

const SPLIT_NORMAL  = { gpu: 0.65, cpu: 0.20, ram: 0.10, storage: 0.05 };
const SPLIT_REFRESH = { gpu: 0.40, cpu: 0.20, ram: 0.15, mobo: 0.15, storage: 0.10 };

// ─── URL PARAM PARSING ──────────────────────────────────────────────
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

// ─── COMPONENT NAME EXTRACTION ──────────────────────────────────────
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

// ─── BASELINE BENCHMARKS ────────────────────────────────────────────
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

// ─── PLATFORM REFRESH DETECTION ─────────────────────────────────────
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

// ─── RECOMMENDATION ENGINES ─────────────────────────────────────────
function recommendGPUs(currentGPU, budget, topN = TOP_N_GPU) {
  if (!currentGPU || !currentGPU.bench || currentGPU.bench <= 0) return [];
  if (!budget || budget <= 0) return [];
  const target = currentGPU.bench * (1 + MIN_IMPROVEMENT);
  const pool = PARTS.filter(p => {
    if (p.c !== "GPU" || p.bundle) return false;
    if (p.bench == null || p.bench < target) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > budget) return false;
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
    if (out.length >= topN) break;
  }
  return out;
}

function recommendCPUs(currentCPU, budget, topN = TOP_N_CPU) {
  if (!currentCPU || !currentCPU.bench || currentCPU.bench <= 0 || !currentCPU.socket) return [];
  if (!budget || budget <= 0) return [];
  const target = currentCPU.bench * (1 + MIN_IMPROVEMENT);
  const pool = PARTS.filter(p => {
    if (p.c !== "CPU" || p.bundle) return false;
    if (p.bench == null || p.bench < target) return false;
    if (p.socket !== currentCPU.socket) return false;
    const price = bestPrice(p);
    if (price <= 0 || price > budget) return false;
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
    if (out.length >= topN) break;
  }
  return out;
}

function recommendPlatformSwap(currentCPU, budget, sameSocketBest) {
  if (!currentCPU || !currentCPU.bench || currentCPU.bench <= 0) return null;
  const swapSockets = currentCPU.brand === "Intel"
    ? ["AM5"]
    : currentCPU.brand === "AMD"
      ? ["LGA1700", "LGA1851"]
      : [];

  let best = null;
  for (const socket of swapSockets) {
    const cpu = PARTS.filter(p => p.c === "CPU" && !p.bundle && p.socket === socket && p.bench != null && bestPrice(p) > 0)
                     .sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)))[0];
    if (!cpu) continue;
    const ddr = socketToDDR(socket) || "DDR5";
    const mobo = PARTS.filter(p => p.c === "Motherboard" && !p.bundle && p.socket === socket &&
                                   (!p.memType || p.memType === ddr) && bestPrice(p) > 0)
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

function recommendRAMs(specs, budget, topN = TOP_N_RAM) {
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
    if (price <= 0 || price > budget) return false;
    const nameDdr = /DDR5/i.test(p.n) ? "DDR5" : /DDR4/i.test(p.n) ? "DDR4" : null;
    const partType = p.ramType || nameDdr;
    if (currentType && partType && partType !== currentType) return false;
    if (p.cap != null && p.cap < currentCapGB) return false;
    if (allSlotsFilled && p.sticks != null && p.sticks !== currentSticks) return false;
    if (currentSpeed && p.speed != null && p.speed <= currentSpeed) return false;
    return true;
  });

  pool.sort((a, b) => {
    if (a.bench != null && b.bench != null) {
      return (b.bench / bestPrice(b)) - (a.bench / bestPrice(a));
    }
    return ((b.speed || 0) / bestPrice(b)) - ((a.speed || 0) / bestPrice(a));
  });

  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const key = `${p.cap}-${p.sticks}-${p.speed}-${p.b || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= topN) break;
  }
  return out;
}

function recommendStorages(wantGB, wantType, budget, topN = TOP_N_STORAGE) {
  if (!wantGB || !wantType) return [];
  const isHDD = wantType === "HDD";

  const byCapacity = PARTS.filter(p => {
    if (p.c !== "Storage" || p.bundle) return false;
    if (p.cap == null || p.cap < wantGB) return false;
    if (bestPrice(p) <= 0) return false;
    const isHddProduct = /\bHDD\b|hard drive/i.test(p.n);
    const isSsdProduct = /\bSSD\b|NVMe/i.test(p.n);
    if (isHDD && !isHddProduct) return false;
    if (!isHDD && !isSsdProduct) return false;
    return true;
  });
  if (!byCapacity.length) return [];

  const tierOf = (p) => {
    if (isHDD) return 0;
    const n = p.n.toUpperCase();
    if (/\bGEN\s*5\b|PCIE\s*5\.?0/.test(n)) return 5;
    if (/\bGEN\s*4\b|PCIE\s*4\.?0/.test(n)) return 4;
    if (/\bGEN\s*3\b|PCIE\s*3\.?0|NVMe/.test(n)) return 3;
    if (/\bSSD\b/.test(n)) return 2;
    return 1;
  };

  const inBudget = byCapacity.filter(p => bestPrice(p) <= budget);
  const working = inBudget.length ? inBudget : byCapacity;

  working.sort((a, b) => {
    const t = tierOf(b) - tierOf(a);
    if (t !== 0) return t;
    if (a.bench != null && b.bench != null) {
      return (b.bench / bestPrice(b)) - (a.bench / bestPrice(a));
    }
    if (a.bench != null && b.bench == null) return -1;
    if (b.bench != null && a.bench == null) return 1;
    return bestPrice(a) - bestPrice(b);
  });

  const seen = new Set();
  const out = [];
  for (const p of working) {
    const key = `${p.cap}-${p.b || ""}-${p.n.slice(0, 20)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= topN) break;
  }
  return out;
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

    // Coerce string inputs from scanner URL to numbers
    const budget = Number(specs.budget) || 1000;
    const currentGPU = findCatalogMatch("GPU", specs.gpu);
    const currentCPU = findCatalogMatch("CPU", specs.cpu);
    const cpuModel = extractCPUModel(specs.cpu);
    const refresh = needsPlatformRefresh(currentCPU, cpuModel, specs.cpu_socket);

    const split = refresh.refresh ? SPLIT_REFRESH : SPLIT_NORMAL;
    const budgetGPU     = Math.round(budget * split.gpu);
    const budgetCPU     = Math.round(budget * split.cpu);
    const budgetRAM     = Math.round(budget * split.ram);
    const budgetMobo    = refresh.refresh ? Math.round(budget * split.mobo) : 0;
    const budgetStorage = Math.round(budget * split.storage);

    const gpuRecs = recommendGPUs(currentGPU, budgetGPU);
    const cpuRecs = recommendCPUs(currentCPU, budgetCPU);
    const sameSocketBest = cpuRecs[0] || null;
    const platformSwap = !refresh.refresh
      ? recommendPlatformSwap(currentCPU, budget, sameSocketBest)
      : null;

    const ramRecs = recommendRAMs(specs, budgetRAM);

    const storageWant = Number(specs.add_storage_gb) || 0;
    const storageType = specs.add_storage_type || "";
    const storageRecs = storageWant > 0
      ? recommendStorages(storageWant, storageType, budgetStorage)
      : [];

    const bottleneck = analyzeBottleneck(currentCPU, currentGPU);

    const newCpuTDP = cpuRecs[0]?.tdp ?? currentCPU?.tdp ?? 125;
    const newGpuTDP = gpuRecs[0]?.tdp ?? currentGPU?.tdp ?? 200;
    const psuWattsNeeded = calculatePSU(newCpuTDP, newGpuTDP);

    let estCost = 0;
    if (gpuRecs[0])     estCost += bestPrice(gpuRecs[0]);
    if (cpuRecs[0])     estCost += bestPrice(cpuRecs[0]);
    if (ramRecs[0])     estCost += bestPrice(ramRecs[0]);
    if (storageRecs[0]) estCost += bestPrice(storageRecs[0]);

    // Dev diagnostics — exposed for debugging via window.__upgradeAnalysis
    if (typeof window !== "undefined") {
      window.__upgradeAnalysis = {
        budget, budgetGPU, budgetCPU, budgetRAM, budgetStorage,
        currentGPU: currentGPU ? { name: currentGPU.n, bench: currentGPU.bench, isBaseline: !!currentGPU.isBaseline } : null,
        currentCPU: currentCPU ? { name: currentCPU.n, bench: currentCPU.bench, socket: currentCPU.socket, isBaseline: !!currentCPU.isBaseline } : null,
        gpuTarget: currentGPU?.bench ? (currentGPU.bench * 1.1).toFixed(1) : null,
        cpuTarget: currentCPU?.bench ? (currentCPU.bench * 1.1).toFixed(1) : null,
        gpuRecs: gpuRecs.map(p => ({ n: p.n, bench: p.bench, price: bestPrice(p) })),
        cpuRecs: cpuRecs.map(p => ({ n: p.n, bench: p.bench, price: bestPrice(p) })),
      };
    }

    return {
      budget, budgetGPU, budgetCPU, budgetRAM, budgetMobo, budgetStorage,
      currentGPU, currentCPU, refresh,
      gpuRecs, cpuRecs, ramRecs, storageRecs,
      platformSwap, bottleneck,
      psuWattsNeeded, estCost,
      storageWant, storageType,
    };
  }, [specs]);

  if (loading) return <div style={{padding:40, textAlign:"center", color:"var(--dim)"}}>Loading your specs…</div>;
  if (!specs)  return <MissingSpecsView />;

  const a = analysis;
  const allSlotsFilled = Number(specs.ram_used_slots) >= Number(specs.ram_total_slots) && Number(specs.ram_total_slots) > 0;

  return (
    <div style={{minHeight:"100vh", background:"var(--bg)"}}>
      <div style={{maxWidth:1100, margin:"0 auto", padding:"48px 32px"}}>
        <Header />
        <CurrentSystemCard specs={specs} analysis={a} />
        {a.refresh.refresh && <PlatformRefreshAlert reason={a.refresh.reason} />}
        <BudgetBanner budget={a.budget} estCost={a.estCost} split={a.refresh.refresh ? SPLIT_REFRESH : SPLIT_NORMAL} />
        {a.bottleneck && <BottleneckAnalysisCard bn={a.bottleneck} />}
        <PSUWarning watts={a.psuWattsNeeded} />

        <UpgradeSection
          title="GPU Upgrades"
          color="#4ADE80"
          icon="🟢"
          description={`These GPUs would improve your gaming performance. Budget: $${a.budgetGPU.toLocaleString()}. Check PSU wattage compatibility before purchasing.`}
          items={a.gpuRecs}
          baseline={a.currentGPU}
          emptyMsg={`No GPU upgrades within $${a.budgetGPU.toLocaleString()} offer 10%+ improvement over your current card. Try increasing your budget.`}
        />

        <UpgradeSection
          title="CPU Upgrades"
          color="#F87171"
          icon="🔴"
          description={a.currentCPU?.socket
            ? `Filtered to ${a.currentCPU.socket}-compatible CPUs. Budget: $${a.budgetCPU.toLocaleString()}.`
            : `CPU upgrades compatible with your current motherboard. Budget: $${a.budgetCPU.toLocaleString()}.`}
          items={a.cpuRecs}
          baseline={a.currentCPU}
          emptyMsg={`No same-socket CPU upgrades within $${a.budgetCPU.toLocaleString()} offer 10%+ improvement. See platform swap below if available.`}
        />

        {a.platformSwap && <PlatformSwapCard swap={a.platformSwap} currentBrand={a.currentCPU?.brand} />}

        <UpgradeSection
          title="RAM Upgrades"
          color="#FFB020"
          icon="⚡"
          description={allSlotsFilled
            ? `All ${specs.ram_total_slots} slots are filled — only showing ${specs.ram_sticks}-stick kits that can fully replace your current RAM.`
            : `Faster RAM improves CPU-bound games (Valorant, CS2, Fortnite).`}
          warning={`RAM must match your motherboard's supported type (${specs.ram_type}). Check max supported speed in your motherboard manual.`}
          items={a.ramRecs}
          emptyMsg={allSlotsFilled
            ? `No faster ${specs.ram_type} ${specs.ram_sticks}-stick kits at ≥${specs.ram_total}GB within budget. 4-stick high-speed kits are rare — consider switching to a 2-stick kit at higher speeds if you're willing to reduce stick count.`
            : "No faster RAM kits found within budget."}
        />

        {a.storageRecs.length > 0 && (
          <UpgradeSection
            title="Storage Upgrades"
            color="#C084FC"
            icon="💾"
            description={`You asked for ${a.storageWant >= 1000 ? (a.storageWant/1000) + "TB" : a.storageWant + "GB"} of ${a.storageType} storage. Showing options that meet your capacity target.`}
            warning={a.storageType !== "HDD" ? "Your motherboard needs a free M.2 slot. Check if it supports PCIe Gen 4 or Gen 5 NVMe drives." : null}
            items={a.storageRecs}
            emptyMsg={`No ${a.storageWant >= 1000 ? (a.storageWant/1000)+"TB" : a.storageWant+"GB"}+ ${a.storageType} options found within budget. Try a smaller capacity or a higher budget.`}
          />
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

function BudgetBanner({budget, estCost, split}) {
  const over = estCost > budget;
  return (
    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"16px 20px", marginBottom:20}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:12}}>
        <div>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>YOUR BUDGET</div>
          <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color:"var(--accent)"}}>${budget.toLocaleString()}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>ESTIMATED TOTAL</div>
          <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color: over ? "#FFB020" : "var(--txt)"}}>${estCost.toLocaleString()}</div>
        </div>
      </div>
      <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
        {Object.entries(split).map(([key, pct]) => (
          <div key={key} style={{background:"var(--bg3)", padding:"4px 10px", borderRadius:6, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)"}}>
            <span style={{color:"var(--txt)", fontWeight:600}}>{key.toUpperCase()}</span> {Math.round(pct*100)}% · ${Math.round(budget*pct).toLocaleString()}
          </div>
        ))}
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
          Look at the label on your PSU (inside your PC case) for the wattage rating. Your upgraded system will need at least <strong style={{color:"var(--txt)"}}>{watts}W</strong>. If your PSU doesn't have enough power, you'll need to upgrade it too. Also check that your PSU has the right PCIe power connectors for your new GPU.
        </div>
      </div>
    </div>
  );
}

function UpgradeSection({title, color, icon, description, warning, items, baseline, emptyMsg}) {
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
      {items.length === 0 ? (
        <div style={{fontFamily:"var(--ff)", fontSize:12, color:"var(--dim)", fontStyle:"italic", padding:"12px 0"}}>{emptyMsg}</div>
      ) : (
        <div style={{display:"flex", flexDirection:"column", gap:8}}>
          {items.map((p, i) => <UpgradeRow key={p.id || i} part={p} color={color} baseline={baseline}/>)}
        </div>
      )}
    </div>
  );
}

function UpgradeRow({part, color, baseline}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  const improvement = (baseline?.bench != null && baseline.bench > 0 && part.bench != null)
    ? Math.round(((part.bench - baseline.bench) / baseline.bench) * 100)
    : null;
  return (
    <div style={{background:"var(--bg3)", borderRadius:10, padding:"12px 16px", display:"flex", alignItems:"center", gap:14, borderLeft:`3px solid ${color}`}}>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{part.n}</div>
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
        <div style={{fontFamily:"var(--ff)", fontSize:18, fontWeight:800, color:"var(--accent)"}}>${price}</div>
        {retailer && (
          <a href={retailer.url} target="_blank" rel="noopener noreferrer"
             style={{display:"inline-block", marginTop:4, padding:"6px 12px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:6, fontFamily:"var(--ff)", fontSize:11, fontWeight:700}}>
            Buy on {retailer.name} →
          </a>
        )}
      </div>
    </div>
  );
}

function PlatformSwapCard({swap, currentBrand}) {
  const total = swap.total;
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
        <div style={{fontFamily:"var(--ff)", fontSize:20, fontWeight:800, color:"var(--accent)"}}>${total.toLocaleString()}</div>
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
