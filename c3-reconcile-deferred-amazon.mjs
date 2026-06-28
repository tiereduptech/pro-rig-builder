// C3 reconciliation: the 96 Amazon New prices that C1 DEFERRED (confirmed-New but
// failed the dispersion gate against then-dirty peers) are re-gated here against
// the NOW-clean peers (Amazon New written, Newegg first-party, BB comps removed).
// Those that now pass are written + un-hidden; genuine anomalies stay flagged.
//   node c3-reconcile-deferred-amazon.mjs            # dry run
//   node c3-reconcile-deferred-amazon.mjs --apply
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { amazonPriceSanity } from './amazon-price.js';

const APPLY = process.argv.includes('--apply');
const SWEEP_DATE = '2026-06-28';
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';

// Pull the deferred New prices (type price_drift_flagged carries .amazon = New price).
const rep = readdirSync('verify-reports').filter(x => x.startsWith('report-') && x.endsWith('.json')).sort().pop();
const j = JSON.parse(readFileSync('verify-reports/' + rep, 'utf8'));
const deferred = [];
for (const e of j.issues || []) for (const i of e.issues)
  if (i.type === 'price_drift_flagged' && typeof i.amazon === 'number')
    deferred.push({ id: e.productId, newPrice: i.amazon, oldPrice: i.stored });
console.log(`Deferred New prices in report: ${deferred.length}`);

const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const byId = new Map(mod.PARTS.map(p => [p.id, p]));

const resolved = [], stillFlagged = [], skipped = [];
for (const d of deferred) {
  const p = byId.get(d.id);
  if (!p || !p.deals?.amazon) { skipped.push(d.id); continue; }
  const s = amazonPriceSanity(p, d.newPrice); // re-gate vs CURRENT (clean) peers
  if (s.pass) {
    if (APPLY) {
      p.deals.amazon.price = d.newPrice;
      if (p.quarantinedAt === SWEEP_DATE) { delete p.needsReview; delete p.quarantinedAt; }
    }
    resolved.push({ id: d.id, name: p.n, from: d.oldPrice, to: d.newPrice });
  } else {
    stillFlagged.push({ id: d.id, name: p.n, newPrice: d.newPrice, cls: s.cls,
      peers: { newegg: p.deals?.newegg ? (p.deals.newegg.saleprice ?? p.deals.newegg.price) : null, bestbuy: p.deals?.bestbuy?.price ?? null } });
  }
}

console.log(`\n=== C3 RECONCILIATION ===`);
console.log(`Resolved (now pass → written + un-hidden): ${resolved.length}`);
console.log(`Still flagged (genuine anomalies, kept needsReview): ${stillFlagged.length}`);
console.log(`Skipped (amazon deal no longer present): ${skipped.length}`);
const p7700 = byId.get(10018);
console.log(`\n7700X: amazon=$${p7700?.deals?.amazon?.price} needsReview=${!!p7700?.needsReview}`);
console.log(`\nStill-flagged anomalies (sample):`);
for (const x of stillFlagged.slice(0, 12))
  console.log(`  id ${x.id} New=$${x.newPrice} ${x.cls}  newegg=$${x.peers.newegg} bestbuy=$${x.peers.bestbuy}  ${x.name.slice(0,38)}`);

writeFileSync(process.cwd().replace(/\\/g, '/') + `/verify-reports/c3-reconcile-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`,
  JSON.stringify({ deferred: deferred.length, resolved, stillFlagged, skipped }, null, 2));

if (APPLY) {
  writeFileSync(PARTS_PATH, '// Auto-merged catalog. Edit with care.\n' + 'export const PARTS = ' + JSON.stringify(mod.PARTS, null, 2) + ';\n\nexport default PARTS;\n');
  console.log('\nAPPLIED to parts.js.');
} else console.log('\nDRY RUN — re-run with --apply.');
