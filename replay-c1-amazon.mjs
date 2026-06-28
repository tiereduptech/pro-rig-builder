// Re-run step 1: deterministically REPLAY C1-Amazon from the saved verify report
// (report-2026-06-28T21-51-44.json) onto the clean restore-point data. No API.
// Reproduces the exact net effect of C1-Amazon + the no_new_offer fix:
//   price_drift        -> write the confirmed-New price
//   price_drift_flagged -> needsReview (deferred-96, resolved in C3)
//   no_new_offer       -> remove the stale Amazon deal; hide only if deal-less
// The report was generated WITH --exclude-ids, so the 144 VS_LIST are already absent.
import { readFileSync, writeFileSync } from 'node:fs';
const SWEEP_DATE = '2026-06-28';
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';
const APPLY = process.argv.includes('--apply');

const j = JSON.parse(readFileSync('verify-reports/report-2026-06-28T21-51-44.json', 'utf8'));
const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const byId = new Map(mod.PARTS.map(p => [p.id, p]));

let written = 0, deferred = 0, noNewRemoved = 0, noNewHidden = 0, noNewRecovered = 0;
for (const e of j.issues || []) {
  const p = byId.get(e.productId);
  if (!p) continue;
  for (const i of e.issues) {
    if (i.type === 'price_drift' && typeof i.amazon === 'number' && p.deals?.amazon) {
      if (APPLY) p.deals.amazon.price = i.amazon;
      written++;
    } else if (i.type === 'price_drift_flagged') {
      if (APPLY) { p.needsReview = true; p.quarantinedAt = SWEEP_DATE; }
      deferred++;
    } else if (i.type === 'no_new_offer') {
      if (APPLY && p.deals?.amazon) delete p.deals.amazon;
      noNewRemoved++;
      const hasOther = !!(p.deals?.newegg || p.deals?.bestbuy);
      if (hasOther) { noNewRecovered++; }
      else { if (APPLY) { p.needsReview = true; p.quarantinedAt = SWEEP_DATE; } noNewHidden++; }
    }
  }
}
console.log('=== C1-AMAZON REPLAY ===');
console.log(`New prices written:        ${written}`);
console.log(`Deferred (needsReview):    ${deferred}`);
console.log(`no_new_offer amazon removed: ${noNewRemoved} (hidden ${noNewHidden}, kept-visible ${noNewRecovered})`);
if (APPLY) {
  writeFileSync(PARTS_PATH, '// Auto-merged catalog. Edit with care.\n' + 'export const PARTS = ' + JSON.stringify(mod.PARTS, null, 2) + ';\n\nexport default PARTS;\n');
  console.log('APPLIED.');
} else console.log('DRY RUN.');
