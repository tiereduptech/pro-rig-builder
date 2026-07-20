#!/usr/bin/env node
//
// One-pass backfill: re-stamp deals.newegg.sellerClass across the existing catalog.
//
// WHY THIS EXISTS
//   sellerClass is stamped at ingest from NEG.sellerClass() -> neweggSkuClass().
//   That classifier originally knew only two first-party shapes (the legacy
//   "N82E…" prefix) and treated Newegg's CURRENT dashed format ("2AM-00CN-00060")
//   as 'other'. It was corrected on 2026-07-20 after every dashed SKU sampled
//   against live pages read "Sold by Newegg / Shipped by Newegg".
//
//   Ingest is already correct going forward — it calls the fixed classifier. But
//   fetch-newegg-via-rakuten.cjs SKIPS products that already have a
//   deals.newegg.sku, so deals stamped before the fix are never revisited. Every
//   Newegg deal in the catalog today is one of those, and all of them carry a
//   stale 'other'.
//
// WHY IT MATTERS
//   'other' is not cosmetic. price-sanity.js gates its C3B marketplace-gouge
//   cleanup on `cls === 'official'`; a first-party deal mislabelled 'other'
//   loses that protection. Seller-rank selection also demotes 'other' below
//   first-party, so a stale label can cost a legitimate listing its priority.
//
// WHAT IT DOES NOT DO
//   It only rewrites the sellerClass field. It never adds, removes, reprices or
//   re-matches a deal. It cannot delete anything.
//
// Usage:
//   node restamp-newegg-sellerclass.cjs [--apply] [--report=FILE]
//
//   Dry run is the DEFAULT. Nothing is written unless --apply is passed.
//
const fs = require('fs');
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const REPORT = (() => {
  const a = argv.find(x => x.startsWith('--report='));
  return a ? a.split('=')[1] : 'newegg-restamp-summary.json';
})();

(async () => {
  // price-sanity.js is ESM; this script is CJS.
  const { neweggSkuClass } = await import('./price-sanity.js');
  const partsMod = await import('./src/data/parts.js');
  const parts = partsMod.PARTS || partsMod.default;
  if (!Array.isArray(parts)) throw new Error('could not load PARTS array');

  const loadedCount = parts.length;
  const changes = [];
  const transitions = {};
  let examined = 0;

  for (const p of parts) {
    const d = p.deals && p.deals.newegg;
    if (!d || typeof d !== 'object') continue;
    examined++;

    const stored = d.sellerClass || '(unset)';
    const fresh = neweggSkuClass(d);

    // 'none' means the deal carries no SKU at all. There is nothing to classify
    // from, so leave whatever is stored rather than overwriting it with a
    // weaker value.
    if (fresh === 'none') continue;
    if (stored === fresh) continue;

    transitions[`${stored} -> ${fresh}`] = (transitions[`${stored} -> ${fresh}`] || 0) + 1;
    changes.push({ id: p.id, name: p.n, sku: d.sku, from: stored, to: fresh });
    if (APPLY) d.sellerClass = fresh;
  }

  console.log(`\n=== NEWEGG sellerClass RE-STAMP ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
  console.log(`Products in catalog:  ${loadedCount}`);
  console.log(`Newegg deals examined:${examined}`);
  console.log(`Would re-stamp:       ${changes.length}`);
  for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(v).padStart(4)}  ${k}`);
  }
  if (changes.length) {
    console.log(`\nSample:`);
    for (const c of changes.slice(0, 5)) console.log(`   ${c.sku}  ${c.from} -> ${c.to}   ${String(c.name).slice(0, 52)}`);
  }

  fs.writeFileSync(REPORT, JSON.stringify({
    timestamp: new Date().toISOString(),
    apply: APPLY,
    loadedCount, examined,
    restamped: changes.length,
    transitions,
    changes: changes.slice(0, 500),
  }, null, 2));
  console.log(`\nReport: ${REPORT}`);

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to commit.');
    return;
  }
  if (!changes.length) {
    console.log('Nothing to change — skipping write.');
    return;
  }

  // Same crash-safe path every other catalog mutation uses: atomic promote plus
  // mandatory re-split, or it throws and the on-disk catalog is untouched.
  await writeCatalog(parts, {
    loadedCount,
    reason: `re-stamp newegg sellerClass (${changes.length} deals)`,
  });
  console.log(`Wrote catalog — ${changes.length} deals re-stamped.`);
})().catch(e => { console.error(e); process.exit(1); });
