// C1 follow-up: for Amazon `no_new_offer` products (used-only listings), REMOVE
// the stale Amazon deal entirely so the wrong used price is gone from the DATA
// (not merely hidden). Products that still have a Newegg/Best Buy deal are then
// un-hidden (recovered) — but only if THIS sweep quarantined them today, so we
// never un-hide a pre-existing quarantine.
//   node fix-no-new-offer-amazon.mjs            # dry run
//   node fix-no-new-offer-amazon.mjs --apply
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const SWEEP_DATE = '2026-06-28';
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';

const rep = readdirSync('verify-reports').filter(x => x.startsWith('report-') && x.endsWith('.json')).sort().pop();
const j = JSON.parse(readFileSync('verify-reports/' + rep, 'utf8'));
const noNewIds = new Set();
for (const e of j.issues || []) for (const i of e.issues) if (i.type === 'no_new_offer') noNewIds.add(e.productId);

const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const parts = mod.PARTS;
let removedDeal = 0, recovered = 0, keptHidden = 0;
for (const p of parts) {
  if (!noNewIds.has(p.id)) continue;
  if (p.deals?.amazon) { delete p.deals.amazon; removedDeal++; }
  const hasOther = !!(p.deals?.newegg || p.deals?.bestbuy);
  if (hasOther && p.quarantinedAt === SWEEP_DATE) {
    delete p.needsReview; delete p.quarantinedAt; recovered++;   // visible again via other retailers
  } else {
    keptHidden++;                                                // amazon-only (or pre-existing quarantine) → stays hidden
  }
}
console.log(`no_new_offer products: ${noNewIds.size}`);
console.log(`  stale Amazon deal removed: ${removedDeal}`);
console.log(`  recovered (un-hidden, has Newegg/BestBuy): ${recovered}`);
console.log(`  kept hidden (amazon-only or pre-existing quarantine): ${keptHidden}`);
if (APPLY) {
  writeFileSync(PARTS_PATH, '// Auto-merged catalog. Edit with care.\n' + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n');
  console.log('APPLIED.');
} else console.log('DRY RUN.');
