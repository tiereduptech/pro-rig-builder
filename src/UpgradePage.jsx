import React, { useState, useEffect, useMemo } from "react";
import { PARTS } from "./data/parts.js";

// ═══════════════════════════════════════════════════════════════════
// UpgradePage — landing page for Pro Rig Scanner
// Reads URL params (?specs=base64(json)) with user's hardware + budget
// and returns ranked upgrade recommendations.
// ═══════════════════════════════════════════════════════════════════

// ─── URL PARAM PARSING ────────────────────────────────────────────
function parseSpecs() {
  try {
    const hash = window.location.hash.split("?")[1] || "";
    const params = new URLSearchParams(hash);
    const raw = params.get("specs");
    if (!raw) return null;
    const decoded = atob(decodeURIComponent(raw));
    return JSON.parse(decoded);
  } catch (e) {
    console.error("Failed to parse specs:", e);
    return null;
  }
}

// ─── COMPONENT MATCHING ───────────────────────────────────────────
// GPU matching — strip brand, match by model (e.g., "RTX 4070 Ti")
function extractGPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  // NVIDIA RTX/GTX
  let m = n.match(/RTX\s*(\d{4})\s*(TI\s*SUPER|TI|SUPER)?/);
  if (m) return `RTX ${m[1]}${m[2] ? " " + m[2].replace(/\s+/g, " ") : ""}`.trim();
  m = n.match(/GTX\s*(\d{3,4})\s*(TI)?/);
  if (m) return `GTX ${m[1]}${m[2] ? " TI" : ""}`.trim();
  // AMD RX
  m = n.match(/RX\s*(\d{4})\s*(XTX|XT)?/);
  if (m) return `RX ${m[1]}${m[2] ? " " + m[2] : ""}`.trim();
  // Intel Arc
  m = n.match(/ARC\s*([AB]\d{3})/);
  if (m) return `Arc ${m[1]}`.trim();
  return null;
}

// CPU matching — extract brand + family + model number
function extractCPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  // Intel: "Core i7-13700K" → "13700K"
  let m = n.match(/CORE\s+I[3579]-?(\d{4,5}[A-Z]{0,2})/);
  if (m) return { brand: "Intel", model: m[1], full: `i${n.match(/I(\d)/)?.[1] || "?"}-${m[1]}` };
  // AMD Ryzen: "Ryzen 7 7700X" → "7700X"
  m = n.match(/RYZEN\s*\d\s+(\d{4}[A-Z]{0,2})/);
  if (m) return { brand: "AMD", model: m[1], full: `Ryzen ${n.match(/RYZEN\s*(\d)/)?.[1]} ${m[1]}` };
  return null;
}

// Detect Intel generation from model number
function intelGeneration(model) {
  if (!model) return null;
  const m = model.match(/^(\d{2,5})/);
  if (!m) return null;
  const num = parseInt(m[1]);
  if (num >= 10000) return Math.floor(num / 1000);   // 13700, 14600 → 13, 14
  return Math.floor(num / 100);                       // 9700, 8400 → 9, 8
}


// ─── BASELINE BENCHMARKS (for GPUs/CPUs not in our sales catalog) ───
// Scaled to match catalog's 0-100 bench values. Derived from catalog relative positions.
const GPU_BASELINE_BENCH = {
  // NVIDIA 10-series (Pascal)
  "GTX 1030": 6,  "GTX 1050": 8,  "GTX 1050 TI": 10,  "GTX 1060": 13,
  "GTX 1070": 17, "GTX 1070 TI": 19, "GTX 1080": 22, "GTX 1080 TI": 26,
  // NVIDIA 16-series (Turing no RT)
  "GTX 1630": 7, "GTX 1650": 11, "GTX 1650 SUPER": 13, "GTX 1660": 14, "GTX 1660 SUPER": 18, "GTX 1660 TI": 19,
  // NVIDIA 20-series
  "RTX 2060": 22, "RTX 2060 SUPER": 26, "RTX 2070": 27, "RTX 2070 SUPER": 30,
  "RTX 2080": 32, "RTX 2080 SUPER": 33, "RTX 2080 TI": 36,
  // NVIDIA 30-series
  "RTX 3050": 22, "RTX 3060": 28, "RTX 3060 TI": 36, "RTX 3070": 40, "RTX 3070 TI": 43,
  "RTX 3080": 50, "RTX 3080 TI": 58, "RTX 3090": 60, "RTX 3090 TI": 65,
  // AMD RX 500
  "RX 550": 5, "RX 560": 7, "RX 570": 11, "RX 580": 13, "RX 590": 14,
  // AMD RX 5000
  "RX 5500 XT": 14, "RX 5600 XT": 20, "RX 5700": 23, "RX 5700 XT": 26,
  // Integrated / Intel
  "UHD GRAPHICS": 2, "IRIS XE": 4, "ARC A310": 8, "ARC A380": 11,
};

