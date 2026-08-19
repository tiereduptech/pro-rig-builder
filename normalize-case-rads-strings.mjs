/**
 * Re-encode Case.rads from the joined-string shape back to arrays of integers.
 *
 *   "360mm"        → [360]
 *   "240mm,360mm"  → [240, 360]
 *   [240, 360]     → unchanged
 *
 * Why this matters more than it looks: the AIO/Radiator Support filter in
 * src/App.jsx reads
 *
 *     extract: p => { const arr = Array.isArray(p.rads) ? p.rads : []; ... }
 *
 * and buckets every non-array as "None". A string rads is therefore a field
 * that LOOKS like coverage and is not — the row is missing from the filter and
 * counted as having no AIO support at all. The enrichment summary compounded it
 * by counting truthiness, reporting rads coverage of 383 when the filter could
 * only read 341.
 *
 * normalize-case-rads.js settled this shape once before, in the same pass that
 * introduced that `Array.isArray` extract. The DataForSEO case enrichment
 * reintroduced strings on the rows it wrote; the writers are fixed in this same
 * change, and this re-encodes what they already emitted.
 *
 * Re-encoding only. No size is added, dropped, or inferred — a value that was
 * wrong before is exactly as wrong after, just in the shape the site reads.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const parts = (await import('./src/data/parts.js')).default;

const parseRads = (raw) => String(raw)
  .split(',')
  .map(s => {
    const m = s.trim().match(/^(\d{2,4})\s*mm$/i) || s.trim().match(/^(\d{2,4})$/);
    return m ? parseInt(m[1], 10) : null;
  })
  .filter(n => n != null);

const unreadable = [];
let converted = 0;

for (const p of parts) {
  if (p.c !== 'Case' || p.rads == null) continue;
  if (Array.isArray(p.rads)) continue;

  const sizes = [...new Set(parseRads(p.rads))].sort((a, b) => a - b);
  if (!sizes.length) { unreadable.push({ id: p.id, rads: p.rads }); continue; }
  console.log(`${String(p.id).padEnd(7)} ${JSON.stringify(p.rads).padEnd(18)} → [${sizes}]`);
  p.rads = sizes;
  converted++;
}

if (unreadable.length) {
  console.error('\n✗ Refusing to write — rads values that parse to nothing, which this pass');
  console.error('  must not silently drop:');
  for (const u of unreadable) console.error(`  ${u.id}: ${JSON.stringify(u.rads)}`);
  process.exit(1);
}

const cases = parts.filter(p => p.c === 'Case');
const readable = cases.filter(p => Array.isArray(p.rads) && p.rads.length).length;
const stillNot = cases.filter(p => p.rads != null && !(Array.isArray(p.rads) && p.rads.length)).length;
console.log(`\n${converted} row(s) re-encoded.`);
console.log(`Case rads the filter can read: ${readable}/${cases.length} (was ${readable - converted})`);
if (stillNot) { console.error(`✗ ${stillNot} row(s) still hold a shape the filter cannot read`); process.exit(1); }

await writeCatalog(parts, {
  loadedCount: parts.length,
  reason: `re-encode Case.rads to integer arrays (${converted} rows)`,
});
