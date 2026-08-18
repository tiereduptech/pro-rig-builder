#!/usr/bin/env node
/**
 * stamp-unbuyable-bestbuy.mjs — mark the Best Buy deals whose sku is alive but
 * cannot be bought, and quarantine only the rows that have nothing else.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node stamp-unbuyable-bestbuy.mjs                 # report, writes nothing
 *   node stamp-unbuyable-bestbuy.mjs --apply         # stamp + write the catalog
 *   node stamp-unbuyable-bestbuy.mjs --strict-peers  # see PEER LIVENESS below
 *
 * ── THE OTHER HALF OF THE DEAD-LINK PURGE ────────────────────────────────────
 * purge-dead-bestbuy-links.mjs handled the 483 skus the Developer API returns
 * 404 for: broken link, price attached to nothing, deal deleted. This handles
 * the 343 the same audit found ALIVE but unbuyable — the sku resolves, the name
 * and price come back, and Best Buy will not sell it today:
 *
 *   161  orderable "SoldOut"
 *   168  orderable "NotOrderable"
 *    14  orderable "Available" but active:false / onlineAvailability:false
 *
 * These are not deleted. A sold-out sku routinely comes back, and even a
 * NotOrderable one resolves; the sku is a working identity that cost real work
 * to establish and would have to be rediscovered from scratch. What the deal
 * must stop doing is presenting itself as something a customer can buy, and
 * setting the price we compare every other retailer against.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────────
 * For every unbuyable row: `deals.bestbuy.inStock = false`. That is the whole
 * data change. inStock is not a new field — it is the one Best Buy ingest has
 * always written (bestbuy-merge.js), it is already false on 143 rows, and the
 * frontend reads it in seven places. All three buckets get identical treatment;
 * the bucket is reported, never stored.
 *
 * A row is quarantined (`needsReview` + `quarantinedAt` + a review flag) ONLY
 * when Best Buy was its last retailer — the same orphan rule as the 483, and
 * the reason hard suppression downstream is safe: every row that stays VISIBLE
 * still has a peer with a price, so no visible product can be left with zero
 * buy options by an out-of-stock Best Buy deal being suppressed.
 *
 * Nothing is ever un-quarantined here, and a row that already carries
 * `needsReview` keeps it untouched — it still gets the inStock stamp, because
 * the deal data should be true whether or not anyone is looking at it.
 *
 * ── WHY THE STAMP IS SAFE TO BE WRONG ────────────────────────────────────────
 * bestbuy-merge.js rewrites inStock from `stockAvailability` on every merge and
 * in-stock always beats out-of-stock, so the day the feed says the sku is back,
 * the stamp lifts itself. That self-healing is why there is no re-check flag
 * for the NotOrderable rows: a field nothing reads is not a re-check, and if
 * one of them goes fully dead it lands in the next dead-sku audit as a 404 and
 * gets purged. The stamp is a statement about today that today can revoke.
 *
 * ── THE SPLIT, MEASURED RATHER THAN REMEMBERED ───────────────────────────────
 * Against the 2026-08-17 audit and the catalog as it stands on 2026-08-18:
 *
 *   343  unbuyable rows, every one still carrying its Best Buy deal
 *   132  already inStock:false — the feed caught these, the stamp is a no-op
 *   211  still claiming inStock:true  -> stamped here
 *   202  have no other retailer at all -> orphans
 *    16   of those were already quarantined — left exactly as they are
 *   186   quarantined here (1,688 -> 1,874)
 *   141  keep another retailer; 32 of those were already quarantined for other
 *        reasons, so 109 stay visible with the Best Buy row sunk and labelled
 *
 * The orphan rate is 59% here against 12% on the 483, and that is a real
 * difference rather than a bug: the unbuyable set is dominated by Best Buy
 * EXCLUSIVES that never had a peer — 78 monitors, 36 storage, 24 GPUs, and 61
 * of the 202 are Geek Squad Certified Refurbished. Sold out is also the state
 * most likely to reverse, so this run hides a block of rows that may well come
 * back. That is the cost of the orphan rule, not a reason to skip it: a row
 * with no buyable retailer has nothing to show a customer either way.
 *
 * ── PEER LIVENESS ────────────────────────────────────────────────────────────
 * "Has another retailer" and "has a WORKING another retailer" are different
 * counts. Of the 141 non-orphans, 12 keep only peers whose own audit does not
 * call them alive (all Amazon); 10 of those already carry needsReview, so
 * `--strict-peers` changes the outcome for exactly 2 rows — 188 quarantined
 * rather than 186. They are left live by default deliberately, exactly as the 5
 * were in the purge: quarantining a row on a second-hand, older verdict hides a
 * product on someone else's measurement. They are named in the report and on
 * the console either way, so the stricter call can be made deliberately.
 *
 * ── HOW IT WRITES ────────────────────────────────────────────────────────────
 * Through scripts/write-catalog.cjs, the sanctioned path. This run touches
 * fields only — no row is added or removed — so the count must come back
 * identical, and the size brakes are left at their defaults precisely so a bug
 * that lost rows would hit them.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STRICT_PEERS = args.includes('--strict-peers');
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const ROOT = process.cwd();
const REPORT_IN = argOf('report', path.join(ROOT, 'catalog-build', 'bestbuy-dead-sku-audit.json'));
const AMAZON_AUDIT = path.join(ROOT, 'amazon-asin-identity-audit.json');
const NEWEGG_AUDIT = argOf('newegg-report', path.join(ROOT, 'catalog-build', 'newegg-dead-sku-audit.json'));
const today = new Date().toISOString().slice(0, 10);

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const audit = readJson(REPORT_IN);
if (!audit?.unbuyableIds?.length) {
  console.error(`ERROR: no unbuyable list in the dead-sku report at ${path.relative(ROOT, REPORT_IN)}.`);
  console.error('Download the artifact from the "Best Buy dead-SKU audit (read-only)" run, or pass --report=<path>.');
  process.exit(1);
}
const unbuyableIds = new Set(audit.unbuyableIds);
const auditRow = new Map((audit.rows || []).map((r) => [r.id, r]));

// Reporting only. The three buckets get identical treatment — "Available" with
// active:false is a sold-out row the orderable field describes badly — so the
// bucket is never stored, it just has to be visible in the dry run.
const bucketOf = (id) => {
  const o = String(auditRow.get(id)?.api?.orderable ?? '(null)');
  if (/^soldout$/i.test(o)) return 'SoldOut';
  if (/^notorderable$/i.test(o)) return 'NotOrderable';
  return 'Available-but-inactive';
};

// Peer liveness, second-hand and optional — see the header. A missing audit
// simply means no peer can be called dead, never that every peer is dead.
const azAudit = readJson(AMAZON_AUDIT);
const neAudit = readJson(NEWEGG_AUDIT);
const azDead = new Set([
  ...(azAudit?.findings || []).filter((f) => f.class === 'dead-asin').map((f) => f.id),
  ...(azAudit?.noOfferRows || []).map((r) => r.id),
]);
const neStatus = new Map((neAudit?.rows || []).map((r) => [`${r.id}|${r.dealKey}`, r.status]));

const peerIsLive = (id, key) => {
  if (key === 'amazon') return !azDead.has(id);
  if (key.startsWith('newegg')) return (neStatus.get(`${id}|${key}`) ?? 'alive') === 'alive';
  return true;
};

/**
 * Retailers other than Best Buy that this row can still sell through.
 * Identical to the purge's rule, deliberately: the two scripts decide "is this
 * row an orphan" the same way or the catalog ends up with two definitions.
 */