const CPU_BASELINE_BENCH = {
  // Intel 6th-9th gen (LGA1151)
  "6100": 30, "6300": 35, "6500": 40, "6600": 45, "6700": 50, "6700K": 52, "6800K": 55, "6850K": 58, "6900K": 62,
  "7100": 32, "7300": 37, "7400": 40, "7500": 45, "7600": 48, "7700": 52, "7700K": 55, "7740X": 56, "7820X": 65,
  "8100": 38, "8300": 42, "8400": 48, "8500": 52, "8600": 55, "8600K": 58, "8700": 62, "8700K": 65,
  "9100": 42, "9300": 45, "9400": 52, "9500": 55, "9600K": 60, "9700K": 66, "9900K": 72,
  // Intel 10th gen
  "10100": 45, "10300": 50, "10400": 58, "10500": 62, "10600K": 68, "10700K": 74, "10900K": 80,
  "10105": 46, "10600": 64, "10700": 70, "10900": 76,
  // Intel 11th gen
  "11400": 62, "11600K": 70, "11700K": 76, "11900K": 82,
  // AMD Ryzen 1xxx (AM4)
  "1600": 42, "1700": 48, "1800X": 52, "1600X": 45,
  // AMD Ryzen 2xxx
  "2600": 48, "2700": 55, "2700X": 58,
  // AMD Ryzen 3xxx
  "3600": 55, "3700X": 64, "3800X": 66, "3900X": 75, "3950X": 82,
};

function lookupGPUBaseline(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  for (const [key, bench] of Object.entries(GPU_BASELINE_BENCH)) {
    if (n.includes(key)) return { bench, name: key };
  }
  return null;
}


// Infer CPU socket from model when no catalog match
function inferCPUSocket(model, brand) {
  if (!model) return null;
  const m = model.toUpperCase();
  if (brand === "Intel") {
    // Intel generation → socket
    const genMatch = m.match(/^(\d{2,5})/);
    if (!genMatch) return null;
    const num = parseInt(genMatch[1]);
    const gen = num >= 10000 ? Math.floor(num / 1000) : Math.floor(num / 100);
    if (gen === 6 || gen === 7) return "LGA1151";
    if (gen === 8 || gen === 9) return "LGA1151";
    if (gen === 10 || gen === 11) return "LGA1200";
    if (gen === 12 || gen === 13 || gen === 14) return "LGA1700";
    if (gen === 15) return "LGA1851";
  }
  if (brand === "AMD") {
    const genMatch = m.match(/^(\d)/);
    if (!genMatch) return null;
    const gen = parseInt(genMatch[1]);
    if (gen === 1 || gen === 2 || gen === 3 || gen === 5) return "AM4"; // Ryzen 1000/2000/3000/5000 are AM4
    if (gen === 7 || gen === 8 || gen === 9) return "AM5"; // Ryzen 7000/8000/9000 are AM5
  }
  return null;
}

function lookupCPUBaseline(model) {
  if (!model) return null;
  const m = model.toUpperCase();
  for (const [key, bench] of Object.entries(CPU_BASELINE_BENCH)) {
    if (m.startsWith(key) || m === key) return { bench, name: key };
  }
  return null;
}


// Detect AMD Ryzen generation (7000-series, 5000-series, etc.)
function amdGeneration(model) {
  if (!model) return null;
  const m = model.match(/^(\d)/);
  if (!m) return null;
  return parseInt(m[1]);
}

