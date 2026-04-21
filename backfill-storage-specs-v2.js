#!/usr/bin/env node
/**
 * backfill-storage-specs-v2.js
 *
 * Two jobs:
 *
 *   1. NORMALIZE existing `interface` values to simple tags.
 *      Currently the catalog has mixed values like "PCIe Gen 5 x4", "SATA III",
 *      "USB 3.2 Gen 2", etc. We normalize to: NVMe | SATA | USB | mSATA.
 *      This makes the filter column consistent before we backfill more.
 *
 *   2. EXPAND the spec dictionary with patterns missed in v1:
 *      - Samsung 9100 PRO, PM9A3
 *      - Crucial P310 (and bare model names without brand prefix)
 *      - WD_BLACK SN850P, C50 console SSDs
 *      - WD Blue HDD with RPM in title
 *      - Micron 7450 Pro U.2 enterprise
 *      - Generic fallbacks for titles with explicit Gen4/Gen5 markers
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── STEP 1: NORMALIZE EXISTING INTERFACE VALUES ─────────────────────────────
function normalizeInterface(val) {
  if (val == null) return null;
  const t = String(val).toLowerCase();
  if (/pcie|nvme|m\.?2/.test(t)) return 'NVMe';
  if (/sata/.test(t)) return 'SATA';
  if (/usb|thunderbolt/.test(t)) return 'USB';
  if (/sas/.test(t)) return 'SAS';
  if (/u\.?2/.test(t)) return 'U.2';
  if (/msata/.test(t)) return 'mSATA';
  return null;
}

let normalized = 0;
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.interface == null) continue;
  const norm = normalizeInterface(p.interface);
  if (norm && norm !== p.interface) {
    p.interface = norm;
    normalized++;
  }
}
console.log(`Normalized ${normalized} existing interface values to simple tags`);

// ─── STEP 2: EXPANDED DICTIONARY ─────────────────────────────────────────────
const DB = [
  // ═══ SAMSUNG ════════════════════════════════════════════════════════════
  { pat: /Samsung.*9100\s*Pro|(?:^|\s)SSD\s*9100\s*Pro/i, iface: 'NVMe', pcie: 5.0, seq_r: 14800, seq_w: 13400, nand: 'TLC', dram: true },
  { pat: /Samsung\s+990\s*EVO\s*Plus|(?:^|\s)990\s*EVO\s*Plus/i, iface: 'NVMe', pcie: 5.0, seq_r: 7250, seq_w: 6300, nand: 'TLC', dram: false },
  { pat: /Samsung\s+990\s*EVO\b|(?:^|\s)990\s*EVO\b/i,      iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4200, nand: 'TLC', dram: false },
  { pat: /Samsung\s+990\s*Pro|(?:^|\s)990\s*Pro/i,          iface: 'NVMe', pcie: 4.0, seq_r: 7450, seq_w: 6900, nand: 'TLC', dram: true },
  { pat: /Samsung\s+980\s*Pro|(?:^|\s)980\s*Pro/i,          iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 5100, nand: 'TLC', dram: true },
  { pat: /Samsung\s+980\b|(?:^|\s)980\b(?!.*Pro)/i,         iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /Samsung\s+970\s*EVO\s*Plus|(?:^|\s)970\s*EVO\s*Plus/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3300, nand: 'TLC', dram: true },
  { pat: /Samsung\s+970\s*EVO\b|(?:^|\s)970\s*EVO\b/i,      iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 2500, nand: 'TLC', dram: true },
  { pat: /Samsung.*PM9A3/i,                                 iface: 'U.2',  pcie: 4.0, seq_r: 6800, seq_w: 4000, nand: 'TLC', dram: true },
  { pat: /Samsung\s+T9\b|(?:^|\s)T9\s+Portable/i,           iface: 'USB',  seq_r: 2000, seq_w: 1950, nand: 'TLC' },
  { pat: /Samsung\s+T7\s*Shield/i,                          iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Samsung\s+T7\b/i,                                 iface: 'USB',  seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Samsung.*870\s*EVO|(?:^|\s)870\s*EVO/i,           iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: true },
  { pat: /Samsung.*870\s*QVO|(?:^|\s)870\s*QVO/i,           iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'QLC', dram: true },
  { pat: /Samsung.*860\s*EVO|(?:^|\s)860\s*EVO/i,           iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: true },

  // ═══ WD / WD_BLACK / SANDISK ════════════════════════════════════════════
  { pat: /SN8100/i,   iface: 'NVMe', pcie: 5.0, seq_r: 14900, seq_w: 14000, nand: 'TLC', dram: true },
  { pat: /SN850X/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6600,  nand: 'TLC', dram: true },
  { pat: /SN850P/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300,  seq_w: 6600,  nand: 'TLC', dram: true },
  { pat: /\bSN850\b/i, iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 5300, nand: 'TLC', dram: true },
  { pat: /\bC50\b.*(?:Xbox|Storage\s*Expansion)/i, iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 5200, nand: 'TLC', dram: true },
  { pat: /SN770M/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5150, seq_w: 4900, nand: 'TLC', dram: false },
  { pat: /\bSN770\b/i, iface: 'NVMe', pcie: 4.0, seq_r: 5150, seq_w: 4900, nand: 'TLC', dram: false },
  { pat: /SN580/i,    iface: 'NVMe', pcie: 4.0, seq_r: 4150, seq_w: 4150, nand: 'TLC', dram: false },
  { pat: /SN570/i,    iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /SN550/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1950, nand: 'TLC', dram: false },
  { pat: /SN350/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1900, nand: 'QLC', dram: false },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*SA510/i,  iface: 'SATA', seq_r: 560, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*(?:3D\s*)?SATA/i, iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: true },
  { pat: /(?:WD|Western\s*Digital).*Red\s*SA500/i,   iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: true },
  { pat: /SanDisk.*Extreme\s*PRO\s*(?:Portable|SSD)/i, iface: 'USB', seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  { pat: /SanDisk.*Extreme\s*(?:Portable|SSD)/i,     iface: 'USB', seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /SanDisk.*Ultra\s*(?:3D\s*)?SSD/i,          iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: true },

  // ═══ WD HDD ════════════════════════════════════════════════════════════
  { pat: /(?:WD|Western\s*Digital).*Red\s*Pro\b/i,   iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Red\s*Plus/i,    iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Red\b/i,         iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Blue.*7200\s*RPM/i, iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Blue.*5400\s*RPM/i, iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Black.*(?:Performance|HDD|7200)/i, iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Blue\s*(?:PC\s*)?(?:Desktop|HDD)/i, iface: 'SATA', rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Purple/i,        iface: 'SATA', rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Gold/i,          iface: 'SATA', rpm: 7200 },

  // ═══ SEAGATE ════════════════════════════════════════════════════════════
  { pat: /FireCuda\s*540/i,                iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /FireCuda\s*530/i,                iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6900, nand: 'TLC', dram: true },
  { pat: /FireCuda\s*520/i,                iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /FireCuda\s*510/i,                iface: 'NVMe', pcie: 3.0, seq_r: 3450, seq_w: 3200, nand: 'TLC', dram: true },
  { pat: /IronWolf\s*Pro/i,                iface: 'SATA', rpm: 7200 },
  { pat: /IronWolf/i,                      iface: 'SATA', rpm: 7200 },
  { pat: /SkyHawk\s*AI/i,                  iface: 'SATA', rpm: 7200 },
  { pat: /SkyHawk/i,                       iface: 'SATA', rpm: 5400 },
  { pat: /Exos/i,                          iface: 'SATA', rpm: 7200 },
  { pat: /Barracuda\s*Pro/i,               iface: 'SATA', rpm: 7200 },
  { pat: /Barracuda/i,                     iface: 'SATA', rpm: 7200 },
  { pat: /Seagate.*Expansion/i,            iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Backup\s*Plus/i,        iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*One\s*Touch/i,          iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Game\s*Drive/i,         iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Ultra\s*Touch/i,        iface: 'USB',  rpm: 5400 },
  { pat: /Seagate.*Portable\s*\d+TB\s*External|External\s*Hard\s*Drive.*USB/i, iface: 'USB', rpm: 5400 },
  { pat: /Seagate.*Video\s*3\.5/i,         iface: 'SATA', rpm: 5900 },

  // ═══ CRUCIAL ════════════════════════════════════════════════════════════
  { pat: /Crucial.*T710|(?:^|\s)T710/i,    iface: 'NVMe', pcie: 5.0, seq_r: 14900, seq_w: 13800, nand: 'TLC', dram: true },
  { pat: /Crucial.*T705|(?:^|\s)T705/i,    iface: 'NVMe', pcie: 5.0, seq_r: 14500, seq_w: 12700, nand: 'TLC', dram: true },
  { pat: /Crucial.*T700|(?:^|\s)T700\b/i,  iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /Crucial.*T500|(?:^|\s)T500\b/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 7000, nand: 'TLC', dram: true },
  { pat: /Crucial.*T400|(?:^|\s)T400\b/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Crucial.*P510|(?:^|\s)P510/i,    iface: 'NVMe', pcie: 5.0, seq_r: 11000, seq_w: 9550, nand: 'TLC', dram: false },
  { pat: /Crucial.*P310|(?:^|\s)P310/i,    iface: 'NVMe', pcie: 4.0, seq_r: 7100, seq_w: 6000, nand: 'QLC', dram: false },
  { pat: /Crucial.*P5\s*Plus|(?:^|\s)P5\s*Plus/i, iface: 'NVMe', pcie: 4.0, seq_r: 6600, seq_w: 5000, nand: 'TLC', dram: true },
  { pat: /Crucial.*P5\b(?!\s*Plus)|(?:^|\s)P5\b(?!\s*Plus)/i, iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /Crucial.*P3\s*Plus|(?:^|\s)P3\s*Plus/i, iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4200, nand: 'QLC', dram: false },
  { pat: /Crucial.*P3\b(?!\s*Plus)|(?:^|\s)P3\b(?!\s*Plus)/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'QLC', dram: false },
  { pat: /Crucial.*P2\b|(?:^|\s)P2\b/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1900, nand: 'QLC', dram: false },
  { pat: /Crucial.*P1\b|(?:^|\s)P1\b/i,    iface: 'NVMe', pcie: 3.0, seq_r: 2000, seq_w: 1700, nand: 'QLC', dram: false },
  { pat: /Crucial.*MX500|(?:^|\s)MX500/i,  iface: 'SATA', seq_r: 560, seq_w: 510, nand: 'TLC', dram: true },
  { pat: /Crucial.*BX500|(?:^|\s)BX500/i,  iface: 'SATA', seq_r: 540, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /Crucial.*X10\s*Pro/i,            iface: 'USB', seq_r: 2100, seq_w: 2000, nand: 'TLC' },
  { pat: /Crucial.*X9\s*Pro/i,             iface: 'USB', seq_r: 1050, seq_w: 1050, nand: 'TLC' },
  { pat: /Crucial.*X9\b/i,                 iface: 'USB', seq_r: 1050, seq_w: 1050, nand: 'TLC' },
  { pat: /Crucial.*X8\b/i,                 iface: 'USB', seq_r: 1050, seq_w: 1000, nand: 'TLC' },
  { pat: /Crucial.*X6\b/i,                 iface: 'USB', seq_r: 800,  seq_w: 800,  nand: 'TLC' },

  // ═══ KINGSTON ═══════════════════════════════════════════════════════════
  { pat: /Kingston.*Fury\s*Renegade/i,     iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 7000, nand: 'TLC', dram: true },
  { pat: /Kingston.*KC3000/i,              iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 7000, nand: 'TLC', dram: true },
  { pat: /Kingston.*KC2000/i,              iface: 'NVMe', pcie: 3.0, seq_r: 3200, seq_w: 2200, nand: 'TLC', dram: true },
  { pat: /Kingston.*NV3/i,                 iface: 'NVMe', pcie: 4.0, seq_r: 6000, seq_w: 5000, nand: 'TLC', dram: false },
  { pat: /Kingston.*NV2/i,                 iface: 'NVMe', pcie: 4.0, seq_r: 3500, seq_w: 2800, nand: 'QLC', dram: false },
  { pat: /Kingston.*NV1/i,                 iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'QLC', dram: false },
  { pat: /Kingston.*A2000/i,               iface: 'NVMe', pcie: 3.0, seq_r: 2200, seq_w: 2000, nand: 'TLC', dram: true },
  { pat: /Kingston.*A400|A400\s*SATA/i,    iface: 'SATA', seq_r: 500, seq_w: 450, nand: 'TLC', dram: false },
  { pat: /Kingston.*KC600/i,               iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Kingston.*XS2000/i,              iface: 'USB', seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  { pat: /Kingston.*XS1000/i,              iface: 'USB', seq_r: 1050, seq_w: 1000, nand: 'TLC' },

  // ═══ SK HYNIX ═══════════════════════════════════════════════════════════
  { pat: /SK\s*Hynix.*P51/i,  iface: 'NVMe', pcie: 5.0, seq_r: 14700, seq_w: 13400, nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix.*P41/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 6500, nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix.*P31/i,  iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3200, nand: 'TLC', dram: true },
  { pat: /SK\s*Hynix.*Beetle\s*X31/i, iface: 'USB', seq_r: 1050, seq_w: 1000, nand: 'TLC' },

  // ═══ CORSAIR ════════════════════════════════════════════════════════════
  { pat: /MP700\s*PRO\s*SE/i,     iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /MP700\s*PRO/i,          iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /MP700\b/i,              iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /MP600\s*PRO\s*XT/i,     iface: 'NVMe', pcie: 4.0, seq_r: 7100, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /MP600\s*PRO/i,          iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 6550, nand: 'TLC', dram: true },
  { pat: /MP600\s*CORE/i,         iface: 'NVMe', pcie: 4.0, seq_r: 4950, seq_w: 3950, nand: 'QLC', dram: false },
  { pat: /MP600\s*ELITE/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /MP600\b/i,              iface: 'NVMe', pcie: 4.0, seq_r: 4950, seq_w: 4250, nand: 'TLC', dram: true },
  { pat: /MP510/i,                iface: 'NVMe', pcie: 3.0, seq_r: 3480, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /MP400/i,                iface: 'NVMe', pcie: 3.0, seq_r: 3480, seq_w: 3000, nand: 'QLC', dram: true },

  // ═══ SABRENT ════════════════════════════════════════════════════════════
  { pat: /Sabrent.*Rocket\s*5/i,         iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\s*Plus\s*G/i, iface: 'NVMe', pcie: 4.0, seq_r: 7100, seq_w: 6600, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\s*Plus/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7000, seq_w: 6850, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*4\b/i,       iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /Sabrent.*Rocket\s*Q4/i,        iface: 'NVMe', pcie: 4.0, seq_r: 4700, seq_w: 1800, nand: 'QLC', dram: true },
  { pat: /Sabrent.*Rocket\s*Q\b/i,       iface: 'NVMe', pcie: 3.0, seq_r: 3200, seq_w: 2900, nand: 'QLC', dram: true },
  { pat: /Sabrent.*Rocket\b/i,           iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: true },

  // ═══ PNY ════════════════════════════════════════════════════════════════
  { pat: /CS3150/i,   iface: 'NVMe', pcie: 5.0, seq_r: 12000, seq_w: 11000, nand: 'TLC', dram: true },
  { pat: /CS3140/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7500, seq_w: 6850, nand: 'TLC', dram: true },
  { pat: /CS2241/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6000, nand: 'TLC', dram: false },
  { pat: /CS2140/i,   iface: 'NVMe', pcie: 4.0, seq_r: 3600, seq_w: 3200, nand: 'TLC', dram: false },
  { pat: /CS1030/i,   iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /CS900/i,    iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ LEXAR ══════════════════════════════════════════════════════════════
  { pat: /NM1090\s*PRO/i, iface: 'NVMe', pcie: 5.0, seq_r: 14500, seq_w: 13000, nand: 'TLC', dram: true },
  { pat: /NM1090/i,       iface: 'NVMe', pcie: 5.0, seq_r: 12000, seq_w: 11000, nand: 'TLC', dram: true },
  { pat: /NM800\s*PRO/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7500, seq_w: 6500, nand: 'TLC', dram: true },
  { pat: /NM790/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /NM710/i,        iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4500, nand: 'TLC', dram: false },
  { pat: /NM620/i,        iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /Lexar.*NS100/i, iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },

  // ═══ TEAMGROUP ══════════════════════════════════════════════════════════
  { pat: /Cardea\s*Z540/i, iface: 'NVMe', pcie: 5.0, seq_r: 12400, seq_w: 11800, nand: 'TLC', dram: true },
  { pat: /TeamGroup.*MP44|(?:^|\s)MP44\b/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6900, nand: 'TLC', dram: false },
  { pat: /TeamGroup.*MP34|(?:^|\s)MP34\b/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /TeamGroup.*MP33\s*PRO/i, iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'TLC', dram: false },
  { pat: /TeamGroup.*MP33\b|(?:^|\s)MP33\b/i, iface: 'NVMe', pcie: 3.0, seq_r: 1800, seq_w: 1500, nand: 'TLC', dram: false },
  { pat: /TeamGroup.*Vulcan|Vulcan\s*Z/i, iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /TeamGroup.*GX2|(?:^|\s)GX2\b/i,  iface: 'SATA', seq_r: 530, seq_w: 430, nand: 'TLC', dram: false },

  // ═══ PATRIOT ════════════════════════════════════════════════════════════
  { pat: /VP4300\s*Lite/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6400, nand: 'TLC', dram: false },
  { pat: /VP4300/i,        iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /VP4100/i,        iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /VPN110/i,        iface: 'NVMe', pcie: 3.0, seq_r: 3300, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /Patriot.*P400\s*Lite/i, iface: 'NVMe', pcie: 4.0, seq_r: 3500, seq_w: 2700, nand: 'QLC', dram: false },
  { pat: /Patriot.*P400\b/i,      iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Patriot.*P310/i, iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1800, nand: 'QLC', dram: false },
  { pat: /Patriot.*P300/i, iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'QLC', dram: false },
  { pat: /Patriot.*P210/i, iface: 'SATA', seq_r: 520, seq_w: 430, nand: 'TLC', dram: false },
  { pat: /Patriot.*Burst\s*Elite/i, iface: 'SATA', seq_r: 450, seq_w: 320, nand: 'QLC', dram: false },

  // ═══ SP SILICON POWER ═══════════════════════════════════════════════════
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*XS70/i,   iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*UD90/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*UD85/i,   iface: 'NVMe', pcie: 4.0, seq_r: 3600, seq_w: 2800, nand: 'QLC', dram: false },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*US70/i,   iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4400, nand: 'TLC', dram: true },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*P34A80/i, iface: 'NVMe', pcie: 3.0, seq_r: 3400, seq_w: 3000, nand: 'TLC', dram: true },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*P34A60/i, iface: 'NVMe', pcie: 3.0, seq_r: 2200, seq_w: 1600, nand: 'TLC', dram: false },
  { pat: /(?:Silicon\s*Power|^\s*SP\b).*A55/i,    iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: false },

  // ═══ FANXIANG ═══════════════════════════════════════════════════════════
  { pat: /Fanxiang.*S880/i,       iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fanxiang.*S790/i,       iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S770/i,       iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fanxiang.*S660/i,       iface: 'NVMe', pcie: 4.0, seq_r: 4900, seq_w: 4500, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S500\s*PRO/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /Fanxiang.*S501/i,       iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ FIKWOT ═════════════════════════════════════════════════════════════
  { pat: /Fikwot.*FN960/i, iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /Fikwot.*FN955/i, iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FN950/i, iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4800, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FN500/i, iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 3200, nand: 'TLC', dram: false },
  { pat: /Fikwot.*FS810/i, iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ BESTOSS / KINGSPEC ═════════════════════════════════════════════════
  { pat: /Bestoss.*BX100/i, iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },
  { pat: /Bestoss.*BM5/i,   iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /KingSpec.*XG7000/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6700, nand: 'TLC', dram: true },
  { pat: /KingSpec.*NX/i,   iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /KingSpec.*P3/i,   iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },

  // ═══ ADATA / XPG ════════════════════════════════════════════════════════
  { pat: /(?:ADATA|XPG).*Legend\s*970/i, iface: 'NVMe', pcie: 5.0, seq_r: 10000, seq_w: 10000, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*960/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*850/i, iface: 'NVMe', pcie: 4.0, seq_r: 5000, seq_w: 4500, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*Legend\s*800/i, iface: 'NVMe', pcie: 4.0, seq_r: 3500, seq_w: 2800, nand: 'QLC', dram: false },
  { pat: /(?:ADATA|XPG).*Legend\s*710/i, iface: 'NVMe', pcie: 3.0, seq_r: 2400, seq_w: 1800, nand: 'TLC', dram: false },
  { pat: /(?:ADATA|XPG).*Gammix\s*S70/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU800/i,        iface: 'SATA', seq_r: 560, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU750/i,        iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /(?:ADATA|XPG).*SU650/i,        iface: 'SATA', seq_r: 520, seq_w: 450, nand: 'TLC', dram: false },

  // ═══ KLEVV / TRANSCEND / KIOXIA / TOSHIBA / MICRON / MSI / EDILOCA / MISC
  { pat: /KLEVV.*CRAS\s*C910/i,  iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 13000, nand: 'TLC', dram: true },
  { pat: /KLEVV.*CRAS\s*C820/i,  iface: 'NVMe', pcie: 4.0, seq_r: 4700,  seq_w: 4200,  nand: 'TLC', dram: false },
  { pat: /KLEVV.*NEO\s*N400/i,   iface: 'SATA', seq_r: 550, seq_w: 520, nand: 'TLC', dram: false },
  { pat: /Transcend.*MTE250S/i,  iface: 'NVMe', pcie: 4.0, seq_r: 7500, seq_w: 6500, nand: 'TLC', dram: false },
  { pat: /Transcend.*MTE240S/i,  iface: 'NVMe', pcie: 4.0, seq_r: 3800, seq_w: 3200, nand: 'TLC', dram: false },
  { pat: /Transcend.*MTE220S/i,  iface: 'NVMe', pcie: 3.0, seq_r: 3500, seq_w: 2500, nand: 'TLC', dram: true },
  { pat: /Transcend.*SSD230S/i,  iface: 'SATA', seq_r: 560, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Gigastone/i,           iface: 'SATA', seq_r: 540, seq_w: 480, nand: 'TLC', dram: false },
  { pat: /Ediloca.*EN760/i,      iface: 'NVMe', pcie: 4.0, seq_r: 7400, seq_w: 6800, nand: 'TLC', dram: false },
  { pat: /Ediloca.*EN600/i,      iface: 'NVMe', pcie: 3.0, seq_r: 3300, seq_w: 3100, nand: 'TLC', dram: false },
  { pat: /Ediloca.*ES106/i,      iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'TLC', dram: false },
  { pat: /KIOXIA.*Exceria\s*Pro/i, iface: 'NVMe', pcie: 4.0, seq_r: 7300, seq_w: 6400, nand: 'TLC', dram: true },
  { pat: /KIOXIA.*Exceria/i,     iface: 'NVMe', pcie: 3.0, seq_r: 2100, seq_w: 1700, nand: 'TLC', dram: false },
  { pat: /Toshiba.*[XPN]300/i,   iface: 'SATA', rpm: 7200 },
  { pat: /Micron.*5400\s*PRO/i,  iface: 'SATA', seq_r: 540, seq_w: 520, nand: 'TLC', dram: true },
  { pat: /Micron.*7450\s*Pro/i,  iface: 'U.2',  pcie: 4.0, seq_r: 6800, seq_w: 5300, nand: 'TLC', dram: true },
  { pat: /Micron.*2450/i,        iface: 'NVMe', pcie: 4.0, seq_r: 3600, seq_w: 3000, nand: 'TLC', dram: false },
  { pat: /MSI.*Spatium\s*M570\s*PRO/i, iface: 'NVMe', pcie: 5.0, seq_r: 14000, seq_w: 12000, nand: 'TLC', dram: true },
  { pat: /MSI.*Spatium\s*M480\s*PRO/i, iface: 'NVMe', pcie: 4.0, seq_r: 7400,  seq_w: 7000,  nand: 'TLC', dram: true },
  { pat: /MSI.*Spatium\s*M470/i,       iface: 'NVMe', pcie: 4.0, seq_r: 5000,  seq_w: 4400,  nand: 'TLC', dram: true },

  // ═══ GENERIC FALLBACKS (form factor + gen only) ═════════════════════════
  // These catch generic/unknown SSDs where we can at least tag interface+pcie
  // from explicit markers in the title
  { pat: /\bNVMe\b.*\bGen\s*5\b|\bPCIe\s*(?:Gen\s*)?5\.0\b.*M\.?2/i, iface: 'NVMe', pcie: 5.0 },
  { pat: /\bNVMe\b.*\bGen\s*4\b|\bPCIe\s*(?:Gen\s*)?4\.0\b.*M\.?2/i, iface: 'NVMe', pcie: 4.0 },
  { pat: /\bNVMe\b.*\bGen\s*3\b|\bPCIe\s*(?:Gen\s*)?3\.0\b.*M\.?2/i, iface: 'NVMe', pcie: 3.0 },
  { pat: /\bNVMe\b|M\.?2\s*2280/i,        iface: 'NVMe' },
  { pat: /\bSATA\s*(?:III|3)\b|2\.5\s*Inch\s*SSD/i, iface: 'SATA' },
  { pat: /External\s*(?:Portable\s*)?(?:Hard\s*Drive|SSD|HDD)|\bUSB\s*3/i, iface: 'USB' },
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
