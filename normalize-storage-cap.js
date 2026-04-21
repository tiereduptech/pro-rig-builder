#!/usr/bin/env node
/**
 * normalize-storage-cap.js — convert all Storage `cap` values to GB integers.
 * Strings like "1TB", "1 TB", "1000 GB", "1024 GB" → 1000 (number).
 * Strings like "500 GB", "500GB" → 500 (number).
 * Bare numbers like 500 or 1000 → kept as-is.
 *
 * Also fixes sketchy outliers like "30TB", "76 TB", "1000 TB" → delete (data error).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './src/data/parts.js';
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function parseCap(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const m = s.match(/^([\d.]+)\s*(TB|GB|MB)?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = (m[2] || 'GB').toUpperCase();
  if (unit === 'TB') return Math.round(num * 1000);
  if (unit === 'GB') return Math.round(num);
  if (unit === 'MB') return Math.round(num / 1000);
  return null;
}

let fixed = 0;
let dropped = 0;
const stats = {};

for (const p of parts) {
  if (p.c !== 'Storage' || p.cap == null) continue;
  const original = p.cap;
  const normalized = parseCap(original);

  // Sanity: consumer storage maxes at ~30TB. Anything over is likely data error.
  if (normalized == null || normalized > 30000 || normalized < 32) {
    delete p.cap;
    dropped++;
    continue;
  }

  if (normalized !== original) {
    p.cap = normalized;
    fixed++;
  }

  stats[normalized] = (stats[normalized] || 0) + 1;
}

console.log(`Fixed ${fixed} cap values, dropped ${dropped} invalid ones`);
console.log('\nFinal distribution (GB):');
for (const k of Object.keys(stats).map(Number).sort((a,b)=>a-b)) {
  console.log(`  ${k}GB → ${stats[k]} products`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync(path, source);
console.log(`\nWrote ${parts.length} products to ${path}`);
