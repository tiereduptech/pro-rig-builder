#!/usr/bin/env node
/**
 * purge-dead-bestbuy-links.mjs — remove Best Buy deals whose sku Best Buy no
 * longer sells, and quarantine only the rows that have nothing left.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node purge-dead-bestbuy-links.mjs                 # report, writes nothing
 *   node purge-dead-bestbuy-links.mjs --apply         # remove + write the catalog
 *   node purge-dead-bestbuy-links.mjs --strict-peers  # see PEER LIVENESS below
 *
 * ── WHY THIS IS NOT THE PRICE QUESTION ───────────────────────────────────────
 * Whether `deals.bestbuy.price` is the number a customer pays is unsettled and,
 * after ten probe runs, unsettleable through Google Shopping: runs 32178925976
 * and 32193394665 asked the same 20 keywords three hours apart and six rows came
 * back on a different listing, $92 to $688 apart. This script does not depend on
 * that answer. A sku the Developer API returns 404 for is a broken affiliate
 * link and a price attached to nothing, whatever the right price would have
 * been — bestbuy-dead-sku-audit.mjs measured 483 of 1,523 rows in that state on
 * 2026-08-17, with zero UNKNOWN, so the number is the number.
 *
 * ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────
 * For every dead row: delete `deals.bestbuy`, stamp `bestbuyRemovedDead` with
 * the date, following the `bestbuyRemovedComp` precedent from the B3 sweep.
 * The row itself survives if it still sells somewhere.
 *
 * A row is quarantined (`needsReview` + `quarantinedAt` + a review flag) ONLY
 * when Best Buy was the last retailer on it. A row with a live Amazon or Newegg
 * deal is a working row that happens to have lost one link, and hiding it would
 * cost a product to fix a link.
 *
 * Nothing is ever un-quarantined here: a row already carrying `needsReview`
 * keeps it, whatever its deals look like.
 *
 * ── THE SPLIT, MEASURED RATHER THAN REMEMBERED ───────────────────────────────
 * Against the 2026-08-17 audit and the catalog as it stands on 2026-08-18:
 *
 *   483  dead Best Buy rows, every one still carrying its Best Buy deal
 *   124  already quarantined for other reasons — left exactly as they are
 *   359  live rows to act on
 *    53   of those have no other retailer at all  -> quarantined here
 *   306   keep a working Amazon or Newegg deal    -> row survives, link removed
 *
 * (57 of the 483 have no peer at all; 4 of those were already quarantined,
 * which is why 53 rather than 57 are quarantined by this run.)
 *
 * "Has another retailer" and "has a WORKING another retailer" are different
 * counts, because the peer audits are stricter than the peer deals. Of the 306
 * survivors, 5 have peers whose own audit does not call them alive
 * (amazon-asin-identity-audit.json: dead-asin / no-offer; the Newegg dead-sku
 * audit's per-deal status). `--strict-peers` treats those as orphans too,
 * quarantining 58.
 *
 * The default is the loose rule on purpose: the Best Buy audit is first-hand
 * evidence about the row being written, while a peer verdict is second-hand and
 * older, and quarantining on it hides a product on someone else's measurement.
 * The 5 are named in the report and on the console either way, so the stricter
 * call can be made deliberately rather than by default.
 *
 * ── HOW IT WRITES ────────────────────────────────────────────────────────────
 * Through scripts/write-catalog.cjs, the sanctioned path: it writes a temp
 * literal, round-trips it, snapshots, promotes atomically, re-splits the
 * per-category chunks and asserts the count survived. This run touches fields
 * only — no row is added or removed — so the count must come back identical,
 * and the size brakes are left at their defaults precisely so a bug that lost
 * rows would hit them.
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
if (!audit?.deadIds?.length) {
  console.error(`ERROR: no dead-sku report at ${REPORT_IN}.`);
  console.error('Download the artifact from the "Best Buy dead-SKU audit (read-only)" run, or pass --report=<path>.');
  process.exit(1);
}
const deadIds = new Set(audit.deadIds);

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

/** Retailers other than Best Buy that this row can still sell through. */
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

const purged = [];
const quarantined = [];
const keptOnDeadPeersOnly = [];
const alreadyQuarantined = [];
const notInCatalog = [];

