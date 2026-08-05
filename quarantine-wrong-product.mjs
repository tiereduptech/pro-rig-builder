// quarantine-wrong-product.mjs
//
// Quarantines ONLY the live `wrong-product` rows — links where Amazon's own
// title shows a different BRAND entirely (Secretlab -> Razer, Intel NIC ->
// USB audio adapter). Those are not judgement calls.
//
// `close-but-wrong` is deliberately EXCLUDED and routed to human review
// instead. That class is same-brand/different-model, and the hand-checked
// sample produced a confirmed false positive:
//   stored "Intel X550-T2 Dual-Port 10GbE PCIe 3.0 x4 Ethernet NIC"
//   amazon "Intel(R) Ethernet Converged Network Adapter X550-T2"
// — the same product under Amazon's longer name. Auto-acting on that class
// would hide correct rows.
//
// Never relinks. needsReview + quarantinedAt only.
//
//   node quarantine-wrong-product.mjs           # report only
//   node quarantine-wrong-product.mjs --apply   # write quarantine flags

import { readFileSync, writeFileSync } from 'node:fs';

const QUEUE_IN  = 'relink-review-queue.json';
const CLOSE_OUT = 'close-but-wrong-review.json';
const APPLY = process.argv.includes('--apply');
const today = () => new Date().toISOString().slice(0, 10);

const queue = JSON.parse(readFileSync(QUEUE_IN, 'utf8')).queue;

const wrongLiveAll = queue.filter(r => r.class === 'wrong-product' && r.live);
const closeLive    = queue.filter(r => r.class === 'close-but-wrong' && r.live);

// The `wrong-product` label alone is NOT proof. brandShared() compares the stored
// name's leading token against the Amazon title, so a row ingested with Amazon's
// marketing title MINUS the brand ("M.2 NVMe SSD 1TB With…", "3-Pack 120mm Black
// Computer Case Fans") starts with a generic word, fails the brand check, and is
// labelled wrong-product even though it is the same product. That is the X550-T2
// failure mode via a different route.
//
// Corroborating evidence is required before an automated write. A genuinely wrong
// link moves the price materially or mismatches capacity; a title variant of the
// same product does neither.
const CONFIRM_DELTA_PCT = 50;
function confirmedWrong(r) {
  if (r.capConflict) return 'capacity-conflict';
  if (r.priceDeltaPct != null && Math.abs(r.priceDeltaPct) >= CONFIRM_DELTA_PCT) return `price ${r.priceDeltaPct > 0 ? '+' : ''}${r.priceDeltaPct}%`;
  if (r.amazonPrice == null && (r.overlapStoredInAmazon ?? 1) < 0.2) return 'no-offer + near-zero overlap';
  return null;
}
const wrongLive   = wrongLiveAll.filter(r => confirmedWrong(r));
const unconfirmed = wrongLiveAll.filter(r => !confirmedWrong(r));

console.log(`Wrong-product quarantine — ${APPLY ? 'APPLY MODE' : 'REPORT ONLY'}\n`);
console.log(`  queue total .................... ${queue.length}`);
console.log(`  wrong-product LIVE (labelled) .. ${wrongLiveAll.length}`);
console.log(`    CONFIRMED -> quarantine ...... ${wrongLive.length}`);
console.log(`    unconfirmed -> human review .. ${unconfirmed.length}`);
console.log(`  close-but-wrong LIVE (review) .. ${closeLive.length}`);
console.log(`  already quarantined ............ ${queue.filter(r => !r.live).length}`);

console.log('\nCONFIRMED WRONG — quarantining:');
console.log('-'.repeat(74));
for (const r of wrongLive) {
  console.log(`[${r.category}] id=${r.id} ${r.asin}  overlap=${r.overlapStoredInAmazon}  evidence: ${confirmedWrong(r)}`);
  console.log(`   stored: ${String(r.storedName).slice(0, 92)}`);
  console.log(`   amazon: ${String(r.amazonTitle).slice(0, 92)}`);
}

