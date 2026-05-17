#!/usr/bin/env node
/**
 * analyze-duplicates2.js  — READ ONLY, writes nothing.
 *
 * Corrected duplicate analysis. The first version clustered by a model
 * token and produced false positives (36 different MSI boards grouped
 * because they share "Ryzen 9000" compatibility text).
 *
 * This version clusters by signals that actually indicate the SAME
 * product row ingested more than once:
 *   A. exact normalized name   (catches verbatim re-ingestion)
 *   B. ASIN                    (catches same Amazon product, any name)
 *
 * It also reports, for the known 5500 twin case, what keys each row gets,
 * so we can pick a reviews-keying scheme that collapses real duplicates
 * without merging distinct products.
 *
 * Usage:  node analyze-duplicates2.js
 */
import { join } from 'node:path';

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
const parts = mod.PARTS || mod.default;
if (!Array.isArray(parts)) { console.error('parts.js has no PARTS array'); process.exit(1); }
console.log('Catalog: ' + parts.length + ' products\n');

function normName(n) {
  return String(n || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}
// ASIN from p.asin or extracted from an Amazon deal URL
function asinOf(p) {
  if (p.asin) return String(p.asin).toUpperCase();
  const u = p.deals && p.deals.amazon && p.deals.amazon.url;
  const m = u && String(u).match(/\/dp\/([A-Z0-9]{10})/);
  return m ? m[1].toUpperCase() : null;
}

// ── A. cluster by exact normalized name ──
const byName = new Map();
for (const p of parts) {
  if (!p || !p.n) continue;
  const k = normName(p.n);
  if (!k) continue;
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(p);
}
const nameDups = [...byName.entries()].filter(([, rows]) => rows.length > 1);
let nameExtra = 0;
for (const [, rows] of nameDups) nameExtra += rows.length - 1;

// ── B. cluster by ASIN ──
const byAsin = new Map();
for (const p of parts) {
  const a = asinOf(p);
  if (!a) continue;
  if (!byAsin.has(a)) byAsin.set(a, []);
  byAsin.get(a).push(p);
}
const asinDups = [...byAsin.entries()].filter(([, rows]) => rows.length > 1);
let asinExtra = 0;
for (const [, rows] of asinDups) asinExtra += rows.length - 1;

console.log('━━━ A. EXACT-NAME DUPLICATES ━━━');
console.log('Name groups with >1 row: ' + nameDups.length);
console.log('Extra rows (same exact name): ' + nameExtra);
console.log('');
console.log('━━━ B. ASIN DUPLICATES ━━━');
console.log('ASINs appearing on >1 row: ' + asinDups.length);
console.log('Extra rows (same ASIN): ' + asinExtra);
console.log('');

// bundles skew ASIN dups (a CPU+mobo bundle shares the CPU ASIN) — split them out
let asinDupsNoBundle = 0, asinExtraNoBundle = 0;
for (const [, rows] of asinDups) {
  const nb = rows.filter(r => !r.bundle);
  if (nb.length > 1) { asinDupsNoBundle++; asinExtraNoBundle += nb.length - 1; }
}
console.log('  (excluding bundles: ' + asinDupsNoBundle + ' ASINs, ' + asinExtraNoBundle + ' extra rows)');
console.log('');

// ── show 12 largest exact-name dup groups ──
console.log('━━━ 12 LARGEST EXACT-NAME DUPLICATE GROUPS ━━━');
nameDups.sort((a, b) => b[1].length - a[1].length);
for (const [k, rows] of nameDups.slice(0, 12)) {
  console.log('\n"' + k.slice(0, 70) + '" — ' + rows.length + ' rows:');
  for (const r of rows) {
    console.log('  id' + r.id + ' | c=' + r.c + ' | pr=' + (r.pr ?? '?') +
      ' | asin=' + (asinOf(r) || '-') + ' | bundle=' + (r.bundle ? 'Y' : 'n') +
      ' | deals=[' + (r.deals ? Object.keys(r.deals).join(',') : '-') + ']');
  }
}

// ── the 5500 twin case ──
console.log('\n━━━ 5500 TWIN CHECK ━━━');
const fivefives = parts.filter(p => p.n && /5500/.test(p.n) && /ryzen/i.test(p.n) && !p.bundle);
for (const p of fivefives) {
  console.log('  id' + p.id + ' | normName="' + normName(p.n) + '"');
  console.log('         asin=' + (asinOf(p) || '-'));
}
console.log('\n→ If the two 5500 CPU rows share an ASIN, ASIN-keying collapses them.');
console.log('  If not, they cannot be auto-linked and stay separate (acceptable).');
console.log('\n━━━ END (read-only — nothing modified) ━━━');