for (const id of deadIds) {
  const p = parts.find((x) => x.id === id);
  if (!p) { notInCatalog.push(id); continue; }
  if (!p.deals?.bestbuy) continue; // already gone — nothing to purge

  const peers = peersOf(p);
  const livePeers = peers.filter((x) => x.live);
  const usable = STRICT_PEERS ? livePeers : peers;

  const row = {
    id, cat: p.c, name: String(p.n || '').slice(0, 70),
    bbPrice: p.deals.bestbuy.price ?? null,
    sku: (/prodsku=(\d+)/.exec(p.deals.bestbuy.url || '') || [])[1] ?? null,
    peers: peers.map((x) => `${x.key}${x.live ? '' : ' (audit: not alive)'} $${x.price}`),
  };
  purged.push(row);

  if (p.needsReview) alreadyQuarantined.push(row);
  else if (!usable.length) quarantined.push(row);
  else if (!livePeers.length) keptOnDeadPeersOnly.push(row);

  if (APPLY) {
    delete p.deals.bestbuy;
    p.bestbuyRemovedDead = today;
    if (!usable.length && !p.needsReview) {
      p.needsReview = true;
      p.quarantinedAt = today;
      p.reviewFlags = [...new Set([...(p.reviewFlags || []), 'bestbuy:dead-sku-orphan'])];
    }
  }
}

const pct = (n) => `${((n / deadIds.size) * 100).toFixed(1)}%`;
console.log('='.repeat(96));
console.log(`BEST BUY DEAD-LINK PURGE — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
console.log(`report ${path.relative(ROOT, REPORT_IN)} audited ${audit.auditedAt} | peers: ${STRICT_PEERS ? 'must be audit-alive' : 'priced deal is enough'}`);
console.log('='.repeat(96));
console.log(`  dead rows in the report ............ ${deadIds.size}`);
console.log(`  found in the catalog, bb deal live . ${purged.length}`);
console.log(`  not in the catalog (already gone) .. ${notInCatalog.length}`);
console.log(`  -> Best Buy deal removed ........... ${purged.length}`);
console.log(`  -> quarantined (no retailer left) .. ${quarantined.length}  (${pct(quarantined.length)})`);
console.log(`  -> already quarantined, untouched .. ${alreadyQuarantined.length}`);
console.log(`  kept, but every peer is audit-dead . ${keptOnDeadPeersOnly.length}  <- --strict-peers would quarantine these too`);

const show = (label, rows, n = 12) => {
  if (!rows.length) return;
  console.log(`\n${label}`);
  for (const r of rows.slice(0, n)) console.log(`  ${String(r.id).padEnd(8)} ${r.cat.padEnd(12)} ${r.name.slice(0, 46).padEnd(46)} ${r.peers.join(', ') || '(no other retailer)'}`);
  if (rows.length > n) console.log(`  … and ${rows.length - n} more (full list in the report)`);
};
show('QUARANTINED — Best Buy was the last retailer:', quarantined);
show('KEPT ON A PEER ITS OWN AUDIT CALLS DEAD:', keptOnDeadPeersOnly);

mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
const out = path.join(ROOT, 'verify-reports', `bestbuy-dead-link-purge-${today}.json`);
writeFileSync(out, JSON.stringify({
  apply: APPLY, strictPeers: STRICT_PEERS, ranAt: new Date().toISOString(),
  sourceReport: path.relative(ROOT, REPORT_IN), sourceAuditedAt: audit.auditedAt,
  counts: {
    dead: deadIds.size, purged: purged.length, quarantined: quarantined.length,
    alreadyQuarantined: alreadyQuarantined.length, keptOnDeadPeersOnly: keptOnDeadPeersOnly.length,
    notInCatalog: notInCatalog.length,
  },
  purged, quarantined, keptOnDeadPeersOnly, alreadyQuarantined, notInCatalog,
}, null, 2));
console.log(`\nReport: ${path.relative(ROOT, out)}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to remove these Best Buy deals.');
  process.exit(0);
}

await writeCatalog(parts, {
  loadedCount,
  reason: `purge ${purged.length} dead Best Buy links, quarantine ${quarantined.length} orphans`,
});
console.log('Done.');
