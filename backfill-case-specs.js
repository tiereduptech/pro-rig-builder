#!/usr/bin/env node
/**
 * backfill-case-specs.js
 *
 * Two passes:
 *
 * PASS 1 — REGEX INFERENCE from product name/title tokens:
 *   - tg (tempered glass): detect "Tempered Glass", "TG", "Glass Panel"
 *   - rgb: detect "RGB", "ARGB", "Infinity Mirror", "LED"
 *   - fans_inc: extract from "3x120mm", "Pre-Installed 4 x 120mm", "7 PWM"
 *   - color: "Black", "White", "Gray" in name
 *   - rads (max size): "360MM RAD", "Up to 360mm Radiator", "Supports 280mm"
 *   - usb_c: "Type-C", "USB-C"
 *   - drive25 / drive35: "10 x3.5", "3 x2.5", "2.5 SSD"
 *   - mobo (form factors supported): from "ATX Mid-Tower" / "Micro-ATX" / "Mini-ITX"
 *
 * PASS 2 — DICTIONARY for known models:
 *   Fills maxGPU, maxCooler from manufacturer spec sheets for top brands.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ═══════════════════════════════════════════════════════════════════════════
// PASS 1: REGEX INFERENCE
// ═══════════════════════════════════════════════════════════════════════════
function inferCase(p) {
  const text = `${p.b} ${p.n}`;
  const out = {};

  if (p.tg == null) {
    out.tg = /\bTempered\s*Glass|\bTG\b|\bGlass\s*(?:Panel|Side|Front|Panoramic)|\bPanoramic\s*(?:Glass|Tempered)/i.test(text);
  }

  if (p.rgb == null) {
    out.rgb = /\bRGB\b|\bARGB\b|\bInfinity\s*Mirror\b|\bLED\s*Strip|\bPrism\s*ARGB|\bLighting/i.test(text);
  }

  if (p.fans_inc == null) {
    let m = text.match(/(\d+)\s*x\s*(?:120|140|200)\s*mm/i);
    if (!m) m = text.match(/Pre-?Install(?:ed)?\s*(\d+)\s*(?:RGB|ARGB|PWM|No\s*RGB)?\s*Fans?/i);
    if (!m) m = text.match(/\b(\d+)\s*(?:PWM\s*)?(?:RGB|ARGB|Infinity\s*Mirror)\s*Fans?/i);
    if (!m) m = text.match(/Built-in\s*(\d+)X?\s*\d+mm/i);
    if (!m) m = text.match(/Includes?\s*(\d+)\s*x\s*\d+\s*mm/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n <= 12) out.fans_inc = n;
    }
  }

  if (p.color == null) {
    if (/\bWhite\b/i.test(text)) out.color = 'White';
    else if (/\bBlack\b/i.test(text)) out.color = 'Black';
    else if (/\bGray\b|\bGrey\b/i.test(text)) out.color = 'Gray';
    else if (/\bPink\b/i.test(text)) out.color = 'Pink';
    else if (/\bBlue\b/i.test(text)) out.color = 'Blue';
    else if (/\bRed\b/i.test(text)) out.color = 'Red';
  }

  if (p.rads == null || (Array.isArray(p.rads) && p.rads.length === 0)) {
    const sizes = new Set();
    const rx = /\b(120|140|240|280|360|420|480)\s*mm\s*(?:Rad|Radiator|AIO)/ig;
    let m;
    while ((m = rx.exec(text)) !== null) sizes.add(parseInt(m[1], 10));
    const upto = text.match(/(?:Supports?\s*(?:Up\s*to\s*)?|Up\s*to\s*)(\d{3})\s*mm/i);
    if (upto) sizes.add(parseInt(upto[1], 10));
    if (sizes.size > 0) {
      out.rads = [...sizes].sort((a, b) => a - b);
    }
  }

  if (p.usb_c == null) {
    out.usb_c = /\bType-?C\b|\bUSB-?C\b/i.test(text);
  }

  if (p.drive35 == null) {
    const m = text.match(/(\d+)\s*(?:x|×)\s*3\.5"?(?:\s*HDD|\s*Drive|\s*Bay)?/i);
    if (m) out.drive35 = parseInt(m[1], 10);
  }
  if (p.drive25 == null) {
    const m = text.match(/(\d+)\s*(?:x|×)\s*2\.5"?(?:\s*S?SDD?|\s*SSD|\s*Bay)?/i);
    if (m) out.drive25 = parseInt(m[1], 10);
  }

  if (p.mobo == null) {
    const mobo = [];
    if (/E-?ATX/i.test(text)) mobo.push('E-ATX');
    if (/\bATX\b/i.test(text) && !/E-?ATX|mATX|Micro-?ATX/i.test(text)) mobo.push('ATX');
    else if (/\bATX\s*(?:Mid-?Tower|Full-?Tower|Case|PC|Gaming)/i.test(text)) mobo.push('ATX');
    if (/Micro-?ATX|\bmATX\b|\bMATX\b/i.test(text)) mobo.push('mATX');
    if (/Mini-?ITX|\bITX\b/i.test(text)) mobo.push('ITX');
    if (mobo.length) out.mobo = mobo;
  }

  return out;
}

let filled = {};
for (const p of parts) {
  if (p.c !== 'Case') continue;
  const inf = inferCase(p);
  for (const [k, v] of Object.entries(inf)) {
    if (v !== null && v !== undefined && p[k] == null) {
      p[k] = v;
      filled[k] = (filled[k] || 0) + 1;
    }
  }
}

console.log(`━━━ PASS 1: REGEX INFERENCE ━━━`);
Object.entries(filled).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} +${v}`));

// ═══════════════════════════════════════════════════════════════════════════
// PASS 2: DICTIONARY
// ═══════════════════════════════════════════════════════════════════════════
const DB = [
  // CORSAIR
  { pat: /Corsair.*(?:iCUE\s*)?7000D|7000D\s*Airflow/i, maxGPU: 450, maxCooler: 190, rads: [120,140,240,280,360,420,480] },
  { pat: /Corsair.*(?:iCUE\s*)?7000X/i,                 maxGPU: 450, maxCooler: 190, rads: [120,140,240,280,360,420,480] },
  { pat: /Corsair.*(?:iCUE\s*)?6500[DX]/i,              maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360,420] },
  { pat: /Corsair.*(?:iCUE\s*)?5000[DXTQ]\b|5000T\s*RGB|Frame\s*5000/i, maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360,420] },
  { pat: /Corsair.*(?:iCUE\s*)?4500X|Frame\s*4500/i,    maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Corsair.*(?:iCUE\s*)?4000[DXT]\b/i,           maxGPU: 360, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Corsair.*3500X/i,                             maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Corsair.*3000D/i,                             maxGPU: 360, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Corsair.*2500[DX]|Frame\s*2500/i,             maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Corsair.*2000D/i,                             maxGPU: 365, maxCooler: 50,  rads: [120,140,240,280,360] },
  { pat: /Corsair.*(?:iCUE\s*)?220T/i,                  maxGPU: 300, maxCooler: 160, rads: [120,240] },

  // NZXT
  { pat: /NZXT.*H9\s*Elite|H9\s*Flow/i,                 maxGPU: 435, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H7\s*(?:Elite|Flow)/i,                  maxGPU: 400, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H6\s*Flow/i,                            maxGPU: 415, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H5\s*(?:Elite|Flow)/i,                  maxGPU: 365, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H4\s*Flow/i,                            maxGPU: 400, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H3\s*Flow/i,                            maxGPU: 365, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /NZXT.*H2\s*Flow/i,                            maxGPU: 365, maxCooler: 165, rads: [120,140,240,280] },
  { pat: /NZXT.*H1\b/i,                                 maxGPU: 324, maxCooler: 60,  rads: [120,140,240] },

  // LIAN LI
  { pat: /Lian\s*Li.*O11\s*Vision\s*Compact|O11V\s*Compact/i, maxGPU: 395, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*O11\s*Vision/i,                    maxGPU: 456, maxCooler: 170, rads: [120,140,240,280,360,420] },
  { pat: /Lian\s*Li.*O11\s*Dynamic\s*Evo\s*XL|O11D\s*Evo\s*XL|Dynamic\s*EVO\s*XL/i, maxGPU: 458, maxCooler: 167, rads: [120,140,240,280,360,420] },
  { pat: /Lian\s*Li.*O11\s*Dynamic\s*Evo\s*RGB|O11D\s*Evo\s*RGB/i, maxGPU: 426, maxCooler: 167, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*O11\s*Dynamic\s*Evo|O11D\s*Evo/i,  maxGPU: 426, maxCooler: 167, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*O11\s*Dynamic\s*(?:Mini|XL)?|O11D/i, maxGPU: 420, maxCooler: 155, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*O11\s*Air\s*Mini/i,                maxGPU: 362, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*O11\b/i,                           maxGPU: 420, maxCooler: 155, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*Lancool\s*III|Lancool\s*3/i,       maxGPU: 450, maxCooler: 180, rads: [120,140,240,280,360,420] },
  { pat: /Lian\s*Li.*Lancool\s*II\s*Mesh|Lancool\s*2\s*Mesh/i, maxGPU: 384, maxCooler: 176, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*Lancool\s*207/i,                   maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*Lancool\s*216/i,                   maxGPU: 392, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*V100\s*MINI|VECTOR\s*V100\s*MINI/i, maxGPU: 320, maxCooler: 160, rads: [120,240] },
  { pat: /Lian\s*Li.*V100\b/i,                          maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Lian\s*Li.*A4-H2O/i,                          maxGPU: 330, maxCooler: 55,  rads: [120] },
  { pat: /Lian\s*Li.*Q58/i,                             maxGPU: 322, maxCooler: 70,  rads: [120,240,280] },
  { pat: /Lian\s*Li.*Dan\s*A3|A3-mATX/i,                maxGPU: 400, maxCooler: 158, rads: [120,240,360] },

  // FRACTAL DESIGN
  { pat: /Fractal.*North\s*XL/i,                        maxGPU: 413, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Fractal.*North\b/i,                           maxGPU: 355, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Fractal.*Torrent\s*Nano/i,                    maxGPU: 335, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /Fractal.*Torrent/i,                           maxGPU: 461, maxCooler: 188, rads: [120,140,240,280,360,420] },
  { pat: /Fractal.*Define\s*7\s*XL/i,                   maxGPU: 540, maxCooler: 185, rads: [120,140,240,280,360,420,480] },
  { pat: /Fractal.*Define\s*7/i,                        maxGPU: 491, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Fractal.*Meshify\s*2\s*XL/i,                  maxGPU: 490, maxCooler: 185, rads: [120,140,240,280,360,420,480] },
  { pat: /Fractal.*Meshify\s*2/i,                       maxGPU: 491, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Fractal.*Pop\s*Air/i,                         maxGPU: 365, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Fractal.*Pop\s*XL/i,                          maxGPU: 440, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Fractal.*Pop\s*Mini/i,                        maxGPU: 330, maxCooler: 170, rads: [120,140,240,280] },
  { pat: /Fractal.*Era\s*ITX/i,                         maxGPU: 295, maxCooler: 120, rads: [120,240,280] },
  { pat: /Fractal.*Ridge/i,                             maxGPU: 335, maxCooler: 85,  rads: [120,240,280] },
  { pat: /Fractal.*Terra/i,                             maxGPU: 322, maxCooler: 77,  rads: [120,240] },

  // BE QUIET!
  { pat: /be\s*quiet.*Light\s*Base\s*900\s*FX/i,        maxGPU: 450, maxCooler: 190, rads: [120,140,240,280,360,420] },
  { pat: /be\s*quiet.*Light\s*Base\s*600\s*LX/i,        maxGPU: 430, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Light\s*Base\s*500/i,             maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Shadow\s*Base\s*800\s*(?:FX|DX)/i, maxGPU: 430, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /be\s*quiet.*Shadow\s*Base\s*800/i,            maxGPU: 430, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Silent\s*Base\s*802/i,            maxGPU: 432, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Silent\s*Base\s*601/i,            maxGPU: 432, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Pure\s*Base\s*501/i,              maxGPU: 392, maxCooler: 190, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Pure\s*Base\s*500\s*FX|Pure\s*Base\s*500\s*DX/i, maxGPU: 369, maxCooler: 190, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Pure\s*Base\s*500/i,              maxGPU: 369, maxCooler: 190, rads: [120,140,240,280,360] },
  { pat: /be\s*quiet.*Pure\s*Base\s*600/i,              maxGPU: 369, maxCooler: 190, rads: [120,140,240,280] },
  { pat: /be\s*quiet.*Dark\s*Base\s*901/i,              maxGPU: 511, maxCooler: 180, rads: [120,140,240,280,360,420] },
  { pat: /be\s*quiet.*Dark\s*Base\s*700/i,              maxGPU: 431, maxCooler: 185, rads: [120,140,240,280,360] },

  // PHANTEKS
  { pat: /Phanteks.*NV9|NV\s*9/i,                       maxGPU: 440, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Phanteks.*NV7|NV\s*7/i,                       maxGPU: 440, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*NV5|NV\s*5/i,                       maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*Eclipse\s*G500A/i,                  maxGPU: 435, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*Eclipse\s*G400A/i,                  maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*Eclipse\s*P500A/i,                  maxGPU: 435, maxCooler: 190, rads: [120,140,240,280,360,420] },
  { pat: /Phanteks.*Eclipse\s*P400A/i,                  maxGPU: 420, maxCooler: 160, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*Enthoo\s*Pro/i,                     maxGPU: 471, maxCooler: 193, rads: [120,140,240,280,360] },
  { pat: /Phanteks.*XT\s*Pro/i,                         maxGPU: 400, maxCooler: 165, rads: [120,140,240,280,360] },

  // THERMALTAKE
  { pat: /Thermaltake.*Tower\s*900/i,                   maxGPU: 400, maxCooler: 190, rads: [120,140,240,280,360,420] },
  { pat: /Thermaltake.*Tower\s*500/i,                   maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*Tower\s*300/i,                   maxGPU: 350, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*Tower\s*200/i,                   maxGPU: 330, maxCooler: 190, rads: [120,140,240] },
  { pat: /Thermaltake.*Tower\s*100/i,                   maxGPU: 330, maxCooler: 190, rads: [120,240] },
  { pat: /Thermaltake.*View\s*380/i,                    maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*View\s*270/i,                    maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*View\s*170/i,                    maxGPU: 330, maxCooler: 160, rads: [120,140,240,280] },
  { pat: /Thermaltake.*View\s*71/i,                     maxGPU: 410, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Thermaltake.*Core\s*P8/i,                     maxGPU: 450, maxCooler: 200, rads: [120,140,240,280,360,420,480] },
  { pat: /Thermaltake.*Core\s*P6/i,                     maxGPU: 400, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*Core\s*P3/i,                     maxGPU: 330, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*CTE\s*C750/i,                    maxGPU: 450, maxCooler: 200, rads: [120,140,240,280,360,420] },
  { pat: /Thermaltake.*CTE\s*E660/i,                    maxGPU: 425, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*Versa\s*H21|Versa\s*H25/i,       maxGPU: 310, maxCooler: 155, rads: [120,240] },
  { pat: /Thermaltake.*S100/i,                          maxGPU: 315, maxCooler: 155, rads: [120,240] },
  { pat: /Thermaltake.*S300\s*TG/i,                     maxGPU: 310, maxCooler: 170, rads: [120,240] },
  { pat: /Thermaltake.*Divider\s*550/i,                 maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Thermaltake.*Divider\s*300/i,                 maxGPU: 330, maxCooler: 170, rads: [120,240,280] },

  // COOLER MASTER
  { pat: /Cooler\s*Master.*HAF\s*700\s*EVO/i,           maxGPU: 500, maxCooler: 200, rads: [120,140,240,280,360,420,480] },
  { pat: /Cooler\s*Master.*HAF\s*500/i,                 maxGPU: 410, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /Cooler\s*Master.*HAF\s*XB/i,                  maxGPU: 334, maxCooler: 180, rads: [120,140,240,280] },
  { pat: /Cooler\s*Master.*MasterFrame\s*600/i,         maxGPU: 460, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Cooler\s*Master.*MasterBox\s*TD500/i,         maxGPU: 410, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /Cooler\s*Master.*MasterBox\s*NR200/i,         maxGPU: 330, maxCooler: 155, rads: [120,240,280] },
  { pat: /Cooler\s*Master.*MasterBox\s*Q300/i,          maxGPU: 360, maxCooler: 159, rads: [120,240] },
  { pat: /Cooler\s*Master.*MasterCase\s*(?:H500|H100)/i, maxGPU: 410, maxCooler: 167, rads: [120,140,240,280,360] },
  { pat: /Cooler\s*Master.*QUBE\s*540/i,                maxGPU: 410, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Cooler\s*Master.*N200\b/i,                    maxGPU: 355, maxCooler: 175, rads: [120,240] },

  // MONTECH
  { pat: /Montech.*King\s*95\s*Pro/i,                   maxGPU: 420, maxCooler: 178, rads: [120,140,240,280,360] },
  { pat: /Montech.*King\s*95/i,                         maxGPU: 405, maxCooler: 178, rads: [120,140,240,280,360] },
  { pat: /Montech.*King\s*65\s*Pro/i,                   maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Montech.*King\s*65/i,                         maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Montech.*AIR\s*903/i,                         maxGPU: 400, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Montech.*AIR\s*100/i,                         maxGPU: 330, maxCooler: 155, rads: [120,240] },
  { pat: /Montech.*XR-?B/i,                             maxGPU: 380, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Montech.*Sky\s*Two/i,                         maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Montech.*Sky\s*One\s*Pro/i,                   maxGPU: 400, maxCooler: 163, rads: [120,140,240,280,360] },
  { pat: /Montech.*Sky\s*One/i,                         maxGPU: 400, maxCooler: 163, rads: [120,140,240,280,360] },
  { pat: /Montech.*Heritage/i,                          maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },

  // ANTEC
  { pat: /Antec.*C5\s*ARGB/i,                           maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },
  { pat: /Antec.*C8\b/i,                                maxGPU: 410, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Antec.*P20/i,                                 maxGPU: 405, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Antec.*DF700/i,                               maxGPU: 360, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Antec.*NX410/i,                               maxGPU: 360, maxCooler: 170, rads: [120,140,240,280,360] },

  // SILVERSTONE
  { pat: /SilverStone.*FLP0[12]/i,                      maxGPU: 400, maxCooler: 165, rads: [120,240,360] },
  { pat: /SilverStone.*SG13/i,                          maxGPU: 267, maxCooler: 61,  rads: [120] },
  { pat: /SilverStone.*SG16/i,                          maxGPU: 330, maxCooler: 62,  rads: [120] },
  { pat: /SilverStone.*ALTA\s*G1M/i,                    maxGPU: 360, maxCooler: 150, rads: [120,240] },
  { pat: /SilverStone.*FARA/i,                          maxGPU: 322, maxCooler: 167, rads: [120,240] },
  { pat: /SilverStone.*Seta/i,                          maxGPU: 360, maxCooler: 163, rads: [120,240,280,360] },

  // JONSBO
  { pat: /Jonsbo.*D41/i,                                maxGPU: 330, maxCooler: 160, rads: [120,140,240,280,360] },
  { pat: /Jonsbo.*D32\s*Pro/i,                          maxGPU: 338, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /Jonsbo.*D31/i,                                maxGPU: 338, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /Jonsbo.*D500|D500\s*ATX/i,                    maxGPU: 420, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /Jonsbo.*TR03/i,                               maxGPU: 400, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /Jonsbo.*T8/i,                                 maxGPU: 340, maxCooler: 200, rads: [120,240] },
  { pat: /Jonsbo.*U4\b/i,                               maxGPU: 355, maxCooler: 180, rads: [120,240,280] },
  { pat: /Jonsbo.*VR3/i,                                maxGPU: 335, maxCooler: 77,  rads: [120,240] },
  { pat: /Jonsbo.*Z20/i,                                maxGPU: 400, maxCooler: 165, rads: [120,240,280] },
  { pat: /Jonsbo.*N3\b/i,                               maxGPU: 250, maxCooler: 70,  rads: [120] },

  // HYTE
  { pat: /HYTE.*Y70\s*Touch\s*Infinite/i,               maxGPU: 445, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /HYTE.*Y70\s*Touch/i,                          maxGPU: 445, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /HYTE.*Y70/i,                                  maxGPU: 445, maxCooler: 180, rads: [120,140,240,280,360] },
  { pat: /HYTE.*Y60/i,                                  maxGPU: 375, maxCooler: 160, rads: [120,140,240,280,360] },
  { pat: /HYTE.*Y40/i,                                  maxGPU: 422, maxCooler: 145, rads: [120,140,240,280,360] },
  { pat: /HYTE.*Revolt/i,                               maxGPU: 335, maxCooler: 140, rads: [120,240,280] },

  // ASUS
  { pat: /ASUS.*ROG\s*Hyperion/i,                       maxGPU: 460, maxCooler: 190, rads: [120,140,240,280,360,420] },
  { pat: /ASUS.*ROG\s*Strix\s*Helios/i,                 maxGPU: 450, maxCooler: 190, rads: [120,140,240,280,360,420] },
  { pat: /ASUS.*TUF\s*Gaming\s*GT502/i,                 maxGPU: 400, maxCooler: 163, rads: [120,140,240,280,360] },
  { pat: /ASUS.*TUF\s*Gaming\s*GT301/i,                 maxGPU: 320, maxCooler: 160, rads: [120,240] },
  { pat: /ASUS.*Prime\s*AP201/i,                        maxGPU: 338, maxCooler: 170, rads: [120,240,280,360] },

  // INWIN
  { pat: /InWin.*A1\s*Plus/i,                           maxGPU: 320, maxCooler: 140, rads: [120] },
  { pat: /InWin.*Chopin/i,                              maxGPU: 220, maxCooler: 44,  rads: [] },
  { pat: /InWin.*309/i,                                 maxGPU: 420, maxCooler: 160, rads: [120,140,240,280,360] },
  { pat: /InWin.*B1/i,                                  maxGPU: 210, maxCooler: 40,  rads: [] },

  // ARCTIC
  { pat: /Arctic.*P12|Arctic.*PC\s*Case/i,              maxGPU: 360, maxCooler: 170, rads: [120,140,240,280,360] },

  // ZALMAN
  { pat: /Zalman.*T6/i,                                 maxGPU: 290, maxCooler: 145, rads: [120] },
  { pat: /Zalman.*S3/i,                                 maxGPU: 330, maxCooler: 160, rads: [120,240] },
  { pat: /Zalman.*Z1/i,                                 maxGPU: 320, maxCooler: 155, rads: [120,240] },
  { pat: /Zalman.*I4/i,                                 maxGPU: 380, maxCooler: 165, rads: [120,140,240,280,360] },

  // MSI
  { pat: /MSI.*MAG\s*Forge\s*320R/i,                    maxGPU: 340, maxCooler: 160, rads: [120,240,280] },
  { pat: /MSI.*MAG\s*Pano/i,                            maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },
  { pat: /MSI.*MPG\s*Velox/i,                           maxGPU: 400, maxCooler: 165, rads: [120,140,240,280,360] },
  { pat: /MSI.*MPG\s*Gungnir/i,                         maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /MSI.*MEG\s*Prospect/i,                        maxGPU: 450, maxCooler: 190, rads: [120,140,240,280,360,420] },

  // DARKROCK
  { pat: /DARKROCK.*Classico\s*Max/i,                   maxGPU: 420, maxCooler: 185, rads: [120,140,240,280,360] },
  { pat: /DARKROCK.*EC2/i,                              maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },

  // DARKFLASH
  { pat: /DarkFlash.*DLX22/i,                           maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /DarkFlash.*DLM21|DLX21/i,                     maxGPU: 350, maxCooler: 160, rads: [120,240,280] },
  { pat: /DarkFlash.*DS900/i,                           maxGPU: 410, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /DarkFlash.*DR-?G(?:22|23)/i,                  maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /DarkFlash.*NVX|NEPTUNE/i,                     maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },
  { pat: /DarkFlash.*DLV22/i,                           maxGPU: 380, maxCooler: 170, rads: [120,140,240,280,360] },

  // OKINOS
  { pat: /Okinos.*Aqua\s*3/i,                           maxGPU: 335, maxCooler: 170, rads: [120,240,280,360] },
  { pat: /Okinos.*Walnut|Okinos.*Wood/i,                maxGPU: 335, maxCooler: 170, rads: [120,240,280] },
  { pat: /Okinos.*Aqua\s*7/i,                           maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },
  { pat: /Okinos.*S1/i,                                 maxGPU: 400, maxCooler: 170, rads: [120,140,240,280,360] },

  // GEOMETRIC FUTURE
  { pat: /Geometric\s*Future.*Model\s*(?:[48]|M[48])/i, maxGPU: 400, maxCooler: 175, rads: [120,140,240,280,360] },

  // GENERIC FALLBACKS — applied last by tower class
  { pat: /Full-?Tower|E-?ATX.*Case/i,                   maxGPU: 430, maxCooler: 185, rads: [120,140,240,280,360,420] },
  { pat: /Mid-?Tower.*ATX|ATX.*Mid-?Tower/i,            maxGPU: 380, maxCooler: 170, rads: [120,140,240,280,360] },
  { pat: /Micro-?ATX|mATX|MATX/i,                       maxGPU: 330, maxCooler: 160, rads: [120,240,280] },
  { pat: /Mini-?ITX|\bITX\b/i,                          maxGPU: 320, maxCooler: 140, rads: [120,240] },
];

const db_filled = {};
let db_matched = 0;
for (const p of parts) {
  if (p.c !== 'Case') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (!entry.pat.test(text)) continue;
    db_matched++;
    for (const key of ['maxGPU', 'maxCooler', 'rads']) {
      if (entry[key] !== undefined && (p[key] == null || (key === 'rads' && Array.isArray(p[key]) && p[key].length === 0))) {
        p[key] = entry[key];
        db_filled[key] = (db_filled[key] || 0) + 1;
      }
    }
    break;
  }
}

console.log(`\n━━━ PASS 2: DICTIONARY ━━━`);
console.log(`  Matched: ${db_matched}`);
Object.entries(db_filled).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} +${v}`));

// FINAL COVERAGE
const cases = parts.filter(p => p.c === 'Case');
console.log(`\n━━━ FINAL CASE COVERAGE (${cases.length} cases) ━━━`);
for (const f of ['tower', 'ff', 'maxGPU', 'maxCooler', 'rads', 'fans_inc', 'tg', 'rgb', 'color', 'usb_c', 'drive25', 'drive35', 'mobo']) {
  const n = cases.filter(x => x[f] != null && (!Array.isArray(x[f]) || x[f].length > 0)).length;
  console.log(`  ${f.padEnd(12)} ${n}/${cases.length}  (${Math.round(n / cases.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