console.log('\nUNCONFIRMED — NOT quarantined, routed to review');
console.log('(label says wrong-product, but price/capacity give no corroboration —');
console.log(' most are the stored-name-omits-brand false positive):');
console.log('-'.repeat(74));
for (const r of unconfirmed) {
  const d = r.priceDeltaPct == null ? 'no price' : `${r.priceDeltaPct > 0 ? '+' : ''}${r.priceDeltaPct}%`;
  console.log(`[${r.category}] id=${r.id} ${r.asin}  price ${d}`);
  console.log(`   stored: ${String(r.storedName).slice(0, 88)}`);
  console.log(`   amazon: ${String(r.amazonTitle).slice(0, 88)}`);
}

// ---- close-but-wrong -> human review file ------------------------------
const closeReport = {
  meta: {
    generatedAt: new Date().toISOString(),
    policy: 'HUMAN REVIEW ONLY — never auto-quarantined, never auto-relinked',
    why: 'same-brand/different-model class; contains confirmed false positives '
       + '(e.g. Intel X550-T2 vs "Intel Ethernet Converged Network Adapter X550-T2" '
       + 'are the same product), so automated action would hide correct rows',
  },
  totals: {
    liveForReview: closeLive.length + unconfirmed.length,
    closeButWrong: closeLive.length,
    unconfirmedWrongProduct: unconfirmed.length,
    priceDivergent: closeLive.filter(r => r.priceDivergent).length,
    flaggedFalsePositiveRisk: closeLive.filter(r => r.falsePositiveRisk).length,
    capacityConflicts: closeLive.filter(r => r.capConflict).length,
  },
  rows: [...closeLive, ...unconfirmed].map(r => ({
    id: r.id, category: r.category, asin: r.asin,
    storedName: r.storedName, amazonTitle: r.amazonTitle,
    overlapStoredInAmazon: r.overlapStoredInAmazon,
    overlapAmazonInStored: r.overlapAmazonInStored,
    gateScore: r.gateScore,
    storedPrice: r.storedPrice, amazonPrice: r.amazonPrice,
    priceDeltaPct: r.priceDeltaPct, priceDivergent: r.priceDivergent,
    capConflict: r.capConflict,
    falsePositiveRisk: r.falsePositiveRisk,
    auditClass: r.class,
    reviewReason: r.class === 'close-but-wrong'
      ? 'same-brand/different-model — may be the same product under a longer Amazon name'
      : 'labelled wrong-product but price/capacity give no corroboration — likely stored name omits the brand',
    verdict: 'UNREVIEWED',
  })),
};
writeFileSync(CLOSE_OUT, JSON.stringify(closeReport, null, 2));
console.log(`\nhuman-review file -> ${CLOSE_OUT} (${closeReport.totals.liveForReview} rows = ` +
            `${closeLive.length} close-but-wrong + ${unconfirmed.length} unconfirmed wrong-product)`);

if (!APPLY) {
  console.log('\nREPORT ONLY — no catalog changes. Re-run with --apply.');
  process.exit(0);
}

const ids = new Set(wrongLive.map(r => r.id));
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
const parts = [...mod.PARTS];
const stamp = today();
let changed = 0;
for (const p of parts) {
  if (!ids.has(p.id)) continue;
  p.needsReview = true;
  p.quarantinedAt = stamp;
  changed++;
}
if (changed !== ids.size) {
  console.log(`\n! id mismatch: expected ${ids.size}, matched ${changed}. Aborting write.`);
  process.exit(1);
}
writeFileSync('./src/data/parts.js',
  `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
console.log(`\nAPPLIED — ${changed} wrong-product rows quarantined (needsReview=true, quarantinedAt=${stamp}).`);
console.log('close-but-wrong untouched. No relinks. Run scripts/split-parts-by-cat.cjs next.');
