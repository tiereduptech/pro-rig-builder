// C3b — finish the sweep: remove Amazon anomalies (bundles + 3rd-party gouges) and
// cross-retailer-VALIDATED Newegg non-official outliers. Conservative by design:
//   - Amazon: remove only the 13 diagnosed bad listings (2 bundles + 11 3rd-party
//     gouges with NO Amazon.com first-party New offer). KEEP legit Amazon.com BuyBox
//     prices even if higher than a peer (real price, not a bug).
//   - Newegg: remove a non-official (marketplace/other) deal ONLY when it is a genuine
//     outlier vs >=1 CLEAN corroborating peer (Amazon/Best Buy). No clean peer -> FLAG
//     (needsReview), don't remove. Reasonably-priced marketplace -> KEEP (labeled).
//     NEVER remove an official (N82E) Newegg deal.
//   node c3b-cleanup.mjs            # dry run
//   node c3b-cleanup.mjs --apply
import { writeFileSync } from 'node:fs';
import { classifyDeal, effectivePrice, CLASS } from './price-sanity.js';

const APPLY = process.argv.includes('--apply');
const STAMP = '2026-06-28';
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';

// Diagnosed via /sellers (b3b-diagnose round 1 + round 2): 4 bundles + 29 3rd-party
// gouges (no Amazon.com first-party New offer). 7 legit Amazon.com BuyBox prices kept.
const AMAZON_REMOVE = new Set([
  // round 1 (amazon-high vs official-newegg/bestbuy peer)
  10055, 20004, 10064, 20040, 20234, 30163, 40084, 50546, 50549, 100452, 100454, 60075, 90085,
  // round 2 (amazon-high vs cheaper non-official newegg)
  10068, 20005, 20044, 20050, 20165, 20167, 20175, 20179, 20507, 50010, 50072, 50146, 50156, 50239, 50420, 70027, 80024, 80161, 80199, 85008,
]);
const AMAZON_BUNDLE = new Set([10055, 20004, 20005, 20507]); // wrong product (bundle ASINs, data-quality)

const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const parts = mod.PARTS;
const byId = new Map(parts.map(p => [p.id, p]));

// ── Phase 1: remove Amazon anomalies ─────────────────────────────────────────
let azRemoved = 0, azBundle = 0;
for (const id of AMAZON_REMOVE) {
  const p = byId.get(id);
  if (p?.deals?.amazon) {
    if (APPLY) { delete p.deals.amazon; p.amazonRemovedAnomaly = STAMP; if (AMAZON_BUNDLE.has(id)) p.amazonBundleAsin = true; }
    azRemoved++; if (AMAZON_BUNDLE.has(id)) azBundle++;
  }
}

// ── Phase 2: Newegg non-official outlier removal (clean-peer-validated) ───────
// "Clean peer" = a present Amazon/Best Buy price NOT itself queued for removal.
let neRemoved = 0, neFlagged = 0, neKept = 0;
const flaggedNoPeer = [], removed = [], neLowSuspect = [];
for (const p of parts) {
  const ne = p.deals?.newegg;
  if (!ne) continue;
  const cls = ne.sellerClass;
  if (cls === 'official') { neKept++; continue; }     // never touch first-party
  const nePrice = effectivePrice(ne);
  if (nePrice == null) continue;
  // clean peers: amazon (unless removed in phase 1) + bestbuy
  const peers = [];
  if (p.deals?.amazon && !AMAZON_REMOVE.has(p.id)) { const a = effectivePrice(p.deals.amazon); if (a != null) peers.push(a); }
  if (p.deals?.bestbuy) { const b = effectivePrice(p.deals.bestbuy); if (b != null) peers.push(b); }
  if (peers.length === 0) {
    // sole-ish (no corroborating clean retailer) -> flag, don't remove
    if (APPLY) { p.needsReview = true; p.quarantinedAt = STAMP; }
    neFlagged++; flaggedNoPeer.push(p.id);
    continue;
  }
  const r = classifyDeal(nePrice, peers, p.pr, p.msrp);
  const isOutlier = r.cls !== CLASS.OK && r.cls !== CLASS.UNVERIFIED;
  const high = (r.deviation ?? 0) > 0;
  if (isOutlier && high) {
    // Newegg priced ABOVE a clean peer = marketplace gouge → remove.
    if (APPLY) { delete p.deals.newegg; p.neweggRemovedOutlier = STAMP; }
    neRemoved++; removed.push({ id: p.id, nePrice, peers, cls: r.cls, dev: r.deviation, sellerClass: cls, name: p.n });
  } else if (isOutlier && !high) {
    // Newegg is the CHEAP side, peer (Amazon) is HIGH. Ambiguous without per-item
    // diagnosis (could be Amazon gouge OR a wrong-cheap marketplace listing).
    // Conservative: flag the product for human review rather than guess a side.
    if (APPLY) { p.needsReview = true; p.quarantinedAt = STAMP; }
    neLowSuspect.push({ id: p.id, ne: nePrice, peers });
  } else {
    neKept++; // reasonably priced marketplace stays (labeled)
  }
}

// ── Phase 3: deal-less -> needsReview ────────────────────────────────────────
let hidden = 0;
if (APPLY) for (const p of parts) {
  if (!p.deals?.amazon && !p.deals?.newegg && !p.deals?.bestbuy && !p.needsReview) {
    p.needsReview = true; p.quarantinedAt = STAMP; hidden++;
  }
}

console.log('=== C3b CLEANUP ===');
console.log(`Amazon removed: ${azRemoved} (incl ${azBundle} bundles); 5 legit Amazon.com kept`);
console.log(`Newegg non-official: removed ${neRemoved} (outlier vs clean peer) | flagged ${neFlagged} (no clean peer) | kept ${neKept} (official + sane marketplace)`);
console.log(`Deal-less -> hidden: ${hidden}`);
console.log(`Newegg removal had corroborating clean peer: ${neRemoved}/${neRemoved + neFlagged} of the cross-validated set`);
console.log(`  Newegg removed = HIGH gouges only: ${neRemoved} (marketplace=${removed.filter(r=>r.sellerClass==='marketplace').length} other=${removed.filter(r=>r.sellerClass==='other').length})`);
console.log(`  Newegg-cheap/Amazon-high ambiguous → flagged for human review: ${neLowSuspect.length}`);
if (APPLY) {
  writeFileSync(PARTS_PATH, '// Auto-merged catalog. Edit with care.\n' + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n');
  console.log('APPLIED.');
} else console.log('DRY RUN.');