// Check if CPU requires platform refresh (mobo + cpu + ram)
function needsPlatformRefresh(cpu, rawSocket) {
  if (!cpu) return { refresh: false };
  // AM3/AM2/older AMD sockets require platform refresh
  if (rawSocket && /^AM[123]$|^FM[12]$|^939|^754|^AM3\+/.test(rawSocket)) {
    return { refresh: true, reason: `${rawSocket} socket is obsolete � AM5 platform needed` };
  }
  if (cpu.brand === "Intel") {
    const gen = intelGeneration(cpu.model);
    if (gen && gen < 8) return { refresh: true, reason: `Intel ${gen}th gen is outdated — newer socket required` };
    // LGA1200 (10/11th gen) is dead-end — force refresh if we don't have matching CPUs in catalog
    if (gen === 10 || gen === 11) {
      const hasLGA1200 = PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1200");
      if (!hasLGA1200) return { refresh: true, reason: `LGA1200 has limited upgrades — LGA1700 or LGA1851 recommended` };
    }
    // Same for LGA1151 (8/9th gen)
    if (gen === 8 || gen === 9) {
      const hasLGA1151 = PARTS.some(p => p.c === "CPU" && !p.bundle && p.socket === "LGA1151");
      if (!hasLGA1151) return { refresh: true, reason: `LGA1151 has no upgrade path in our catalog — newer socket needed` };
    }
  }
  // AMD Ryzen CPUs are all AM4/AM5 modern sockets — refresh only forced via rawSocket check above.
  return { refresh: false };
}

// ─── FIND MATCHING CATALOG PART ───────────────────────────────────
function findCatalogMatch(type, scannerName) {
  if (!scannerName) return null;
  const pool = PARTS.filter(p => p.c === type && !p.bundle);
  if (type === "GPU") {
    const model = extractGPUModel(scannerName);
    if (!model) return null;
    const modelUpper = model.toUpperCase();
    const catalog = pool.find(p => p.n.toUpperCase().includes(modelUpper));
    if (catalog) return catalog;
    // Fallback: use baseline lookup
    const baseline = lookupGPUBaseline(scannerName);
    if (baseline) return { n: "Current: " + baseline.name, bench: baseline.bench, isBaseline: true };
    return null;
  }
  if (type === "CPU") {
    const cpu = extractCPUModel(scannerName);
    if (!cpu) return null;
    const catalog = pool.find(p => p.n.toUpperCase().includes(cpu.model));
    if (catalog) return catalog;
    // Fallback: use baseline lookup
    const baseline = lookupCPUBaseline(cpu.model);
    if (baseline) return { n: "Current: " + cpu.full, bench: baseline.bench, socket: inferCPUSocket(cpu.model, cpu.brand), isBaseline: true, brand: cpu.brand };
    return null;
  }
  return null;
}

// ─── BENCHMARK TIER HELPERS ───────────────────────────────────────
function bestPrice(p) {
  if (p.deals?.amazon?.price) return p.deals.amazon.price;
  if (p.deals?.bestbuy?.price) return p.deals.bestbuy.price;
  return p.pr;
}

function retailerUrl(p) {
  if (p.deals?.amazon?.url) return { url: p.deals.amazon.url, name: "Amazon" };
  if (p.deals?.bestbuy?.url) return { url: p.deals.bestbuy.url, name: "Best Buy" };
  return null;
}

// ─── RECOMMENDATION ENGINE ────────────────────────────────────────
function recommendGPU(currentGPU, budget) {
  if (!currentGPU) return null;
  const pool = PARTS.filter(p => p.c === "GPU" && p.bench != null && bestPrice(p) <= budget);
  const target = currentGPU.bench * 1.10; // require 10% improvement
  const better = pool.filter(p => p.bench >= target);
  if (!better.length) return null;
  // Sort by performance-per-dollar (bench / price)
  better.sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)));
  return better[0];
}

function recommendCPU(currentCPU, budget, platformRefresh) {
  if (!currentCPU) return null;
  let pool = PARTS.filter(p => p.c === "CPU" && !p.bundle && p.bench != null && bestPrice(p) <= budget);
  // If not refreshing, only same-socket CPUs
  if (!platformRefresh && currentCPU.socket) {
    pool = pool.filter(p => p.socket === currentCPU.socket);
  }
  const target = currentCPU.bench * 1.10;
  const better = pool.filter(p => p.bench >= target);
  if (!better.length) return null;
  better.sort((a, b) => (b.bench / bestPrice(b)) - (a.bench / bestPrice(a)));
  return better[0];
}

