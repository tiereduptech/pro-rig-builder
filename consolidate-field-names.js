#!/usr/bin/env node
/**
 * consolidate-field-names.js — merge duplicate field names so App.jsx columns
 * populate for ALL products regardless of whether they came from Amazon or
 * Best Buy discovery.
 *
 * Strategy: prefer the SHORTER name that App.jsx's CAT.cols config expects.
 * "formFactor" → "ff", "driveType" → "storageType", "maxGpuLen" → "maxGPU", etc.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './src/data/parts.js';
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// Map of [oldField → newField] to perform across all products
const RENAMES = {
  formFactor: 'ff',           // Motherboard, Case, PSU, Storage
  driveType:  'storageType',  // Storage
  maxGpuLen:  'maxGPU',       // Case (already done earlier but safe to rerun)
  maxCoolerHeight: 'maxCooler', // Case
};

let renamedCount = 0;
const perCategory = {};

for (const p of parts) {
  for (const [oldKey, newKey] of Object.entries(RENAMES)) {
    if (p[oldKey] != null) {
      // Only overwrite if the target doesn't already have a value
      if (p[newKey] == null) {
        p[newKey] = p[oldKey];
      }
      delete p[oldKey];
      renamedCount++;
      perCategory[p.c] = (perCategory[p.c] || 0) + 1;
    }
  }
}

console.log('Renamed', renamedCount, 'fields total');
console.log('\nPer category:');
for (const [cat, n] of Object.entries(perCategory).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + cat.padEnd(14), n);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync(path, source);
console.log('\nWrote', parts.length, 'products to', path);
