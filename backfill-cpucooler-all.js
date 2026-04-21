#!/usr/bin/env node
/**
 * backfill-cpucooler-all.js
 *
 * Three jobs in one pass:
 *
 * 1. NORMALIZE brand name variants:
 *      "CORSAIR" → "Corsair"
 *      "THERMALRLGHT" → "Thermalright"
 *      "Lian-Li" → "Lian Li"
 *      "Deepcool" → "DeepCool"
 *      "Shanghai TRYX Technology Co.Ltd" → "TRYX"
 *
 * 2. DICTIONARY of specs for popular coolers. Fills:
 *      coolerType: Air | AIO | Liquid
 *      radSize:    120 | 240 | 280 | 360 | 420 (AIO only)
 *      height:     cooler height in mm (Air only)
 *      tdp_rating: cooler's rated TDP (W)
 *      fans_inc:   fans included in box
 *      sockets:    AM5,AM4,LGA1700,LGA1851 etc
 *      rgb:        true/false
 *
 * 3. INFER coolerType from product name for the ~34 missing it:
 *      "AIO", "liquid", "radiator", "water cooler" → AIO
 *      "tower", "air cooler", "low-profile", "heatsink" → Air
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── STEP 1: NORMALIZE BRAND NAMES ─────────────────────────────────────────
const BRAND_FIXES = {
  'CORSAIR': 'Corsair',
  'THERMALRLGHT': 'Thermalright',
  'Lian-Li': 'Lian Li',
  'Deepcool': 'DeepCool',
  'Shanghai TRYX Technology Co.Ltd': 'TRYX',
};

let brandFixed = 0;
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  if (BRAND_FIXES[p.b]) {
    p.b = BRAND_FIXES[p.b];
    brandFixed++;
  }
}
console.log(`Brand names normalized: ${brandFixed}`);

// ─── STEP 2: COOLER DICTIONARY ──────────────────────────────────────────────
// Specs from manufacturer spec sheets. TDP is conservative rating.
const DB = [
  // ═══ NOCTUA (AIR ONLY) ═══════════════════════════════════════════════════
  { pat: /Noctua\s+NH-D15\s*G2/i,       type: 'Air', height: 168, tdp: 260, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-D15(?:\s+chromax)?/i, type: 'Air', height: 165, tdp: 220, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200,LGA1151', rgb: false },
  { pat: /Noctua\s+NH-D12L/i,           type: 'Air', height: 145, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-U14S/i,           type: 'Air', height: 165, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-U12A/i,           type: 'Air', height: 158, tdp: 200, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-U12S\s+Redux/i,   type: 'Air', height: 158, tdp: 140, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-U12S(?!\s+Redux)/i, type: 'Air', height: 158, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-U9S/i,            type: 'Air', height: 125, tdp: 140, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-L12S?/i,          type: 'Air', height: 70,  tdp: 100, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-L9[axi]/i,        type: 'Air', height: 37,  tdp: 95,  fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Noctua\s+NH-P1/i,             type: 'Air', height: 158, tdp: 95,  fans: 0, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // ═══ BE QUIET! ═══════════════════════════════════════════════════════════
  { pat: /be\s*quiet!\s*Dark\s*Rock\s*Pro\s*5/i,    type: 'Air', height: 168, tdp: 270, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Dark\s*Rock\s*Pro\s*4/i,    type: 'Air', height: 163, tdp: 250, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Dark\s*Rock\s*5(?!\s*Pro)/i, type: 'Air', height: 160, tdp: 210, fans: 1, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Dark\s*Rock\s*4(?!\s*Pro)/i, type: 'Air', height: 159, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Shadow\s*Rock\s*3/i,        type: 'Air', height: 163, tdp: 190, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Pure\s*Rock\s*2/i,          type: 'Air', height: 155, tdp: 150, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Pure\s*Loop\s*2\s*FX\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /be\s*quiet!\s*Pure\s*Loop\s*2\s*FX\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /be\s*quiet!\s*Pure\s*Loop\s*2\s*280/i,    type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Silent\s*Loop\s*2\s*360/i,  type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /be\s*quiet!\s*Light\s*Loop\s*360/i,       type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /be\s*quiet!\s*Light\s*Loop\s*240/i,       type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ DEEPCOOL (AIR + AIO) ═══════════════════════════════════════════════
  { pat: /DeepCool\s+Assassin\s*IV/i,               type: 'Air', height: 164, tdp: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AK620\s*Digital/i,             type: 'Air', height: 162, tdp: 260, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AK620(?!\s*Digital)/i,         type: 'Air', height: 162, tdp: 260, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AK500/i,                       type: 'Air', height: 158, tdp: 240, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AK400/i,                       type: 'Air', height: 155, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AG400(?:\s*(?:Digital|ARGB))?/i, type: 'Air', height: 150, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+AS500/i,                       type: 'Air', height: 164, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+LS720\s*(?:SE|Digital)?/i,     type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /DeepCool\s+LT720/i,                       type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+LT520/i,                       type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /DeepCool\s+Mystique\s*360/i,              type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /DeepCool\s+Mystique\s*240/i,              type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ THERMALRIGHT ═══════════════════════════════════════════════════════
  { pat: /Thermalright\s+Peerless\s*Assassin\s*120\s*SE/i,  type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Peerless\s*Assassin\s*120/i,       type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Burst\s*Assassin\s*120/i,          type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Phantom\s*Spirit\s*120\s*SE/i,     type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Phantom\s*Spirit\s*120/i,          type: 'Air', height: 157, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Assassin\s*X\s*120\s*Refined\s*SE/i, type: 'Air', height: 154, tdp: 210, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Frost\s*Commander\s*140/i,         type: 'Air', height: 160, tdp: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Frozen\s*(?:Edge|Prism)\s*360/i,   type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Frozen\s*(?:Edge|Prism)\s*240/i,   type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+AquaElite\s*(?:V3|V2)?\s*360/i,    type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+AquaElite\s*(?:V3|V2)?\s*240/i,    type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Thermalright\s+Grand\s*Vision\s*360/i,            type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Thermalright\s+Grand\s*Vision\s*240/i,            type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ ID-COOLING ═════════════════════════════════════════════════════════
  { pat: /ID-COOLING\s+SE-226-XT/i,         type: 'Air', height: 148, tdp: 250, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /ID-COOLING\s+SE-224-XTS/i,        type: 'Air', height: 154, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /ID-COOLING\s+FROSTFLOW\s*X\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /ID-COOLING\s+FROSTFLOW\s*X\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /ID-COOLING\s+ZOOMFLOW\s*240X?/i,  type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /ID-COOLING\s+DASHFLOW\s*360/i,    type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ CORSAIR (MOSTLY AIO) ════════════════════════════════════════════════
  { pat: /Corsair\s+iCUE\s*(?:Link\s*)?H170i(?:\s*Elite|\s*LCD)?/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+iCUE\s*(?:Link\s*)?H150i(?:\s*Elite|\s*LCD|\s*Capellix)?(?:\s*XT)?/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+iCUE\s*(?:Link\s*)?H115i(?:\s*Elite|\s*LCD|\s*Capellix)?(?:\s*XT)?/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+iCUE\s*(?:Link\s*)?H100i(?:\s*Elite|\s*LCD|\s*Capellix)?(?:\s*XT)?/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+Nautilus\s*360\s*RS\s*ARGB/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+Nautilus\s*240\s*RS\s*ARGB/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Corsair\s+A115/i, type: 'Air', height: 166, tdp: 270, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Corsair\s+A75/i,  type: 'Air', height: 158, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // ═══ NZXT ════════════════════════════════════════════════════════════════
  { pat: /NZXT\s+Kraken\s*Elite\s*420(?:\s*RGB)?/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Elite\s*360(?:\s*RGB)?/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Elite\s*280(?:\s*RGB)?/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*Elite\s*240(?:\s*RGB)?/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*420(?!\s*Elite)/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*360(?!\s*Elite)/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*280(?!\s*Elite)/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+Kraken\s*240(?!\s*Elite)/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+T120(?:\s*RGB)?/i,          type: 'Air', height: 159, tdp: 200, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /NZXT\s+T40/i,                      type: 'Air', height: 80,  tdp: 100, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // ═══ LIAN LI ═════════════════════════════════════════════════════════════
  { pat: /Lian\s*Li\s+Galahad\s*II\s*(?:Trinity|LCD)\s*(?:SL-INF\s*)?360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Galahad\s*II\s*(?:Trinity|LCD)\s*(?:SL-INF\s*)?240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Galahad\s*(?:Trinity|SL)?\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Galahad\s*(?:Trinity|SL)?\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Hydroshift\s*II\s*LCD\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Hydroshift\s*II\s*LCD\s*280/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /Lian\s*Li\s+Hydroshift\s*(?:II)?\s*240/i,  type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ COOLER MASTER ═══════════════════════════════════════════════════════
  { pat: /Cooler\s*Master\s+Hyper\s*622\s*Halo/i, type: 'Air', height: 154, tdp: 220, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+Hyper\s*612\s*APEX/i, type: 'Air', height: 166, tdp: 240, fans: 1, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Cooler\s*Master\s+Hyper\s*212\s*Halo/i, type: 'Air', height: 154, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+Hyper\s*212(?:\s+Black|\s+EVO|\s+RGB)?/i, type: 'Air', height: 159, tdp: 180, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*PL360\s*Flux/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*PL240\s*Flux/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*360\s*Atmos/i,  type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*240\s*Atmos/i,  type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*ML360/i,        type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Cooler\s*Master\s+MasterLiquid\s*ML240L/i,       type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ ARCTIC ══════════════════════════════════════════════════════════════
  { pat: /Arctic\s+Liquid\s*Freezer\s*III\s*(?:Pro\s*)?420/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*III\s*(?:Pro\s*)?360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*III\s*(?:Pro\s*)?280/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*III\s*(?:Pro\s*)?240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*II\s*420/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*II\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*II\s*280/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Liquid\s*Freezer\s*II\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Freezer\s*36(?:\s*A-RGB)?/i,    type: 'Air', height: 159, tdp: 220, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Freezer\s*34\s*eSports\s*DUO/i, type: 'Air', height: 157, tdp: 210, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Freezer\s*34/i,                 type: 'Air', height: 157, tdp: 210, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /Arctic\s+Freezer\s*7\s*Pro/i,            type: 'Air', height: 124, tdp: 115, fans: 1, sockets: 'AM4,LGA1700,LGA1200,LGA1151', rgb: false },

  // ═══ THERMALTAKE ═════════════════════════════════════════════════════════
  { pat: /Thermaltake\s+TH420\s*(?:V2\s*)?(?:Ultra|ARGB)?/i, type: 'AIO', radSize: 420, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+TH360\s*(?:V2\s*)?(?:Ultra|ARGB)?/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+TH280\s*(?:V2\s*)?(?:Ultra|ARGB)?/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+TH240\s*(?:V2\s*)?(?:Ultra|ARGB)?/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+TOUGHLIQUID\s*Ultra\s*360/i,  type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+Ceres\s*360/i,                type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /Thermaltake\s+Peerless\s*Assassin\s*140/i,  type: 'Air', height: 160, tdp: 260, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },

  // ═══ MSI ═════════════════════════════════════════════════════════════════
  { pat: /MSI\s+MEG\s*CoreLiquid\s*(?:S|E)?\s*360/i,   type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MEG\s*CoreLiquid\s*(?:S|E)?\s*280/i,   type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MEG\s*CoreLiquid\s*(?:S|E)?\s*240/i,   type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MAG\s*CoreLiquid\s*(?:E|I|P)?\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MAG\s*CoreLiquid\s*(?:E|I|P)?\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MAG\s*CoreLiquid\s*(?:E|I|P)?\s*280/i, type: 'AIO', radSize: 280, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /MSI\s+MAG\s*Coreliquid\s*D\s*Vision\s*(?:A|R)?360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ ASUS ════════════════════════════════════════════════════════════════
  { pat: /ASUS\s+ROG\s*Ryujin\s*III\s*(?:Extreme)?\s*360/i,  type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS\s+ROG\s*Ryujin\s*III\s*(?:Extreme)?\s*240/i,  type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS\s+ROG\s*Ryuo\s*III\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS\s+ROG\s*Ryuo\s*III\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS\s+ROG\s*Strix\s*LC\s*III\s*(?:ARGB\s*)?360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /ASUS\s+ROG\s*Strix\s*LC\s*III\s*(?:ARGB\s*)?240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ TRYX ═══════════════════════════════════════════════════════════════
  { pat: /TRYX\s+Panorama\s*360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },
  { pat: /TRYX\s+Panorama\s*240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1851,LGA1700,LGA1200', rgb: true },

  // ═══ PCCOOLER ═══════════════════════════════════════════════════════════
  { pat: /PCCOOLER\s+(?:RZ|CPS\s+RZ)?400(?:\s*Digital)?/i,   type: 'Air', height: 153, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /PCCOOLER\s+K6\s*DUO/i,                             type: 'Air', height: 158, tdp: 245, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: false },
  { pat: /PCCOOLER\s+CPS\s+RT400/i,                          type: 'Air', height: 153, tdp: 220, fans: 1, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /PCCOOLER\s+AIO/i,                                   type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },

  // ═══ DARKFLASH ══════════════════════════════════════════════════════════
  { pat: /DarkFlash\s+Ellsworth\s*A360/i, type: 'AIO', radSize: 360, fans: 3, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /DarkFlash\s+Ellsworth\s*A240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
  { pat: /DarkFlash\s+Twister\s*DX-240/i, type: 'AIO', radSize: 240, fans: 2, sockets: 'AM5,AM4,LGA1700,LGA1200', rgb: true },
];

// ─── APPLY DICTIONARY ───────────────────────────────────────────────────────
let dictMatched = 0;
const stats = { coolerType: 0, radSize: 0, height: 0, tdp_rating: 0, fans_inc: 0, sockets: 0, rgb: 0 };

for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      dictMatched++;
      // coolerType
      if (entry.type && p.coolerType == null) { p.coolerType = entry.type; stats.coolerType++; }
      // radSize (AIO only)
      if (entry.radSize != null && p.radSize == null) { p.radSize = entry.radSize; stats.radSize++; }
      // height (Air only)
      if (entry.height != null && p.height == null) { p.height = entry.height; stats.height++; }
      // tdp rating
      if (entry.tdp != null && p.tdp_rating == null) { p.tdp_rating = entry.tdp; stats.tdp_rating++; }
      // fans included
      if (entry.fans != null && p.fans_inc == null) { p.fans_inc = entry.fans; stats.fans_inc++; }
      // sockets
      if (entry.sockets && p.sockets == null) { p.sockets = entry.sockets; stats.sockets++; }
      // rgb
      if (entry.rgb !== undefined && p.rgb == null) { p.rgb = entry.rgb; stats.rgb++; }
      break;
    }
  }
}
console.log(`\nDictionary matches: ${dictMatched}`);
console.log(`Filled:`, JSON.stringify(stats));

// ─── STEP 3: INFER coolerType FROM NAME FOR REMAINING ───────────────────────
let inferredTypes = 0;
for (const p of parts) {
  if (p.c !== 'CPUCooler') continue;
  if (p.coolerType != null) continue;
  const name = (p.n || '').toLowerCase();
  const isAIO = /\b(?:aio|liquid|water\s*cool|radiator|\d+mm\s*rad\b)\b/.test(name);
  const isAir = /\b(?:air\s*cool|tower\s*cool|heatsink|low[\s-]*profile)\b/.test(name);
  if (isAIO && !isAir) { p.coolerType = 'AIO'; inferredTypes++; }
  else if (isAir && !isAIO) { p.coolerType = 'Air'; inferredTypes++; }
  // Fallback: look for radiator size signals
  else if (/\b(?:120|140|240|280|360|420)mm\s*(?:AIO|liquid|rad)/i.test(p.n || '')) { p.coolerType = 'AIO'; inferredTypes++; }
  else if (/\b\d+mm\s*(?:tower|fan|cooler)\b/i.test(p.n || '')) { p.coolerType = 'Air'; inferredTypes++; }
}
console.log(`\ncoolerType inferred from title: ${inferredTypes}`);

// ─── FINAL REPORT ───────────────────────────────────────────────────────────
const coolers = parts.filter(p => p.c === 'CPUCooler');
console.log(`\n━━━ FINAL COVERAGE ━━━`);
for (const f of ['coolerType', 'radSize', 'height', 'tdp_rating', 'fans_inc', 'sockets', 'rgb', 'noise']) {
  const n = coolers.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(12)} ${n}/${coolers.length}  (${Math.round(n / coolers.length * 100)}%)`);
}

// Split by type
const aios = coolers.filter(p => p.coolerType === 'AIO');
const airs = coolers.filter(p => p.coolerType === 'Air');
console.log(`\n  AIO coolers: ${aios.length}`);
console.log(`    radSize    ${aios.filter(x => x.radSize != null).length}/${aios.length}  (${Math.round(aios.filter(x => x.radSize != null).length / Math.max(aios.length, 1) * 100)}%)`);
console.log(`\n  Air coolers: ${airs.length}`);
console.log(`    height     ${airs.filter(x => x.height != null).length}/${airs.length}  (${Math.round(airs.filter(x => x.height != null).length / Math.max(airs.length, 1) * 100)}%)`);
console.log(`    tdp_rating ${airs.filter(x => x.tdp_rating != null).length}/${airs.length}  (${Math.round(airs.filter(x => x.tdp_rating != null).length / Math.max(airs.length, 1) * 100)}%)`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