function recommendMotherboard(cpu, budget, ddrGen) {
  if (!cpu?.socket) return null;
  const pool = PARTS.filter(p =>
    p.c === "Motherboard" && !p.bundle &&
    p.socket === cpu.socket &&
    (ddrGen ? p.memType === ddrGen : true) &&
    bestPrice(p) <= budget
  );
  if (!pool.length) return null;
  pool.sort((a, b) => (b.r || 0) - (a.r || 0) || bestPrice(a) - bestPrice(b));
  return pool[0];
}

function recommendRAM(ddrGen, totalGBWanted, budget) {
  // Parse DDR gen from name for RAM
  const pool = PARTS.filter(p => {
    if (p.c !== "RAM") return false;
    const nameDdr = /DDR5/i.test(p.n) ? "DDR5" : /DDR4/i.test(p.n) ? "DDR4" : null;
    if (ddrGen && nameDdr && nameDdr !== ddrGen) return false;
    if (bestPrice(p) > budget) return false;
    if (totalGBWanted && p.cap && p.cap < totalGBWanted) return false;
    return true;
  });
  if (!pool.length) return null;
  pool.sort((a, b) => (b.r || 0) - (a.r || 0) || bestPrice(a) - bestPrice(b));
  return pool[0];
}

function recommendStorage(wantGB, wantType) {
  if (!wantGB || !wantType) return null;
  const isHDD = wantType === "HDD";
  const pool = PARTS.filter(p => {
    if (p.c !== "Storage") return false;
    if (p.cap == null) return false;
    if (p.cap < wantGB * 0.9) return false;  // allow ±10% wiggle
    if (p.cap > wantGB * 1.5) return false;   // don't over-buy
    const isHddProduct = /\bHDD\b|hard drive/i.test(p.n);
    const isSsdProduct = /\bSSD\b|NVMe/i.test(p.n);
    if (isHDD && !isHddProduct) return false;
    if (!isHDD && !isSsdProduct) return false;
    return true;
  });
  if (!pool.length) return null;
  pool.sort((a, b) => bestPrice(a) - bestPrice(b));  // cheapest first
  return pool[0];
}

function calculatePSUNeeded(cpuTDP, gpuTDP) {
  // Rule of thumb: CPU + GPU + 150W overhead, rounded up to nearest 100W
  const raw = (cpuTDP || 100) + (gpuTDP || 150) + 150;
  return Math.ceil(raw / 100) * 100;
}

