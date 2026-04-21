#!/usr/bin/env node
/**
 * storage-finish.js
 *
 * Final pass. Addresses remaining gaps:
 *
 * 1. HDDs don't have seq_r/seq_w as a meaningful spec. We fill RPM from
 *    titles where possible, and stop chasing seq_r for HDDs.
 *
 * 2. Add SN7100 (WD's 2025 SSD sold under SanDisk brand).
 *
 * 3. Fill remaining SSDs that slipped through by matching known brand
 *    models more aggressively.
 *
 * 4. Report what's genuinely unreachable so we know the real ceiling.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── Classify each storage product as SSD | HDD | USB ────────────────────────
function classify(p) {
  const text = `${p.b} ${p.n}`.toLowerCase();
  // Explicit HDD markers
  if (/\b(?:rpm|hard\s*drive|hdd|barracuda|ironwolf|skyhawk|exos|wd\s*(?:red|blue|black|purple|gold).*(?:\d+\s*tb|nas|desktop|performance)|\d+\s*tb.*(?:7200|5400)\s*rpm|3\.5\s*inch|3\.5\"|bare\s*drive)\b/i.test(text)
      && !/\bSSD\b/i.test(text)) return 'HDD';
  // Explicit SSD markers
  if (/\b(?:SSD|NVMe|M\.2|2\.5\s*inch\s*ssd|sata\s*ssd|tlc|qlc|mlc|pcie)\b/i.test(text)) return 'SSD';
  // External/portable
  if (/\b(?:external|portable|game\s*drive|usb\s*3)\b/i.test(text)) {
    if (/\b(?:ssd|nvme)\b/i.test(text)) return 'USB-SSD';
    return 'USB-HDD';
  }
  return 'UNKNOWN';
}

// ─── Extract RPM from titles ─────────────────────────────────────────────────
function extractRPM(p) {
  if (p.rpm != null) return null;
  const text = `${p.b} ${p.n}`;
  const m = text.match(/(5400|5900|7200|10000|15000)\s*RPM/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Additional SSD patterns missed previously ──────────────────────────────
const ADDITIONAL_SSD_DB = [
  // SanDisk/WD_BLACK SN7100 (WD's current gen, sold under SanDisk brand)
  { pat: /SN7100/i, iface: 'NVMe', pcie: 4.0, seq_r: 7250, seq_w: 6900, nand: 'TLC', dram: false },
  // WD_Black P40 / P50 Portable SSDs
  { pat: /WD_?BLACK.*P40/i, iface: 'USB', seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  { pat: /WD_?BLACK.*P50/i, iface: 'USB', seq_r: 2000, seq_w: 2000, nand: 'TLC' },
  // Kingston Renegade G5
  { pat: /Kingston.*Renegade\s*G5|Renegade\s*G5/i, iface: 'NVMe', pcie: 5.0, seq_r: 14800, seq_w: 14000, nand: 'TLC', dram: true },
  // Samsung 870 QVO variants mentioned without "Samsung" prefix
  { pat: /(?:Electronics\s*)?870\s*EVO/i,           iface: 'SATA', seq_r: 560, seq_w: 530, nand: 'TLC', dram: true },
  // Crucial MX500 without brand prefix
  { pat: /(?:^|\s)MX500\b/i,                        iface: 'SATA', seq_r: 560, seq_w: 510, nand: 'TLC', dram: true },
  // ADATA SU630
  { pat: /(?:ADATA|XPG).*SU630|(?:^|\s)SU630\b/i,   iface: 'SATA', seq_r: 520, seq_w: 450, nand: 'QLC', dram: false },
  // Fikwot FX815 (SATA 2.5")
  { pat: /Fikwot.*FX815/i,                          iface: 'SATA', seq_r: 550, seq_w: 450, nand: 'TLC', dram: false },
  // Seagate FireCuda SSHD (hybrid, but it's still marketed with specs)
  { pat: /FireCuda.*SSHD|Solid\s*State\s*Hybrid/i,  iface: 'SATA', rpm: 7200 },
  // BarraCuda Q1 SSD (rare)
  { pat: /BarraCuda\s*Q1\s*SSD/i,                   iface: 'SATA', seq_r: 550, seq_w: 500, nand: 'QLC', dram: false },
  { pat: /BarraCuda\s*SSD/i,                        iface: 'SATA', seq_r: 560, seq_w: 540, nand: 'TLC', dram: true },
];

let addlMatched = 0;
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of ADDITIONAL_SSD_DB) {
    if (entry.pat.test(text)) {
      addlMatched++;
      for (const [dkey, pkey] of Object.entries({ iface: 'interface', pcie: 'pcie', seq_r: 'seq_r', seq_w: 'seq_w', nand: 'nand', dram: 'dram', rpm: 'rpm' })) {
        if (entry[dkey] !== undefined && p[pkey] == null) p[pkey] = entry[dkey];
      }
      break;
    }
  }
}
console.log(`Extra model patterns matched: ${addlMatched}`);

// ─── Fill RPM for HDDs ──────────────────────────────────────────────────────
let rpmAdded = 0;
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const rpm = extractRPM(p);
  if (rpm) { p.rpm = rpm; rpmAdded++; }
}

// Default RPM by known HDD product lines (manufacturer spec)
const HDD_RPM_DEFAULTS = [
  { pat: /BarraCuda.*(?:2\.5|2\.5\")/i,       rpm: 5400 },  // laptop BarraCuda
  { pat: /BarraCuda(?!\s*Pro)/i,              rpm: 7200 },  // desktop BarraCuda
  { pat: /BarraCuda\s*Pro/i,                  rpm: 7200 },
  { pat: /IronWolf\s*Pro/i,                   rpm: 7200 },
  { pat: /IronWolf/i,                         rpm: 7200 },
  { pat: /SkyHawk\s*AI/i,                     rpm: 7200 },
  { pat: /SkyHawk/i,                          rpm: 5400 },
  { pat: /Exos/i,                             rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Red\s*Pro/i, rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Red/i,    rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Gold/i,   rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Purple/i, rpm: 5400 },
  { pat: /(?:WD|Western\s*Digital).*Black.*(?:Performance|\d+TB)/i, rpm: 7200 },
  { pat: /(?:WD|Western\s*Digital).*Blue/i,   rpm: 7200 },
  { pat: /Toshiba.*[XNP]300/i,                rpm: 7200 },
  { pat: /Seagate.*Game\s*Drive/i,            rpm: 5400 },
  { pat: /Seagate.*Expansion/i,               rpm: 5400 },
  { pat: /Seagate.*Portable/i,                rpm: 5400 },
  { pat: /Seagate.*Backup\s*Plus/i,           rpm: 5400 },
  { pat: /Seagate.*One\s*Touch/i,             rpm: 5400 },
  { pat: /Seagate.*Ultra\s*Touch/i,           rpm: 5400 },
  { pat: /Seagate.*Constellation/i,           rpm: 7200 },
  { pat: /Seagate.*Video/i,                   rpm: 5900 },
];

let rpmDefaultsAdded = 0;
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.rpm != null) continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of HDD_RPM_DEFAULTS) {
    if (entry.pat.test(text)) {
      p.rpm = entry.rpm;
      rpmDefaultsAdded++;
      break;
    }
  }
}

console.log(`RPM added from regex: ${rpmAdded}`);
console.log(`RPM added from HDD defaults: ${rpmDefaultsAdded}`);

// ─── FINAL REPORT ───────────────────────────────────────────────────────────
const storage = parts.filter(p => p.c === 'Storage');
console.log(`\n━━━ FINAL COVERAGE ━━━`);
console.log(`Total Storage: ${storage.length}`);

// Classify
const counts = { SSD: 0, HDD: 0, 'USB-SSD': 0, 'USB-HDD': 0, UNKNOWN: 0 };
for (const p of storage) counts[classify(p)]++;
console.log(`By type: SSD=${counts.SSD}  HDD=${counts.HDD}  USB-SSD=${counts['USB-SSD']}  USB-HDD=${counts['USB-HDD']}  Unknown=${counts.UNKNOWN}`);

// Coverage of each field, but only over products where it's applicable
const ssdLike = storage.filter(p => ['SSD', 'USB-SSD'].includes(classify(p)));
const hddLike = storage.filter(p => ['HDD', 'USB-HDD'].includes(classify(p)));

console.log(`\nField coverage (honest — only over applicable products):`);
console.log(`\n  SSDs (${ssdLike.length}):`);
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram']) {
  const n = ssdLike.filter(x => x[f] != null).length;
  console.log(`    ${f.padEnd(10)} ${n}/${ssdLike.length}  (${Math.round(n / ssdLike.length * 100)}%)`);
}
console.log(`\n  HDDs (${hddLike.length}):`);
for (const f of ['interface', 'rpm']) {
  const n = hddLike.filter(x => x[f] != null).length;
  console.log(`    ${f.padEnd(10)} ${n}/${hddLike.length}  (${Math.round(n / hddLike.length * 100)}%)`);
}

// Show truly unreachable products
console.log(`\n━━━ SSDs still missing seq_r ━━━`);
ssdLike.filter(p => p.seq_r == null).slice(0, 10).forEach(p => {
  console.log(`  [${p.b}] ${p.n.slice(0, 90)}`);
});

console.log(`\n━━━ HDDs still missing rpm ━━━`);
hddLike.filter(p => p.rpm == null).slice(0, 10).forEach(p => {
  console.log(`  [${p.b}] ${p.n.slice(0, 90)}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log(`\nWrote parts.js`);
