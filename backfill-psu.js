#!/usr/bin/env node
/**
 * backfill-psu.js
 *
 * 1. Move 3 misclassified extension-cable products from PSU → ExtensionCables
 * 2. Infer missing PSU fields from product names:
 *      ff        (ATX | SFX | SFX-L | TFX)
 *      atx3      (ATX 3.0/3.1 certified)
 *      rgb       (has RGB lighting)
 *      modular   (Full / Semi / Non)
 *      eff       (80+ rating)
 * 3. Dictionary of common PSU models for fan size/depth specs
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── STEP 1: RECATEGORIZE EXTENSION CABLES ──────────────────────────────────
const CABLE_IDS = [15452, 15477, 16760];
let moved = 0;
for (const p of parts) {
  if (CABLE_IDS.includes(p.id)) {
    console.log(`  Moved: [${p.b}] ${p.n.slice(0, 70)}`);
    p.c = 'ExtensionCables';
    moved++;
  }
}
console.log(`Moved ${moved} products from PSU → ExtensionCables\n`);

// ─── STEP 2: INFER PSU FIELDS FROM NAMES ────────────────────────────────────
function inferFF(name) {
  const n = String(name);
  if (/\bSFX-L\b/i.test(n)) return 'SFX-L';
  if (/\bSFX\b/i.test(n)) return 'SFX';
  if (/\bTFX\b/i.test(n)) return 'TFX';
  if (/\bATX\b/i.test(n)) return 'ATX';
  return null;
}

function inferATX3(name) {
  return /\bATX\s*3\.[01]\b|\bPCIe\s*5\.[01]\b|\b12VHPWR\b|\b12V-2x6\b/i.test(name);
}

function inferRGB(name) {
  return /\b(?:ARGB|A-RGB|RGB(?!\s*Lighting\s*disabled))\b/i.test(name);
}

function inferModular(name) {
  const n = String(name);
  if (/\bFull[\s-]*Modular\b|\b100%\s*Modular\b|\bFully\s*Modular\b/i.test(n)) return 'Full';
  if (/\bSemi[\s-]*Modular\b/i.test(n)) return 'Semi';
  if (/\bNon[\s-]*Modular\b/i.test(n)) return 'Non';
  return null;
}

function inferEff(name) {
  const n = String(name);
  if (/80\+?\s*Titanium|80\s*Plus\s*Titanium/i.test(n)) return 'Titanium';
  if (/80\+?\s*Platinum|80\s*Plus\s*Platinum/i.test(n)) return 'Platinum';
  if (/80\+?\s*Gold|80\s*Plus\s*Gold/i.test(n))         return 'Gold';
  if (/80\+?\s*Silver|80\s*Plus\s*Silver/i.test(n))     return 'Silver';
  if (/80\+?\s*Bronze|80\s*Plus\s*Bronze/i.test(n))     return 'Bronze';
  if (/80\+?\s*White|80\s*Plus\s*White/i.test(n))       return 'White';
  return null;
}

const stats = { ff: 0, atx3: 0, rgb: 0, modular: 0, eff: 0 };
for (const p of parts) {
  if (p.c !== 'PSU') continue;
  if (p.ff == null)       { const v = inferFF(p.n);      if (v) { p.ff = v; stats.ff++; } }
  if (p.atx3 == null)     { const v = inferATX3(p.n);    if (v) { p.atx3 = true; stats.atx3++; } }
  if (p.rgb == null)      { const v = inferRGB(p.n);     if (v) { p.rgb = true; stats.rgb++; } }
  if (p.modular == null)  { const v = inferModular(p.n); if (v) { p.modular = v; stats.modular++; } }
  if (p.eff == null)      { const v = inferEff(p.n);     if (v) { p.eff = v; stats.eff++; } }
}
console.log('━━━ INFERRED FROM TITLES ━━━');
console.log(JSON.stringify(stats, null, 2));

// ─── STEP 3: PSU DICTIONARY (fanSize, depth, exact specs for popular models) ──
const DB = [
  // Corsair
  { pat: /Corsair.*RM(?:e|i|x)?\s*\d{3,4}/i,        fanSize: 135, depth: 160 },
  { pat: /Corsair.*HX(?:i|I|P)?\s*\d{3,4}/i,        fanSize: 135, depth: 180 },
  { pat: /Corsair.*AX(?:i)?\s*\d{3,4}/i,            fanSize: 135, depth: 180 },
  { pat: /Corsair.*CX(?:M|F)?\s*\d{3,4}/i,          fanSize: 120, depth: 150 },
  { pat: /Corsair.*SF\s*\d{3,4}\s*(?:L)?/i,         fanSize: 92,  depth: 130, ff: 'SFX' },
  // Seasonic
  { pat: /Seasonic.*Prime\s*(?:TX|PX|GX)/i,         fanSize: 135, depth: 170 },
  { pat: /Seasonic.*Focus\s*(?:GX|PX|SGX)/i,        fanSize: 120, depth: 150 },
  { pat: /Seasonic.*Vertex\s*(?:GX|PX)/i,           fanSize: 135, depth: 160 },
  { pat: /Seasonic.*Connect/i,                      fanSize: 120, depth: 160 },
  // EVGA
  { pat: /EVGA.*SuperNOVA\s*\d{3,4}\s*G\+|EVGA.*G(?:2|3|5|6|7)/i, fanSize: 135, depth: 150 },
  { pat: /EVGA.*BQ\s*\d{3,4}/i,                    fanSize: 135, depth: 160 },
  { pat: /EVGA.*BR\s*\d{3,4}/i,                    fanSize: 120, depth: 140 },
  // be quiet!
  { pat: /be\s*quiet!\s*Dark\s*Power\s*(?:13|12|11|Pro)/i, fanSize: 135, depth: 175 },
  { pat: /be\s*quiet!\s*Straight\s*Power\s*(?:12|11)/i,    fanSize: 135, depth: 160 },
  { pat: /be\s*quiet!\s*Pure\s*Power\s*(?:12|13)\s*M/i,    fanSize: 120, depth: 160 },
  { pat: /be\s*quiet!\s*Pure\s*Power\s*(?:11|12)/i,        fanSize: 120, depth: 160 },
  // Thermaltake
  { pat: /Thermaltake.*Toughpower\s*GF\d/i,         fanSize: 140, depth: 170 },
  { pat: /Thermaltake.*Toughpower\s*PF\d/i,         fanSize: 135, depth: 150 },
  { pat: /Thermaltake.*Toughpower\s*GT/i,           fanSize: 140, depth: 170 },
  { pat: /Thermaltake.*Smart(?:\s*Standard|\s*BX1)?/i, fanSize: 120, depth: 140 },
  // NZXT
  { pat: /NZXT\s+C(?:750|850|1000|1200|1500)/i,    fanSize: 135, depth: 150 },
  { pat: /NZXT\s+E(?:500|650|850)/i,               fanSize: 135, depth: 150 },
  // Cooler Master
  { pat: /Cooler\s*Master.*MWE\s*Gold\s*\d+\s*V2/i, fanSize: 120, depth: 150 },
  { pat: /Cooler\s*Master.*V\s*SFX/i,               fanSize: 92,  depth: 130, ff: 'SFX' },
  { pat: /Cooler\s*Master.*V\s*Platinum/i,          fanSize: 135, depth: 160 },
  { pat: /Cooler\s*Master.*XG\s*\d+\s*Plus/i,       fanSize: 135, depth: 160 },
  // MSI
  { pat: /MSI.*MEG\s*Ai\d+/i,                       fanSize: 135, depth: 190 },
  { pat: /MSI.*MPG\s*A\d+GF/i,                      fanSize: 135, depth: 160 },
  { pat: /MSI.*MAG\s*A\d+/i,                        fanSize: 120, depth: 150 },
  // ASUS ROG
  { pat: /ASUS.*ROG\s*Thor/i,                       fanSize: 135, depth: 190, rgb: true },
  { pat: /ASUS.*ROG\s*Loki\s*SFX-L/i,               fanSize: 120, depth: 150, ff: 'SFX-L' },
  { pat: /ASUS.*ROG\s*Strix/i,                      fanSize: 135, depth: 160 },
  // XPG/ADATA
  { pat: /(?:XPG|ADATA).*Core\s*Reactor\s*II/i,     fanSize: 120, depth: 160 },
  { pat: /(?:XPG|ADATA).*Core\s*Reactor(?!\s*II)/i, fanSize: 120, depth: 160 },
  // Montech
  { pat: /Montech\s+Titan\s*Gold/i,                 fanSize: 135, depth: 150 },
  { pat: /Montech\s+Century/i,                      fanSize: 120, depth: 150 },
];

let dictHits = 0;
for (const p of parts) {
  if (p.c !== 'PSU') continue;
  const text = `${p.b} ${p.n}`;
  for (const entry of DB) {
    if (entry.pat.test(text)) {
      if (entry.fanSize != null && p.fanSize == null) p.fanSize = entry.fanSize;
      if (entry.depth != null && p.depth == null) p.depth = entry.depth;
      if (entry.ff && p.ff == null) p.ff = entry.ff;
      if (entry.rgb !== undefined && p.rgb == null) p.rgb = entry.rgb;
      dictHits++;
      break;
    }
  }
}
console.log(`\nDictionary matched: ${dictHits}`);

// ─── FINAL REPORT ───────────────────────────────────────────────────────────
const psus = parts.filter(p => p.c === 'PSU');
console.log(`\n━━━ FINAL PSU COVERAGE (${psus.length} products) ━━━`);
for (const f of ['watts', 'eff', 'modular', 'ff', 'atx3', 'rgb', 'fanSize', 'depth']) {
  const n = psus.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${psus.length}  (${Math.round(n / psus.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
