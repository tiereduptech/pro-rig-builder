#!/usr/bin/env node
/**
 * audit-bestbuy-cases.js
 *
 * Read-only audit. No data is modified.
 *
 * Compares your DB to Best Buy's full case catalog (abcat0507006). Reports:
 *
 *   1. Best Buy cases NOT in your DB (missing products)
 *   2. Cases in your DB linked to Best Buy SKUs but missing spec data
 *   3. Cases in your DB linked to dead/stale Best Buy SKUs (404)
 *   4. Spec field coverage for products that DID get Best Buy data
 *   5. Spot-check: pick 5 products and compare each spec field to Best Buy's
 *      current value (catches stale data)
 */
import { readFileSync } from 'node:fs';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const API = 'https://api.bestbuy.com/v1';
const RATE_DELAY = 250;

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;
const cases = parts.filter(p => p.c === 'Case');

console.log(`━━━ AUDIT: Cases in DB vs Best Buy catalog ━━━`);
console.log(`  DB total cases: ${cases.length}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// FETCH BEST BUY'S FULL CASE CATALOG
// ═══════════════════════════════════════════════════════════════════════════
console.log('Fetching Best Buy catalog (Computer Cases category)...');
const bbCatalog = new Map(); // sku → { name, manufacturer, modelNumber }
for (let page = 1; page <= 5; page++) {
  const url = `${API}/products(categoryPath.id=abcat0507006)?show=sku,name,manufacturer,modelNumber&pageSize=100&page=${page}&format=json&apiKey=${KEY}`;
  const r = await fetch(url);
  if (!r.ok) break;
  const j = await r.json();
  if (!j.products || !j.products.length) break;
  for (const p of j.products) {
    bbCatalog.set(String(p.sku), { name: p.name, manufacturer: p.manufacturer, modelNumber: p.modelNumber });
  }
  if (j.currentPage >= j.totalPages) break;
  await new Promise(r => setTimeout(r, RATE_DELAY));
}
console.log(`  ${bbCatalog.size} cases in Best Buy's catalog\n`);

// ═══════════════════════════════════════════════════════════════════════════
// MAP DB CASES TO BEST BUY SKUs
// ═══════════════════════════════════════════════════════════════════════════
function extractSku(p) {
  if (!p.deals?.bestbuy?.url) return null;
  const m = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
  return m ? m[1] : null;
}

const dbBySku = new Map(); // sku → product
const dbWithoutSku = [];
for (const p of cases) {
  const sku = extractSku(p);
  if (sku) dbBySku.set(sku, p);
  else dbWithoutSku.push(p);
}
console.log(`DB linked to Best Buy SKU: ${dbBySku.size}`);
console.log(`DB without Best Buy SKU:   ${dbWithoutSku.length}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// REPORT 1: Best Buy cases NOT in DB
// ═══════════════════════════════════════════════════════════════════════════
const missing = [];
for (const [sku, info] of bbCatalog.entries()) {
  if (!dbBySku.has(sku)) missing.push({ sku, ...info });
}
console.log(`━━━ REPORT 1: ${missing.length} Best Buy cases NOT in your DB ━━━`);
const missingByBrand = {};
for (const m of missing) {
  const b = m.manufacturer || '(none)';
  if (!missingByBrand[b]) missingByBrand[b] = [];
  missingByBrand[b].push(m);
}
for (const [b, items] of Object.entries(missingByBrand).sort((a, c) => c[1].length - a[1].length)) {
  console.log(`\n  ${b} (${items.length} missing)`);
  items.slice(0, 5).forEach(m => console.log(`    sku=${m.sku} | ${m.name?.slice(0, 80)}`));
  if (items.length > 5) console.log(`    ... +${items.length - 5} more`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT 2: DB → BB SKUs that are stale (404)
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n\n━━━ REPORT 2: Checking ${dbBySku.size} linked SKUs for live status ━━━`);
const dead = [];
const liveButEmptyDetails = [];
const liveWithDetails = [];
let progress = 0;
for (const [sku, p] of dbBySku.entries()) {
  progress++;
  if (progress % 25 === 0) process.stdout.write(`  Checked ${progress}/${dbBySku.size}...\n`);
  try {
    const r = await fetch(`${API}/products/${sku}.json?show=sku,name,details&apiKey=${KEY}`);
    if (r.status === 404) {
      dead.push({ sku, p });
    } else if (r.ok) {
      const j = await r.json();
      if (!j.details || j.details.length === 0) liveButEmptyDetails.push({ sku, p });
      else liveWithDetails.push({ sku, p, details: j.details });
    }
  } catch (e) {
    // ignore
  }
  await new Promise(r => setTimeout(r, RATE_DELAY));
}

console.log(`\n  Live with spec details: ${liveWithDetails.length}`);
console.log(`  Live but no details:    ${liveButEmptyDetails.length}`);
console.log(`  Dead (404):             ${dead.length}`);

if (dead.length) {
  console.log(`\n  Dead SKUs (consider removing the Best Buy deal):`);
  dead.slice(0, 10).forEach(d => console.log(`    sku=${d.sku} | ${d.p.n.slice(0, 70)}`));
  if (dead.length > 10) console.log(`    ... +${dead.length - 10} more`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT 3: For "live with details", how many actually got spec data applied?
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ REPORT 3: Spec data application audit ━━━`);
const SPEC_FIELDS = ['maxGPU', 'maxCooler', 'rads', 'mobo', 'drive25', 'drive35', 'fans_inc'];
let withFullSpecs = 0, withSomeSpecs = 0, withNoSpecs = 0;
const missingSpecsForLive = [];
for (const { p } of liveWithDetails) {
  const present = SPEC_FIELDS.filter(f => p[f] != null && (!Array.isArray(p[f]) || p[f].length > 0));
  if (present.length === SPEC_FIELDS.length) withFullSpecs++;
  else if (present.length === 0) {
    withNoSpecs++;
    missingSpecsForLive.push(p);
  } else withSomeSpecs++;
}
console.log(`  Of ${liveWithDetails.length} live SKUs with details available:`);
console.log(`    ${withFullSpecs} have all 7 spec fields populated`);
console.log(`    ${withSomeSpecs} have partial spec data`);
console.log(`    ${withNoSpecs} have NO spec data (data not applied during rebuild)`);

if (missingSpecsForLive.length) {
  console.log(`\n  Products missing spec data (Best Buy HAS the data — rebuild bug):`);
  missingSpecsForLive.slice(0, 10).forEach(p => console.log(`    ${p.n.slice(0, 80)}`));
  if (missingSpecsForLive.length > 10) console.log(`    ... +${missingSpecsForLive.length - 10} more`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT 4: Spec field coverage breakdown
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ REPORT 4: Field coverage (across ${cases.length} cases) ━━━`);
for (const f of SPEC_FIELDS) {
  const filled = cases.filter(p => p[f] != null && (!Array.isArray(p[f]) || p[f].length > 0)).length;
  const pct = Math.round(filled / cases.length * 100);
  console.log(`    ${f.padEnd(12)} ${filled}/${cases.length}  (${pct}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT 5: Spot-check 5 random products against current Best Buy data
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ REPORT 5: Spot-check 5 cases (does our data match Best Buy?) ━━━`);
const sample = liveWithDetails
  .filter(({ p }) => p.maxGPU != null) // only check products that claim to have data
  .sort(() => Math.random() - 0.5)
  .slice(0, 5);

function findDetail(details, ...keys) {
  for (const d of details) {
    for (const k of keys) {
      if (d.name.toLowerCase() === k.toLowerCase()) return d.value;
    }
  }
  return null;
}
function mmFrom(s) { if (!s) return null; const m = s.match(/(\d{2,4})/); return m ? parseInt(m[1], 10) : null; }

for (const { sku, p, details } of sample) {
  console.log(`\n  ${p.n.slice(0, 75)}`);
  console.log(`  (sku=${sku})`);

  const checks = [
    ['maxGPU',    p.maxGPU,    mmFrom(findDetail(details, 'Maximum GPU Length'))],
    ['maxCooler', p.maxCooler, mmFrom(findDetail(details, 'Maximum CPU Cooler Height'))],
    ['drive35',   p.drive35,   parseInt(findDetail(details, 'Number Of Internal 3.5" Bays') || '0', 10) || null],
    ['drive25',   p.drive25,   parseInt(findDetail(details, 'Number Of Internal 2.5" Bays') || '0', 10) || null],
    ['fans_inc',  p.fans_inc,  parseInt(findDetail(details, 'Number of Fans Included') || '0', 10) || null],
  ];
  for (const [field, mine, theirs] of checks) {
    if (mine == null && theirs == null) continue;
    const match = mine == theirs ? '✓' : '✗';
    console.log(`    ${match} ${field}: us=${mine ?? '(blank)'} | bb=${theirs ?? '(none)'}`);
  }
}

console.log('\nDone.');
