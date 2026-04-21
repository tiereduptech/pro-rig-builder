#!/usr/bin/env node
/**
 * backfill-ram-sticks-cl.js — extract sticks count and CAS latency from
 * RAM product names via regex.
 *
 * Patterns:
 *   sticks: "(2x16GB)", "2 x 16GB", "Kit (2x16GB)"
 *   cl:     "CL36", "C18", "CL22-26-26-52" (first number only)
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function extractSticks(name) {
  const s = String(name || '');
  // (2x16GB), (2 x 16GB), 2x16GB, 2 x 16GB
  const m = s.match(/\(?\s*(\d)\s*[x×]\s*\d+\s*(?:GB|MB)/i);
  if (m) return parseInt(m[1]);
  // "32GB DDR5 RAM Kit (2x16GB)"  -- already covered above
  // Single-stick indicator: nothing obvious, default to null
  return null;
}

function extractCL(name) {
  const s = String(name || '');
  // CL36, CL22-26-26-52, C18, CAS Latency 36
  const m = s.match(/\bC(?:L|AS\s*Latency)?\s*(\d{2})\b/i);
  if (m) {
    const n = parseInt(m[1]);
    // Sanity: CL values are typically 14-50
    if (n >= 10 && n <= 60) return n;
  }
  return null;
}

let sticksAdded = 0;
let clAdded = 0;

for (const p of parts) {
  if (p.c !== 'RAM') continue;
  if (!p.sticks) {
    const s = extractSticks(p.n);
    if (s) { p.sticks = s; sticksAdded++; }
  }
  if (!p.cl) {
    const c = extractCL(p.n);
    if (c) { p.cl = c; clAdded++; }
  }
}

const ram = parts.filter(p => p.c === 'RAM');
console.log('Added sticks to', sticksAdded, 'products');
console.log('Added cl to', clAdded, 'products');
console.log('Coverage after:');
console.log('  sticks:', ram.filter(p => p.sticks).length + '/' + ram.length);
console.log('  cl:    ', ram.filter(p => p.cl).length + '/' + ram.length);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
