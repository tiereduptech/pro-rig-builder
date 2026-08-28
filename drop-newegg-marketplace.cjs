#!/usr/bin/env node
/**
 * drop-newegg-marketplace.cjs — remove deals.newegg_marketplace from the catalog.
 *
 * WHY THESE ROWS ARE DROPPED RATHER THAN REFRESHED
 *
 * newegg_marketplace was one of the last two retailers publishing prices that
 * nothing would ever check. The other, newegg_openbox, is being fixed instead —
 * Rakuten's SFTP feed carries open-box listings and sftp-ingest.yml already
 * writes that lane nightly, so it only needed a confirmation stamp. This lane
 * has no such path:
 *
 *   - Its only writer, dedupe-case-batch.cjs, is a one-off no workflow invokes.
 *   - The MKPL marketplace feed is deliberately NOT ingested — sftp-ingest.cjs
 *     skips it as 886MB and measurably dead (of the 443 pending Newegg deals it
 *     carries zero, and 83,502 of its rows claim in-stock in a file last written
 *     2023-03-16).
 *   - Rakuten Product Search can reach marketplace listings, but the matcher
 *     PREFERS first-party and treats marketplace as last resort, so asking for
 *     the product returns the 1P listing — which is deals.newegg, not this lane.
 *     Repricing it would need a dedicated per-row request lane, spent against
 *     the budget #71 had just tightened, to keep 37 duplicate offers alive.
 *
 * WHY IT COSTS NOTHING (measured 2026-08-28, before the drop)
 *
 *   37 rows, every one of them Case, every one carrying a deals.newegg peer on
 *   the same row — the lane exists BECAUSE dedupe-case-batch preserved a cheaper
 *   3P offer beside the 1P one. 30 of those peers are in stock and confirmed
 *   inside PRICE_STALE_AFTER_DAYS. Not one row loses its only offer.
 *
 *   21 of the 37 wore a BEST badge before #73, on prices confirmed 18 days ago
 *   and never once updated: 29 rows have price history since 2026-08-12 and 2 of
 *   them have ever moved.
 *
 * The CADENCE entry in scripts/assert-retailer-freshness.cjs is deliberately
 * KEPT after this runs. dedupe-case-batch.cjs still exists and still writes this
 * key, so if it is ever run again the rows must come back to a gate that fails
 * them rather than to silence. With 0 rows the entry is inert.
 *
 * Run:
 *   node drop-newegg-marketplace.cjs            (dry run — default)
 *   node drop-newegg-marketplace.cjs --apply
 */

const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const LANE = 'newegg_marketplace';
const PARTS_PATH = path.join(__dirname, 'src', 'data', 'parts.js');
const APPLY = process.argv.includes('--apply');

(async () => {
  const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  const loadedCount = parts.length;

  const dealPrice = (d) => {
    if (!d || typeof d !== 'object') return null;
    const l = Number(d.price), s = Number(d.saleprice);
    const hl = Number.isFinite(l) && l > 0, hs = Number.isFinite(s) && s > 0;
    if (hl && hs) return Math.min(l, s);
    if (hs) return s;
    return hl ? l : null;
  };

  const hits = parts.filter((p) => p.deals && p.deals[LANE]);
  console.log(`\n${LANE}: ${hits.length} rows\n`);

  // The safety property, re-checked at apply time rather than trusted from the
  // analysis that motivated this. A row whose only offer is this lane must not
  // be silently stripped of its price — if one appears, stop and look.
  const orphans = [];
  const byCat = {};
  for (const p of hits) {
    byCat[p.c] = (byCat[p.c] || 0) + 1;
    const peers = Object.entries(p.deals)
      .filter(([k, d]) => k !== LANE && d && typeof d === 'object' && dealPrice(d) != null && (d.url || d.linkurl));
    if (!peers.length) orphans.push({ id: p.id, n: p.n });
  }

  console.log(`  by category: ${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  rows whose ONLY priced offer is this lane: ${orphans.length}`);

  if (orphans.length) {
    console.error(`\n  REFUSING: ${orphans.length} row(s) would lose their only offer:`);
    for (const o of orphans.slice(0, 20)) console.error(`    [${o.id}] ${o.n}`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  let removed = 0;
  for (const p of hits) { delete p.deals[LANE]; removed++; }

  // Product COUNT is unchanged — this removes a deal key, not a row — so the
  // shrink brake is not the guard here. The orphan check above is.
  await writeCatalog(parts, { loadedCount, reason: `drop deals.${LANE} (${removed} rows, all with a Newegg peer)` });
  console.log(`\n  Removed deals.${LANE} from ${removed} rows.\n`);
})();
