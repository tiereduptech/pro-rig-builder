#!/usr/bin/env node
/**
 * backfill-storage-specs.js
 *
 * Dictionary of SSD/HDD specs for popular models. For each match we fill:
 *   - interface: NVMe | SATA | USB | etc.
 *   - pcie:      3.0 | 4.0 | 5.0 (NVMe only)
 *   - seq_r:     sequential read MB/s
 *   - seq_w:     sequential write MB/s
 *   - nand:      TLC | QLC | MLC
 *   - dram:      true | false (has DRAM cache)
 *   - rpm:       HDD spindle speed
 *
 * Patterns are matched in order (most specific first). Specs are typically
 * the TOP-capacity (2TB) figure, since smaller capacities run slightly lower.
 * We only fill missing fields — existing values are never overwritten.
 *
 * Sources: manufacturer spec sheets (samsung.com, westerndigital.com,
 * crucial.com, seagate.com, kingston.com, corsair.com, sabrent.com, etc.)
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── DICTIONARY ──────────────────────────────────────────────────────────────
// Each entry: { pat, iface, pcie, seq_r, seq_w, nand, dram, rpm }
const DB = [
  // ═══ SAMSUNG ════════════════════════════════════════════════════════════
  { pat: /Samsung\s+9100\s*Pro/i,       iface: 'NVMe', pcie: 5.0, seq_r: 14800, seq_w: 13400, nand: 'TLC', dram: true },
  { pat: /Samsung\s+990\s*EVO\s*Plus/i, iface: 'NVMe', pcie: 5.0, seq_r: 7250,  seq_w: 6300,  nand: 'TLC', dram: false },
  { pat: /Samsung\s+990\s*EVO\b/i,      iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4200,  nand: 'TLC', dram: false },
  { pat: /Samsung\s+990\s*Pro/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7450,  seq_w: 6900,  nand: 'TLC', dram: true },
  { pat: /Samsung\s+980\s*Pro/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7000,  seq_w: 5100,  nand: 'TLC', dram: true },
  { pat: /Samsung\s+980\b/i,            iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3000,  nand: 'TLC', dram: false },
  { pat: /Samsung\s+970\s*EVO\s*Plus/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3300,  nand: 'TLC', dram: true },
  { pat: /Samsung\s+970\s*EVO\b/i,      iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 2500,  nand: 'TLC', dram: true },
  { pat: /Samsung\s+T9\b/i,             iface: 'USB',  seq_r: 2000, seq_w: 1950, nand: 'TLC' },
  { pat: /Samsung\s+T7\s*Shield/i,      iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Samsung\s+T7\b/i,             iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Samsung\s+870\s*EVO/i,        iface: 'SATA', seq_r: 560,  seq_w: 530,  nand: 'TLC', dram: true },
  { pat: /Samsung\s+870\s*QVO/i,        iface: 'SATA', seq_r: 560,  seq_w: 530,  nand: 'QLC', dram: true },
  { pat: /Samsung\s+860\s*EVO/i,        iface: 'SATA', seq_r: 550,  seq_w: 520,  nand: 'TLC', dram: true },

  // ═══ WD / WD_BLACK / SANDISK ════════════════════════════════════════════
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Black)?\s*SN8100/i,   iface: 'NVMe', pcie: 5.0, seq_r: 14900, seq_w: 14000, nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Black)?\s*SN850X/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6600,  nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Black)?\s*SN850\b/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7000,  seq_w: 5300,  nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Black)?\s*SN770M/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5150,  seq_w: 4900,  nand: 'TLC', dram: false },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Black)?\s*SN770\b/i,  iface: 'NVMe', pcie: 4.0, seq_r: 5150,  seq_w: 4900,  nand: 'TLC', dram: false },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Blue)?\s*SN580/i,     iface: 'NVMe', pcie: 4.0, seq_r: 4150,  seq_w: 4150,  nand: 'TLC', dram: false },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Blue)?\s*SN570/i,     iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3000,  nand: 'TLC', dram: false },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Blue)?\s*SN550/i,     iface: 'NVMe', pcie: 3.0, seq_r: 2400,  seq_w: 1950,  nand: 'TLC', dram: false },
  { pat: /(?:WD|Western\s*Digital)?\s*(?:Green)?\s*SN350/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400,  seq_w: 1900,  nand: 'QLC', dram: false },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*(?:3D\s*)?SATA/i,   iface: 'SATA', seq_r: 560,  seq_w: 530,  nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*SA510/i,            iface: 'SATA', seq_r: 560,  seq_w: 520,  nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital).*Red\s*SA500/i,             iface: 'SATA', seq_r: 560,  seq_w: 530,  nand: 'TLC', dram: true },
  { pat: /SanDisk.*Extreme\s*PRO\s*(?:Portable|SSD)/i,         iface: 'USB',  seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  { pat: /SanDisk.*Extreme\s*(?:Portable|SSD)/i,               iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /SanDisk.*Ultra\s*(?:3D\s*)?SSD/i,                    iface: 'SATA', seq_r: 560,  seq_w: 530,  nand: 'TLC', dram: true },

  // ═══ WD HDD (BLUE / RED / BLACK / PURPLE / GOLD) ════════════════════════
  { pat: /(?:WD|Western\s*Digital).*Red\s*Pro\b/i,       iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Red\s*Plus/i,        iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Red\b/i,             iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Black\s*(?:\d+TB)?\s*(?:Performance|HDD)/i, iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*(?:PC\s*)?(?:Desktop|HDD)/i, iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Purple/i,            iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Gold/i,              iface: 'SATA', rpm: 7200 },

  // ═══ SEAGATE ════════════════════════════════════════════════════════════
  { pat: /Seagate.*FireCuda\s*540/i,                     iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /Seagate.*FireCuda\s*530/i,                     iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6900,  nand: 'TLC', dram: true },
  { pat: /Seagate.*FireCuda\s*520/i,                     iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4400,  nand: 'TLC', dram: true },
  { pat: /Seagate.*FireCuda\s*510/i,                     iface: 'NVMe', pcie: 3.0, seq_r: 3450,  seq_w: 3200,  nand: 'TLC', dram: true },
  { pat: /Seagate.*IronWolf\s*Pro/i,                     iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*IronWolf/i,                           iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*SkyHawk\s*AI/i,                       iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*SkyHawk/i,                            iface: 'SATA', rpm: 5400 },
  { pat: /Seagate.*Exos\s*X/i,                           iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Exos/i,                               iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Barracuda\s*Pro/i,                    iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Barracuda\s*(?:Compute\s*)?(?:3\.5|HDD|\d+TB)/i, iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Barracuda/i,                          iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Expansion\s*(?:Desktop|Portable)/i,   iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Backup\s*Plus/i,                      iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*One\s*Touch\s*(?:Portable|HDD)/i,     iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Game\s*Drive/i,                       iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Ultra\s*Touch/i,                      iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Video\s*3\.5/i,                       iface: 'SATA', rpm: 5900 },

  // ═══ CRUCIAL ════════════════════════════════════════════════════════════
  { pat: /Crucial\s*T710/i,         iface: 'NVMe', pcie: 5.0, seq_r: 14900, seq_w: 13800, nand: 'TLC', dram: true },
  { pat: /Crucial\s*T705/i,         iface: 'NVMe', pcie: 5.0, seq_r: 14500, seq_w: 12700, nand: 'TLC', dram: true },
  { pat: /Crucial\s*T700/i,         iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /Crucial\s*T500/i,         iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 7000,  nand: 'TLC', dram: true },
  { pat: /Crucial\s*T400/i,         iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6800,  nand: 'TLC', dram: true },
  { pat: /Crucial\s*P510/i,         iface: 'NVMe', pcie: 5.0, seq_r: 11000, seq_w: 9550,  nand: 'TLC', dram: false },
  { pat: /Crucial\s*P5\s*Plus/i,    iface: 'NVMe', pcie: 4.0, seq_r: 6600,  seq_w: 5000,  nand: 'TLC', dram: true },
  { pat: /Crucial\s*P5\b/i,         iface: 'NVMe', pcie: 3.0, seq_r: 3400,  seq_w: 3000,  nand: 'TLC', dram: true },
  { pat: /Crucial\s*P3\s*Plus/i,    iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4200,  nand: 'QLC', dram: false },
  { pat: /Crucial\s*P3\b/i,         iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3000,  nand: 'QLC', dram: false },
  { pat: /Crucial\s*P2\b/i,         iface: 'NVMe', pcie: 3.0, seq_r: 2400,  seq_w: 1900,  nand: 'QLC', dram: false },
  { pat: /Crucial\s*P1\b/i,         iface: 'NVMe', pcie: 3.0, seq_r: 2000,  seq_w: 1700,  nand: 'QLC', dram: false },
  { pat: /Crucial\s*MX500/i,        iface: 'SATA', seq_r: 560, seq_w: 510, nand: 'TLC', dram: true },
  { pat: /Crucial\s*BX500/i,        iface: 'SATA', seq_r: 540, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /Crucial\s*X10\s*Pro/i,    iface: 'USB',  seq_r: 2100, seq_w: 2000, nand: 'TLC' },
  { pat: /Crucial\s*X9\s*Pro/i,     iface: 'USB',  seq_r: 1050, seq_w: 1050, nand: 'TLC' },
  { pat: /Crucial\s*X9\b/i,         iface: 'USB',  seq_r: 1050, seq_w: 1050, nand: 'TLC' },
  { pat: /Crucial\s*X8\b/i,         iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Crucial\s*X6\b/i,         iface: 'USB',  seq_r: 800,  seq_w: 800,  nand: 'TLC' },

  // ═══ KINGSTON ═══════════════════════════════════════════════════════════
  { pat: /Kingston\s*Fury\s*Renegade/i, iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 7000, nand: 'TLC', dram: true },
  { pat: /Kingston\s*KC3000/i,          iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 7000, nand: 'TLC', dram: true },
  { pat: /Kingston\s*KC2000/i,          iface: 'NVMe', pcie: 3.0, seq_r: 3200, seq_w: 2200, nand: 'TLC', dram: true },
  { pat: /Kingston\s*NV3/i,             iface: 'NVMe', pcie: 4.0, seq_r: 6000, seq_w: 5000, nand: 'TLC', dram: false },
  { pat: /Kingston\s*NV2/i,             iface: 'NVMe', pcie: 4.0, seq_r: 3500, seq_w: 2800, nand: 'QLC', dram: false },
  { pat: /Kingston\s*NV1/i,             iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'QLC', dram: false },
  { pat: /Kingston\s*A2000/i,           iface: 'NVMe', pcie: 3.0, seq_r: 2200, seq_w: 2000, nand: 'TLC', dram: true },
  { pat: /Kingston\s*A400/i,            iface: 'SATA', seq_r: 500, seq_w: 450, nand: 'TLC', dram: false },
  { pat: /Kingston\s*KC600/i,           iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Kingston\s*XS2000/i,          iface: 'USB',  seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  { pat: /Kingston\s*XS1000/i,          iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },

  // ═══ SK HYNIX ═══════════════════════════════════════════════════════════
  { pat: /SK\s*Hynix\s*Platinum\s*P51/i, iface: 'NVMe', pcie: 5.0, seq_r: 14700, seq_w: 13400, nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix\s*Platinum\s*P41/i, iface: 'NVMe', pcie: 4.0, seq_r: 7000,  seq_w: 6500,  nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix\s*Gold\s*P31/i,     iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3200,  nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix\s*Beetle\s*X31/i,   iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },

  // ═══ CORSAIR ════════════════════════════════════════════════════════════
  { pat: /Corsair\s*MP700\s*PRO\s*SE/i,  iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP700\s*PRO/i,       iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP700\b/i,           iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP600\s*PRO\s*XT/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7100,  seq_w: 6800,  nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP600\s*PRO/i,       iface: 'NVMe', pcie: 4.0, seq_r: 7000,  seq_w: 6550,  nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP600\s*CORE/i,      iface: 'NVMe', pcie: 4.0, seq_r: 4950,  seq_w: 3950,  nand: 'QLC', dram: false },
  { pat: /Corsair\s*MP600\s*ELITE/i,     iface: 'NVMe', pcie: 4.0, seq_r: 7000,  seq_w: 6500,  nand: 'TLC', dram: false },
  { pat: /Corsair\s*MP600\b/i,           iface: 'NVMe', pcie: 4.0, seq_r: 4950,  seq_w: 4250,  nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP510/i,             iface: 'NVMe', pcie: 3.0, seq_r: 3480,  seq_w: 3000,  nand: 'TLC', dram: true },
  { pat: /Corsair\s*MP400/i,             iface: 'NVMe', pcie: 3.0, seq_r: 3480,  seq_w: 3000,  nand: 'QLC', dram: true },

  // ═══ SABRENT ════════════════════════════════════════════════════════════
  { pat: /Sabrent.*Rocket\s*5/i,         iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\s*Plus\s*G/i, iface: 'NVMe', pcie: 4.0, seq_r: 7100, seq_w: 6600, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\s*Plus/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 6850, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\b/i,       iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*Q4/i,        iface: 'NVMe', pcie: 4.0, seq_r: 4700, seq_w: 1800, nand: 'QLC', dram: true },
  { pat: /Sabrent.*Rocket\s*Q\b/i,       iface: 'NVMe', pcie: 3.0, seq_r: 3200, seq_w: 2900, nand: 'QLC', dram: true },
  { pat: /Sabrent.*Rocket\b/i,           iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: true },

  // ═══ PNY ════════════════════════════════════════════════════════════════
  { pat: /PNY.*CS3150/i,   iface: 'NVMe', pcie: 5.0, seq_r: 12000, seq_w: 11000, nand: 'TLC', dram: true },
  { pat: /PNY.*CS3140/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7500,  seq_w: 6850,  nand: 'TLC', dram: true },
  { pat: /PNY.*CS2241/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6000,  nand: 'TLC', dram: false },
  { pat: /PNY.*CS2140/i,   iface: 'NVMe', pcie: 4.0, seq_r: 3600,  seq_w: 3200,  nand: 'TLC', dram: false },
  { pat: /PNY.*CS1030/i,   iface: 'NVMe', pcie: 3.0, seq_r: 2400,  seq_w: 1800,  nand: 'TLC', dram: false },
  { pat: /PNY.*CS900/i,    iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ LEXAR ══════════════════════════════════════════════════════════════
  { pat: /Lexar.*NM1090\s*PRO/i,    iface: 'NVMe', pcie: 5.0, seq_r: 14500, seq_w: 13000, nand: 'TLC', dram: true },
  { pat: /Lexar.*NM1090/i,          iface: 'NVMe', pcie: 5.0, seq_r: 12000, seq_w: 11000, nand: 'TLC', dram: true },
  { pat: /Lexar.*NM800\s*PRO/i,     iface: 'NVMe', pcie: 4.0, seq_r: 7500,  seq_w: 6500,  nand: 'TLC', dram: true },
  { pat: /Lexar.*NM790/i,           iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 6500,  nand: 'TLC', dram: false },
  { pat: /Lexar.*NM710/i,           iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4500,  nand: 'TLC', dram: false },
  { pat: /Lexar.*NM620/i,           iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3000,  nand: 'TLC', dram: false },
  { pat: /Lexar.*NS100/i,           iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },

  // ═══ TEAMGROUP ══════════════════════════════════════════════════════════
  { pat: /TeamGroup.*Cardea\s*Z540/i,   iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /TeamGroup.*MP44\b/i,          iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 6900,  nand: 'TLC', dram: false },
  { pat: /TeamGroup.*MP34/i,            iface: 'NVMe', pcie: 3.0, seq_r: 3500,  seq_w: 3000,  nand: 'TLC', dram: true },
  { pat: /TeamGroup.*MP33/i,            iface: 'NVMe', pcie: 3.0, seq_r: 1800,  seq_w: 1500,  nand: 'TLC', dram: false },
  { pat: /TeamGroup.*MP33\s*PRO/i,      iface: 'NVMe', pcie: 3.0, seq_r: 2100,  seq_w: 1700,  nand: 'TLC', dram: false },
  { pat: /TeamGroup.*Vulcan\s*Z/i,      iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /TeamGroup.*GX2/i,             iface: 'SATA', seq_r: 530, seq_w: 430, nand: 'TLC', dram: false },

  // ═══ PATRIOT ════════════════════════════════════════════════════════════
  { pat: /Patriot.*Viper\s*VP4300\s*Lite/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6400, nand: 'TLC', dram: false },
  { pat: /Patriot.*Viper\s*VP4300/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Patriot.*Viper\s*VP4100/i,        iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /Patriot.*Viper\s*VPN110/i,        iface: 'NVMe', pcie: 3.0, seq_r: 3300, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /Patriot.*P400\s*Lite/i,           iface: 'NVMe', pcie: 4.0, seq_r: 3500, seq_w: 2700, nand: 'QLC', dram: false },
  { pat: /Patriot.*P400/i,                  iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Patriot.*P310/i,                  iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1800, nand: 'QLC', dram: false },
  { pat: /Patriot.*P300/i,                  iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'QLC', dram: false },
  { pat: /Patriot.*P210/i,                  iface: 'SATA', seq_r: 520, seq_w: 430, nand: 'TLC', dram: false },
  { pat: /Patriot.*Burst\s*Elite/i,         iface: 'SATA', seq_r: 450, seq_w: 320, nand: 'QLC', dram: false },

  // ═══ SP SILICON POWER ═══════════════════════════════════════════════════
  { pat: /(?:SP\s*)?Silicon\s*Power.*XS70/i,    iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /(?:SP\s*)?Silicon\s*Power.*UD90/i,    iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /(?:SP\s*)?Silicon\s*Power.*UD85/i,    iface: 'NVMe', pcie: 4.0, seq_r: 3600, seq_w: 2800, nand: 'QLC', dram: false },
  { pat: /(?:SP\s*)?Silicon\s*Power.*US70/i,    iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /(?:SP\s*)?Silicon\s*Power.*P34A80/i,  iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /(?:SP\s*)?Silicon\s*Power.*P34A60/i,  iface: 'NVMe', pcie: 3.0, seq_r: 2200, seq_w: 1600, nand: 'TLC', dram: false },
  { pat: /(?:SP\s*)?Silicon\s*Power.*A55/i,     iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: false },

  // ═══ FANXIANG (BUDGET — common Amazon ) ═════════════════════════════════
  { pat: /Fanxiang.*S880/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fanxiang.*S790/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S770/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fanxiang.*S660/i,      iface: 'NVMe', pcie: 4.0, seq_r: 4900, seq_w: 4500, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S500\s*PRO/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S501/i,      iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ FIKWOT ═════════════════════════════════════════════════════════════
  { pat: /Fikwot.*FN960/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fikwot.*FN955/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FN950/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FN500/i,   iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3200, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FS810/i,   iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ BESTOSS ════════════════════════════════════════════════════════════
  { pat: /Bestoss.*BX100/i,  iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },
  { pat: /Bestoss.*BM5/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },

  // ═══ KINGSPEC ═══════════════════════════════════════════════════════════
  { pat: /KingSpec.*NX/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /KingSpec.*XG7000/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6700, nand: 'TLC', dram: true },
  { pat: /KingSpec.*P3/i,    iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ ADATA / XPG ════════════════════════════════════════════════════════
  { pat: /(?:ADATA|XPG).*Legend\s*970/i,      iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*960/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 6800,  nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*850/i,      iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4500,  nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*800/i,      iface: 'NVMe', pcie: 4.0, seq_r: 3500,  seq_w: 2800,  nand: 'QLC', dram: false },
  { pat: /(?:ADATA|XPG).*Legend\s*710/i,      iface: 'NVMe', pcie: 3.0, seq_r: 2400,  seq_w: 1800,  nand: 'TLC', dram: false },
  { pat: /(?:ADATA|XPG).*Gammix\s*S70/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 6800,  nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU800/i,             iface: 'SATA', seq_r: 560, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU750/i,             iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU650/i,             iface: 'SATA', seq_r: 520, seq_w: 450, nand: 'TLC', dram: false },

  // ═══ KLEVV ══════════════════════════════════════════════════════════════
  { pat: /KLEVV.*CRAS\s*C910/i,  iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 13000, nand: 'TLC', dram: true },
  { pat: /KLEVV.*CRAS\s*C910/i,  iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 13000, nand: 'TLC', dram: true },
  { pat: /KLEVV.*CRAS\s*C820/i,  iface: 'NVMe', pcie: 4.0, seq_r: 4700,  seq_w: 4200,  nand: 'TLC', dram: false },
  { pat: /KLEVV.*NEO\s*N400/i,   iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: false },

  // ═══ TRANSCEND / GIGASTONE / EDILOCA / MICRON / TOSHIBA / MISC ══════════
  { pat: /Transcend.*MTE250S/i,    iface: 'NVMe', pcie: 4.0, seq_r: 7500, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /Transcend.*MTE240S/i,    iface: 'NVMe', pcie: 4.0, seq_r: 3800, seq_w: 3200, nand: 'TLC', dram: false },
  { pat: /Transcend.*MTE220S/i,    iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 2500, nand: 'TLC', dram: true },
  { pat: /Transcend.*SSD230S/i,    iface: 'SATA', seq_r: 560, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Gigastone/i,             iface: 'SATA', seq_r: 540, seq_w: 480, nand: 'TLC', dram: false },
  { pat: /Ediloca.*EN760/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: false },
  { pat: /Ediloca.*EN600/i,        iface: 'NVMe', pcie: 3.0, seq_r: 3300, seq_w: 3100, nand: 'TLC', dram: false },
  { pat: /Ediloca.*ES106/i,        iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /KIOXIA.*Exceria\s*Pro/i, iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6400, nand: 'TLC', dram: true },
  { pat: /KIOXIA.*Exceria/i,       iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'TLC', dram: false },
  { pat: /Toshiba.*X300/i,         iface: 'SATA', rpm: 7200 },
  { pat: /Toshiba.*P300/i,         iface: 'SATA', rpm: 7200 },
  { pat: /Toshiba.*N300/i,         iface: 'SATA', rpm: 7200 },
  { pat: /Micron.*5400\s*PRO/i,    iface: 'SATA', seq_r: 540, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Micron.*2450/i,          iface: 'NVMe', pcie: 4.0, seq_r: 3600, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /MSI.*Spatium\s*M570\s*PRO/i, iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /MSI.*Spatium\s*M480\s*PRO/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 7000,  nand: 'TLC', dram: true },
  { pat: /MSI.*Spatium\s*M470/i,       iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4400,  nand: 'TLC', dram: true },
];

// ─── MATCHER ─────────────────────────────────────────────────────────────────
function matchStorage(p) {
  const name = String(p.n || '').replace(/[™®©\u00AD\u200B\u200C\u200D]/g, '').replace(/\s+/g, ' ');
  const withBrand = `${p.b || ''} ${name}`;
  for (const entry of DB) {
    if (entry.pat.test(withBrand) || entry.pat.test(name)) return entry;
  }
  return null;
}

// ─── APPLY ───────────────────────────────────────────────────────────────────
const stats = { matched: 0, interface: 0, pcie: 0, seq_r: 0, seq_w: 0, nand: 0, dram: 0, rpm: 0 };
const unmatchedSamples = [];

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const m = matchStorage(p);
  if (!m) {
    if (unmatchedSamples.length < 15) unmatchedSamples.push(`${p.b}  |  ${p.n.slice(0, 75)}`);
    continue;
  }
  stats.matched++;
  for (const key of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram', 'rpm']) {
    if (m[key] !== undefined && p[key] == null) {
      p[key] = m[key];
      stats[key]++;
    }
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Matched:', stats.matched);
console.log('Fields filled:', JSON.stringify({
  interface: stats.interface, pcie: stats.pcie,
  seq_r: stats.seq_r, seq_w: stats.seq_w,
  nand: stats.nand, dram: stats.dram, rpm: stats.rpm,
}));

const storage = parts.filter(p => p.c === 'Storage');
console.log('\nStorage coverage after:');
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram', 'rpm']) {
  const n = storage.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${storage.length}  (${Math.round(n / storage.length * 100)}%)`);
}

if (unmatchedSamples.length) {
  console.log('\nSample unmatched:');
  unmatchedSamples.forEach(s => console.log('  ' + s));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
