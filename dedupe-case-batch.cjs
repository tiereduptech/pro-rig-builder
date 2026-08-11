#!/usr/bin/env node
/**
 * dedupe-case-batch.cjs — merge-then-delete the intra-batch duplicates the case ingest
 * created (batchId case-ingest-2026-08-10).
 *
 * WHY THEY EXIST: the ingest deduped every candidate against the CATALOG but never against
 * the other candidates in the same run, so a product listed twice on Newegg (typically once
 * first-party and once by a marketplace seller) became two catalog rows. Measured: 104 UPC
 * groups, 137 redundant rows, 0 collisions with pre-existing rows. Left alone they would
 * prerender as 137 duplicate pages of the same product.
 *
 * DISCIPLINE — identical to dedupe-and-bundle-flag.cjs (the 183-row dedupe): MERGE every
 * retailer deal onto the survivor BEFORE deleting anything, so a deal can never be lost to a
 * survivor-selection mistake.
 *
 * Survivor  = live before held, then most retailer deals, then freshest deal, then lowest id.
 *             ("live before held" is added here: these groups can pair a published row with a
 *             markup-quarantined one, and the published page is the one to keep.)
 * Conflict  = same retailer on both rows: prefer 1P over 3P, then freshest timestamp, then
 *             lower price. 1P-first matters because the duplicate is often the SAME product
 *             at a marketplace markup, and merging must never move a live row onto that price.
 * Enrich    = survivor inherits img / upc / mpn / reviews / rating from a duplicate when it
 *             lacks them — which also recovers thumbnails on rows that had none.
 * Never     = a deleted row's quarantine state (priceQuarantine, heldReason) is not carried
 *             onto the survivor.
 *
 * Usage:  node dedupe-case-batch.cjs            (dry run — full report, writes nothing)
 *         node dedupe-case-batch.cjs --write     (apply via writeCatalog)
 */
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const WRITE = process.argv.includes('--write');
const BATCH = (process.argv.find((a) => a.startsWith('--batch=')) || '--batch=case-ingest-2026-08-10').split('=')[1];

const TS_FIELDS = ['priceConfirmedAt', 'linkVerifiedAt', 'verifiedAt', 'lastVerifiedAt', 'priceUpdatedAt', 'matchedAt', 'updatedAt', 'asOf'];
const dealTs = (d) => { let b = 0; for (const f of TS_FIELDS) { const v = d && d[f]; if (v) { const t = Date.parse(v); if (t > b) b = t; } } return b; };
const retailers = (p) => (p.deals && typeof p.deals === 'object')
  ? Object.keys(p.deals).filter((k) => p.deals[k] && typeof p.deals[k] === 'object' && p.deals[k].price != null) : [];
const dealCount = (p) => retailers(p).length;
const freshest = (p) => retailers(p).reduce((mx, k) => Math.max(mx, dealTs(p.deals[k])), 0);
const isLive = (p) => p.needsReview !== true;
const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };

