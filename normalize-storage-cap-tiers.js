#!/usr/bin/env node
/**
 * normalize-storage-cap-tiers.js — collapse capacity values into standard tiers:
 *   120, 128       → 128
 *   240, 250, 256  → 256
 *   480, 500, 512  → 500
 *   960, 1000      → 1000
 *   1920, 2000     → 2000
 * All other values (3000, 4000, 5000, 6000, 8000 etc.) remain untouched.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

const MAP = {
  '120': '128',  '128': '128',
  '240': '256',  '250': '256',  '256': '256',
  '480': '500',  '500': '500',  '512': '500',
  '960': '1000', '1000': '1000',
  '1920': '2000','2000': '2000',
};

const before = {};
const after = {};
let changed = 0;

for (const p of parts) {
  if (p.c !== 'Storage') continue;
  if (p.cap == null) continue;
  const key = String(p.cap);
  before[key] = (before[key] || 0) + 1;

  if (MAP[key] && MAP[key] !== key) {
    p.cap = MAP[key];
    changed++;
  }
  after[String(p.cap)] = (after[String(p.cap)] || 0) + 1;
}

console.log(`Changed: ${changed}\n`);
console.log('━━━ BEFORE ━━━');
Object.entries(before).sort((a, b) => (+a[0]) - (+b[0])).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(10)} ${v}`);
});
console.log('\n━━━ AFTER ━━━');
Object.entries(after).sort((a, b) => (+a[0]) - (+b[0])).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(10)} ${v}`);
});

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
