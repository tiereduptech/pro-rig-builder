#!/usr/bin/env node
/**
 * dedupe-and-bundle-flag.cjs — one-pass catalog cleanup:
 *   (1) set bundle:true on the 3 confirmed CPU+motherboard combos.
 *   (2) dedupe exact-name duplicate VISIBLE rows (needsReview!==true), MERGING
 *       every retailer deal onto the survivor BEFORE deleting any row, so a deal
 *       can never be lost by a survivor-selection mistake.
 *
 * Survivor = most complete deal set; tie-break = freshest verified deal timestamp;
 * final tie-break = lowest id. On a retailer-price conflict (two copies, same
 * retailer, different price) the freshest-timestamped deal wins (tie: lower price),
 * and the conflict is printed. Reviews/price-history are name-slug keyed (never id
 * keyed) so the same-name survivor inherits them automatically — no orphaning.
 *
 * Usage:  node dedupe-and-bundle-flag.cjs           (dry run — prints report)
 *         node dedupe-and-bundle-flag.cjs --write    (apply via writeCatalog)
 */
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const WRITE = process.argv.includes('--write');
const BUNDLE_IDS = [10141, 20065, 20492];

const TS_FIELDS = ['verifiedAt', 'linkVerifiedAt', 'lastVerifiedAt', 'priceUpdatedAt', 'matchedAt', 'updatedAt', 'asOf'];
const dealTs = (deal) => {
  let best = 0;
  for (const f of TS_FIELDS) { const v = deal && deal[f]; if (v) { const t = Date.parse(v); if (t > best) best = t; } }
  return best;
};
const retailers = (p) => (p.deals && typeof p.deals === 'object')
  ? Object.keys(p.deals).filter((k) => p.deals[k] && typeof p.deals[k] === 'object' && p.deals[k].price != null) : [];
const dealCount = (p) => retailers(p).length;
const freshest = (p) => retailers(p).reduce((mx, k) => Math.max(mx, dealTs(p.deals[k])), 0);

(async () => {
  const mod = await import('file://' + path.resolve('src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default)];
  const loadedCount = parts.length;
  const byId = new Map(parts.map((p) => [p.id, p]));

  // ── (1) flag the 3 bundles ──
  const flagged = [];
  for (const id of BUNDLE_IDS) {
    const p = byId.get(id);
    if (!p) { console.log(`  ! bundle id ${id} not found`); continue; }
    if (p.bundle !== true) { p.bundle = true; flagged.push(id); }
  }

  // ── (2) dedupe exact-name VISIBLE duplicates ──
  const groups = new Map();
  for (const p of parts) {
    if (p.needsReview === true) continue;            // quarantined rows are hidden; leave them
    const k = String(p.n || '').trim().toLowerCase();
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(p);
  }
  const dupGroups = [...groups.values()].filter((m) => m.length > 1);

  const deleteIds = new Set();
  const report = [];
  const conflicts = [];
  for (const members of dupGroups) {
    // survivor: dealCount desc, freshest desc, id asc
    const survivor = [...members].sort((a, b) =>
      dealCount(b) - dealCount(a) || freshest(b) - freshest(a) || a.id - b.id)[0];
    const merged = new Set(retailers(survivor));
    for (const p of members) {
      if (p.id === survivor.id) continue;
      deleteIds.add(p.id);
      for (const rk of retailers(p)) {
        const inc = p.deals[rk];
        const ex = survivor.deals && survivor.deals[rk];
        if (!ex || ex.price == null) {                          // survivor lacks this retailer -> take it
          survivor.deals = survivor.deals || {};
          survivor.deals[rk] = inc; merged.add(rk);
        } else if (ex.price !== inc.price) {                    // CONFLICT: same retailer, different price
          const keepInc = dealTs(inc) > dealTs(ex) || (dealTs(inc) === dealTs(ex) && inc.price < ex.price);
          if (keepInc) survivor.deals[rk] = inc;
          conflicts.push({ name: survivor.n.slice(0, 50), retailer: rk, survivorId: survivor.id, keptPrice: keepInc ? inc.price : ex.price, droppedPrice: keepInc ? ex.price : inc.price, fromId: p.id, how: dealTs(inc) !== dealTs(ex) ? 'freshest-ts' : 'lower-price' });
        }
      }
      // enrich survivor with review/rating/asin if it lacks them (data files are name-keyed)
      if ((survivor.reviews || 0) < (p.reviews || 0)) { survivor.reviews = p.reviews; if (p.r != null) survivor.r = p.r; }
      if (!survivor.asin && p.asin) survivor.asin = p.asin;
    }
    report.push({ survivor: survivor.id, deleted: members.filter((p) => p.id !== survivor.id).map((p) => p.id), merged: [...merged].sort() });
  }

  const kept = parts.filter((p) => !deleteIds.has(p.id));

  // ── report ──
  console.log(`\n=== BUNDLE FLAGS ===`);
  console.log(`  set bundle:true on: ${flagged.join(', ') || '(none — already flagged)'}`);
  console.log(`\n=== DEDUPE (exact-name, visible) ===`);
  console.log(`  duplicate groups: ${dupGroups.length} | rows deleted: ${deleteIds.size}`);
  console.log(`  catalog: ${loadedCount} -> ${kept.length}  (target ~5567)`);
  console.log(`  price-conflicts during merge: ${conflicts.length}`);
  for (const c of conflicts) console.log(`    ! "${c.name}" [${c.retailer}] kept $${c.keptPrice} (${c.how}), dropped $${c.droppedPrice} from id ${c.fromId} -> survivor ${c.survivorId}`);
  console.log(`\n=== per-group: survivor <- deleted [merged retailers] ===`);
  for (const r of report) console.log(`  ${String(r.survivor).padEnd(7)} <- [${r.deleted.join(',')}]  merged:[${r.merged.join(',')}]`);

  if (!WRITE) { console.log('\n=== DRY RUN — nothing written. Re-run with --write. ===\n'); return; }
  const res = await writeCatalog(kept, { loadedCount, reason: `dedupe ${deleteIds.size} exact-name dups (deals merged) + flag ${flagged.length} bundles` });
  console.log(`\nwriteCatalog: ${JSON.stringify(res)}\n`);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
