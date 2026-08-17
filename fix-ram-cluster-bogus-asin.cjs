#!/usr/bin/env node
/**
 * fix-ram-cluster-bogus-asin.cjs — remove one wrong ASIN from the three RAM
 * rows that share it.
 *
 * WHAT THE AUDIT FOUND (run 32057489722, the 2026-08-17 ASIN identity audit)
 * Three different Corsair DDR5 kits all carry the SAME Amazon link,
 * B0CQCK7TYW, which resolves to a V-Color 64GB TRX50 workstation R-DIMM kit at
 * $2,409.99. One ASIN cannot be three different Corsair kits, and it is not any
 * of them. Stored prices are $109 / $179 / $249, so the divergence runs to
 * +2,111%. The audit classed all three `wrong-product`, two with an outright
 * capacity conflict, and queued them for human relink review — it never
 * relinks on its own.
 *
 * WHY DELETE RATHER THAN RELINK
 * The audit's standing rule is that a wrong-product link is reported, never
 * auto-repaired: guessing a replacement ASIN is how a wrong link becomes a
 * confidently wrong link. Removing the false claim needs no guess. Picking the
 * right Corsair ASIN for each kit is a separate, verified job.
 *
 * WHAT THIS COSTS
 * Amazon is the ONLY priced retailer on all three rows, so they come out of
 * this with no buy link at all. They keep `needsReview: true`, which they
 * already had — App.jsx, UpgradePage, the sitemap and scripts/url-slugs.cjs all
 * filter on it, and ProductPage looks products up in the already-filtered
 * array, so none of the three is reachable today. This does not take anything
 * off the site. It removes a false price that a future un-quarantine pass would
 * otherwise put back.
 *
 * Run:
 *   node fix-ram-cluster-bogus-asin.cjs --dry-run     (default: report only)
 *   node fix-ram-cluster-bogus-asin.cjs --apply
 * then re-split:
 *   node scripts/split-parts-by-cat.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const RECORD = path.join(ROOT, 'catalog-build', 'ram-cluster-bogus-asin.json');

const APPLY = process.argv.includes('--apply');
const BAD_ASIN = 'B0CQCK7TYW';

// Each row must name the ASIN it is expected to carry. If the data has moved on
// since the audit, we abort rather than delete something we did not measure.
const TARGETS = [
  { id: 40002, retailer: 'amazon', expectAsin: BAD_ASIN, storedPrice: 109,
    why: 'Corsair Vengeance RGB DDR5 32GB (2x16GB) 6400 CL32 -> V-Color 64GB TRX50 R-DIMM @ $2409.99 (+2111%), capacity conflict' },
  { id: 40004, retailer: 'amazon', expectAsin: BAD_ASIN, storedPrice: 179,
    why: 'Corsair Dominator Titanium DDR5 32GB (2x16GB) 7200 CL34 -> V-Color 64GB TRX50 R-DIMM @ $2409.99 (+1246%), capacity conflict' },
  { id: 40005, retailer: 'amazon', expectAsin: BAD_ASIN, storedPrice: 249,
    why: 'Corsair Dominator Titanium DDR5 64GB (2x32GB) 6400 CL32 -> V-Color 64GB TRX50 R-DIMM @ $2409.99 (+868%)' },
];

const asinOf = (u) => { const m = /\/dp\/([A-Z0-9]{10})/.exec(u || ''); return m ? m[1] : null; };

(async () => {
  const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }
  console.log(`Loaded ${parts.length} products from ${path.relative(ROOT, PARTS_PATH)}\n`);

  const actions = [];
  const problems = [];

  for (const t of TARGETS) {
    const p = parts.find((x) => x.id === t.id);
    if (!p) { problems.push(`id ${t.id}: not in the catalog`); continue; }
    const deal = p.deals && p.deals[t.retailer];
    if (!deal) { problems.push(`id ${t.id}: no deals.${t.retailer} — already removed?`); continue; }

    // Refuse to delete a link that is not the one the audit measured.
    const asin = asinOf(deal.url);
    if (asin !== t.expectAsin) {
      problems.push(`id ${t.id}: carries ASIN ${asin || '(none)'}, expected ${t.expectAsin} — data changed since the audit, not touching it`);
      continue;
    }

    const otherPriced = Object.entries(p.deals)
      .filter(([k, d]) => k !== t.retailer && d && ((d.price > 0) || (d.saleprice > 0)))
      .map(([k]) => k);

    actions.push({
      id: t.id, name: p.n, cat: p.c, retailer: t.retailer, asin,
      storedPrice: deal.price ?? deal.saleprice ?? null,
      amazonActual: 2409.99, why: t.why,
      quarantinedBefore: p.needsReview === true,
      survivingRetailers: otherPriced,
      leavesRowUnpriced: otherPriced.length === 0,
      _part: p,
    });
  }

  if (problems.length) {
    console.error('REFUSING TO PROCEED — the catalog does not match what the audit measured:');
    for (const m of problems) console.error(`  ✗ ${m}`);
    process.exit(1);
  }

  for (const a of actions) {
    console.log(`  [id ${a.id}] ${a.cat}  ${a.name}`);
    console.log(`      remove deals.${a.retailer} (${a.asin}, stored $${a.storedPrice} vs actual $${a.amazonActual})`);
    console.log(`      quarantined already: ${a.quarantinedBefore}` +
      `  |  retailers left after removal: ${a.survivingRetailers.join(', ') || 'NONE'}`);
  }

  const unpriced = actions.filter((a) => a.leavesRowUnpriced);
  console.log(`\n${actions.length} link(s) to remove. ${unpriced.length} row(s) will have no priced retailer left.`);
  const notQuarantined = actions.filter((a) => !a.quarantinedBefore);
  if (notQuarantined.length) {
    console.log(`⚠  ${notQuarantined.length} of these were NOT already quarantined — removing their only link changes what the site shows.`);
  } else {
    console.log('All three were already quarantined, so nothing changes for a visitor today.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  for (const a of actions) { delete a._part.deals[a.retailer]; }

  // parts.js is written back as one flat array; scripts/split-parts-by-cat.cjs
  // regenerates the per-category chunks and the barrel from it.
  const header = '// Auto-merged catalog. Edit with care.\n';
  const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  fs.writeFileSync(PARTS_PATH, header + body, 'utf8');
  console.log(`\nWrote ${path.relative(ROOT, PARTS_PATH)} (${parts.length} products, flat array).`);

  fs.mkdirSync(path.dirname(RECORD), { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    appliedAt: new Date().toISOString(),
    source: 'ASIN Identity Audit run 32057489722 (2026-08-17)',
    badAsin: BAD_ASIN,
    amazonTitle: 'V-Color DDR5 64GB (16GBx4) 6000MHz CL32 2Gx8 1Rx8 OC R-DIMM (AMD Expo) (TRA516G60S832Q)',
    amazonPrice: 2409.99,
    removed: actions.map(({ _part, ...a }) => a),
    note: 'Links removed, not relinked. Correct ASINs for these three Corsair kits are still unknown and must be verified before any relink.',
  }, null, 2));
  console.log(`Record -> ${path.relative(ROOT, RECORD)}`);
  console.log('\nNext: node scripts/split-parts-by-cat.cjs');
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