function peersOf(p) {
  const out = [];
  for (const [key, deal] of Object.entries(p.deals || {})) {
    if (key === 'bestbuy') continue;
    const price = deal?.price ?? deal?.saleprice ?? null;
    if (typeof price !== 'number' || !(price > 0)) continue;
    out.push({ key, price, live: peerIsLive(p.id, key) });
  }
  return out;
}

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
const loadedCount = parts.length;

const stamped = [];          // inStock flipped true -> false by this run
const alreadyOOS = [];       // the feed already knew — no-op, still reported
const orphans = [];          // every row with no retailer left, quarantined here or already
const quarantined = [];      // orphan, newly hidden
const alreadyQuarantined = []; // orphan or not, already carrying needsReview
const keptOnDeadPeersOnly = [];
const notInCatalog = [];
const noBestBuyDeal = [];
const byBucket = {};

for (const id of unbuyableIds) {
  const p = parts.find((x) => x.id === id);
  if (!p) { notInCatalog.push(id); continue; }
  if (!p.deals?.bestbuy) { noBestBuyDeal.push(id); continue; }

  const bucket = bucketOf(id);
  const peers = peersOf(p);
  const livePeers = peers.filter((x) => x.live);
  const usable = STRICT_PEERS ? livePeers : peers;
  const wasOOS = p.deals.bestbuy.inStock === false;

  const row = {
    id, bucket, cat: p.c, name: String(p.n || '').slice(0, 70),
    bbPrice: p.deals.bestbuy.price ?? null,
    sku: (/prodsku=(\d+)/.exec(p.deals.bestbuy.url || '') || [])[1] ?? null,
    apiOrderable: auditRow.get(id)?.api?.orderable ?? null,
    wasInStock: !wasOOS,
    peers: peers.map((x) => `${x.key}${x.live ? '' : ' (audit: not alive)'} $${x.price}`),
  };
  (wasOOS ? alreadyOOS : stamped).push(row);

  const b = (byBucket[bucket] ||= { rows: 0, stamped: 0, alreadyOOS: 0, orphans: 0, quarantined: 0 });
  b.rows++; wasOOS ? b.alreadyOOS++ : b.stamped++;
  if (!usable.length) { orphans.push(row); b.orphans++; }

  if (p.needsReview) alreadyQuarantined.push(row);
  else if (!usable.length) { quarantined.push(row); b.quarantined++; }
  else if (!livePeers.length) keptOnDeadPeersOnly.push(row);

  if (APPLY) {
    p.deals.bestbuy.inStock = false;
    if (!usable.length && !p.needsReview) {
      p.needsReview = true;
      p.quarantinedAt = today;
      p.reviewFlags = [...new Set([...(p.reviewFlags || []), 'bestbuy:unbuyable-orphan'])];
    }
  }
}

