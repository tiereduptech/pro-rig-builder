#!/usr/bin/env node
/**
 * backfill-cpu-specs.js — fill CPU tdp, cores, threads, bench via dictionary.
 *
 * Same approach as backfill-gpu-specs.js: match model via regex against a
 * dictionary of known CPUs with reference specs.
 *
 * bench is normalized 0-100 scale (Cinebench R23 multi-thread).
 * TDP = PPT (AMD) or PL1 base (Intel) per manufacturer spec sheet.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─────────────────────────────────────────────────────────────────────────────
// CPU DATABASE — ordered most-specific first (longest pattern wins)
// ─────────────────────────────────────────────────────────────────────────────
const CPU_DB = [
  // ─── AMD Zen 5 (Ryzen 9000 / AM5, 2024-25) ───
  { pat: /Ryzen\s*9\s*9950X3D/i,   tdp: 170, cores: 16, threads: 32, bench: 100 },
  { pat: /Ryzen\s*9\s*9950X\b/i,   tdp: 170, cores: 16, threads: 32, bench: 96 },
  { pat: /Ryzen\s*9\s*9900X3D/i,   tdp: 120, cores: 12, threads: 24, bench: 88 },
  { pat: /Ryzen\s*9\s*9900X\b/i,   tdp: 120, cores: 12, threads: 24, bench: 82 },
  { pat: /Ryzen\s*7\s*9850X3D/i,   tdp: 120, cores:  8, threads: 16, bench: 75 },
  { pat: /Ryzen\s*7\s*9800X3D/i,   tdp: 120, cores:  8, threads: 16, bench: 72 },
  { pat: /Ryzen\s*7\s*9700X\b/i,   tdp:  65, cores:  8, threads: 16, bench: 68 },
  { pat: /Ryzen\s*5\s*9600X\b/i,   tdp:  65, cores:  6, threads: 12, bench: 58 },

  // ─── AMD Zen 4 Raphael (Ryzen 7000 / AM5, 2022-23) ───
  { pat: /Ryzen\s*9\s*7950X3D/i,   tdp: 120, cores: 16, threads: 32, bench: 92 },
  { pat: /Ryzen\s*9\s*7950X\b/i,   tdp: 170, cores: 16, threads: 32, bench: 90 },
  { pat: /Ryzen\s*9\s*7900X3D/i,   tdp: 120, cores: 12, threads: 24, bench: 80 },
  { pat: /Ryzen\s*9\s*7900X\b/i,   tdp: 170, cores: 12, threads: 24, bench: 78 },
  { pat: /Ryzen\s*9\s*7900\b/i,    tdp:  65, cores: 12, threads: 24, bench: 72 },
  { pat: /Ryzen\s*7\s*7800X3D/i,   tdp: 120, cores:  8, threads: 16, bench: 68 },
  { pat: /Ryzen\s*7\s*7700X\b/i,   tdp: 105, cores:  8, threads: 16, bench: 62 },
  { pat: /Ryzen\s*7\s*7700\b/i,    tdp:  65, cores:  8, threads: 16, bench: 58 },
  { pat: /Ryzen\s*5\s*7600X3D/i,   tdp:  65, cores:  6, threads: 12, bench: 54 },
  { pat: /Ryzen\s*5\s*7600X\b/i,   tdp: 105, cores:  6, threads: 12, bench: 52 },
  { pat: /Ryzen\s*5\s*7600\b/i,    tdp:  65, cores:  6, threads: 12, bench: 48 },

  // ─── AMD Zen 4 Phoenix (Ryzen 8000G / AM5 APU) ───
  { pat: /Ryzen\s*7\s*8700G/i,     tdp:  65, cores:  8, threads: 16, bench: 55 },
  { pat: /Ryzen\s*7\s*8700F/i,     tdp:  65, cores:  8, threads: 16, bench: 56 },
  { pat: /Ryzen\s*5\s*8600G/i,     tdp:  65, cores:  6, threads: 12, bench: 45 },
  { pat: /Ryzen\s*5\s*8500G/i,     tdp:  65, cores:  6, threads: 12, bench: 40 },
  { pat: /Ryzen\s*5\s*8400F/i,     tdp:  65, cores:  6, threads: 12, bench: 42 },
  { pat: /Ryzen\s*3\s*8300G/i,     tdp:  65, cores:  4, threads:  8, bench: 30 },

  // F-variants that were missed (identical cores/threads, slight bench bump)
  { pat: /Ryzen\s*5\s*7500F/i,     tdp:  65, cores:  6, threads: 12, bench: 46 },
  { pat: /Ryzen\s*3\s*5300G/i,     tdp:  65, cores:  4, threads:  8, bench: 24 },
  { pat: /Ryzen\s*3\s*3300X/i,     tdp:  65, cores:  4, threads:  8, bench: 18 },
  { pat: /Ryzen\s*3\s*3100/i,      tdp:  65, cores:  4, threads:  8, bench: 14 },

  // Ryzen 5000XT refresh and Threadripper 9000 (2025 releases)
  { pat: /Ryzen\s*9\s*5900XT/i,    tdp: 105, cores: 16, threads: 32, bench: 62 },
  { pat: /Ryzen\s*7\s*5800XT/i,    tdp: 105, cores:  8, threads: 16, bench: 52 },
  { pat: /Threadripper\s*9980X/i,  tdp: 350, cores: 64, threads:128, bench: 92 },
  { pat: /Threadripper\s*9970X/i,  tdp: 350, cores: 32, threads: 64, bench: 82 },
  { pat: /Threadripper\s*9960X/i,  tdp: 350, cores: 24, threads: 48, bench: 72 },

  // Intel 14/13th gen F variants that the earlier patterns missed
  { pat: /Core\s*i9[-\s]*14900F/i, tdp: 65, cores: 24, threads: 32, bench: 80 },
  { pat: /Core\s*i7[-\s]*14700F/i, tdp: 65, cores: 20, threads: 28, bench: 68 },
  { pat: /Core\s*i5[-\s]*14500F/i, tdp: 65, cores: 14, threads: 20, bench: 48 },

  // Intel Core Ultra 200S Super refresh (2025)
  { pat: /Core\s*Ultra\s*7\s*(?:Processor\s*)?270K?/i,    tdp: 125, cores: 24, threads: 24, bench: 76 },

  // Match i5-12500 even with (12th Gen) between "Core i5" and "12500"
  // The alt-fallback is to just match the SKU directly
  { pat: /\bi5[-\s]*12500\b/i,     tdp:  65, cores:  6, threads: 12, bench: 32 },
  { pat: /\bi7[-\s]*12700[fF]?\b/i,tdp:  65, cores: 12, threads: 20, bench: 50 },

  // Ryzen 5 7500X3D (listed on Amazon but doesn't exist — treat as 7600X3D fallback)
  { pat: /Ryzen\s*5\s*7500X3D/i,   tdp:  65, cores:  6, threads: 12, bench: 52 },

  // Xeon 6900P
  { pat: /Xeon\s*6900P/i,          tdp: 500, cores:128, threads:256, bench: 96 },

  // Core Ultra without space between "Ultra" and tier (i.e. "Ultra5 225F")
  { pat: /Core\s*Ultra\s*5\s*225F?/i,    tdp:  65, cores: 10, threads: 10, bench: 44 },

  // 8th-gen Coffee Lake (T = low-power variant)
  { pat: /Core\s*i5[-\s]*8400T/i,  tdp:  35, cores:  6, threads:  6, bench: 12 },
  { pat: /Core\s*i5[-\s]*8400/i,   tdp:  65, cores:  6, threads:  6, bench: 14 },
  { pat: /Core\s*i7[-\s]*8700K/i,  tdp:  95, cores:  6, threads: 12, bench: 18 },
  { pat: /Core\s*i7[-\s]*8700/i,   tdp:  65, cores:  6, threads: 12, bench: 16 },

  // ─── AMD Zen 3 Vermeer (Ryzen 5000 / AM4, 2020-22) ───
  { pat: /Ryzen\s*9\s*5950X\b/i,   tdp: 105, cores: 16, threads: 32, bench: 68 },
  { pat: /Ryzen\s*9\s*5900X\b/i,   tdp: 105, cores: 12, threads: 24, bench: 60 },
  { pat: /Ryzen\s*9\s*5900\b/i,    tdp:  65, cores: 12, threads: 24, bench: 56 },
  { pat: /Ryzen\s*7\s*5800X3D/i,   tdp: 105, cores:  8, threads: 16, bench: 54 },
  { pat: /Ryzen\s*7\s*5800X\b/i,   tdp: 105, cores:  8, threads: 16, bench: 50 },
  { pat: /Ryzen\s*7\s*5800\b/i,    tdp:  65, cores:  8, threads: 16, bench: 46 },
  { pat: /Ryzen\s*7\s*5700X3D/i,   tdp:  65, cores:  8, threads: 16, bench: 48 },
  { pat: /Ryzen\s*7\s*5700X\b/i,   tdp:  65, cores:  8, threads: 16, bench: 44 },
  { pat: /Ryzen\s*7\s*5700G/i,     tdp:  65, cores:  8, threads: 16, bench: 40 },
  { pat: /Ryzen\s*7\s*5700\b/i,    tdp:  65, cores:  8, threads: 16, bench: 42 },
  { pat: /Ryzen\s*5\s*5600X3D/i,   tdp:  65, cores:  6, threads: 12, bench: 40 },
  { pat: /Ryzen\s*5\s*5600X\b/i,   tdp:  65, cores:  6, threads: 12, bench: 38 },
  { pat: /Ryzen\s*5\s*5600G/i,     tdp:  65, cores:  6, threads: 12, bench: 32 },
  { pat: /Ryzen\s*5\s*5600\b/i,    tdp:  65, cores:  6, threads: 12, bench: 34 },
  { pat: /Ryzen\s*5\s*5500\b/i,    tdp:  65, cores:  6, threads: 12, bench: 28 },

  // ─── AMD Zen 2 Matisse (Ryzen 3000 / AM4, 2019) ───
  { pat: /Ryzen\s*9\s*3950X\b/i,   tdp: 105, cores: 16, threads: 32, bench: 44 },
  { pat: /Ryzen\s*9\s*3900X\b/i,   tdp: 105, cores: 12, threads: 24, bench: 38 },
  { pat: /Ryzen\s*7\s*3800X\b/i,   tdp: 105, cores:  8, threads: 16, bench: 32 },
  { pat: /Ryzen\s*7\s*3700X\b/i,   tdp:  65, cores:  8, threads: 16, bench: 30 },
  { pat: /Ryzen\s*5\s*3600X\b/i,   tdp:  95, cores:  6, threads: 12, bench: 24 },
  { pat: /Ryzen\s*5\s*3600\b/i,    tdp:  65, cores:  6, threads: 12, bench: 22 },

  // ─── AMD Zen+ Pinnacle Ridge (Ryzen 2000 / AM4) ───
  { pat: /Ryzen\s*7\s*2700X\b/i,   tdp: 105, cores:  8, threads: 16, bench: 20 },

  // ─── AMD Zen Summit Ridge (Ryzen 1000 / AM4) ───
  { pat: /Ryzen\s*7\s*1800X\b/i,   tdp:  95, cores:  8, threads: 16, bench: 16 },
  { pat: /Ryzen\s*5\s*1600X\b/i,   tdp:  95, cores:  6, threads: 12, bench: 12 },
  { pat: /Ryzen\s*5\s*1600\b/i,    tdp:  65, cores:  6, threads: 12, bench: 10 },

  // ─── AMD Threadripper (sTR5) ───
  { pat: /Threadripper\s*(?:PRO\s*)?9995WX/i, tdp: 350, cores: 96, threads: 192, bench: 100 },
  { pat: /Threadripper\s*(?:PRO\s*)?7995WX/i, tdp: 350, cores: 96, threads: 192, bench: 100 },
  { pat: /Threadripper\s*(?:PRO\s*)?7985WX/i, tdp: 350, cores: 64, threads: 128, bench: 90 },
  { pat: /Threadripper\s*(?:PRO\s*)?7975WX/i, tdp: 350, cores: 32, threads: 64,  bench: 80 },
  { pat: /Threadripper\s*(?:PRO\s*)?7965WX/i, tdp: 350, cores: 24, threads: 48,  bench: 72 },
  { pat: /Threadripper\s*7980X/i,             tdp: 350, cores: 64, threads: 128, bench: 90 },
  { pat: /Threadripper\s*7970X/i,             tdp: 350, cores: 32, threads: 64,  bench: 80 },
  { pat: /Threadripper\s*7960X/i,             tdp: 350, cores: 24, threads: 48,  bench: 70 },

  // ─── AMD EPYC 9005 series (Turin / Zen 5, 2024) ─────────────────────────────
  // Highest-core-count server CPUs. bench=100 is our max scale.
  { pat: /EPYC\s*9965/i,           tdp: 500, cores:192, threads:384, bench:100 },
  { pat: /EPYC\s*9845/i,           tdp: 390, cores:160, threads:320, bench: 96 },
  { pat: /EPYC\s*9825/i,           tdp: 390, cores:144, threads:288, bench: 94 },
  { pat: /EPYC\s*9755/i,           tdp: 500, cores:128, threads:256, bench: 98 },
  { pat: /EPYC\s*9745/i,           tdp: 400, cores:128, threads:256, bench: 96 },
  { pat: /EPYC\s*9655P?/i,         tdp: 400, cores: 96, threads:192, bench: 92 },
  { pat: /EPYC\s*9645/i,           tdp: 320, cores: 96, threads:192, bench: 90 },
  { pat: /EPYC\s*9575F/i,          tdp: 400, cores: 64, threads:128, bench: 86 },
  { pat: /EPYC\s*9565/i,           tdp: 400, cores: 72, threads:144, bench: 85 },
  { pat: /EPYC\s*9555P?/i,         tdp: 360, cores: 64, threads:128, bench: 84 },
  { pat: /EPYC\s*9475F/i,          tdp: 400, cores: 48, threads: 96, bench: 78 },
  { pat: /EPYC\s*9455P?/i,         tdp: 300, cores: 48, threads: 96, bench: 74 },
  { pat: /EPYC\s*9375F/i,          tdp: 320, cores: 32, threads: 64, bench: 68 },
  { pat: /EPYC\s*9355P?/i,         tdp: 280, cores: 32, threads: 64, bench: 64 },
  { pat: /EPYC\s*9335/i,           tdp: 210, cores: 32, threads: 64, bench: 60 },
  { pat: /EPYC\s*9275F/i,          tdp: 320, cores: 24, threads: 48, bench: 56 },
  { pat: /EPYC\s*9255/i,           tdp: 200, cores: 24, threads: 48, bench: 52 },
  { pat: /EPYC\s*9175F/i,          tdp: 320, cores: 16, threads: 32, bench: 48 },
  { pat: /EPYC\s*9135/i,           tdp: 200, cores: 16, threads: 32, bench: 42 },
  { pat: /EPYC\s*9115/i,           tdp: 125, cores: 16, threads: 32, bench: 36 },
  { pat: /EPYC\s*9015/i,           tdp: 125, cores:  8, threads: 16, bench: 22 },

  // ─── AMD EPYC 9004 series (Genoa / Zen 4, 2022-23) ──────────────────────────
  { pat: /EPYC\s*9684X/i,          tdp: 400, cores: 96, threads:192, bench: 88 },
  { pat: /EPYC\s*9654P?/i,         tdp: 360, cores: 96, threads:192, bench: 86 },
  { pat: /EPYC\s*9634/i,           tdp: 290, cores: 84, threads:168, bench: 82 },
  { pat: /EPYC\s*9554P?/i,         tdp: 360, cores: 64, threads:128, bench: 78 },
  { pat: /EPYC\s*9534/i,           tdp: 280, cores: 64, threads:128, bench: 76 },
  { pat: /EPYC\s*9474F/i,          tdp: 360, cores: 48, threads: 96, bench: 72 },
  { pat: /EPYC\s*9454P?/i,         tdp: 290, cores: 48, threads: 96, bench: 68 },
  { pat: /EPYC\s*9384X/i,          tdp: 320, cores: 32, threads: 64, bench: 64 },
  { pat: /EPYC\s*9374F/i,          tdp: 320, cores: 32, threads: 64, bench: 62 },
  { pat: /EPYC\s*9354P?/i,         tdp: 280, cores: 32, threads: 64, bench: 58 },
  { pat: /EPYC\s*9334/i,           tdp: 210, cores: 32, threads: 64, bench: 54 },
  { pat: /EPYC\s*9274F/i,          tdp: 320, cores: 24, threads: 48, bench: 50 },
  { pat: /EPYC\s*9254/i,           tdp: 200, cores: 24, threads: 48, bench: 46 },
  { pat: /EPYC\s*9224/i,           tdp: 200, cores: 24, threads: 48, bench: 44 },
  { pat: /EPYC\s*9184X/i,          tdp: 320, cores: 16, threads: 32, bench: 42 },
  { pat: /EPYC\s*9174F/i,          tdp: 320, cores: 16, threads: 32, bench: 40 },
  { pat: /EPYC\s*9124/i,           tdp: 200, cores: 16, threads: 32, bench: 32 },

  // ─── AMD EPYC 8004 series (Siena / Zen 4c, SP6 socket) ──────────────────────
  { pat: /EPYC\s*8534P/i,          tdp: 200, cores: 64, threads:128, bench: 64 },
  { pat: /EPYC\s*8434P/i,          tdp: 200, cores: 48, threads: 96, bench: 58 },
  { pat: /EPYC\s*8324P/i,          tdp: 180, cores: 32, threads: 64, bench: 48 },
  { pat: /EPYC\s*8224P/i,          tdp: 160, cores: 24, threads: 48, bench: 40 },
  { pat: /EPYC\s*8124P/i,          tdp: 125, cores: 16, threads: 32, bench: 30 },

  // ─── AMD EPYC 7003 series (Milan / Zen 3, SP3) ──────────────────────────────
  { pat: /EPYC\s*7763/i,           tdp: 280, cores: 64, threads:128, bench: 62 },
  { pat: /EPYC\s*7713/i,           tdp: 225, cores: 64, threads:128, bench: 58 },
  { pat: /EPYC\s*7663/i,           tdp: 240, cores: 56, threads:112, bench: 54 },
  { pat: /EPYC\s*7543/i,           tdp: 225, cores: 32, threads: 64, bench: 42 },
  { pat: /EPYC\s*7413/i,           tdp: 180, cores: 24, threads: 48, bench: 34 },
  { pat: /EPYC\s*7313/i,           tdp: 155, cores: 16, threads: 32, bench: 26 },

  // ─── AMD EPYC 4000 series (AM5 desktop-socket EPYC / Zen 4 & 5) ─────────────
  // These are Ryzen 7000/9000 chips with longer warranty/BMC. Same die specs.
  { pat: /EPYC\s*4565P/i,          tdp:  65, cores: 16, threads: 32, bench: 68 },
  { pat: /EPYC\s*4545P/i,          tdp:  65, cores: 16, threads: 32, bench: 62 },
  { pat: /EPYC\s*4464P/i,          tdp:  65, cores: 12, threads: 24, bench: 56 },
  { pat: /EPYC\s*4364P/i,          tdp: 105, cores:  8, threads: 16, bench: 50 },
  { pat: /EPYC\s*4345P/i,          tdp:  65, cores:  8, threads: 16, bench: 44 },
  { pat: /EPYC\s*4244P/i,          tdp:  65, cores:  6, threads: 12, bench: 36 },
  { pat: /EPYC\s*4245P/i,          tdp:  65, cores:  6, threads: 12, bench: 38 },

  // ─── Intel Xeon W-3400/W-2400 (Sapphire Rapids WS, 2023) ────────────────────
  { pat: /Xeon\s*w9[-\s]*3595X/i,  tdp: 385, cores: 60, threads:120, bench: 86 },
  { pat: /Xeon\s*w9[-\s]*3545/i,   tdp: 270, cores: 36, threads: 72, bench: 72 },
  { pat: /Xeon\s*w9[-\s]*3495X/i,  tdp: 350, cores: 56, threads:112, bench: 84 },
  { pat: /Xeon\s*w9[-\s]*3475X/i,  tdp: 300, cores: 36, threads: 72, bench: 70 },
  { pat: /Xeon\s*w7[-\s]*3465X/i,  tdp: 300, cores: 28, threads: 56, bench: 60 },
  { pat: /Xeon\s*w7[-\s]*3455/i,   tdp: 270, cores: 24, threads: 48, bench: 54 },
  { pat: /Xeon\s*w7[-\s]*2495X/i,  tdp: 225, cores: 24, threads: 48, bench: 50 },
  { pat: /Xeon\s*w7[-\s]*2475X/i,  tdp: 225, cores: 20, threads: 40, bench: 44 },
  { pat: /Xeon\s*w5[-\s]*3435X/i,  tdp: 270, cores: 16, threads: 32, bench: 40 },
  { pat: /Xeon\s*w5[-\s]*2465X/i,  tdp: 200, cores: 16, threads: 32, bench: 36 },
  { pat: /Xeon\s*w5[-\s]*2455X/i,  tdp: 200, cores: 12, threads: 24, bench: 32 },
  { pat: /Xeon\s*w3[-\s]*2435/i,   tdp: 165, cores:  8, threads: 16, bench: 24 },
  { pat: /Xeon\s*w3[-\s]*2425/i,   tdp: 130, cores:  6, threads: 12, bench: 20 },
  { pat: /Xeon\s*w3[-\s]*2423/i,   tdp: 120, cores:  6, threads: 12, bench: 18 },

  // ─── Intel Xeon 6 (Granite Rapids, 2024-25) ─────────────────────────────────
  { pat: /Xeon\s*6980P/i,          tdp: 500, cores:128, threads:256, bench: 98 },
  { pat: /Xeon\s*6979P/i,          tdp: 500, cores:120, threads:240, bench: 96 },
  { pat: /Xeon\s*6972P/i,          tdp: 500, cores: 96, threads:192, bench: 92 },
  { pat: /Xeon\s*6960P/i,          tdp: 500, cores: 72, threads:144, bench: 88 },
  { pat: /Xeon\s*6952P/i,          tdp: 400, cores: 96, threads:192, bench: 90 },
  { pat: /Xeon\s*6780E/i,          tdp: 330, cores:144, threads:144, bench: 80 },
  { pat: /Xeon\s*6766E/i,          tdp: 250, cores:144, threads:144, bench: 78 },
  { pat: /Xeon\s*6761P/i,          tdp: 250, cores: 64, threads:128, bench: 70 },

  // ─── Intel Core Ultra 200S (Arrow Lake / LGA1851, 2024) ───
  { pat: /Core\s*Ultra\s*9\s*285K/i,          tdp: 125, cores: 24, threads: 24, bench: 85 },
  { pat: /Core\s*Ultra\s*7\s*265K(?:F)?/i,    tdp: 125, cores: 20, threads: 20, bench: 72 },
  { pat: /Core\s*Ultra\s*7\s*265\b/i,         tdp:  65, cores: 20, threads: 20, bench: 68 },
  { pat: /Core\s*Ultra\s*5\s*245K/i,          tdp: 125, cores: 14, threads: 14, bench: 58 },
  { pat: /Core\s*Ultra\s*5\s*235\b/i,         tdp:  65, cores: 14, threads: 14, bench: 52 },
  { pat: /Core\s*Ultra\s*5\s*225\b/i,         tdp:  65, cores: 10, threads: 10, bench: 44 },

  // ─── Intel 14th Gen Raptor Lake Refresh (LGA1700, 2023) ───
  { pat: /Core\s*i9[-\s]*14900KS/i,  tdp: 150, cores: 24, threads: 32, bench: 90 },
  { pat: /Core\s*i9[-\s]*14900K(?:F)?/i, tdp: 125, cores: 24, threads: 32, bench: 86 },
  { pat: /Core\s*i9[-\s]*14900\b/i,  tdp:  65, cores: 24, threads: 32, bench: 80 },
  { pat: /Core\s*i7[-\s]*14700K(?:F)?/i, tdp: 125, cores: 20, threads: 28, bench: 74 },
  { pat: /Core\s*i7[-\s]*14700\b/i,  tdp:  65, cores: 20, threads: 28, bench: 68 },
  { pat: /Core\s*i5[-\s]*14600K(?:F)?/i, tdp: 125, cores: 14, threads: 20, bench: 58 },
  { pat: /Core\s*i5[-\s]*14600\b/i,  tdp:  65, cores: 14, threads: 20, bench: 52 },
  { pat: /Core\s*i5[-\s]*14500\b/i,  tdp:  65, cores: 14, threads: 20, bench: 48 },
  { pat: /Core\s*i5[-\s]*14400(?:F)?/i, tdp: 65, cores: 10, threads: 16, bench: 42 },
  { pat: /Core\s*i3[-\s]*14100(?:F)?/i, tdp: 60, cores:  4, threads:  8, bench: 26 },

  // ─── Intel 13th Gen Raptor Lake (LGA1700, 2022-23) ───
  { pat: /Core\s*i9[-\s]*13900KS/i,  tdp: 150, cores: 24, threads: 32, bench: 88 },
  { pat: /Core\s*i9[-\s]*13900K(?:F)?/i, tdp: 125, cores: 24, threads: 32, bench: 82 },
  { pat: /Core\s*i9[-\s]*13900\b/i,  tdp:  65, cores: 24, threads: 32, bench: 76 },
  { pat: /Core\s*i7[-\s]*13700K(?:F)?/i, tdp: 125, cores: 16, threads: 24, bench: 68 },
  { pat: /Core\s*i7[-\s]*13700(?:F)?/i, tdp: 65, cores: 16, threads: 24, bench: 60 },
  { pat: /Core\s*i5[-\s]*13600K(?:F)?/i, tdp: 125, cores: 14, threads: 20, bench: 54 },
  { pat: /Core\s*i5[-\s]*13600\b/i,  tdp:  65, cores: 14, threads: 20, bench: 50 },
  { pat: /Core\s*i5[-\s]*13500\b/i,  tdp:  65, cores: 14, threads: 20, bench: 44 },
  { pat: /Core\s*i5[-\s]*13400(?:F)?/i, tdp: 65, cores: 10, threads: 16, bench: 38 },
  { pat: /Core\s*i3[-\s]*13100(?:F)?/i, tdp: 60, cores:  4, threads:  8, bench: 24 },

  // ─── Intel 12th Gen Alder Lake (LGA1700, 2021) ───
  { pat: /Core\s*i9[-\s]*12900KS/i,  tdp: 150, cores: 16, threads: 24, bench: 72 },
  { pat: /Core\s*i9[-\s]*12900K(?:F)?/i, tdp: 125, cores: 16, threads: 24, bench: 68 },
  { pat: /Core\s*i9[-\s]*12900\b/i,  tdp:  65, cores: 16, threads: 24, bench: 62 },
  { pat: /Core\s*i7[-\s]*12700K(?:F)?/i, tdp: 125, cores: 12, threads: 20, bench: 56 },
  { pat: /Core\s*i7[-\s]*12700(?:F)?/i, tdp: 65, cores: 12, threads: 20, bench: 50 },
  { pat: /Core\s*i5[-\s]*12600K(?:F)?/i, tdp: 125, cores: 10, threads: 16, bench: 46 },
  { pat: /Core\s*i5[-\s]*12600\b/i,  tdp:  65, cores:  6, threads: 12, bench: 36 },
  { pat: /Core\s*i5[-\s]*12500\b/i,  tdp:  65, cores:  6, threads: 12, bench: 32 },
  { pat: /Core\s*i5[-\s]*12400(?:F)?/i, tdp: 65, cores:  6, threads: 12, bench: 28 },
  { pat: /Core\s*i3[-\s]*12100(?:F)?/i, tdp: 60, cores:  4, threads:  8, bench: 20 },
];

function matchCPU(name) {
  // Normalize: strip trademarks, zero-width chars, collapse whitespace
  let s = String(name || '').replace(/[™®©\u00AD\u200B\u200C\u200D]/g, '').replace(/\s+/g, ' ');
  // Also collapse parenthetical notes so "Core i5 (12th Gen) i5-12500" → "Core i5 i5-12500"
  // which then matches after the second "i5-12500" token regardless
  for (const entry of CPU_DB) {
    if (entry.pat.test(s)) return entry;
  }
  return null;
}

let matched = 0;
let unmatched = 0;
let tdpFilled = 0, coresFilled = 0, threadsFilled = 0, benchFilled = 0;
const unmatchedSamples = [];

for (const p of parts) {
  if (p.c !== 'CPU') continue;
  const m = matchCPU(p.n);
  if (!m) {
    unmatched++;
    if (unmatchedSamples.length < 15) unmatchedSamples.push(p.n.slice(0, 90));
    continue;
  }
  matched++;
  if (!p.tdp && m.tdp) { p.tdp = m.tdp; tdpFilled++; }
  if (!p.cores && m.cores) { p.cores = m.cores; coresFilled++; }
  if (!p.threads && m.threads) { p.threads = m.threads; threadsFilled++; }
  // Overwrite bad cores data (we saw some Intel 12600K listed as "1 core" earlier)
  if (p.cores && m.cores && p.cores < m.cores / 2) { p.cores = m.cores; coresFilled++; }
  if (p.bench == null && m.bench != null) { p.bench = m.bench; benchFilled++; }
}

console.log('Matched:', matched, '| Unmatched:', unmatched);
console.log('Filled — tdp:', tdpFilled, 'cores:', coresFilled, 'threads:', threadsFilled, 'bench:', benchFilled);

const cpus = parts.filter(p => p.c === 'CPU');
console.log('\nCoverage after:');
console.log('  tdp:    ', cpus.filter(p => p.tdp).length + '/' + cpus.length);
console.log('  cores:  ', cpus.filter(p => p.cores).length + '/' + cpus.length);
console.log('  threads:', cpus.filter(p => p.threads).length + '/' + cpus.length);
console.log('  bench:  ', cpus.filter(p => p.bench != null).length + '/' + cpus.length);

if (unmatchedSamples.length) {
  console.log('\nUnmatched samples:');
  unmatchedSamples.forEach(n => console.log('  ' + n));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