function recommendPSU(wantWatts) {
  const pool = PARTS.filter(p => p.c === "PSU" && p.watts != null && p.watts >= wantWatts && p.watts <= wantWatts + 200);
  if (!pool.length) return null;
  pool.sort((a, b) => bestPrice(a) - bestPrice(b));
  return pool[0];
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────
export default function UpgradePage() {
  const [specs, setSpecs] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const s = parseSpecs();
    setSpecs(s);
    setLoading(false);
  }, []);

  const analysis = useMemo(() => {
    if (!specs) return null;

    // Find current components in catalog
    const currentGPU = findCatalogMatch("GPU", specs.gpu);
    const currentCPU = findCatalogMatch("CPU", specs.cpu);
    const cpuModel = extractCPUModel(specs.cpu);
    const gpuModel = extractGPUModel(specs.gpu);

    const budget = parseInt(specs.budget) || 1000;

    // Platform refresh detection
    const refresh = cpuModel ? needsPlatformRefresh(cpuModel, specs.cpu_socket) : { refresh: false };

    // Budget allocation: 60% GPU, 25% CPU, 10% RAM, 5% misc (storage is separate)
    const budgetGPU = Math.round(budget * 0.60);
    const budgetCPU = Math.round(budget * 0.25);
    const budgetRAM = Math.round(budget * 0.10);
    // If platform refresh: need mobo too (from misc budget)
    const budgetMobo = refresh.refresh ? Math.round(budget * 0.15) : 0;

    // Generate recommendations
    const gpuUpgrade = recommendGPU(currentGPU, budgetGPU);
    const cpuUpgrade = recommendCPU(currentCPU, budgetCPU, refresh.refresh);

    // Determine target DDR generation after upgrade
    let ddrGen = null;
    if (cpuUpgrade) {
      const socket = cpuUpgrade.socket;
      if (socket === "AM5" || socket === "LGA1851") ddrGen = "DDR5";
      else if (socket === "AM4" || socket === "LGA1200") ddrGen = "DDR4";
      else if (socket === "LGA1700") ddrGen = "DDR5"; // LGA1700 supports both, prefer DDR5
    }

    const moboUpgrade = refresh.refresh && cpuUpgrade ? recommendMotherboard(cpuUpgrade, budgetMobo, ddrGen) : null;
    const ramUpgrade = refresh.refresh ? recommendRAM(ddrGen, 32, budgetRAM) : null;

    // Storage (separate budget — "additional storage gets least budget allocation")
    const addStorage = recommendStorage(parseInt(specs.add_storage_gb), specs.add_storage_type);

    // PSU calculation (add-on, NOT in main budget)
    const newCpuTDP = cpuUpgrade?.tdp || currentCPU?.tdp || 125;
    const newGpuTDP = gpuUpgrade?.tdp || currentGPU?.tdp || 200;
    const psuWattsNeeded = calculatePSUNeeded(newCpuTDP, newGpuTDP);
    const psuUpgrade = recommendPSU(psuWattsNeeded);

    // Calculate total cost
    let upgradeCost = 0;
    if (gpuUpgrade) upgradeCost += bestPrice(gpuUpgrade);
    if (cpuUpgrade) upgradeCost += bestPrice(cpuUpgrade);
    if (moboUpgrade) upgradeCost += bestPrice(moboUpgrade);
    if (ramUpgrade) upgradeCost += bestPrice(ramUpgrade);
    if (addStorage) upgradeCost += bestPrice(addStorage);

    return {
      currentGPU, currentCPU,
      cpuModel, gpuModel,
      refresh,
      gpuUpgrade, cpuUpgrade, moboUpgrade, ramUpgrade,
      addStorage, psuUpgrade, psuWattsNeeded,
      upgradeCost, budget,
    };
  }, [specs]);

  if (loading) return <div style={{padding:40, textAlign:"center", color:"var(--dim)"}}>Loading your specs...</div>;
  if (!specs) return <MissingSpecsView />;

  return (
    <div style={{minHeight:"100vh", background:"var(--bg)"}}>
      <div style={{maxWidth:1100, margin:"0 auto", padding:"48px 32px"}}>
        <HeaderSection specs={specs} analysis={analysis} />
        <CurrentSystemCard specs={specs} analysis={analysis} />
        {analysis.refresh.refresh && <PlatformRefreshAlert reason={analysis.refresh.reason} />}
        <BudgetBanner budget={analysis.budget} totalCost={analysis.upgradeCost} />
        <RecommendationsSection analysis={analysis} />
        {analysis.addStorage && <StorageCard part={analysis.addStorage} />}
        {analysis.psuUpgrade && <PSUCard part={analysis.psuUpgrade} watts={analysis.psuWattsNeeded} />}
      </div>
    </div>
  );
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────
function HeaderSection({specs, analysis}) {
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"inline-flex", alignItems:"center", gap:8, background:"var(--accent3)", borderRadius:20, padding:"6px 16px", marginBottom:16}}>
        <span style={{fontSize:14}}>⚡</span>
        <span style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)", fontWeight:600}}>SCAN COMPLETE</span>
      </div>
      <h1 style={{fontFamily:"var(--ff)", fontSize:40, fontWeight:800, color:"var(--txt)", margin:"8px 0 8px"}}>
        Here's your upgrade path
      </h1>
      <p style={{fontFamily:"var(--ff)", fontSize:15, color:"var(--dim)", lineHeight:1.5}}>
        Based on your current system and budget, these upgrades deliver the biggest performance gain per dollar.
      </p>
    </div>
  );
}

function CurrentSystemCard({specs, analysis}) {
  return (
    <div style={{background:"var(--bg2)", borderRadius:16, border:"1px solid var(--bdr)", padding:24, marginBottom:24}}>
      <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, marginBottom:12, letterSpacing:1.5}}>YOUR CURRENT SYSTEM</div>
      <div style={{display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:16}}>
        <SpecRow label="CPU" value={specs.cpu} detail={`${specs.cpu_cores}C/${specs.cpu_threads}T · ${specs.cpu_clock} GHz`} color="var(--sky)" bench={analysis.currentCPU?.bench}/>
        <SpecRow label="GPU" value={specs.gpu} detail={`${specs.gpu_vram} GB VRAM`} color="var(--green, #4ADE80)" bench={analysis.currentGPU?.bench}/>
        <SpecRow label="RAM" value={`${specs.ram_total}GB ${specs.ram_type} @ ${specs.ram_speed}MHz`} detail={`${specs.ram_sticks}× sticks · ${specs.ram_used_slots}/${specs.ram_total_slots} slots`} color="var(--amber)"/>
        <SpecRow label="MOBO" value={specs.mobo} detail={specs.mobo_mfr} color="var(--dim)"/>
      </div>
    </div>
  );
}

