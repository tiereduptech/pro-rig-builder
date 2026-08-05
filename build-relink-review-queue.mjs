// build-relink-review-queue.mjs
//
// Builds the HUMAN review queue for wrong-product / close-but-wrong Amazon
// links found by amazon-asin-identity-audit.mjs.
//
// This script NEVER writes to the catalog and NEVER relinks. A wrong ASIN
// replaced by a guessed ASIN is the same bug in a new coat — every row here
// needs a human to pick the correct ASIN.
//
// Unlike dead ASINs (objectively broken — no item returned), these classes are
// produced by a heuristic classifier, so they carry a `confidence` field and a
// `falsePositiveRisk` note where the two titles may in fact be the same product.
//
//   node build-relink-review-queue.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const IN  = 'amazon-asin-identity-audit.json';
const OUT = 'relink-review-queue.json';

const report = JSON.parse(readFileSync(IN, 'utf8'));

const rows = report.findings
  .filter(f => f.class === 'wrong-product' || f.class === 'close-but-wrong')
  .map(f => ({
    id: f.id,
    category: f.cat,
    asin: f.asin,
    storedName: f.storedName,
    amazonTitle: f.amazonTitle,

    // overlap: both directions. storedInAmazon is the existing gate's metric;
    // amazonInStored catches the "stored name is just longer marketing text"
    // case that inflates the raw flag rate.
    overlapStoredInAmazon: f.scoreStoredInAmazon,
    overlapAmazonInStored: f.scoreAmazonInStored,
    gateScore: f.gateScore,

    storedPrice: f.storedPrice,
    amazonPrice: f.amazonPrice,
    priceDeltaPct: f.priceDeltaPct,
    priceDivergent: f.priceDivergent,
    merchant: f.merchant,

    class: f.class,
    capConflict: f.capConflict,
    currentlyQuarantined: f.needsReview,
    live: !f.needsReview,

    // close-but-wrong with high reverse-containment is the shape that produced
    // the one confirmed false positive in the hand-checked sample
    // (Intel X550-T2 vs "Intel Ethernet Converged Network Adapter X550-T2").
    falsePositiveRisk: f.class === 'close-but-wrong' && (f.scoreAmazonInStored ?? 0) >= 0.6,

    action: 'HUMAN_REVIEW_REQUIRED — pick correct ASIN manually; never auto-relink',
  }))
  // worst first: price-divergent, then lowest overlap
  .sort((a, b) => {
    if (a.priceDivergent !== b.priceDivergent) return a.priceDivergent ? -1 : 1;
    const ap = Math.abs(a.priceDeltaPct ?? 0), bp = Math.abs(b.priceDeltaPct ?? 0);
    if (ap !== bp) return bp - ap;
    return (a.overlapStoredInAmazon ?? 0) - (b.overlapStoredInAmazon ?? 0);
  });

// ASINs attached to more than one catalog row — the bulk mis-attach signature.
const byAsin = {};
for (const r of rows) (byAsin[r.asin] ||= []).push(r);
const sharedAsins = Object.entries(byAsin)
  .filter(([, v]) => v.length > 1)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([asin, v]) => ({
    asin, rowCount: v.length, amazonTitle: v[0].amazonTitle,
    categories: [...new Set(v.map(r => r.category))],
    rows: v.map(r => ({ id: r.id, category: r.category, storedName: r.storedName })),
  }));

const wrong = rows.filter(r => r.class === 'wrong-product');
const close = rows.filter(r => r.class === 'close-but-wrong');
const live  = rows.filter(r => r.live);

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: IN,
    policy: 'REPORT ONLY — no catalog writes, no auto-relink, ever',
    classifier: 'heuristic (bidirectional token containment + brand-token sharing) — not ground truth',
  },
  totals: {
    queued: rows.length,
    wrongProduct: wrong.length,
    closeButWrong: close.length,
    currentlyQuarantined: rows.length - live.length,
    liveOnSite: live.length,
    priceDivergent: rows.filter(r => r.priceDivergent).length,
    flaggedFalsePositiveRisk: rows.filter(r => r.falsePositiveRisk).length,
    sharedAsinClusters: sharedAsins.length,
    rowsInSharedClusters: sharedAsins.reduce((s, c) => s + c.rowCount, 0),
  },
  sharedAsinClusters: sharedAsins,
  queue: rows,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));

console.log('Relink review queue — REPORT ONLY (no catalog writes, no relinks)\n');
console.log(`  queued for human review ...... ${out.totals.queued}`);
console.log(`    wrong-product .............. ${out.totals.wrongProduct}`);
console.log(`    close-but-wrong ............ ${out.totals.closeButWrong}`);
console.log(`  currently quarantined ........ ${out.totals.currentlyQuarantined}`);
console.log(`  LIVE on site (not quarantined) ${out.totals.liveOnSite}`);
console.log(`  price-divergent .............. ${out.totals.priceDivergent}`);
console.log(`  flagged false-positive risk .. ${out.totals.flaggedFalsePositiveRisk}`);
console.log(`  shared-ASIN clusters ......... ${out.totals.sharedAsinClusters} (${out.totals.rowsInSharedClusters} rows)`);
console.log(`\nwritten to ${OUT}`);
