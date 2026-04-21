#!/usr/bin/env node
/**
 * backfill-psu-v2.js — tighter inference patterns and brand defaults
 * for the 47 remaining PSUs with missing ff/modular/eff.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── Broader ff patterns ─────────────────────────────────────────────────────
function inferFF(name) {
  const n = String(name);
  if (/\bSFX-L\b|\bSFX\s*L\b/i.test(n)) return 'SFX-L';
  if (/\bSFX\b(?!-L)/i.test(n)) return 'SFX';
  if (/\bTFX\b/i.test(n)) return 'TFX';
  // Catches "ATX 3.1", "ATX Power Supply", "ATX PSU", "ATX Gaming" etc
  if (/\bATX\b/i.test(n)) return 'ATX';
  // Brand-based fallback: most PSU model lines are ATX unless stated
  // Names mentioning a wattage of 550+ are almost always ATX
  if (/\b(?:550|600|650|750|850|1000|1200|1500)\s*W(?:att)?\b/i.test(n)) return 'ATX';
  return null;
}

// ─── Broader modular patterns ───────────────────────────────────────────────
function inferModular(name) {
  const n = String(name);
  if (/\bFully\s*Modular\b|\bFull[\s-]*Modular\b|\b100%\s*Modular\b/i.test(n)) return 'Full';
  if (/\bSemi[\s-]*Modular\b/i.test(n)) return 'Semi';
  if (/\bNon[\s-]*Modular\b/i.test(n)) return 'Non';
  // Model-name-implied modularity
  // be quiet! "M" suffix = Modular; Dark Power Pro = always full modular
  if (/Pure\s*Power\s*\d+\s*M\b/i.test(n)) return 'Full';
  if (/Straight\s*Power\s*12/i.test(n)) return 'Full';
  if (/Dark\s*Power\s*(?:Pro\s*)?1[23]/i.test(n)) return 'Full';
  if (/Power\s*Zone\s*2/i.test(n)) return 'Full';
  // Corsair naming: RMx/RMi/RMe/HXi/AXi = Full; CXM = Semi; CX (no M) = Non
  if (/\bRM[xieX]?\s*\d{3,4}|\bHX(?:i|I)?\s*\d{3,4}|\bAX(?:i)?\s*\d{3,4}|\bSF\s*\d{3,4}\s*L?\b/i.test(n)) return 'Full';
  if (/\bCXM\s*\d{3,4}|\bCX[MF]\s*\d{3,4}/i.test(n)) return 'Semi';
  // Apevia Prestige, Jupiter series tend to be non-modular
  if (/Apevia.*(?:Jupiter|Prestige\s*600|ATX-PR600)/i.test(n)) return 'Non';
  if (/Apevia.*(?:Soul|ATX-SL|ATX-PR1000)/i.test(n)) return 'Full';
  // Corsair CXM is semi, CX is non
  if (/\bCX\d{3,4}(?:\s|$)(?!.*M\b)/i.test(n)) return 'Non';
  // ASRock PRO/Phantom = Non-Modular unless said otherwise
  if (/ASRock.*PRO-\d+G/i.test(n)) return 'Non';
  // SilverStone ET-B/ET-HG = Semi-Modular unless otherwise stated
  if (/SilverStone.*ET\d+-?(?:B|HG)/i.test(n)) return 'Semi';
  // Zalman GigaMax = Non-Modular
  if (/Zalman.*GigaMax/i.test(n)) return 'Non';
  // be quiet! SFX L = Non-Modular in that variant (explicitly stated in title)
  if (/be\s*quiet.*SFX\s*L\s*Quiet/i.test(n)) return 'Non';
  return null;
}

// ─── Broader eff patterns ───────────────────────────────────────────────────
function inferEff(name) {
  const n = String(name);
  // Handle "80 Plus Titanium", "80+ Titanium", "80 PLUS Titanium", "Cybenetics Titanium"
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*Titanium/i.test(n)) return 'Titanium';
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*Platinum/i.test(n)) return 'Platinum';
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*Gold/i.test(n))     return 'Gold';
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*Silver/i.test(n))   return 'Silver';
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*Bronze/i.test(n))   return 'Bronze';
  if (/(?:80\+?|80\s*PLUS|Cybenetics)\s*White/i.test(n))    return 'White';
  // "Gold Certified", "Platinum Certified" without 80+ prefix
  if (/\b(?:Gold|Platinum|Titanium|Bronze|Silver|White)\s*Certified\b/i.test(n)) {
    const m = n.match(/\b(Gold|Platinum|Titanium|Bronze|Silver|White)\s*Certified\b/i);
    return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  }
  // Corsair naming convention: RMx=Gold, HXi=Platinum, AXi=Titanium
  if (/Corsair.*\bAX(?:i)?\s*\d{3,4}/i.test(n)) return 'Titanium';
  if (/Corsair.*\bHX(?:i)?\s*\d{3,4}|Corsair.*Platinum/i.test(n)) return 'Platinum';
  if (/Corsair.*\bRM[xeiX]?\s*\d{3,4}/i.test(n)) return 'Gold';
  // Lian Li EDGE = Platinum
  if (/Lian\s*Li.*EDGE/i.test(n)) return 'Platinum';
  // MOAIPLAY ORA = Gold default
  if (/MOAIPLAY/i.test(n)) return 'Gold';
  return null;
}

const stats = { ff: 0, modular: 0, eff: 0 };
for (const p of parts) {
  if (p.c !== 'PSU') continue;
  if (p.ff == null)      { const v = inferFF(p.n);      if (v) { p.ff = v; stats.ff++; } }
  if (p.modular == null) { const v = inferModular(p.n); if (v) { p.modular = v; stats.modular++; } }
  if (p.eff == null)     { const v = inferEff(p.n);     if (v) { p.eff = v; stats.eff++; } }
}

console.log('Filled:', JSON.stringify(stats));

const psus = parts.filter(p => p.c === 'PSU');
console.log(`\n━━━ FINAL PSU COVERAGE (${psus.length}) ━━━`);
for (const f of ['watts', 'eff', 'modular', 'ff', 'atx3', 'rgb', 'fanSize', 'depth']) {
  const n = psus.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(10)} ${n}/${psus.length}  (${Math.round(n / psus.length * 100)}%)`);
}

const stillMissing = psus.filter(p => p.ff == null || p.modular == null || p.eff == null);
console.log(`\nStill missing something: ${stillMissing.length}`);
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