function SpecRow({label, value, detail, color, bench}) {
  return (
    <div style={{display:"flex", gap:12}}>
      <div style={{minWidth:50, fontFamily:"var(--mono)", fontSize:10, color, fontWeight:700, paddingTop:3}}>{label}</div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:600, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{value}</div>
        <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", marginTop:2}}>{detail}{bench != null && <> · <span style={{color:"var(--accent)"}}>bench {bench}</span></>}</div>
      </div>
    </div>
  );
}

function PlatformRefreshAlert({reason}) {
  return (
    <div style={{background:"rgba(255,176,32,.1)", border:"1px solid var(--amber)", borderRadius:12, padding:"16px 20px", marginBottom:24, display:"flex", gap:12, alignItems:"flex-start"}}>
      <span style={{fontSize:20, flexShrink:0}}>⚠️</span>
      <div>
        <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--txt)", marginBottom:4}}>Platform Refresh Required</div>
        <div style={{fontFamily:"var(--ff)", fontSize:13, color:"var(--dim)", lineHeight:1.5}}>{reason}. Upgrade will include a new motherboard and RAM to match.</div>
      </div>
    </div>
  );
}

function BudgetBanner({budget, totalCost}) {
  const over = totalCost > budget;
  return (
    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"14px 20px", marginBottom:24, display:"flex", justifyContent:"space-between", alignItems:"center"}}>
      <div>
        <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600}}>YOUR BUDGET</div>
        <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color:"var(--accent)"}}>${budget.toLocaleString()}</div>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600}}>ESTIMATED COST</div>
        <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color: over ? "var(--amber)" : "var(--txt)"}}>${totalCost.toLocaleString()}</div>
      </div>
    </div>
  );
}

function RecommendationsSection({analysis}) {
  const recs = [
    analysis.gpuUpgrade && {part: analysis.gpuUpgrade, type: "GPU", baseline: analysis.currentGPU, color: "var(--green, #4ADE80)"},
    analysis.cpuUpgrade && {part: analysis.cpuUpgrade, type: "CPU", baseline: analysis.currentCPU, color: "var(--sky)"},
    analysis.moboUpgrade && {part: analysis.moboUpgrade, type: "Motherboard", color: "var(--dim)"},
    analysis.ramUpgrade && {part: analysis.ramUpgrade, type: "RAM", color: "var(--amber)"},
  ].filter(Boolean);

  if (!recs.length) return (
    <div style={{background:"var(--bg2)", borderRadius:12, padding:32, textAlign:"center", color:"var(--dim)"}}>
      No upgrade recommendations fit your budget that offer 10%+ improvement.
      Try increasing your budget or consider a platform refresh.
    </div>
  );

  return (
    <div style={{marginBottom:24}}>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:600, marginBottom:12, letterSpacing:1.5}}>RECOMMENDED UPGRADES</div>
      <div style={{display:"flex", flexDirection:"column", gap:10}}>
        {recs.map((r, i) => <UpgradeCard key={i} {...r} />)}
      </div>
    </div>
  );
}