(async () => {
  const mod = await import('file://' + path.resolve('src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default)];
  const loadedCount = parts.length;
  const batch = parts.filter((p) => p.batchId === BATCH);
  console.log(`${'='.repeat(94)}\nCASE BATCH DEDUPE — ${WRITE ? 'WRITE' : 'DRY RUN'} — batch ${BATCH}\n${'='.repeat(94)}`);
  console.log(`catalog ${loadedCount} products · ${batch.length} rows in batch\n`);

  // ── group: UPC first, then brand+MPN for rows carrying no UPC ──
  const groups = [];
  const byUPC = new Map();
  for (const p of batch) { const u = normUPC(p.upc); if (!u) continue; (byUPC.get(u) || byUPC.set(u, []).get(u)).push(p); }
  for (const [k, v] of byUPC) if (v.length > 1) groups.push({ key: `upc:${k}`, members: v });
  const claimed = new Set(groups.flatMap((g) => g.members.map((p) => p.id)));
  const byMPN = new Map();
  for (const p of batch) {
    if (claimed.has(p.id) || normUPC(p.upc)) continue;
    const m = normMPN(p.mpn); if (!m) continue;
    const k = `${String(p.b || '').toLowerCase()}|${m}`;
    (byMPN.get(k) || byMPN.set(k, []).get(k)).push(p);
  }
  for (const [k, v] of byMPN) if (v.length > 1) groups.push({ key: `mpn:${k}`, members: v });

  const deleteIds = new Set();
  const report = [];
  const conflicts = [];
  const preserved = [];   // cheaper 3P offers kept as deals.newegg_marketplace
  const enriched = { img: 0, upc: 0, mpn: 0, reviews: 0 };

  for (const g of groups) {
    const survivor = [...g.members].sort((a, b) =>
      (isLive(b) - isLive(a)) || (dealCount(b) - dealCount(a)) || (freshest(b) - freshest(a)) || (a.id - b.id))[0];
    const merged = new Set();
    for (const p of g.members) {
      if (p.id === survivor.id) continue;
      for (const rk of retailers(p)) {
        const inc = p.deals[rk];
        const ex = survivor.deals && survivor.deals[rk];
        if (!ex || ex.price == null) { survivor.deals = survivor.deals || {}; survivor.deals[rk] = inc; merged.add(rk); continue; }
        // same retailer on both rows — decide, and say why
        const inc1p = inc.priceSource === '1p', ex1p = ex.priceSource === '1p';
        let keepInc, how;
        if (inc1p !== ex1p) { keepInc = inc1p; how = '1p-over-3p'; }
        else if (dealTs(inc) !== dealTs(ex)) { keepInc = dealTs(inc) > dealTs(ex); how = 'freshest-ts'; }
        else { keepInc = inc.price < ex.price; how = 'lower-price'; }
        const kept = keepInc ? inc : ex, dropped = keepInc ? ex : inc;
        if (keepInc) { survivor.deals[rk] = inc; merged.add(rk); }
        // PRESERVE a cheaper marketplace offer rather than losing it. deals.newegg keeps the
        // first-party price; the cheaper 3P listing becomes its own retailer key, exactly as
        // newegg_openbox already does. A more EXPENSIVE 3P offer is still discarded -- that is
        // the markup case and preserving it helps nobody.
        if (rk === 'newegg' && kept.priceSource === '1p' && dropped.priceSource === '3p'
            && dropped.price > 0 && dropped.price < kept.price) {
          const cur = survivor.deals.newegg_marketplace;
          if (!cur || !(cur.price > 0) || dropped.price < cur.price) {
            survivor.deals.newegg_marketplace = { ...dropped, sellerClass: 'marketplace', priceSource: '3p' };
            preserved.push({ survivorId: survivor.id, oneP: kept.price, threeP: dropped.price,
              saving: Number((kept.price - dropped.price).toFixed(2)), name: String(survivor.n).slice(0, 42) });
          }
        }
        conflicts.push({ retailer: rk, survivorId: survivor.id, fromId: p.id, how,
          keptPrice: kept.price, droppedPrice: dropped.price,
          name: String(survivor.n).slice(0, 44) });
      }
      // enrich — recovers a missing thumbnail/identifier from the copy being deleted
      if (!survivor.img && p.img) { survivor.img = p.img; enriched.img++; }
      if (!survivor.upc && p.upc) { survivor.upc = p.upc; enriched.upc++; }
      if (!survivor.mpn && p.mpn) { survivor.mpn = p.mpn; enriched.mpn++; }
      if ((survivor.reviews || 0) < (p.reviews || 0)) { survivor.reviews = p.reviews; if (p.r != null) survivor.r = p.r; enriched.reviews++; }
      deleteIds.add(p.id);
    }
    // The survivor's headline price tracks its PRIMARY deal, deliberately EXCLUDING
    // newegg_marketplace: the row's primary price is the first-party one, and pr is what the
    // badge-free product heading shows. The cheaper marketplace price still surfaces in the
    // price-comparison list, which sorts every deal by price and marks the cheapest BEST.
    const primary = retailers(survivor).filter((k) => k !== 'newegg_marketplace')
      .map((k) => survivor.deals[k].price).filter((v) => v > 0);
    if (primary.length) { const lo = Math.min(...primary); if (survivor.pr !== lo) { survivor.msrp = survivor.msrp ?? survivor.pr; survivor.pr = lo; } }
    report.push({ key: g.key, survivor: survivor.id, live: isLive(survivor),
      deleted: g.members.filter((p) => p.id !== survivor.id).map((p) => p.id),
      merged: [...merged].sort(), name: String(survivor.n).slice(0, 58) });
  }

  console.log(`groups: ${groups.length}  (upc ${groups.filter((g) => g.key.startsWith('upc:')).length} · brand+mpn ${groups.filter((g) => g.key.startsWith('mpn:')).length})`);
  console.log(`rows to delete: ${deleteIds.size}\n`);
  console.log('=== per-group: survivor <- deleted [merged retailers] ===');
  for (const r of report) {
    console.log(`  #${String(r.survivor).padEnd(7)}${r.live ? 'live' : 'held'} <- [${r.deleted.join(',')}]  merged:[${r.merged.join(',') || '-'}]  ${r.name}`);
  }
  console.log(`\n=== same-retailer conflicts resolved: ${conflicts.length} ===`);
  for (const c of conflicts) console.log(`  [${c.retailer}] kept $${c.keptPrice} (${c.how}), dropped $${c.droppedPrice} from #${c.fromId} -> #${c.survivorId}  ${c.name}`);
  console.log(`\n=== cheaper 3P offers PRESERVED as deals.newegg_marketplace: ${preserved.length} ===`);
  let saved = 0;
  for (const q of preserved) {
    saved += q.saving;
    console.log(`  #${String(q.survivorId).padEnd(7)} 1P $${String(q.oneP).padStart(8)}  +  marketplace $${String(q.threeP).padStart(8)}  (saves $${String(q.saving).padStart(6)})  ${q.name}`);
  }
  console.log(`  shopper saving surfaced instead of discarded: $${saved.toFixed(2)}`);
  console.log(`\nenriched survivors: img +${enriched.img} · upc +${enriched.upc} · mpn +${enriched.mpn} · reviews +${enriched.reviews}`);

  const kept = parts.filter((p) => !deleteIds.has(p.id));
  const liveAfter = kept.filter((p) => p.c === 'Case' && p.needsReview !== true).length;
  console.log(`\ncatalog ${loadedCount} -> ${kept.length}  ·  live Case rows after: ${liveAfter}`);

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }
  await writeCatalog(kept, { loadedCount, reason: `dedupe case batch ${BATCH}: -${deleteIds.size} intra-batch duplicates (deals merged first)` });
  console.log(`\nWROTE. Removed ${deleteIds.size} duplicate rows.`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
