#!/usr/bin/env node
/**
 * remove-broken-products.js
 *
 * Removes products from 4 expansion card categories where the image URL
 * returns HTTP 4xx/5xx (or is blank). Leaves only products with working
 * images.
 *
 * Target categories: OpticalDrive, WiFiCard, EthernetCard, SoundCard
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];
const TARGET_CATS = ['OpticalDrive', 'WiFiCard', 'EthernetCard', 'SoundCard'];

async function isLive(url) {
  if (!url) return false;
  try { const r = await fetch(url, { method: 'HEAD' }); return r.status >= 200 && r.status < 300; }
  catch { return false; }
}

console.log('━━━ SCANNING ━━━');
const toRemove = [];
for (const p of parts) {
  if (!TARGET_CATS.includes(p.c)) continue;
  const live = await isLive(p.img);
  if (!live) toRemove.push(p);
}

console.log(`Removing ${toRemove.length} products with dead/missing images:\n`);
for (const p of toRemove) {
  console.log(`  [${p.c}] ${p.n.slice(0, 70)}`);
}

const removeIds = new Set(toRemove.map(p => p.id));
parts = parts.filter(p => !removeIds.has(p.id));

console.log(`\n━━━ FINAL COUNTS ━━━`);
for (const c of TARGET_CATS) {
  const n = parts.filter(p => p.c === c).length;
  console.log(`  ${c.padEnd(14)} ${n} products`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
