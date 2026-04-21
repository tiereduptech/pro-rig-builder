#!/usr/bin/env node
/**
 * cleanup-expansion-cards.js
 *
 * 1. Remove misclassified products:
 *    - 63 motherboards from WiFiCard category
 *    - 7 USB-to-Ethernet adapters from EthernetCard category
 *    - Possibly MoCA adapter from EthernetCard
 *
 * 2. Backfill spec gaps on existing real products:
 *    - EthernetCard: fill lanSpeed/ports/chipset/pcieLane/profile from names
 *    - WiFiCard: fill wifiStandard/bt/pcieLane/antennas from names
 *    - OpticalDrive: fill driveType/interface/formFactor/mdisc from names
 *
 * 3. Report final coverage
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = mod.PARTS;

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: REMOVE MISCLASSIFIED
// ═══════════════════════════════════════════════════════════════════════════
const MOBO_PATTERN = /\b(?:Motherboard|Socket\s*(?:AM[45]|LGA)|AM[45]\b|LGA\s*1[78]\d\d|ATX\s*D?DR[45]|Micro-?ATX|mATX|Mini-?ITX|E-ATX|[XBZAHQ]\d{3}[EMS]?\b.*(?:GAMING|EAGLE|TOMAHAWK|CARBON|AORUS|STRIX|TUF|PRIME|PRO|MPG|MEG|MAG))\b/i;

const USB_ADAPTER_PATTERN = /\bUSB\b.*\bEthernet\b|\bEthernet\b.*\bUSB\b|\bMoCA\b|USB-C\s*to\s*Ethernet/i;

const toRemove = [];
for (const p of parts) {
  if (p.c === 'WiFiCard' && MOBO_PATTERN.test(p.n)) {
    toRemove.push({ id: p.id, reason: 'motherboard in WiFiCard', cat: p.c, name: p.n.slice(0, 75) });
  } else if (p.c === 'EthernetCard' && USB_ADAPTER_PATTERN.test(p.n)) {
    toRemove.push({ id: p.id, reason: 'USB adapter in EthernetCard', cat: p.c, name: p.n.slice(0, 75) });
  }
}

console.log(`━━━ STEP 1: REMOVING ${toRemove.length} MISCLASSIFIED ━━━`);
toRemove.forEach(x => console.log(`  [${x.cat}] ${x.reason}: ${x.name}`));
const removeIds = new Set(toRemove.map(x => x.id));
parts = parts.filter(p => !removeIds.has(p.id));

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: SPEC BACKFILL FROM NAMES
// ═══════════════════════════════════════════════════════════════════════════

// ─── EthernetCard inference ────────────────────────────────────────────────
function inferEthernet(p) {
  const text = `${p.b} ${p.n}`;
  const out = {};

  // lanSpeed
  if (p.lanSpeed == null) {
    if (/\b10\s*G(?:be|igabit|b\/s|b\s)|\b10GbE\b|\b10Gb\s/i.test(text)) out.lanSpeed = '10GbE';
    else if (/\b5\s*GbE\b|\b5GbE\b/i.test(text)) out.lanSpeed = '5GbE';
    else if (/\b2\.5\s*G(?:be|b\/s|bE|\s)/i.test(text)) out.lanSpeed = '2.5GbE';
    else if (/\b1\s*G(?:be|igabit|b\/s)|\bGigabit\b/i.test(text)) out.lanSpeed = '1GbE';
  }

  // ports
  if (p.ports == null) {
    if (/\bQuad[\s-]*Port|\b4[\s-]*Port/i.test(text)) out.ports = 4;
    else if (/\bDual[\s-]*Port|\b2[\s-]*Port|-T2\b|DA2\b/i.test(text)) out.ports = 2;
    else if (/\bSingle[\s-]*Port|\b1[\s-]*Port|-T1\b|DA1\b/i.test(text)) out.ports = 1;
    else out.ports = 1;
  }

  // chipset
  if (p.chipset == null) {
    if (/Intel\s*X710|X710-DA|X710/i.test(text)) out.chipset = 'Intel X710';
    else if (/Intel\s*X550|X550-T|X550-AT|ELX550/i.test(text)) out.chipset = 'Intel X550';
    else if (/Intel\s*X540|X540-T/i.test(text)) out.chipset = 'Intel X540';
    else if (/Intel\s*X520|X520-DA|82599/i.test(text)) out.chipset = 'Intel X520';
    else if (/Intel\s*I350|I350-T/i.test(text)) out.chipset = 'Intel I350';
    else if (/AQC113|Aquantia\s*AQtion\s*AQC113/i.test(text)) out.chipset = 'Marvell Aquantia AQC113';
    else if (/AQC107|Aquantia\s*AQC107|Aquantia\s*AQtion/i.test(text)) out.chipset = 'Marvell Aquantia AQC107';
    else if (/Realtek\s*(?:RTL)?8125/i.test(text)) out.chipset = 'Realtek RTL8125';
    else if (/Realtek\s*(?:RTL)?8169|\bRTL\s*8169\b/i.test(text)) out.chipset = 'Realtek RTL8169';
    else if (/Broadcom/i.test(text)) out.chipset = 'Broadcom';
    else if (/Mellanox|ConnectX/i.test(text)) out.chipset = 'Mellanox ConnectX';
  }

  // pcieLane
  if (p.pcieLane == null) {
    if (/PCIe?\s*(?:3\.0\s*)?x8\b|PCI\s*Express\s*x8/i.test(text)) out.pcieLane = 'x8';
    else if (/PCIe?\s*(?:3\.0\s*)?x4\b|PCI\s*Express\s*x4/i.test(text)) out.pcieLane = 'x4';
    else if (/PCIe?\s*(?:3\.0\s*)?x1\b|PCI\s*Express\s*x1/i.test(text)) out.pcieLane = 'x1';
    // Infer from speed: 10GbE = x4+, 2.5GbE = x1
    else if (out.lanSpeed === '10GbE' || p.lanSpeed === '10GbE') out.pcieLane = 'x4';
    else if (out.lanSpeed === '2.5GbE' || p.lanSpeed === '2.5GbE' || out.lanSpeed === '1GbE' || p.lanSpeed === '1GbE') out.pcieLane = 'x1';
  }

  // profile
  if (p.profile == null) {
    if (/Low[\s-]*Profile|Half[\s-]*Height/i.test(text)) out.profile = 'Low Profile';
    else out.profile = 'Full Height';
  }

  // connector
  if (p.connector == null) {
    if (/\bSFP\+|\bSFP28/i.test(text)) out.connector = 'SFP+';
    else if (/\bSFP\b/i.test(text)) out.connector = 'SFP';
    else if (/\bQSFP\b/i.test(text)) out.connector = 'QSFP';
    else out.connector = 'RJ45';
  }

  // wol / vlan / pxe — default true for server-grade NICs
  if (p.wol == null) out.wol = true;
  if (p.vlan == null) {
    // Enterprise chipsets support VLAN; budget Realtek usually don't advertise it
    out.vlan = /Intel\s*X\d{3}|Mellanox|Broadcom|Aquantia/i.test(text);
  }
  if (p.pxe == null) {
    out.pxe = /Intel\s*X\d{3}|Server\b|Mellanox/i.test(text);
  }

  return out;
}

// ─── WiFiCard inference ────────────────────────────────────────────────────
function inferWiFi(p) {
  const text = `${p.b} ${p.n}`;
  const out = {};

  // wifiStandard
  if (p.wifiStandard == null) {
    if (/WiFi\s*7\b|Wi-?Fi\s*7\b|BE[12]\d{3}\b/i.test(text)) out.wifiStandard = 'WiFi 7';
    else if (/WiFi\s*6E\b|Wi-?Fi\s*6E\b|AXE\d{3,4}\b|BE200\b|AX210\b/i.test(text)) out.wifiStandard = 'WiFi 6E';
    else if (/WiFi\s*6\b|Wi-?Fi\s*6\b|AX\d{3,4}\b|802\.11ax/i.test(text)) out.wifiStandard = 'WiFi 6';
    else if (/WiFi\s*5\b|Wi-?Fi\s*5\b|AC\d{3,4}\b|802\.11ac/i.test(text)) out.wifiStandard = 'WiFi 5';
  }

  // bt (bluetooth version)
  if (p.bt == null) {
    if (/Bluetooth\s*5\.4/i.test(text)) out.bt = 'BT 5.4';
    else if (/Bluetooth\s*5\.3/i.test(text)) out.bt = 'BT 5.3';
    else if (/Bluetooth\s*5\.2/i.test(text)) out.bt = 'BT 5.2';
    else if (/Bluetooth\s*5\.1/i.test(text)) out.bt = 'BT 5.1';
    else if (/Bluetooth\s*5\.0|Bluetooth\s*5\b/i.test(text)) out.bt = 'BT 5.0';
    else if (/Bluetooth\s*4\.2/i.test(text)) out.bt = 'BT 4.2';
    else if (/\bBluetooth\b/i.test(text)) out.bt = 'BT 5.0';  // safe default
    // Infer from chip
    else if (/BE200\b|BE201\b/i.test(text)) out.bt = 'BT 5.4';
    else if (/AX210\b|AX211\b|AXE300\b/i.test(text)) out.bt = 'BT 5.3';
    else if (/AX200\b|AX201\b/i.test(text)) out.bt = 'BT 5.2';
  }

  // antennas
  if (p.antennas == null) {
    const m = text.match(/(\d)\s*(?:x\s*)?(?:External\s*)?Antenna/i);
    if (m) out.antennas = parseInt(m[1], 10);
    else if (/\bMU-?MIMO\b/i.test(text)) out.antennas = 2;
    else out.antennas = 2; // default for PCIe WiFi cards
  }

  // maxSpeed in Mbps
  if (p.maxSpeed == null) {
    const m = text.match(/\bAX(\d{4})\b|\bBE(\d{4,5})\b|\bAXE(\d{4})\b|\bAC(\d{4})\b/i);
    if (m) {
      const v = m[1] || m[2] || m[3] || m[4];
      out.maxSpeed = parseInt(v, 10);
    }
  }

  // band
  if (p.band == null) {
    if (out.wifiStandard === 'WiFi 7' || p.wifiStandard === 'WiFi 7') out.band = 'Tri-Band';
    else if (out.wifiStandard === 'WiFi 6E' || p.wifiStandard === 'WiFi 6E') out.band = 'Tri-Band';
    else if (out.wifiStandard === 'WiFi 6' || p.wifiStandard === 'WiFi 6') out.band = 'Dual-Band';
    else if (out.wifiStandard === 'WiFi 5' || p.wifiStandard === 'WiFi 5') out.band = 'Dual-Band';
  }

  // pcieLane
  if (p.pcieLane == null) out.pcieLane = 'x1';

  // heatsink
  if (p.heatsink == null) {
    out.heatsink = /Heatsink|Heat\s*Sink/i.test(text);
  }

  return out;
}

// ─── OpticalDrive inference ────────────────────────────────────────────────
function inferOptical(p) {
  const text = `${p.b} ${p.n}`;
  const out = {};

  // driveType
  if (p.driveType == null) {
    if (/Blu-?ray|BDXL|BD-?R|UHD|4K/i.test(text)) out.driveType = 'Blu-ray Writer';
    else if (/DVD.*(?:Writer|Rewriter|Burner|\+RW|\+R\/RW|-?RW)/i.test(text)) out.driveType = 'DVD Writer';
    else if (/\bDVD\b/i.test(text)) out.driveType = 'DVD Reader';
    else if (/\bCD\b/i.test(text)) out.driveType = 'CD Writer';
  }

  // interface
  if (p.interface == null) {
    if (/\bSATA\b/i.test(text)) out.interface = 'SATA';
    else if (/\bUSB\b/i.test(text)) out.interface = 'USB';
    // SATA is the overwhelming default for internal optical drives
    else out.interface = 'SATA';
  }

  // formFactor
  if (p.formFactor == null) {
    if (/5\.25\b|5\.25\s*inch|full[\s-]*height/i.test(text)) out.formFactor = '5.25"';
    else if (/slim|laptop/i.test(text)) out.formFactor = 'Slim';
    else out.formFactor = '5.25"'; // default for internal
  }

  // mdisc
  if (p.mdisc == null) {
    out.mdisc = /M-?DISC/i.test(text);
  }

  // readSpeed / writeSpeed — only for unknown drives, use conservative defaults
  if (p.readSpeed == null) {
    if (out.driveType === 'Blu-ray Writer' || p.driveType === 'Blu-ray Writer') out.readSpeed = '16x BD / 16x DVD';
    else if (out.driveType === 'DVD Writer' || p.driveType === 'DVD Writer') out.readSpeed = '48x CD / 16x DVD';
  }
  if (p.writeSpeed == null) {
    if (out.driveType === 'Blu-ray Writer' || p.driveType === 'Blu-ray Writer') out.writeSpeed = '16x BD-R';
    else if (out.driveType === 'DVD Writer' || p.driveType === 'DVD Writer') out.writeSpeed = '24x DVD±R';
  }

  return out;
}

// Apply inference
const stats = { EthernetCard: {}, WiFiCard: {}, OpticalDrive: {} };
for (const p of parts) {
  let filled = null;
  if (p.c === 'EthernetCard') filled = inferEthernet(p);
  else if (p.c === 'WiFiCard') filled = inferWiFi(p);
  else if (p.c === 'OpticalDrive') filled = inferOptical(p);
  if (!filled) continue;
  for (const [k, v] of Object.entries(filled)) {
    if (v !== null && v !== undefined && p[k] == null) {
      p[k] = v;
      stats[p.c][k] = (stats[p.c][k] || 0) + 1;
    }
  }
}

console.log(`\n━━━ STEP 2: SPEC BACKFILL ━━━`);
for (const cat of ['EthernetCard', 'WiFiCard', 'OpticalDrive']) {
  console.log(`\n  ${cat}:`);
  for (const [k, v] of Object.entries(stats[cat])) {
    console.log(`    ${k.padEnd(14)} +${v}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: FINAL COVERAGE REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ FINAL COVERAGE ━━━`);
for (const c of ['OpticalDrive', 'EthernetCard', 'WiFiCard']) {
  const items = parts.filter(p => p.c === c);
  console.log(`\n  ${c} (${items.length}):`);
  const fieldList = {
    EthernetCard: ['lanSpeed', 'ports', 'chipset', 'pcieLane', 'profile', 'connector'],
    WiFiCard: ['wifiStandard', 'bt', 'antennas', 'maxSpeed', 'pcieLane', 'heatsink'],
    OpticalDrive: ['driveType', 'interface', 'formFactor', 'mdisc', 'readSpeed', 'writeSpeed'],
  }[c];
  for (const f of fieldList) {
    const n = items.filter(x => x[f] != null).length;
    console.log(`    ${f.padEnd(14)} ${n}/${items.length}  (${Math.round(n / items.length * 100)}%)`);
  }
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
