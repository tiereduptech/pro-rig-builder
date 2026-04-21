#!/usr/bin/env node
/**
 * backfill-case-specs.js — hardcoded dictionary of popular PC case specs.
 *
 * Covers ~100 mainstream cases from major manufacturers. For each, we store:
 *   - maxGPU:   max GPU length in mm
 *   - maxCooler: max CPU cooler height in mm
 *   - fans_inc: fans included out of the box
 *   - rads:     supported radiator sizes (comma-separated mm values)
 *
 * Specs sourced from manufacturer spec sheets (Corsair, Lian Li, NZXT, Fractal,
 * Phanteks, be quiet!, Cooler Master, Thermaltake, HYTE, Montech, Jonsbo, etc.)
 *
 * Patterns are matched in order (most specific first); first match wins.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── CASE DATABASE ──────────────────────────────────────────────────────────
const CASE_DB = [
  // ═══════════════════════════════════════════════════════════════════════════
  // CORSAIR
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Corsair.*iCUE\s*7000X/i,         maxGPU: 450, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Corsair.*iCUE\s*5000T/i,         maxGPU: 400, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*iCUE\s*5000[DX]/i,      maxGPU: 400, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*iCUE\s*Link\s*5000[TD]/i, maxGPU: 400, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*4000D\s*Airflow/i,      maxGPU: 360, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*4000D/i,                maxGPU: 360, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*4000X/i,                maxGPU: 360, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*3000D/i,                maxGPU: 360, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*2500X/i,                maxGPU: 400, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*2000D/i,                maxGPU: 365, maxCooler: 73,  fans_inc: 0, rads: '120mm,240mm,360mm' },
  { pat: /Corsair.*6500X/i,                maxGPU: 400, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*3500X/i,                maxGPU: 400, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Corsair.*Frame\s*4000D/i,        maxGPU: 400, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // LIAN LI
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Lian[\s-]*Li.*O11\s*Dynamic\s*EVO\s*XL/i, maxGPU: 460, maxCooler: 167, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Lian[\s-]*Li.*O11\s*Dynamic\s*EVO/i,      maxGPU: 426, maxCooler: 167, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11\s*Vision\s*Compact/i,   maxGPU: 395, maxCooler: 167, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11\s*Vision/i,             maxGPU: 452, maxCooler: 171, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11D\s*Mini/i,              maxGPU: 395, maxCooler: 170, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11D\s*EVO\s*RGB/i,         maxGPU: 426, maxCooler: 167, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11\s*Air\s*Mini/i,         maxGPU: 362, maxCooler: 170, fans_inc: 3, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*O11\s*(?:Dynamic|Mini)/i,   maxGPU: 420, maxCooler: 167, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*Lancool\s*III/i,            maxGPU: 435, maxCooler: 187, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Lian[\s-]*Li.*Lancool\s*216/i,            maxGPU: 392, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*Lancool\s*217/i,            maxGPU: 415, maxCooler: 190, fans_inc: 5, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Lian[\s-]*Li.*Lancool\s*205/i,            maxGPU: 384, maxCooler: 176, fans_inc: 2, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*A4-H2O/i,                   maxGPU: 322, maxCooler: 55,  fans_inc: 0, rads: '240mm' },
  { pat: /Lian[\s-]*Li.*A3-mATX/i,                  maxGPU: 365, maxCooler: 173, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Lian[\s-]*Li.*Q58/i,                      maxGPU: 320, maxCooler: 67,  fans_inc: 0, rads: '240mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // NZXT
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /NZXT.*H9\s*Flow/i,             maxGPU: 435, maxCooler: 165, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H9\s*Elite/i,            maxGPU: 435, maxCooler: 165, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H7\s*Flow/i,             maxGPU: 400, maxCooler: 185, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H7\s*Elite/i,            maxGPU: 400, maxCooler: 185, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H7\b/i,                  maxGPU: 400, maxCooler: 185, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H6\s*Flow/i,             maxGPU: 365, maxCooler: 163, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H5\s*Flow/i,             maxGPU: 365, maxCooler: 165, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H5\s*Elite/i,            maxGPU: 365, maxCooler: 165, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /NZXT.*H1\b/i,                  maxGPU: 324, maxCooler: 65,  fans_inc: 1, rads: '140mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // FRACTAL DESIGN
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Fractal.*Terra/i,              maxGPU: 322, maxCooler: 77,  fans_inc: 0, rads: '120mm' },
  { pat: /Fractal.*Ridge/i,              maxGPU: 325, maxCooler: 70,  fans_inc: 0, rads: '120mm,240mm' },
  { pat: /Fractal.*Mood/i,               maxGPU: 325, maxCooler: 85,  fans_inc: 0, rads: '120mm,240mm' },
  { pat: /Fractal.*North\s*XL/i,         maxGPU: 413, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*North\b/i,            maxGPU: 355, maxCooler: 170, fans_inc: 2, rads: '120mm,240mm,360mm' },
  { pat: /Fractal.*Era\s*2/i,            maxGPU: 325, maxCooler: 78,  fans_inc: 0, rads: '120mm,240mm' },
  { pat: /Fractal.*Meshify\s*2\s*Compact/i, maxGPU: 360, maxCooler: 169, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Meshify\s*2\s*XL/i,   maxGPU: 498, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Fractal.*Meshify\s*2\b/i,      maxGPU: 491, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*Meshify\s*3\s*XL/i,   maxGPU: 498, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Fractal.*Meshify\s*3\b/i,      maxGPU: 440, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*Define\s*7\s*XL/i,    maxGPU: 498, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Fractal.*Define\s*7\s*Compact/i, maxGPU: 360, maxCooler: 169, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Define\s*7/i,         maxGPU: 491, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*Pop\s*Mini/i,         maxGPU: 360, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Pop\s*Air/i,          maxGPU: 405, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Pop\s*XL/i,           maxGPU: 480, maxCooler: 185, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*Pop\b/i,              maxGPU: 405, maxCooler: 170, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Torrent\s*Nano/i,     maxGPU: 335, maxCooler: 120, fans_inc: 2, rads: '120mm,140mm,240mm,280mm' },
  { pat: /Fractal.*Torrent\s*Compact/i,  maxGPU: 390, maxCooler: 167, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Torrent/i,            maxGPU: 461, maxCooler: 188, fans_inc: 5, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Fractal.*Focus\s*2/i,          maxGPU: 405, maxCooler: 169, fans_inc: 2, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Fractal.*Core\s*1100/i,        maxGPU: 350, maxCooler: 165, fans_inc: 1, rads: '120mm' },
  { pat: /Fractal.*Epoch/i,              maxGPU: 395, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // PHANTEKS
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Phanteks.*Eclipse\s*G500A/i,   maxGPU: 435, maxCooler: 185, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*Eclipse\s*G360A/i,   maxGPU: 400, maxCooler: 163, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*Eclipse\s*G300A/i,   maxGPU: 400, maxCooler: 162, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*Eclipse\s*P600S/i,   maxGPU: 435, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Phanteks.*Eclipse\s*P500A/i,   maxGPU: 435, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Phanteks.*Eclipse\s*P400A/i,   maxGPU: 420, maxCooler: 160, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*XT\s*Pro\s*Ultra/i,  maxGPU: 400, maxCooler: 165, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*XT\s*Pro/i,          maxGPU: 400, maxCooler: 165, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*Evolv\s*X/i,         maxGPU: 435, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Phanteks.*NV7/i,               maxGPU: 440, maxCooler: 185, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Phanteks.*NV5/i,               maxGPU: 400, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Phanteks.*Enthoo\s*Pro\s*2/i,  maxGPU: 503, maxCooler: 195, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm,560mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // COOLER MASTER
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Cooler\s*Master.*HAF\s*700\s*EVO/i,    maxGPU: 490, maxCooler: 166, fans_inc: 7, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Cooler\s*Master.*HAF\s*500/i,          maxGPU: 410, maxCooler: 166, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Cooler\s*Master.*MasterBox\s*TD500/i,  maxGPU: 410, maxCooler: 165, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Cooler\s*Master.*MasterBox\s*Q300L/i,  maxGPU: 360, maxCooler: 158, fans_inc: 1, rads: '120mm,140mm,240mm' },
  { pat: /Cooler\s*Master.*NR200P\s*MAX/i,       maxGPU: 336, maxCooler: 153, fans_inc: 2, rads: '120mm,240mm,280mm' },
  { pat: /Cooler\s*Master.*NR200/i,              maxGPU: 330, maxCooler: 155, fans_inc: 2, rads: '120mm,240mm,280mm' },
  { pat: /Cooler\s*Master.*MasterFrame\s*700/i,  maxGPU: 490, maxCooler: 200, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Cooler\s*Master.*Elite\s*301/i,        maxGPU: 365, maxCooler: 165, fans_inc: 0, rads: '120mm,240mm' },
  { pat: /Cooler\s*Master.*H500/i,               maxGPU: 410, maxCooler: 167, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // BE QUIET!
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /be\s*quiet.*Dark\s*Base\s*Pro\s*901/i, maxGPU: 472, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /be\s*quiet.*Dark\s*Base\s*700/i,       maxGPU: 438, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /be\s*quiet.*Silent\s*Base\s*802/i,     maxGPU: 432, maxCooler: 185, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /be\s*quiet.*Pure\s*Base\s*501\s*LX/i,  maxGPU: 369, maxCooler: 170, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /be\s*quiet.*Pure\s*Base\s*500DX/i,     maxGPU: 369, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /be\s*quiet.*Pure\s*Base\s*500/i,       maxGPU: 369, maxCooler: 190, fans_inc: 2, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /be\s*quiet.*Shadow\s*Base\s*800/i,     maxGPU: 430, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /be\s*quiet.*Light\s*Base\s*600\s*(?:LX|DX)/i, maxGPU: 410, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /be\s*quiet.*Light\s*Base\s*500/i,      maxGPU: 380, maxCooler: 170, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // HYTE
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /HYTE.*Y70\s*Touch/i,           maxGPU: 446, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /HYTE.*Y70/i,                   maxGPU: 446, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /HYTE.*Y60/i,                   maxGPU: 422, maxCooler: 160, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /HYTE.*Y40/i,                   maxGPU: 375, maxCooler: 154, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // THERMALTAKE
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Thermaltake.*Core\s*P3\s*TG/i,         maxGPU: 340, maxCooler: 180, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Thermaltake.*View\s*71/i,              maxGPU: 410, maxCooler: 190, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },
  { pat: /Thermaltake.*Divider\s*500/i,          maxGPU: 400, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Thermaltake.*Divider\s*300/i,          maxGPU: 340, maxCooler: 155, fans_inc: 2, rads: '120mm,140mm,240mm,280mm' },
  { pat: /Thermaltake.*Ceres\s*500/i,            maxGPU: 400, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Thermaltake.*Tower\s*300/i,            maxGPU: 400, maxCooler: 210, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Thermaltake.*View\s*270/i,             maxGPU: 400, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Thermaltake.*MPG\s*SEKIRA/i,           maxGPU: 410, maxCooler: 180, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // MONTECH
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Montech.*KING\s*95\s*PRO/i,    maxGPU: 400, maxCooler: 163, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Montech.*KING\s*95/i,          maxGPU: 400, maxCooler: 163, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Montech.*KING\s*65/i,          maxGPU: 400, maxCooler: 173, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Montech.*AIR\s*903\s*MAX/i,    maxGPU: 400, maxCooler: 175, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Montech.*AIR\s*903/i,          maxGPU: 400, maxCooler: 175, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Montech.*AIR\s*1000/i,         maxGPU: 400, maxCooler: 170, fans_inc: 6, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Montech.*SKY\s*TWO/i,          maxGPU: 380, maxCooler: 172, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Montech.*X3\s*(?:Mesh|Glass)/i, maxGPU: 340, maxCooler: 160, fans_inc: 6, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // JONSBO
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Jonsbo.*TK-?1/i,               maxGPU: 400, maxCooler: 165, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Jonsbo.*TK-?2/i,               maxGPU: 400, maxCooler: 160, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Jonsbo.*D41/i,                 maxGPU: 400, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Jonsbo.*D31/i,                 maxGPU: 360, maxCooler: 160, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Jonsbo.*Z20/i,                 maxGPU: 345, maxCooler: 170, fans_inc: 0, rads: '120mm,240mm,280mm,360mm' },
  { pat: /Jonsbo.*N3/i,                  maxGPU: 250, maxCooler: 130, fans_inc: 1, rads: '120mm' },
  { pat: /Jonsbo.*N2/i,                  maxGPU: 220, maxCooler: 48,  fans_inc: 1, rads: '120mm' },
  { pat: /Jonsbo.*N1/i,                  maxGPU: 200, maxCooler: 70,  fans_inc: 0, rads: '120mm' },
  { pat: /Jonsbo.*(?:MOD3|Mod\s*3)/i,    maxGPU: 400, maxCooler: 175, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /Jonsbo.*C6/i,                  maxGPU: 310, maxCooler: 140, fans_inc: 0, rads: '120mm,240mm' },
  { pat: /Jonsbo.*VR4/i,                 maxGPU: 330, maxCooler: 160, fans_inc: 0, rads: '120mm,240mm,280mm' },
  { pat: /Jonsbo.*ZA-?360WR/i,           maxGPU: 400, maxCooler: 170, fans_inc: 6, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ASUS
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /ASUS.*ROG\s*Hyperion/i,        maxGPU: 466, maxCooler: 190, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /ASUS.*TUF\s*Gaming\s*GT502/i,  maxGPU: 400, maxCooler: 190, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /ASUS.*TUF\s*Gaming\s*GT501/i,  maxGPU: 420, maxCooler: 180, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /ASUS.*Prime\s*AP201/i,         maxGPU: 338, maxCooler: 170, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /ASUS.*TUF\s*Gaming\s*GT301/i,  maxGPU: 320, maxCooler: 160, fans_inc: 4, rads: '120mm,240mm,280mm,360mm' },
  { pat: /ASUS.*ROG\s*Strix\s*Helios/i,  maxGPU: 450, maxCooler: 190, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // SSUPD
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /SSUPD.*Meshroom\s*S/i,         maxGPU: 336, maxCooler: 148, fans_inc: 0, rads: '120mm,240mm,280mm' },
  { pat: /SSUPD.*Meshroom\s*D/i,         maxGPU: 335, maxCooler: 165, fans_inc: 0, rads: '120mm,240mm,280mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ANTEC
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Antec.*Flux\s*Pro/i,           maxGPU: 400, maxCooler: 185, fans_inc: 6, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Antec.*C8/i,                   maxGPU: 400, maxCooler: 175, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Antec.*DF700/i,                maxGPU: 405, maxCooler: 175, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Antec.*P20C/i,                 maxGPU: 405, maxCooler: 170, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /Antec.*Performance\s*1\s*FT/i, maxGPU: 430, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // SILVERSTONE
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /SilverStone.*SUGO/i,           maxGPU: 335, maxCooler: 75,  fans_inc: 0, rads: '120mm' },
  { pat: /SilverStone.*Alta\s*G1M/i,     maxGPU: 350, maxCooler: 165, fans_inc: 2, rads: '120mm,140mm,240mm,280mm' },
  { pat: /SilverStone.*Fara\s*R1/i,      maxGPU: 322, maxCooler: 161, fans_inc: 1, rads: '120mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // DEEPCOOL
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /DeepCool.*CH510/i,             maxGPU: 380, maxCooler: 175, fans_inc: 1, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /DeepCool.*CH560/i,             maxGPU: 380, maxCooler: 175, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /DeepCool.*CK560/i,             maxGPU: 380, maxCooler: 175, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },
  { pat: /DeepCool.*Morpheus/i,          maxGPU: 480, maxCooler: 200, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm,480mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // ZALMAN
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Zalman.*CUBIX/i,               maxGPU: 340, maxCooler: 160, fans_inc: 2, rads: '120mm,240mm,280mm' },
  { pat: /Zalman.*Z9\s*Iceberg/i,        maxGPU: 390, maxCooler: 170, fans_inc: 4, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // HAVN
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /HAVN.*HS\s*420/i,              maxGPU: 440, maxCooler: 180, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // GEOMETRIC FUTURE
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /Geometric\s*Future.*Model\s*8/i, maxGPU: 400, maxCooler: 180, fans_inc: 0, rads: '120mm,140mm,240mm,280mm,360mm' },

  // ═══════════════════════════════════════════════════════════════════════════
  // MSI
  // ═══════════════════════════════════════════════════════════════════════════
  { pat: /MSI.*MPG\s*Sekira/i,           maxGPU: 400, maxCooler: 180, fans_inc: 3, rads: '120mm,140mm,240mm,280mm,360mm,420mm' },
  { pat: /MSI.*MAG\s*Forge/i,            maxGPU: 340, maxCooler: 160, fans_inc: 4, rads: '120mm,240mm,280mm,360mm' },
];

// ─── MATCHER ─────────────────────────────────────────────────────────────────
function matchCase(p) {
  // Test pattern against product name and brand+name
  const name = String(p.n || '').replace(/[™®©\u00AD\u200B\u200C\u200D]/g, '').replace(/\s+/g, ' ');
  const withBrand = `${p.b || ''} ${name}`;
  for (const entry of CASE_DB) {
    if (entry.pat.test(withBrand) || entry.pat.test(name)) return entry;
  }
  return null;
}

// ─── APPLY ───────────────────────────────────────────────────────────────────
let matched = 0;
let unmatched = 0;
const stats = { maxGPU: 0, maxCooler: 0, fans_inc: 0, rads: 0 };
const unmatchedSamples = [];

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const m = matchCase(p);
  if (!m) {
    unmatched++;
    if (unmatchedSamples.length < 10) unmatchedSamples.push(`${p.b}  |  ${p.n.slice(0, 70)}`);
    continue;
  }
  matched++;
  if (p.maxGPU == null && m.maxGPU != null) { p.maxGPU = m.maxGPU; stats.maxGPU++; }
  if (p.maxCooler == null && m.maxCooler != null) { p.maxCooler = m.maxCooler; stats.maxCooler++; }
  if (p.fans_inc == null && m.fans_inc != null) { p.fans_inc = m.fans_inc; stats.fans_inc++; }
  if (p.rads == null && m.rads != null) { p.rads = m.rads; stats.rads++; }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Matched:', matched, '| Unmatched:', unmatched);
console.log('Fields filled:', JSON.stringify(stats));

const cases = parts.filter(p => p.c === 'Case');
console.log('\nCase coverage after:');
console.log('  maxGPU:  ', cases.filter(x => x.maxGPU).length + '/' + cases.length + '  (' + Math.round(cases.filter(x => x.maxGPU).length / cases.length * 100) + '%)');
console.log('  maxCooler:', cases.filter(x => x.maxCooler).length + '/' + cases.length + '  (' + Math.round(cases.filter(x => x.maxCooler).length / cases.length * 100) + '%)');
console.log('  fans_inc:', cases.filter(x => x.fans_inc != null).length + '/' + cases.length + '  (' + Math.round(cases.filter(x => x.fans_inc != null).length / cases.length * 100) + '%)');
console.log('  rads:    ', cases.filter(x => x.rads).length + '/' + cases.length + '  (' + Math.round(cases.filter(x => x.rads).length / cases.length * 100) + '%)');

if (unmatchedSamples.length) {
  console.log('\nSample unmatched cases:');
  unmatchedSamples.forEach(n => console.log('  ' + n));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
