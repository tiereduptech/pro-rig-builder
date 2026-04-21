#!/usr/bin/env node
/**
 * bestbuy-enrich.js — enrich Best Buy discovery results with full specs
 *
 * For each product from catalog-build/bestbuy-discovery/*.json:
 *   1. Call Best Buy Developer API /v1/products/{sku}.json
 *   2. Parse `details` array (name/value pairs) into structured specs
 *      using category-specific mappers
 *   3. Save enriched products to catalog-build/bestbuy-enriched/{category}.json
 *
 * Rate limits: Best Buy free tier allows 5 req/sec + 50k/day. We run at 4/sec
 * conservatively. With ~5000 products that's ~21 min of enrichment.
 *
 * Usage:
 *   railway run node bestbuy-enrich.js
 *   railway run node bestbuy-enrich.js --category=GPU
 *   railway run node bestbuy-enrich.js --limit=50          # dev testing
 *   railway run node bestbuy-enrich.js --resume            # skip already-enriched
 *
 * Output per product (merged with discovery data):
 *   {
 *     catalogItemId, name, manufacturer, price, url, imageUrl, gtin, ...
 *     (original discovery fields)
 *     specs: { cores, tdp, vram, watts, ... },  // parsed from Best Buy details
 *     enrichedAt: ISO timestamp
 *   }
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY env var required.');
  process.exit(1);
}

const DISCOVERY_DIR = join(process.cwd(), 'catalog-build', 'bestbuy-discovery');
const OUTPUT_DIR = join(process.cwd(), 'catalog-build', 'bestbuy-enriched');

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const flags = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  flags[k] = v ?? true;
}
const ONLY_CATEGORY = flags.category || null;
const LIMIT = flags.limit ? parseInt(flags.limit) : null;
const RESUME = !!flags.resume;
// Best Buy docs say 5/sec but in practice they throttle below that.
// Using 333ms (3/sec) keeps us reliably under their enforcement.
const RATE_LIMIT_MS = parseInt(flags.rate || '333');

// ─────────────────────────────────────────────────────────────────────────────
// API call with retry — handles 403 "per second limit" + 429 + 5xx
// ─────────────────────────────────────────────────────────────────────────────

async function fetchProduct(sku, attempt = 1) {
  const url = `https://api.bestbuy.com/v1/products/${sku}.json?apiKey=${KEY}&show=sku,name,manufacturer,modelNumber,upc,salePrice,regularPrice,onSale,onlineAvailability,image,details,features,color,weight,depth,height,width,categoryPath&format=json`;
  const resp = await fetch(url);

  // Best Buy returns 403 for per-second rate limit (not 429 as expected)
  if (resp.status === 403) {
    const body = await resp.text();
    if (/per second limit|rate limit/i.test(body)) {
      if (attempt < 5) {
        const backoff = attempt * 1500;  // 1.5s, 3s, 4.5s, 6s
        await sleep(backoff);
        return fetchProduct(sku, attempt + 1);
      }
      throw new Error(`403 rate limited after ${attempt} retries`);
    }
    throw new Error(`HTTP 403: ${body.slice(0, 200)}`);
  }

  if (resp.status === 429 || resp.status >= 500) {
    if (attempt < 3) {
      const backoff = attempt * 2000;
      await sleep(backoff);
      return fetchProduct(sku, attempt + 1);
    }
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Details array → map
// Best Buy returns: details: [{ name: "Field", value: "X" }, ...]
// Convert to: { "Field": "X" }
// ─────────────────────────────────────────────────────────────────────────────

function detailsToMap(details) {
  const map = {};
  if (!Array.isArray(details)) return map;
  for (const d of details) {
    if (d?.name) map[d.name] = d.value;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value parsers — convert strings like "2.28 gigahertz" → 2.28
// ─────────────────────────────────────────────────────────────────────────────

function parseNum(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function parseWatts(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(?:watts?|w)\b/i);
  return m ? parseInt(m[1]) : parseNum(v);
}

function parseGHz(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(?:gigahertz|ghz)/i);
  return m ? parseFloat(m[1]) : parseNum(v);
}

function parseMHz(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(?:megahertz|mhz)/i);
  if (m) return parseInt(m[1]);
  // Also accept "6000 MT/s" style
  const mts = String(v).match(/([\d.]+)\s*MT\/s/i);
  return mts ? parseInt(mts[1]) : parseNum(v);
}

function parseGB(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(?:gigabytes?|gb)\b/i);
  return m ? parseFloat(m[1]) : null;
}

function parseTB(v) {
  if (v == null) return null;
  const m = String(v).match(/([\d.]+)\s*(?:terabytes?|tb)\b/i);
  return m ? parseFloat(m[1]) * 1000 : null; // as GB
}

function parseCapacity(v) {
  if (v == null) return null;
  return parseTB(v) || parseGB(v);
}

function parseBool(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return s === 'yes' || s === 'true' || s === '1';
}

// ─────────────────────────────────────────────────────────────────────────────
// Category-specific spec mappers
//
// Each returns flat field names matching what App.jsx and parts.js use
// (watts, eff, cap, res, screenSize, fanSize, tg, radSize, cl, fans_inc etc.)
// ─────────────────────────────────────────────────────────────────────────────

function specsForGPU(d) {
  const s = {};
  // GPU chipset — "NVIDIA GeForce RTX 5060" → model
  const gpu = d['Graphics Processing Unit (GPU)'] || d['GPU Chipset'];
  if (gpu) {
    s.model = String(gpu).replace(/^NVIDIA\s+|^AMD\s+|^Intel\s+/i, '').trim();
    // Generation from model name
    const rtx = s.model.match(/RTX\s+(\d)/);
    if (rtx) {
      const gen = parseInt(rtx[1]);
      s.generation = gen === 5 ? 'RTX 50' : gen === 4 ? 'RTX 40' : gen === 3 ? 'RTX 30' : gen === 2 ? 'RTX 20' : 'Older';
    }
    const rx = s.model.match(/RX\s+(\d)/);
    if (rx) {
      const gen = parseInt(rx[1]);
      s.generation = gen === 9 ? 'RX 9000' : gen === 7 ? 'RX 7000' : gen === 6 ? 'RX 6000' : gen === 5 ? 'RX 5000' : 'Older';
    }
  }
  // VRAM
  const vram = parseGB(d['GPU Video Memory (RAM)']);
  if (vram) s.vram = vram;
  if (d['GPU Video Memory Type (RAM)']) s.vramType = d['GPU Video Memory Type (RAM)'];
  // Clocks
  const base = parseGHz(d['GPU Base Clock Frequency']);
  if (base) s.baseClock = base;
  const boost = parseGHz(d['GPU Boost Clock Frequency']);
  if (boost) s.boostClock = boost;
  // Power
  const tgp = parseWatts(d['Total Graphics Power']);
  const psu = parseWatts(d['Recommended Power Supply']);
  // Best Buy sometimes fills TGP with the PSU wattage (data error).
  // Real TGP is always less than recommended PSU. If they're equal, null out TDP.
  if (tgp && psu && tgp !== psu) s.tdp = tgp;
  else if (tgp && !psu) s.tdp = tgp;
  if (psu) s.recommendedPSU = psu;
  // Interface
  if (d['PCI Express Version']) {
    const m = String(d['PCI Express Version']).match(/(\d)(\.0)?/);
    if (m) s.pcie = 'Gen' + m[1];
  }
  // Fan count — Best Buy's "Cooling System" just says "Fan" for 1/2/3-fan cards alike.
  // Not reliable. Skip. (Can extract from product name if needed — left as TODO.)
  // Slot
  if (d['Slot Size']) s.slots = String(d['Slot Size']).replace(/\s+/g, '');
  return s;
}

function specsForCPU(d) {
  const s = {};
  // Cores — "12-core" → 12
  const cores = parseNum(d['Number of CPU Cores']);
  if (cores) s.cores = cores;
  const threads = parseNum(d['Number of CPU Threads']);
  if (threads) s.threads = threads;
  // Clocks in GHz
  const base = parseGHz(d['CPU Base Clock Frequency']);
  if (base) s.baseClock = base;
  const boost = parseGHz(d['CPU Boost Clock Frequency']);
  if (boost) s.boostClock = boost;
  // Power
  const tdp = parseWatts(d['Processor Base Power']);
  if (tdp) s.tdp = tdp;
  // Socket — "Socket AM5 (LGA 1718)" → "AM5"
  const socket = d['Processor Socket'];
  if (socket) {
    // Match first AM/LGA/sTR/sWRX token
    const m = String(socket).match(/\b(AM\d+|LGA\s*\d+|sTR\w*|sWRX\w+|TR\d+)\b/i);
    if (m) s.socket = m[1].toUpperCase().replace(/\s+/g, '');
  }
  // Cache — "64 megabytes" → 64
  const l3 = parseNum(d['L3 Cache']);
  if (l3) s.l3 = l3;
  // Integrated graphics
  if (d['Integrated Graphics']) s.igpu = parseBool(d['Integrated Graphics']);
  if (d['Integrated Graphics Processor']) s.igpuName = d['Integrated Graphics Processor'];
  // Memory support (useful for compat hints)
  if (d['Memory Type Supported']) s.memType = String(d['Memory Type Supported']).match(/DDR\d/i)?.[0]?.toUpperCase();
  if (d['Maximum Memory Supported']) s.maxMem = d['Maximum Memory Supported'];
  // Unlocked flag (overclockable indicator — mainly cosmetic)
  if (d['Unlocked Processor']) s.unlocked = parseBool(d['Unlocked Processor']);
  return s;
}

function specsForMotherboard(d) {
  const s = {};
  // Socket — "Socket AM4 (PGA 1331)" → "AM4"
  const socket = d['Processor Socket'] || d['Socket Type'] || d['CPU Socket'] || d['Socket'];
  if (socket) {
    const m = String(socket).match(/\b(AM\d+|LGA\s*\d+|sTR\w*|sWRX\w+|TR\d+)\b/i);
    if (m) s.socket = m[1].toUpperCase().replace(/\s+/g, '');
  }
  // Chipset — "AMD B550" → "B550"
  const chipset = d['Chipset'] || d['Chipset Type'];
  if (chipset) {
    const m = String(chipset).match(/\b([AXZBHWM]\d{3}[A-Z]?|X\d{3}E?)\b/i);
    s.chipset = m ? m[1].toUpperCase() : String(chipset).toUpperCase();
  }
  // Form factor
  const ff = d['Form Factor'] || d['Motherboard Form Factor'];
  if (ff) s.formFactor = ff;
  // Memory slots
  const slots = parseNum(d['Number Of Memory Slots'] || d['Memory Slots']);
  if (slots) s.memSlots = slots;
  // Max memory
  const maxMem = d['Maximum Memory Supported'] || d['Max Memory'];
  if (maxMem) s.maxMem = maxMem;
  // Memory type: "DDR4" / "DDR5"
  const memType = d['Memory Type Supported'] || d['Memory Technology'] || d['Memory Type'];
  if (memType) {
    const m = String(memType).match(/DDR\d/i);
    if (m) s.memType = m[0].toUpperCase();
  }
  // M.2 slots
  const m2 = parseNum(d['Number of M.2 Slots']);
  if (m2) s.m2Slots = m2;
  // WiFi
  if (d['Wireless Connectivity'] || d['Wireless Standard']) {
    const wifiStr = `${d['Wireless Connectivity'] || ''} ${d['Wireless Standard'] || ''}`;
    if (/Wi-?Fi 7|802\.11be/i.test(wifiStr)) s.wifi = 'WiFi 7';
    else if (/Wi-?Fi 6E/i.test(wifiStr)) s.wifi = 'WiFi 6E';
    else if (/Wi-?Fi 6|\bax\b/i.test(wifiStr)) s.wifi = 'WiFi 6';
    else if (/Wi-?Fi 5|\bac\b/i.test(wifiStr)) s.wifi = 'WiFi 5';
    else if (/none|no wi-fi/i.test(wifiStr)) s.wifi = 'None';
  }
  // Color
  if (d['Color']) s.color = d['Color'];
  return s;
}

function specsForRAM(d) {
  const s = {};
  // Total capacity: "16 gigabytes"
  const cap = parseGB(d['Memory Capacity (Total)'] || d['Total Memory Capacity'] || d['Memory Capacity']);
  if (cap) s.cap = cap;
  // Memory type: "DDR4" / "DDR5"
  const type = d['Type of Memory (RAM)'] || d['Memory Technology'] || d['Memory Type'];
  if (type) {
    const m = String(type).match(/DDR\d/i);
    if (m) s.memType = m[0].toUpperCase();
  }
  // Speed: "3600 megahertz" or "3600 MT/s"
  const speed = parseMHz(d['Speed'] || d['Memory Speed'] || d['Memory Clock Speed'] || d['Frequency']);
  if (speed) s.speed = speed;
  // Sticks in kit
  const modules = parseNum(d['Number Of Modules'] || d['Number of Modules']);
  if (modules) s.sticks = modules;
  // CAS latency: "18"
  const cas = d['CAS Latency'];
  if (cas) s.cl = parseNum(cas);
  // Form factor — DIMM vs SODIMM (desktop vs laptop)
  const form = d['Memory Format'] || d['Form Factor'];
  if (form) {
    if (/SODIMM|SO-DIMM/i.test(form)) s.form = 'SODIMM';
    else if (/UDIMM|DIMM/i.test(form)) s.form = 'DIMM';
  }
  // RGB / lighting
  const lighting = d['Lighting Type'];
  if (lighting) s.rgb = /RGB|LED/i.test(lighting) && !/none/i.test(lighting);
  // Color
  if (d['Color']) s.color = d['Color'];
  // Voltage: "1.35 volts"
  const voltage = d['Voltage'];
  if (voltage) {
    const v = parseNum(voltage);
    if (v) s.voltage = v;
  }
  return s;
}

function specsForStorage(d) {
  const s = {};
  // Capacity: "500 gigabytes" or "2 terabytes"
  const cap = parseCapacity(d['Storage Capacity'] || d['Total Capacity'] || d['Drive Capacity']);
  if (cap) s.cap = cap;
  // Drive type — "SSD" / "Hard Drive" / "Solid State Hybrid"
  const driveType = d['Storage Drive Type'];
  if (driveType) s.driveType = driveType;
  // Form factor: "M.2 2280", "2.5 inches", "3.5 inches"
  const ff = d['Form Factor'] || d['Drive Size'];
  if (ff) s.form = String(ff).replace(/inch(es)?|"/gi, '').trim();
  // Interface: "PCIe Gen 3 x4", "SATA III 6Gb/s", "USB 3.2"
  const iface = d['Interface(s)'] || d['Interface'] || d['Drive Interface'];
  if (iface) {
    s.interface = iface;
    // PCIe gen from interface string
    const pcieM = String(iface).match(/(?:PCIe?|PCI\s*Express)\s*(?:Gen\s*)?(\d)/i);
    if (pcieM) s.pcie = 'Gen' + pcieM[1];
  }
  // Read/write speeds: "3500 megabytes per second"
  const read = parseNum(d['Maximum Read Speed'] || d['Sequential Read Speed']);
  if (read) s.seq_r = read;
  const write = parseNum(d['Maximum Write Speed'] || d['Sequential Write Speed']);
  if (write) s.seq_w = write;
  // RPM for hard drives
  const rpm = parseNum(d['Spindle Speed'] || d['Rotational Speed']);
  if (rpm) s.rpm = rpm;
  // NAND type for SSDs: "TLC", "QLC", "MLC"
  const nand = d['NAND Flash Memory Type'];
  if (nand) s.nand = nand;
  // Heatsink: "Yes" / "No"
  if (d['Heatsink']) s.heatsink = parseBool(d['Heatsink']);
  return s;
}

function specsForPSU(d) {
  const s = {};
  // Wattage: "700 watts"
  const watts = parseWatts(d['Wattage'] || d['Power Output'] || d['Maximum Power']);
  if (watts) s.watts = watts;
  // Efficiency: "80 PLUS" / "80 PLUS Gold" / etc.
  const eff = d['Energy Efficiency'] || d['80 Plus Certification'] || d['Certification'];
  if (eff) {
    const m = String(eff).match(/\b(Titanium|Platinum|Gold|Silver|Bronze|White|Standard)\b/i);
    if (m) s.eff = m[1];
    else if (/80\s*PLUS/i.test(eff)) s.eff = 'White'; // just "80 PLUS" = White tier
  }
  // Modular: "Non-modular" / "Semi-modular" / "Full Modular"
  const modular = d['Modular'] || d['Modular Cables'];
  if (modular) {
    if (/full/i.test(modular)) s.modular = 'Full';
    else if (/semi/i.test(modular)) s.modular = 'Semi';
    else if (/non/i.test(modular)) s.modular = 'None';
  }
  // Form factor: "ATX", "SFX", "SFX-L"
  const ff = d['Form Factor'];
  if (ff) s.formFactor = ff;
  // Color, RGB
  if (d['Color']) s.color = d['Color'];
  const lighting = d['Lighting Type'];
  if (lighting) s.rgb = /RGB|LED/i.test(lighting) && !/none/i.test(lighting);
  // Fan count
  const fans = parseNum(d['Number of Fans Included']);
  if (fans) s.fans = fans;
  return s;
}

function specsForCase(d) {
  const s = {};
  // Motherboard form factor support: "ATX", "microATX", "Mini-ITX"
  const ff = d['Motherboard Form Factor'] || d['Supported Motherboard Form Factor'] || d['Form Factor'];
  if (ff) s.formFactor = ff;
  // Tower size from "Enclosure Type": "Mid tower", "Full tower", "Mini tower"
  const enc = d['Enclosure Type'] || d['Case Type'] || d['Tower Type'];
  if (enc) {
    if (/full/i.test(enc)) s.tower = 'Full';
    else if (/mid/i.test(enc)) s.tower = 'Mid';
    else if (/mini|micro|SFF/i.test(enc)) s.tower = 'Mini';
  }
  // Tempered glass — check material + window panel
  const material = `${d['Case Material'] || ''} ${d['Window Panel(s)'] || ''} ${d['Side Panel'] || ''}`;
  s.tg = /tempered glass|glass/i.test(material);
  // Color
  if (d['Color']) s.color = d['Color'];
  // RGB: "Customizable Case Lighting" = "Yes" or Lighting Type != "None"
  const rgb = d['Customizable Case Lighting'];
  if (rgb) s.rgb = parseBool(rgb);
  else if (d['Lighting Type']) s.rgb = !/none/i.test(d['Lighting Type']);
  // Drive bays
  const drives35 = parseNum(d['Number Of Internal 3.5" Bays'] || d['3.5" Drive Bays']);
  if (drives35 != null) s.drive35 = drives35;
  const drives25 = parseNum(d['Number Of Internal 2.5" Bays'] || d['2.5" Drive Bays']);
  if (drives25 != null) s.drive25 = drives25;
  // Fan / cooling support
  const fansIncluded = parseNum(d['Number of Fans Included']);
  if (fansIncluded != null) s.fans_inc = fansIncluded;
  const fansMax = parseNum(d['Number of Fans Supported']);
  if (fansMax) s.fans_max = fansMax;
  // Max GPU length (useful compatibility filter): "350 millimeters" → 350
  const gpuLen = parseNum(d['Maximum GPU Length']);
  if (gpuLen) s.maxGpuLen = gpuLen;
  // Max CPU cooler height
  const coolerHeight = parseNum(d['Maximum CPU Cooler Height']);
  if (coolerHeight) s.maxCoolerHeight = coolerHeight;
  return s;
}

function specsForCPUCooler(d) {
  const s = {};
  // Cooler type from "Cooling System": "Air" / "Liquid" / "Hybrid"
  const type = d['Cooling System'] || d['Cooler Type'] || d['Type'];
  if (type) {
    if (/liquid|water|AIO/i.test(type)) s.coolerType = 'AIO';
    else if (/air/i.test(type)) s.coolerType = 'Air';
    else if (/hybrid/i.test(type)) s.coolerType = 'Hybrid';
  }
  // Fan size: "120 millimeters"
  const fan = parseNum(d['Fan Size']);
  if (fan) s.fanSize = fan;
  // Radiator size (for AIO)
  const rad = parseNum(d['Radiator Size']);
  if (rad) s.radSize = rad;
  // Noise: "26 decibels adjusted"
  const noise = parseNum(d['Noise Level']);
  if (noise) s.noise = noise;
  // TDP rating
  const tdp = parseWatts(d['TDP Rating'] || d['Maximum TDP']);
  if (tdp) s.tdp_rating = tdp;
  // RPM
  const rpm = parseNum(d['Fan Speed']);
  if (rpm) s.rpm = rpm;
  // Airflow (CFM): "42 cubic feet per minute"
  const cfm = parseNum(d['Airflow Volume'] || d['Airflow'] || d['CFM']);
  if (cfm) s.cfm = cfm;
  // Fan count
  const fansIncluded = parseNum(d['Number of Fans Included']);
  if (fansIncluded) s.fans_inc = fansIncluded;
  // RGB
  const lighting = d['Lighting Type'];
  if (lighting) s.rgb = /RGB|LED/i.test(lighting) && !/none/i.test(lighting);
  // Color
  if (d['Color']) s.color = d['Color'];
  // Socket support (sometimes useful for compat)
  const socket = d['Processor Socket'];
  if (socket) s.socketsSupported = socket;
  return s;
}

function specsForMonitor(d) {
  const s = {};
  const size = parseNum(d['Screen Size'] || d['Display Size'] || d['Screen Size Class']);
  if (size) s.screenSize = size;
  const res = d['Maximum Resolution'] || d['Native Resolution'] || d['Resolution'];
  if (res) {
    if (/4K|3840/i.test(res)) s.res = '4K';
    else if (/1440|QHD/i.test(res)) s.res = '1440p';
    else if (/1080|FHD/i.test(res)) s.res = '1080p';
    else s.res = res;
  }
  const refresh = parseNum(d['Refresh Rate'] || d['Maximum Refresh Rate']);
  if (refresh) s.refresh = refresh;
  const panel = d['Panel Type'] || d['Display Type'];
  if (panel) {
    if (/OLED/i.test(panel)) s.panel = 'OLED';
    else if (/IPS/i.test(panel)) s.panel = 'IPS';
    else if (/VA/i.test(panel)) s.panel = 'VA';
    else if (/TN/i.test(panel)) s.panel = 'TN';
  }
  const response = parseNum(d['Response Time']);
  if (response) s.response = response;
  const curved = d['Curved Screen'];
  if (curved) s.curved = parseBool(curved);
  const contrast = d['Contrast Ratio'];
  if (contrast) s.contrast = contrast;
  return s;
}

function specsForCaseFan(d) {
  const s = {};
  // Fan size: "120 millimeters"
  const size = parseNum(d['Fan Size']);
  if (size) s.fanSize = size;
  // CFM: "40.6 cubic feet per minute"
  const cfm = parseNum(d['Airflow Volume'] || d['Airflow'] || d['CFM']);
  if (cfm) s.cfm = cfm;
  // Noise: "26 decibels"
  const noise = parseNum(d['Noise Level']);
  if (noise) s.noise = noise;
  // RPM: "1500 revolutions per minute"
  const rpm = parseNum(d['Fan Speed']);
  if (rpm) s.rpm = rpm;
  // RGB / lighting
  const lighting = d['Lighting Type'] || d['LED Type'] || d['Lighting'];
  if (lighting) s.rgb = /RGB|LED/i.test(lighting) && !/none/i.test(lighting);
  // PWM: connector type "4 Pin" or "4-pin"
  const pwm = d['Fan/Cooling System Connector'] || d['Connector Type'];
  if (pwm) s.pwm = /PWM|4[-\s]?pin/i.test(pwm);
  // Pack count: "Number of Fans Included" (1 vs 3-pack)
  const pack = parseNum(d['Number of Fans Included']);
  if (pack) s.fans_inc = pack;
  // Color
  if (d['Color']) s.color = d['Color'];
  return s;
}

function specsForSoundCard(d) {
  const s = {};
  const channels = d['Audio Channels'] || d['Number of Channels'];
  if (channels) s.channels = channels;
  const snr = parseNum(d['Signal-to-Noise Ratio'] || d['SNR']);
  if (snr) s.snr = snr;
  const sampleRate = parseNum(d['Sample Rate']);
  if (sampleRate) s.sampleRate = sampleRate;
  const interface_ = d['Interface'];
  if (interface_) s.interface = interface_;
  return s;
}

function specsForNetworkCard(d) {
  const s = {};
  const wifi = d['Wi-Fi Standard'] || d['Wireless Standard'];
  if (wifi) {
    if (/Wi-Fi 7|802\.11be/i.test(wifi)) s.wifiStandard = 'WiFi 7';
    else if (/Wi-Fi 6E/i.test(wifi)) s.wifiStandard = 'WiFi 6E';
    else if (/Wi-Fi 6|802\.11ax/i.test(wifi)) s.wifiStandard = 'WiFi 6';
    else if (/802\.11ac/i.test(wifi)) s.wifiStandard = 'WiFi 5';
    else s.wifiStandard = wifi;
  }
  const speed = d['Maximum Data Transfer Rate'] || d['Data Transfer Rate'];
  if (speed) s.maxSpeed = speed;
  const chipset = d['Chipset'];
  if (chipset) s.chipset = chipset;
  const interface_ = d['Interface'] || d['Connection Type'];
  if (interface_) s.interface = interface_;
  return s;
}

function specsForOpticalDrive(d) {
  const s = {};
  const types = [];
  if (/BD|Blu-ray/i.test(JSON.stringify(d))) types.push('Blu-ray');
  if (/DVD/i.test(JSON.stringify(d))) types.push('DVD');
  if (/CD/i.test(JSON.stringify(d))) types.push('CD');
  if (types.length) s.driveType = types.join('/');
  const read = d['Read Speed'] || d['Maximum Read Speed'];
  if (read) s.readSpeed = read;
  const write = d['Write Speed'] || d['Maximum Write Speed'];
  if (write) s.writeSpeed = write;
  const interface_ = d['Interface'];
  if (interface_) s.interface = interface_;
  return s;
}

const SPEC_MAPPERS = {
  GPU: specsForGPU,
  CPU: specsForCPU,
  Motherboard: specsForMotherboard,
  RAM: specsForRAM,
  Storage: specsForStorage,
  PSU: specsForPSU,
  Case: specsForCase,
  CPUCooler: specsForCPUCooler,
  Monitor: specsForMonitor,
  CaseFan: specsForCaseFan,
  SoundCard: specsForSoundCard,
  NetworkCard: specsForNetworkCard,
  OpticalDrive: specsForOpticalDrive,
};

// ─────────────────────────────────────────────────────────────────────────────
// CategoryPath whitelist — matches against Best Buy's full navigation path.
//
// Each product has a categoryPath like:
//   [
//     { id: "abcat0500000", name: "Computers & Tablets" },
//     { id: "abcat0507000", name: "Computer Components" },
//     { id: "abcat0507010", name: "GPUs / Video Graphics Cards" }
//   ]
//
// Matching strategy: any level of the path must contain one of these parent
// categories. This is stable against Best Buy renaming leaf categories,
// adding brand-specific sub-categories, etc.
// ─────────────────────────────────────────────────────────────────────────────

const PATH_WHITELIST = {
  Motherboard:  ['Motherboards'],
  CPU:          ['CPUs / Processors', 'Processors'],
  GPU:          ['GPUs / Video Graphics Cards', 'Graphics Cards'],
  RAM:          ['Computer Memory (RAM)', 'Computer Memory'],
  Storage:      ['Hard Drives, SSD & Storage', 'Internal Hard Drives', 'Internal Solid State Drives'],
  PSU:          ['Power Supplies'],
  Case:         ['Computer Cases'],
  CPUCooler:    ['Computer Cooling', 'CPU Fans & Heatsinks', 'Water Cooling'],
  Monitor:      ['Monitors', 'Computer Monitors', 'Gaming Monitors'],
  CaseFan:      ['Computer Cooling', 'Case Fans'],
  SoundCard:    ['Sound Cards'],
  NetworkCard:  ['Wi-Fi & Networking', 'Networking', 'Wi-Fi Adapters', 'Network Cards'],
  OpticalDrive: ['Internal Optical Drives', 'Optical Drives'],
};

// Check whether a Best Buy product's categoryPath contains any of our whitelist
// entries for this category. Returns true/false.
function pathMatchesCategory(categoryPath, ourCategory) {
  if (!Array.isArray(categoryPath)) return false;
  const allowed = PATH_WHITELIST[ourCategory];
  if (!allowed) return true;   // no whitelist = accept everything

  for (const level of categoryPath) {
    if (!level?.name) continue;
    for (const entry of allowed) {
      if (level.name === entry) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  if (!existsSync(DISCOVERY_DIR)) {
    console.error(`Discovery dir not found: ${DISCOVERY_DIR}`);
    console.error('Run bestbuy-discover.js first.');
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json'));
  const categories = ONLY_CATEGORY ? [ONLY_CATEGORY + '.json'] : files;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Best Buy spec enrichment via Developer API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Categories:', categories.map(f => f.replace('.json', '')).join(', '));
  console.log('Limit:     ', LIMIT || 'none');
  console.log('Resume:    ', RESUME);
  console.log('Rate:      ', `1 req every ${RATE_LIMIT_MS}ms (~${(1000 / RATE_LIMIT_MS).toFixed(1)}/sec)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const grandStats = { total: 0, enriched: 0, failed: 0, skippedResume: 0 };

  for (const file of categories) {
    const category = file.replace(/\.json$/, '');
    const mapper = SPEC_MAPPERS[category];
    if (!mapper) {
      console.log(`━━━ ${category} ━━━ no mapper defined, skipping`);
      continue;
    }

    const discoveryPath = join(DISCOVERY_DIR, file);
    if (!existsSync(discoveryPath)) {
      console.log(`━━━ ${category} ━━━ no discovery file, skipping`);
      continue;
    }

    const discovered = JSON.parse(readFileSync(discoveryPath, 'utf8'));
    const outPath = join(OUTPUT_DIR, file);
    const enriched = (RESUME && existsSync(outPath)) ? JSON.parse(readFileSync(outPath, 'utf8')) : [];
    const enrichedIds = new Set(enriched.map(p => p.catalogItemId));

    let items = discovered;
    if (LIMIT) items = items.slice(0, LIMIT);

    console.log(`\n━━━ ${category} (${items.length} products${RESUME ? `, ${enrichedIds.size} already enriched` : ''}) ━━━`);

    let done = 0;
    let failed = 0;
    let skipped = 0;
    let filteredPath = 0;
    const rejectedPaths = new Map(); // leaf category name → count

    for (const disc of items) {
      if (RESUME && enrichedIds.has(disc.catalogItemId)) {
        skipped++;
        grandStats.skippedResume++;
        continue;
      }

      const sku = disc.bestBuySku || disc.catalogItemId;
      try {
        // New v2 discovery files already include _details from the catalog API call.
        // Skip the API call if they're present — saves ~21 min per full run.
        let product;
        if (disc._details && Object.keys(disc._details).length > 0) {
          // Build a synthetic "product" from the discovery record
          product = {
            name: disc.name,
            modelNumber: disc.mpn,
            onSale: disc.onSale,
            regularPrice: disc.originalPrice,
            salePrice: disc.price,
            features: disc.features || [],
            categoryPath: (disc.categoryPath || '').split(' > ').map(name => ({ name })),
            color: disc._scalars?.color,
            weight: disc._scalars?.weight,
            depth: disc._scalars?.depth,
            height: disc._scalars?.height,
            width: disc._scalars?.width,
            details: Object.entries(disc._details).map(([name, value]) => ({ name, value })),
          };
        } else {
          // Legacy discovery files lack details — fetch from API
          product = await fetchProduct(sku);
        }

        // Path filter: reject products whose categoryPath doesn't contain
        // an allowed parent category for this bucket.
        if (!pathMatchesCategory(product.categoryPath, category)) {
          filteredPath++;
          const leaf = product.categoryPath?.[product.categoryPath.length - 1]?.name || 'unknown';
          rejectedPaths.set(leaf, (rejectedPaths.get(leaf) || 0) + 1);
          continue;
        }

        const detailsMap = detailsToMap(product.details);
        // Merge top-level scalar fields into the map (weight/dimensions/color live at top level)
        for (const k of ['color', 'weight', 'depth', 'height', 'width']) {
          if (product[k] !== undefined) detailsMap[k.charAt(0).toUpperCase() + k.slice(1)] = product[k];
        }

        const specs = mapper(detailsMap);

        enriched.push({
          ...disc,
          specs,
          bestBuyName: product.name,           // full Best Buy product name (often better)
          bestBuyModelNumber: product.modelNumber,
          bestBuyWeight: product.weight,       // "1.42 pounds"
          bestBuyDimensions: { width: product.width, height: product.height, depth: product.depth },
          categoryPath: product.categoryPath?.map(c => c.name).join(' > '),
          condition: disc.condition || 'new',  // pass through from v2 discovery
          onSale: product.onSale === true,
          regularPrice: product.regularPrice,
          salePrice: product.salePrice,
          features: product.features || [],    // ["5 bullet points"]
          enrichedAt: new Date().toISOString(),
        });

        done++;
        grandStats.enriched++;
      } catch (err) {
        failed++;
        grandStats.failed++;
        if (failed <= 3) console.log(`    ❌ SKU ${sku}: ${err.message}`);
      }

      grandStats.total++;

      // Persist every 50 items so we don't lose progress on crash
      if (done > 0 && done % 50 === 0) {
        writeFileSync(outPath, JSON.stringify(enriched, null, 2));
        console.log(`  [${done}/${items.length}] (failed: ${failed}, skipped: ${skipped}) — saved`);
      }

      // Rate-limit only if we're actually hitting the API
      // (v2 discovery files include _details, so no API calls needed)
      if (!disc._details || Object.keys(disc._details).length === 0) {
        await sleep(RATE_LIMIT_MS);
      }
    }

    // Final save
    writeFileSync(outPath, JSON.stringify(enriched, null, 2));
    console.log(`  ${category.padEnd(14)}  enriched ${done}, failed ${failed}, skipped ${skipped}, filtered-path ${filteredPath}  →  ${outPath}`);

    // Show top rejected leaf categories so we can tune if needed
    if (rejectedPaths.size > 0) {
      const top = [...rejectedPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  Top rejected leaves: ${top.map(([c, n]) => `"${c}" (${n})`).join(', ')}`);
    }

    grandStats.filteredPath = (grandStats.filteredPath || 0) + filteredPath;
  }

  console.log('\n━━━ GRAND TOTALS ━━━');
  console.log(`  Total attempted:   ${grandStats.total}`);
  console.log(`  Enriched:          ${grandStats.enriched}`);
  console.log(`  Failed:            ${grandStats.failed}`);
  console.log(`  Skipped (resume):  ${grandStats.skippedResume}`);
  console.log(`  Filtered (path):   ${grandStats.filteredPath || 0}`);

  console.log('\nNext: run bestbuy-merge.js to merge into parts.js');
})();
