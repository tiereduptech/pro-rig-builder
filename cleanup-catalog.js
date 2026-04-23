#!/usr/bin/env node
/**
 * cleanup-catalog.js
 *
 * Cleans up parts.js before the big catalog expansion:
 *   1. Removes misclassified prebuilt PCs (they have CPU/GPU specs in the name but are whole systems)
 *   2. Removes server/workstation CPUs and motherboards (not our target market)
 *   3. Merges exact duplicate products (same name + category)
 *   4. Leaves consumer-grade quarantined products alone — they'll be corrected in Phase 2 expansion
 *
 * USAGE:
 *   node cleanup-catalog.js           # Dry-run preview
 *   node cleanup-catalog.js --apply   # Apply changes
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

console.log('Loading parts.js...');
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = [...mod.PARTS];
console.log(`Loaded ${parts.length} products\n`);

// ─── Target IDs to remove ───
const toDelete = new Set();

// ═══ 1. Misclassified prebuilt PCs ═══
console.log('─── Removing misclassified prebuilt PCs ───');
for (const p of parts) {
  if (!['CPU', 'GPU', 'Motherboard', 'RAM'].includes(p.c)) continue;
  const n = p.n || '';
  const isPrebuilt =
    /gaming pc desktop|pc desktop.*ryzen.*rtx|desktop.*nvidia.*rtx.*(?:ram|ssd|hdd)/i.test(n) &&
    /\bryzen\b|\bintel\b/i.test(n) &&
    /\brtx\b|\brx\b|\bgtx\b/i.test(n);
  if (isPrebuilt) {
    console.log(`  DELETE id=${p.id} [${p.c}] ${p.n.slice(0, 80)}`);
    toDelete.add(p.id);
  }
}

// ═══ 2. Server/workstation chips (EPYC, Xeon) — not our target ═══
console.log('\n─── Removing server/workstation CPUs (EPYC, Xeon) ───');
for (const p of parts) {
  if (p.c !== 'CPU') continue;
  const n = p.n || '';
  const isServer =
    /\bEPYC\b|Xeon\s+(w\d-|6\d{3}[PE]?|Platinum|Gold|Silver|Bronze|Scalable)|Threadripper.*PRO\s+\d{4,}WX/i.test(n);
  if (isServer) {
    console.log(`  DELETE id=${p.id} ${p.n.slice(0, 80)}`);
    toDelete.add(p.id);
  }
}

// ═══ 3. Server motherboards (LGA3647, SP3, SP5, C621, etc.) ═══
console.log('\n─── Removing server motherboards ───');
for (const p of parts) {
  if (p.c !== 'Motherboard') continue;
  const n = p.n || '';
  const s = p.socket || '';
  const isServerMobo =
    /LGA3647|LGA4189|LGA4677|LGA4710|\bSP[35]\b|C621|C741|C11\d/i.test(n) ||
    /LGA3647|LGA4189|LGA4677|LGA4710|SP[35]|LOCATIONSP/i.test(s);
  if (isServerMobo) {
    console.log(`  DELETE id=${p.id} socket=${s} ${p.n.slice(0, 70)}`);
    toDelete.add(p.id);
  }
}

// ═══ 4. Dedupe: same name + same category ═══
console.log('\n─── Merging duplicates (same name + category) ───');
const nameCatMap = {};
for (const p of parts) {
  if (toDelete.has(p.id)) continue;
  const key = `${p.c}::${p.n}`;
  if (!nameCatMap[key]) nameCatMap[key] = [];
  nameCatMap[key].push(p);
}

const dupes = Object.entries(nameCatMap).filter(([_, arr]) => arr.length > 1);
console.log(`Found ${dupes.length} duplicate groups to merge`);

// Scoring function: which duplicate to keep?
function scoreProduct(p) {
  let score = 0;
  if (p.deals?.amazon?.url) score += 100;
  if (p.deals?.bestbuy?.url) score += 50;
  if (p.deals?.amazon?.price && p.deals.amazon.price > 0) score += 20;
  if (p.r && p.r > 0) score += Math.round(p.r * 10);
  if (p.img) score += 10;
  if (p.bench != null && p.bench > 0) score += 15;
  if (!p.needsReview) score += 30;
  return score;
}

for (const [key, arr] of dupes) {
  // Sort descending by score, keep first, delete rest
  arr.sort((a, b) => scoreProduct(b) - scoreProduct(a));
  const keep = arr[0];
  const remove = arr.slice(1);
  console.log(`  KEEP id=${keep.id} (score=${scoreProduct(keep)}) — ${keep.n.slice(0, 50)}`);
  remove.forEach(p => {
    console.log(`    DELETE id=${p.id} (score=${scoreProduct(p)})`);
    toDelete.add(p.id);
  });
}

// ═══ Summary ═══
console.log('\n═══ CLEANUP SUMMARY ═══');
console.log(`Products before:  ${parts.length}`);
console.log(`Products to remove: ${toDelete.size}`);
console.log(`Products after:   ${parts.length - toDelete.size}`);

// Breakdown
const deletedByReason = {
  prebuilt: 0,
  server_cpu: 0,
  server_mobo: 0,
  duplicate: 0,
};
for (const p of parts) {
  if (!toDelete.has(p.id)) continue;
  if (p.c === 'CPU' && /EPYC|Xeon|Threadripper.*PRO/i.test(p.n)) deletedByReason.server_cpu++;
  else if (p.c === 'Motherboard' && /LGA3647|LGA4189|LGA4677|SP[35]|C621/i.test((p.n || '') + (p.socket || ''))) deletedByReason.server_mobo++;
  else if (/gaming pc desktop|pc desktop/i.test(p.n || '')) deletedByReason.prebuilt++;
  else deletedByReason.duplicate++;
}
console.log('\nReason breakdown:');
Object.entries(deletedByReason).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

if (APPLY) {
  // Backup first
  const backup = './src/data/parts.js.pre-cleanup-backup';
  copyFileSync('./src/data/parts.js', backup);
  console.log(`\n✓ Backup saved: ${backup}`);

  const cleaned = parts.filter(p => !toDelete.has(p.id));
  const header = '// Auto-merged catalog. Edit with care.\n';
  const content = header + 'export const PARTS = ' + JSON.stringify(cleaned, null, 2) + ';\n\nexport default PARTS;\n';
  writeFileSync('./src/data/parts.js', content);
  console.log(`✓ Removed ${toDelete.size} products`);
  console.log(`✓ Wrote src/data/parts.js with ${cleaned.length} products`);
} else {
  console.log('\n(Dry run — no changes written. Use --apply to commit cleanup.)');
}
