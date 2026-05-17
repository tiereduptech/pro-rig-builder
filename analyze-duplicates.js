#!/usr/bin/env node
/**
 * analyze-duplicates.js  — READ ONLY, writes nothing.
 *
 * Scans src/data/parts.js for clusters of catalog rows that are likely
 * the SAME real product split into multiple entries (the "duplicate row"
 * problem: e.g. "AMD Ryzen 5 5500" vs "AMD - Ryzen 5 5500 6-Core ...").
 *
 * Clustering signal: brand + category + a model token extracted from the
 * name. This is loose enough to catch twins with very different name
 * formats. Bundles are reported separately (they legitimately repeat a
 * CPU/GPU model and should NOT be merged).
 *
 * Output: a report to stdout. No files touched.
 *
 * Usage:  node analyze-duplicates.js
 */
import { join } from 'node:path';

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
const parts = mod.PARTS || mod.default;
if (!Array.isArray(parts)) { console.error('parts.js has no PARTS array'); process.exit(1); }
console.log('Catalog: ' + parts.length + ' products\n');

// Try to load the model-token extractor; fall back to a local heuristic.
let extractModelToken = null;
try {
  const nm = await import('file://' + join(process.cwd(), 'normalize-product-name.js').replace(/\\/g, '/'));
  extractModelToken = nm.extractModelToken || null;
} catch { /* fall through */ }

// Local fallback: pull a distinctive model-ish token from a name.
function localToken(name) {
  const n = String(name || '').toUpperCase();
  // common GPU/CPU model patterns
  const patterns = [
    /\bRTX\s?\d{4}\s?(TI|SUPER)?\b/,
    /\bGTX\s?\d{3,4}\s?(TI|SUPER)?\b/,
    /\bRX\s?\d{3,4}\s?(XT|GRE)?\b/,
    /\b(?:RYZEN|CORE)[^A-Z0-9]*[A-Z0-9-]*\d{3,5}[A-Z0-9]*\b/,
    /\bI[3579]-\d{4,5}[A-Z]*\b/,
    /\b\d{4,5}[A-Z]{1,3}3?D?\b/,
  ];
  for (const p of patterns) {
    const m = n.match(p);
    if (m) return m[0].replace(/\s+/g, '');
  }
  return null;
}

function tokenFor(p) {
  if (extractModelToken) {
    try { const t = extractModelToken(p.n, p.c); if (t) return String(t).toUpperCase().replace(/\s+/g, ''); }
    catch { /* fall through */ }
  }
  return localToken(p.n);
}

// Cluster by brand|category|token.
const clusters = new Map();
let noToken = 0;
for (const p of parts) {
  if (!p || !p.n) continue;
  const tok = tokenFor(p);
  if (!tok) { noToken++; continue; }
  const key = (p.b || '?').toUpperCase() + '|' + (p.c || '?') + '|' + tok;
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(p);
}

// A cluster is a "duplicate cluster" if it has >1 NON-bundle row.
const dupClusters = [];
let bundlesInClusters = 0;
for (const [key, rows] of clusters) {
  const nonBundle = rows.filter(r => !r.bundle);
  if (nonBundle.length > 1) dupClusters.push([key, rows]);
  bundlesInClusters += rows.filter(r => r.bundle).length;
}

// Sort biggest clusters first.
dupClusters.sort((a, b) => b[1].filter(r => !r.bundle).length - a[1].filter(r => !r.bundle).length);

let totalDupRows = 0;
for (const [, rows] of dupClusters) totalDupRows += rows.filter(r => !r.bundle).length;

console.log('━━━ DUPLICATE ANALYSIS ━━━');
console.log('Products with no extractable model token: ' + noToken + ' (cannot be clustered this way)');
console.log('Duplicate clusters (>1 non-bundle row, same brand+cat+model): ' + dupClusters.length);
console.log('Total non-bundle rows inside duplicate clusters: ' + totalDupRows);
console.log('  → roughly ' + (totalDupRows - dupClusters.length) + ' rows are "extra" duplicates');
console.log('');

// by category
const byCat = {};
for (const [, rows] of dupClusters) {
  const c = rows[0].c || '?';
  byCat[c] = (byCat[c] || 0) + 1;
}
console.log('Duplicate clusters by category:');
for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + c + ': ' + n);
}
console.log('');

// show the 15 biggest clusters in detail
console.log('━━━ 15 LARGEST DUPLICATE CLUSTERS ━━━');
for (const [key, rows] of dupClusters.slice(0, 15)) {
  const nb = rows.filter(r => !r.bundle);
  console.log('\n[' + key + '] — ' + nb.length + ' non-bundle rows:');
  for (const r of nb) {
    const deals = r.deals ? Object.keys(r.deals).join(',') : '-';
    console.log('  id' + r.id + ' | pr=' + (r.pr ?? '?') + ' | deals=[' + deals + '] | asin=' + (r.asin || '-'));
    console.log('       n="' + r.n + '"');
  }
}
console.log('\n━━━ END (read-only — nothing was modified) ━━━');
