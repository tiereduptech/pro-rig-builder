#!/usr/bin/env node
/**
 * fix-filter-and-sort.js
 *
 * Two surgical patches to App.jsx:
 *
 *   1. Product-filter (offset ~57029) — when a filter has cfg.extract, the
 *      stored sf[field] values look like "Up to 360mm", but the existing
 *      comparison uses String(p[key]) which would be "120,140,240,280,360".
 *      Patch: also test cfg.extract(p) for inclusion.
 *
 *   2. Sort dropdown (sk==="value") — currently computes value as
 *      (bench/price), ignoring the precomputed p.value field added by the
 *      RAM/Case backfill scripts. Patch to use p.value with bench fallback.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

// ─── 1. Patch product filter to use cfg.extract ────────────────────────
// Old: r=r.filter(p=>{const pv=String(p[key]!=null?!!p[key]?p[key]:"false":"false");return vals.includes(pv)||vals.includes(String(p[key]));});
// New: also include cfg.extract result if defined
const oldFilter = 'r=r.filter(p=>{const pv=String(p[key]!=null?!!p[key]?p[key]:"false":"false");return vals.includes(pv)||vals.includes(String(p[key]));});';
const newFilter = 'r=r.filter(p=>{const pv=String(p[key]!=null?!!p[key]?p[key]:"false":"false");const cfg=cat&&CAT[cat]?.filters?.[key];const ev=cfg?.extract?cfg.extract(p):null;return vals.includes(pv)||vals.includes(String(p[key]))||(ev!=null&&vals.includes(ev));});';

if (app.includes(newFilter)) {
  console.log('• product-filter already patched');
} else if (app.includes(oldFilter)) {
  app = app.replace(oldFilter, newFilter);
  console.log('✓ Patched product-filter to use cfg.extract');
} else {
  console.error('✗ product-filter line not found verbatim');
  process.exit(1);
}

// ─── 2. Patch sort dropdown to use p.value ──────────────────────────────
// Old: sk==="value"?(a.bench||0)/Math.max($(a)/100,1)
// New: sk==="value"?(a.value||(a.bench||0)/Math.max($(a)/100,1))
//      (use precomputed value if available, fall back to old formula)
const oldSortA = 'sk==="value"?(a.bench||0)/Math.max($(a)/100,1)';
const newSortA = 'sk==="value"?(a.value!=null?a.value:(a.bench||0)/Math.max($(a)/100,1))';
const oldSortB = 'sk==="value"?(b.bench||0)/Math.max($(b)/100,1)';
const newSortB = 'sk==="value"?(b.value!=null?b.value:(b.bench||0)/Math.max($(b)/100,1))';

let sortPatched = 0;
if (app.includes(newSortA)) {
  console.log('• sort A already patched');
} else if (app.includes(oldSortA)) {
  app = app.replace(oldSortA, newSortA);
  sortPatched++;
}
if (app.includes(newSortB)) {
  console.log('• sort B already patched');
} else if (app.includes(oldSortB)) {
  app = app.replace(oldSortB, newSortB);
  sortPatched++;
}
if (sortPatched > 0) console.log(`✓ Patched sort dropdown (${sortPatched} sites) to use p.value`);

writeFileSync(appPath, app);
console.log('\nWrote App.jsx');