const total = stamped.length + alreadyOOS.length;
const pct = (n) => `${((n / (total || 1)) * 100).toFixed(1)}%`;
console.log('='.repeat(96));
console.log(`BEST BUY UNBUYABLE STAMP — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
console.log(`report ${path.relative(ROOT, REPORT_IN)} audited ${audit.auditedAt} | peers: ${STRICT_PEERS ? 'must be audit-alive' : 'priced deal is enough'}`);
console.log('='.repeat(96));
console.log(`  unbuyable rows in the report ....... ${unbuyableIds.size}`);
console.log(`  found in the catalog, bb deal live . ${total}`);
console.log(`  not in the catalog ................. ${notInCatalog.length}`);
console.log(`  no Best Buy deal left on the row ... ${noBestBuyDeal.length}`);
console.log(`  -> inStock:false stamped ........... ${stamped.length}  (${pct(stamped.length)})`);
console.log(`  -> already inStock:false, no-op .... ${alreadyOOS.length}  (${pct(alreadyOOS.length)})`);
console.log(`  -> orphans (no retailer left) ...... ${orphans.length}`);
console.log(`       quarantined by this run ....... ${quarantined.length}`);
console.log(`       already quarantined ........... ${orphans.length - quarantined.length}`);
console.log(`  -> already quarantined, untouched .. ${alreadyQuarantined.length}  (${orphans.length - quarantined.length} orphans + ${alreadyQuarantined.length - (orphans.length - quarantined.length)} that still have a peer)`);
console.log(`  -> keep a peer and stay visible .... ${total - orphans.length - (alreadyQuarantined.length - (orphans.length - quarantined.length))}`);
console.log(`  kept, but every peer is audit-dead . ${keptOnDeadPeersOnly.length}  <- --strict-peers would quarantine these too`);
console.log('');
console.log('  by bucket (rows / newly stamped / already OOS / orphans / quarantined here):');
for (const [k, v] of Object.entries(byBucket).sort((a, b) => b[1].rows - a[1].rows)) {
  console.log(`    ${k.padEnd(24)} ${String(v.rows).padStart(4)} / ${String(v.stamped).padStart(4)} / ${String(v.alreadyOOS).padStart(4)} / ${String(v.orphans).padStart(4)} / ${String(v.quarantined).padStart(4)}`);
}

const show = (label, rows, n = 12) => {
  if (!rows.length) return;
  console.log(`\n${label}`);
  for (const r of rows.slice(0, n)) console.log(`  ${String(r.id).padEnd(8)} ${String(r.bucket).padEnd(22)} ${(r.cat || '').padEnd(12)} ${r.name.slice(0, 40).padEnd(40)} ${r.peers.join(', ') || '(no other retailer)'}`);
  if (rows.length > n) console.log(`  … and ${rows.length - n} more (full list in the report)`);
};
show('QUARANTINED — Best Buy was the last retailer:', quarantined);
show('KEPT ON A PEER ITS OWN AUDIT CALLS DEAD:', keptOnDeadPeersOnly);

mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
const out = path.join(ROOT, 'verify-reports', `bestbuy-unbuyable-stamp-${today}.json`);
writeFileSync(out, JSON.stringify({
  apply: APPLY, strictPeers: STRICT_PEERS, ranAt: new Date().toISOString(),
  sourceReport: path.relative(ROOT, REPORT_IN), sourceAuditedAt: audit.auditedAt,
  counts: {
    unbuyable: unbuyableIds.size, acted: total, stamped: stamped.length,
    alreadyOOS: alreadyOOS.length, orphans: orphans.length,
    quarantined: quarantined.length,
    alreadyQuarantined: alreadyQuarantined.length,
    keptOnDeadPeersOnly: keptOnDeadPeersOnly.length,
    notInCatalog: notInCatalog.length, noBestBuyDeal: noBestBuyDeal.length,
  },
  byBucket,
  stamped, alreadyOOS, orphans, quarantined, alreadyQuarantined, keptOnDeadPeersOnly,
  notInCatalog, noBestBuyDeal,
}, null, 2));
console.log(`\nReport: ${path.relative(ROOT, out)}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to stamp these Best Buy deals.');
  process.exit(0);
}

await writeCatalog(parts, {
  loadedCount,
  reason: `stamp ${stamped.length} unbuyable Best Buy deals inStock:false, quarantine ${quarantined.length} orphans`,
});
console.log('Done.');