function UpgradeCard({part, type, baseline, color, overBudget}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  const improvement = baseline?.bench && part.bench ? Math.round(((part.bench - baseline.bench) / baseline.bench) * 100) : null;
  return (
    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:16, display:"flex", alignItems:"center", gap:16}}>
      <div style={{width:60, height:60, background:"#fff", borderRadius:8, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden"}}>
        {part.img ? <img src={part.img} alt="" style={{width:"100%", height:"100%", objectFit:"contain"}}/> : <span style={{fontSize:24}}>🔧</span>}
      </div>
      <div style={{flex:1, minWidth:0}}>
        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:2}}>
          <span style={{fontFamily:"var(--mono)", fontSize:10, color, fontWeight:700}}>{type.toUpperCase()}</span>
          {overBudget && <span style={{fontFamily:"var(--mono)", fontSize:9, color:"var(--amber)", fontWeight:700, background:"rgba(255,176,32,.15)", padding:"2px 6px", borderRadius:4}}>OVER BUDGET</span>}
        </div>
        <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)", overflow:"hidden", textOverflow:"ellipsis"}}>{part.n}</div>
        <div style={{display:"flex", gap:10, marginTop:4, fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)"}}>
          {improvement != null && <span style={{color:"var(--accent)", fontWeight:600}}>+{improvement}% performance</span>}
          {part.bench && <span>bench {part.bench}</span>}
          {part.tdp && <span>{part.tdp}W</span>}
        </div>
      </div>
      <div style={{textAlign:"right", flexShrink:0}}>
        <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color:"var(--accent)"}}>${price}</div>
        {retailer && (
          <a href={retailer.url} target="_blank" rel="noopener noreferrer"
             style={{display:"inline-block", marginTop:6, padding:"8px 16px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:8, fontFamily:"var(--ff)", fontSize:12, fontWeight:700}}>
            Buy on {retailer.name} →
          </a>
        )}
      </div>
    </div>
  );
}

function StorageCard({part}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  return (
    <div style={{marginTop:24}}>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:600, marginBottom:12, letterSpacing:1.5}}>ADDITIONAL STORAGE</div>
      <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:16, display:"flex", alignItems:"center", gap:16}}>
        <div style={{width:60, height:60, background:"#fff", borderRadius:8, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden"}}>
          {part.img ? <img src={part.img} alt="" style={{width:"100%", height:"100%", objectFit:"contain"}}/> : <span style={{fontSize:24}}>💾</span>}
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"#C084FC", fontWeight:700, marginBottom:2}}>STORAGE</div>
          <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)"}}>{part.n}</div>
          <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", marginTop:4}}>{part.cap}GB</div>
        </div>
        <div style={{textAlign:"right", flexShrink:0}}>
          <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color:"var(--accent)"}}>${price}</div>
          {retailer && (
            <a href={retailer.url} target="_blank" rel="noopener noreferrer"
               style={{display:"inline-block", marginTop:6, padding:"8px 16px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:8, fontFamily:"var(--ff)", fontSize:12, fontWeight:700}}>
              Buy on {retailer.name} →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function PSUCard({part, watts}) {
  const price = bestPrice(part);
  const retailer = retailerUrl(part);
  return (
    <div style={{marginTop:24}}>
      <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", fontWeight:600, marginBottom:8, letterSpacing:1.5}}>POWER SUPPLY (ADD-ON)</div>
      <div style={{background:"rgba(255,138,61,.05)", border:"1px dashed var(--accent)", borderRadius:12, padding:"12px 16px", marginBottom:10, display:"flex", gap:10, alignItems:"center"}}>
        <span style={{fontSize:16}}>⚡</span>
        <div style={{fontFamily:"var(--ff)", fontSize:13, color:"var(--txt)"}}>
          Your upgraded system will need <strong>at least {watts}W</strong>. Not included in budget total.
        </div>
      </div>
      <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:16, display:"flex", alignItems:"center", gap:16}}>
        <div style={{width:60, height:60, background:"#fff", borderRadius:8, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", overflow:"hidden"}}>
          {part.img ? <img src={part.img} alt="" style={{width:"100%", height:"100%", objectFit:"contain"}}/> : <span style={{fontSize:24}}>🔌</span>}
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--accent)", fontWeight:700, marginBottom:2}}>PSU</div>
          <div style={{fontFamily:"var(--ff)", fontSize:15, fontWeight:700, color:"var(--txt)"}}>{part.n}</div>
          <div style={{fontFamily:"var(--mono)", fontSize:11, color:"var(--dim)", marginTop:4}}>{part.watts}W</div>
        </div>
        <div style={{textAlign:"right", flexShrink:0}}>
          <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color:"var(--accent)"}}>${price}</div>
          {retailer && (
            <a href={retailer.url} target="_blank" rel="noopener noreferrer"
               style={{display:"inline-block", marginTop:6, padding:"8px 16px", background:"var(--accent)", color:"#fff", textDecoration:"none", borderRadius:8, fontFamily:"var(--ff)", fontSize:12, fontWeight:700}}>
              Buy on {retailer.name} →
            </a>
          )}
        </div>
      </div>
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
