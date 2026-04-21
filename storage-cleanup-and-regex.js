#!/usr/bin/env node
/**
 * storage-cleanup-and-regex.js
 *
 * Step 1: Remove products that aren't actual drives (enclosures, NAS, docks,
 *         adapters, cables). These never had specs because they don't apply.
 *
 * Step 2: Regex-extract specs from title/brand for everything still missing.
 *         Titles like "Up to 7,400MB/s read" and "PCIe 4.0" are common.
 *
 * Step 3: Report honest remaining gaps with brand breakdown.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = mod.PARTS;

// ═══ STEP 1: PURGE NON-DRIVES ════════════════════════════════════════════════
const NON_DRIVE_PATTERNS = [
  /\bNAS\s*(?:DXP|D[A-Z]\d|system)/i,   // NAS systems (not the drives)
  /\bhard\s*drive\s*enclosure\b/i,
  /\bHDD\s*enclosure\b/i,
  /\bSSD\s*enclosure\b/i,
  /\bHDD\/SSD\s*enclosure\b/i,
  /\b\d[\s-]*bay\s*(?:hard\s*drive|HDD|SSD|enclosure|docking)/i,
  /\bdocking\s*station\b/i,
  /\bdrive\s*dock\b/i,
  /\bM\.?2\s*(?:NVMe\s*)?enclosure\b/i,
  /\bexternal\s*(?:HDD|SSD)\s*case\b/i,
  /\bcaddy\b/i,
  /\bcloner\b/i,
  /\bduplicator\b/i,
  /\bdisk\s*array\b/i,
  /\bmobile\s*rack\b/i,
];

const toRemove = [];
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const text = `${p.b || ''} ${p.n || ''}`;
  if (NON_DRIVE_PATTERNS.some(re => re.test(text))) {
    toRemove.push(p.id);
  }
}

console.log(`━━━ STEP 1: PURGE NON-DRIVES ━━━`);
console.log(`Removing ${toRemove.length} non-drive products:`);
for (const id of toRemove) {
  const p = parts.find(x => x.id === id);
  if (p) console.log(`  [${p.b}] ${p.n.slice(0, 80)}`);
}
parts = parts.filter(p => !toRemove.includes(p.id));

// ═══ STEP 2: REGEX EXTRACTION FROM TITLES ════════════════════════════════════
console.log(`\n━━━ STEP 2: REGEX EXTRACTION ━━━`);

function extractFromTitle(p) {
  const text = `${p.b || ''} ${p.n || ''}`;
  const result = {};

  // ── interface ───────────────────────────────────────────────────────────
  // Only fill if missing (we already set 96%)
  if (p.interface == null) {
    if (/\bNVMe\b|M\.?2\s*(?:2280|2230|2242)|PCIe\s*(?:Gen\s*)?[3-5]\.?0?/i.test(text)) result.interface = 'NVMe';
    else if (/\bSATA\s*(?:III|3|6Gb)|2\.5\s*(?:Inch\s*)?SSD|mSATA/i.test(text)) result.interface = 'SATA';
    else if (/external\s*(?:hard\s*drive|SSD|HDD|portable)|USB\s*(?:3\.[012]|Type-?C)|thunderbolt/i.test(text)) result.interface = 'USB';
    else if (/\bU\.?2\b/i.test(text)) result.interface = 'U.2';
    else if (/\bSAS\b/i.test(text)) result.interface = 'SAS';
  }

  // ── pcie (3.0 / 4.0 / 5.0) ──────────────────────────────────────────────
  if (p.pcie == null) {
    const m = text.match(/PCIe\s*(?:Gen\s*)?([345])(?:\.0)?\b/i) ||
              text.match(/\bGen\s*([345])\b/i);
    if (m) result.pcie = parseFloat(m[1] + '.0');
  }

  // ── seq_r / seq_w (MB/s) ────────────────────────────────────────────────
  // Handles: "Up to 7,400MB/s", "7400 MB/s read", "Read: 7,000MB/s",
  //          "Reads up to 7400MB/s", "Seq. Read up to 14,800MB/s"
  if (p.seq_r == null) {
    const patterns = [
      /(?:Seq(?:uential|\.)?\s*)?Read\s*(?:Speed|Speeds)?\s*(?:up\s*to|of|:)?\s*(?:up\s*to\s*)?([\d,]{3,6})\s*MB\/s/i,
      /Reads?\s*(?:up\s*to\s*)?([\d,]{3,6})\s*MB\/s/i,
      /\bup\s*to\s*([\d,]{3,6})\s*MB\/s\s*read/i,
      /([\d,]{3,6})\s*MB\/s\s*(?:seq(?:uential|\.)?\s*)?read/i,
      // Ranges like "7400/6500 MB/s" — first number is read
      /([\d,]{3,6})\s*\/\s*[\d,]{3,6}\s*MB\/s/i,
      // Last resort: "Up to 7,400MB/s" alone (single speed typically means read)
      /\bup\s*to\s*([\d,]{3,6})\s*MB\/s\b/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const v = parseInt(m[1].replace(/,/g, ''), 10);
        if (v >= 100 && v <= 20000) { result.seq_r = v; break; }
      }
    }
  }

  if (p.seq_w == null) {
    const patterns = [
      /(?:Seq(?:uential|\.)?\s*)?Write\s*(?:Speed|Speeds)?\s*(?:up\s*to|of|:)?\s*(?:up\s*to\s*)?([\d,]{3,6})\s*MB\/s/i,
      /Writes?\s*(?:up\s*to\s*)?([\d,]{3,6})\s*MB\/s/i,
      /\bup\s*to\s*([\d,]{3,6})\s*MB\/s\s*write/i,
      /([\d,]{3,6})\s*MB\/s\s*(?:seq(?:uential|\.)?\s*)?write/i,
      // Second number of "7400/6500 MB/s" range
      /[\d,]{3,6}\s*\/\s*([\d,]{3,6})\s*MB\/s/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const v = parseInt(m[1].replace(/,/g, ''), 10);
        if (v >= 100 && v <= 20000) { result.seq_w = v; break; }
      }
    }
  }

  // ── rpm (HDDs only) ─────────────────────────────────────────────────────
  if (p.rpm == null) {
    const m = text.match(/([57]200)\s*RPM/i) || text.match(/(5400|5900|7200|10000|15000)\s*RPM/i);
    if (m) result.rpm = parseInt(m[1], 10);
  }

  // ── nand ────────────────────────────────────────────────────────────────
  if (p.nand == null) {
    if (/\bTLC\b|\b3D\s*TLC\b/i.test(text)) result.nand = 'TLC';
    else if (/\bQLC\b/i.test(text)) result.nand = 'QLC';
    else if (/\bMLC\b/i.test(text)) result.nand = 'MLC';
  }

  return result;
}

const stats = { touched: 0, interface: 0, pcie: 0, seq_r: 0, seq_w: 0, rpm: 0, nand: 0 };
for (const p of parts) {
  if (p.c !== 'Storage') continue;
  const extracted = extractFromTitle(p);
  if (Object.keys(extracted).length === 0) continue;
  stats.touched++;
  for (const [key, val] of Object.entries(extracted)) {
    p[key] = val;
    stats[key]++;
  }
}

console.log(`\nRegex extraction results:`);
console.log(`  Touched: ${stats.touched} products`);
console.log(`  Added interface: ${stats.interface}`);
console.log(`  Added pcie: ${stats.pcie}`);
console.log(`  Added seq_r: ${stats.seq_r}`);
console.log(`  Added seq_w: ${stats.seq_w}`);
console.log(`  Added rpm: ${stats.rpm}`);
console.log(`  Added nand: ${stats.nand}`);

// ═══ STEP 3: FINAL COVERAGE REPORT ═══════════════════════════════════════════
const storage = parts.filter(p => p.c === 'Storage');
console.log(`\n━━━ FINAL COVERAGE (Storage category after cleanup) ━━━`);
console.log(`Total Storage products: ${storage.length}`);
for (const f of ['interface', 'pcie', 'seq_r', 'seq_w', 'nand', 'dram', 'rpm']) {
  const n = storage.filter(x => x[f] != null).length;
  const pct = Math.round(n / storage.length * 100);
  console.log(`  ${f.padEnd(10)} ${n}/${storage.length}  (${pct}%)`);
}

// Show brand breakdown of remaining missing seq_r (most-important field)
console.log(`\n━━━ BRANDS STILL MISSING seq_r (the ones fighting 100%) ━━━`);
const missingByBrand = {};
storage.filter(p => p.seq_r == null).forEach(p => {
  missingByBrand[p.b] = (missingByBrand[p.b] || 0) + 1;
});
Object.entries(missingByBrand).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([b, n]) => {
  console.log(`  ${b.padEnd(22)} ${n}`);
});

console.log(`\n━━━ SAMPLE of 10 PRODUCTS STILL MISSING seq_r ━━━`);
storage.filter(p => p.seq_r == null).slice(0, 10).forEach(p => {
  console.log(`  [${p.b}] ${p.n.slice(0, 85)}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log(`\nWrote parts.js (total products: ${parts.length})`);
