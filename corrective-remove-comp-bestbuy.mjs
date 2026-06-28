// corrective-remove-comp-bestbuy.mjs (Stage B3 corrective sweep)
//
// Best Buy affiliate feeds expose only the comp/list price (confirmed: both the
// Developer API salePrice AND Impact CurrentPrice return $399.99 for the 7700X,
// never the real $239.99 member price). So there is no way to CORRECT a comp price
// — the only data-accurate action is to REMOVE Best Buy deals whose price is a
// high outlier vs the product's other retailers. A missing Best Buy row is better
// than a misleading $399.99.
//
//   node corrective-remove-comp-bestbuy.mjs            # DRY RUN (default), writes a report
//   node corrective-remove-comp-bestbuy.mjs --apply    # actually remove + write parts.js
//
// SEQUENCING: run AFTER B1 (New Amazon) and B2 (first-party Newegg) writes land,
// so the gate compares against CORRECTED peers. With dirty peers a comp price can
// be masked (a used-Amazon or marketplace-Newegg outlier drags the median).

import { readFileSync, writeFileSync } from 'node:fs';
import { bestbuyDecision } from './bestbuy-price.js';

const ROOT = process.cwd().replace(/\\/g, '/');
const APPLY = process.argv.includes('--apply');
const PARTS_PATH = `${ROOT}/src/data/parts.js`;

// Exclude the SUSPECT_VS_LIST wrong-baseline cohort (separate bug — do not touch).
const exclIdx = process.argv.indexOf('--exclude-ids');
let EXCLUDE_IDS = new Set();
if (exclIdx >= 0 && process.argv[exclIdx + 1]) {
  EXCLUDE_IDS = new Set(JSON.parse(readFileSync(process.argv[exclIdx + 1], 'utf8')).map(Number));
  console.log(`Excluding ${EXCLUDE_IDS.size} product ids (${process.argv[exclIdx + 1]})`);
}

const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const parts = mod.PARTS;

const drops = [], keeps = [];
for (const p of parts) {
  if (!p.deals?.bestbuy || typeof p.deals.bestbuy.price !== 'number') continue;
  if (EXCLUDE_IDS.has(p.id)) continue;
  const d = bestbuyDecision(p, p.deals.bestbuy.price);
  if (d.action === 'drop') {
    drops.push({ id: p.id, name: p.n, cat: p.c, bbPrice: p.deals.bestbuy.price,
      ref: d.sanity.ref, devPct: d.sanity.deviation == null ? null : Math.round(d.sanity.deviation * 1000) / 10,
      cls: d.sanity.cls, reason: d.reason,
      peers: { amazon: p.deals?.amazon?.price ?? null, newegg: (p.deals?.newegg?.saleprice ?? p.deals?.newegg?.price) ?? null } });
  } else {
    keeps.push(p.id);
  }
}

console.log(`Best Buy deals: ${drops.length + keeps.length}`);
console.log(`  KEEP: ${keeps.length}`);
console.log(`  DROP (comp-signature high outlier): ${drops.length}`);
console.log(`\nTop 25 drops:`);
for (const d of drops.slice(0, 25)) {
  console.log(`  id ${d.id} [${d.cat}] $${d.bbPrice} vs ref $${d.ref} (${d.devPct}% ${d.cls})  a=$${d.peers.amazon} n=$${d.peers.newegg}  ${d.name.slice(0,40)}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(`${ROOT}/verify-reports/b3-bestbuy-removals-${stamp}.json`, JSON.stringify({ apply: APPLY, dropCount: drops.length, keepCount: keeps.length, drops }, null, 2));

if (!APPLY) {
  console.log(`\nDRY RUN — no changes written. Re-run with --apply to remove these Best Buy deals.`);
} else {
  const dropIds = new Set(drops.map(d => d.id));
  for (const p of parts) {
    if (dropIds.has(p.id) && p.deals?.bestbuy) {
      delete p.deals.bestbuy;
      p.bestbuyRemovedComp = stamp.slice(0, 10);
    }
  }
  const header = '// Auto-merged catalog. Edit with care.\n';
  writeFileSync(PARTS_PATH, header + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n');
  console.log(`\nAPPLIED — removed ${drops.length} Best Buy deals, wrote parts.js.`);
}
