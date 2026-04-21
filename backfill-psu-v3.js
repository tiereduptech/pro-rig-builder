#!/usr/bin/env node
/**
 * backfill-psu-v3.js — closes the final 22 PSU gaps.
 *
 * Issues found:
 *   - "80 Plus® Gold Certification" — ® symbol broke regex
 *   - "80+ Bronze Certfied" — typo in title
 *   - Corsair "e" suffix (RM850e, RM1000e) — lowercase missed
 *   - HXi series should map to Platinum (2024/2025 models)
 *   - Pure Power 12/13 WITHOUT M suffix = Semi-Modular
 *   - Most cheap brands ship Non-Modular when not specified
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function inferEff(name) {
  if (!name) return null;
  // Strip the ® and ™ symbols that broke the regex
  const n = String(name).replace(/[®™©]/g, '');
  // More flexible "Certification" vs "Certified" wording
  const m = n.match(/(?:80\+?\s*(?:PLUS\s*)?|Cybenetics\s*|ATX\s*)?(Titanium|Platinum|Gold|Silver|Bronze|White)\s*(?:Certified|Certification|Certfied)/i);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  // Corsair model-based defaults (2024/2025 updates)
  if (/Corsair.*\bHX(?:i|I)\s*\d{3,4}|Corsair.*HX\d+(?:i|I)\s/i.test(n)) return 'Platinum';
  if (/Corsair.*\bRM\d{3,4}[exiX]/i.test(n)) return 'Gold';
  if (/Corsair.*\bAX(?:i|I)?\s*\d{3,4}/i.test(n)) return 'Titanium';
  // Apevia Soul series is Gold
  if (/Apevia.*(?:Soul|ATX-SL)/i.test(n)) return 'Gold';
  // be quiet! Pure Power 12/13 = Gold (always)
  if (/be\s*quiet.*Pure\s*Power\s*1[23]/i.test(n)) return 'Gold';
  return null;
}

function inferModular(name) {
  if (!name) return null;
  const n = String(name);
  if (/\bFully\s*Modular\b|\bFull[\s-]*Modular\b|\b100%\s*Modular\b/i.test(n)) return 'Full';
  if (/\bSemi[\s-]*Modular\b/i.test(n)) return 'Semi';
  if (/\bNon[\s-]*Modular\b/i.test(n)) return 'Non';
  // be quiet! Pure Power 12 (no M) = Semi per manufacturer
  if (/be\s*quiet.*Pure\s*Power\s*1[23](?!\s*M)/i.test(n)) return 'Semi';
  // be quiet! SFX L Quiet Performance = Fully Modular per manufacturer spec
  if (/be\s*quiet.*SFX\s*L\s*Quiet/i.test(n)) return 'Full';
  // Thermaltake Smart series with "80+ White" = Non-Modular always
  if (/Thermaltake.*Smart\s*\d+W.*White/i.test(n)) return 'Non';
  // ASRock PRO-XXXG = Non-Modular
  if (/ASRock.*PRO-\d+G/i.test(n)) return 'Non';
  // Zalman GigaMax = Non-Modular
  if (/Zalman.*GigaMax/i.test(n)) return 'Non';
  // SilverStone ET-B = Non-Modular; ET-HG = Semi
  if (/SilverStone.*ET\d+-?B\b/i.test(n)) return 'Non';
  if (/SilverStone.*ET\d+-?HG\b/i.test(n)) return 'Semi';
  // Apevia ATX-PR = Non-Modular (Prestige base), Jupiter = Non-Modular
  if (/Apevia.*(?:Jupiter|ATX-PR\d+W)/i.test(n)) return 'Non';
  // ARESGAME AGW = Non-Modular, AGV = Non-Modular, AGT = Full
  if (/ARESGAME.*AGW/i.test(n)) return 'Non';
  if (/ARESGAME.*AGV/i.test(n)) return 'Non';
  if (/ARESGAME.*AGT/i.test(n)) return 'Full';
  // High Power generic = Non-Modular
  if (/^High\s*Power\s/i.test(n)) return 'Non';
  // GAMEPOWER Gp-650 = Non-Modular
  if (/GAMEPOWER.*Gp-\d+/i.test(n)) return 'Non';
  // Raidmax Cobra = Full (Gen 5 Ready with PCIe 5.0)
  if (/Raidmax.*Cobra/i.test(n)) return 'Full';
  return null;
}

const stats = { eff: 0, modular: 0 };
for (const p of parts) {
  if (p.c !== 'PSU') continue;
  if (p.eff == null)     { const v = inferEff(p.n);     if (v) { p.eff = v; stats.eff++; } }
  if (p.modular == null) { const v = inferModular(p.n); if (v) { p.modular = v; stats.modular++; } }
}

console.log('Filled:', JSON.stringify(stats));

const psus = parts.filter(p => p.c === 'PSU');
console.log(`\n━━━ FINAL PSU COVERAGE (${psus.length}) ━━━`);
for (const f of ['watts', 'eff', 'modular', 'ff', 'atx3', 'rgb', 'fanSize', 'depth']) {
  const n = psus.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${psus.length}  (${Math.round(n / psus.length * 100)}%)`);
}

const stillMissing = psus.filter(p => p.ff == null || p.modular == null || p.eff == null);
console.log(`\nStill missing: ${stillMissing.length}`);
stillMissing.forEach(p => {
  const miss = [];
  if (!p.ff) miss.push('ff');
  if (!p.modular) miss.push('mod');
  if (!p.eff) miss.push('eff');
  console.log(`  [${miss.join(',').padEnd(10)}] [${p.b}] ${p.n.slice(0, 80)}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
