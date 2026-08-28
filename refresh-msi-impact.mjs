#!/usr/bin/env node
/**
 * refresh-msi-impact.mjs — re-price and re-stock every MSI deal from the MSI
 * catalog feed on Impact, once a day.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node refresh-msi-impact.mjs                      # report, writes nothing
 *   node refresh-msi-impact.mjs --apply              # refresh + write the catalog
 *   node refresh-msi-impact.mjs --from-feed=<json>   # replay a saved feed, no API
 *   node refresh-msi-impact.mjs --n 40               # smoke run over the first 40 rows
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 * deals.msi was written once, by ingest-msi-impact-v2.cjs, on 2026-05-26/27
 * (92f8ce9241f, 322f85bfff5). Nothing has re-read it since: there is no MSI
 * workflow, no MSI cron, and not one of the 157 rows carries a priceConfirmedAt.
 * As of 2026-08-28 those prices are 93 days old.
 *
 * Stale would be tolerable if the numbers only sat there. They do not.
 * bestPrice() takes the MINIMUM across priced retailers and the BEST badge is
 * POSITIONAL — index 0 of a price-sorted list wears it. A price frozen in May
 * undercuts three retailers that ARE refreshed, so it wins the sort by being
 * old rather than by being cheap. On 49 product pages today MSI wears BEST
 * against a live competitor and sets the headline price.
 *
 * The freshness gate's own commit message (66aa31ea137) named this case:
 * "unknown-retailer is the class that prevents a repeat: a retailer added to
 * parts.js with no cadence entry fails the gate. That is exactly how deals.msi
 * came to sit unrefreshed, unstamped, for four months." This is the updater
 * that gate was describing the absence of.
 *
 * ── THIS IS A REFRESHER, NOT AN INGEST ───────────────────────────────────────
 * It re-reads rows that ALREADY carry deals.msi and it never runs the matcher.
 * ingest-msi-impact-v2.cjs decides WHICH catalog row an MSI item belongs to —
 * UPC/MPN/name tiers over all 6,938 products — and re-running that to refresh a
 * price would put every existing link back up for re-decision on a schedule.
 * A daily job must not be able to relink the catalog. It can only move the
 * price and the stock flag on a row whose identity was already settled.
 *
 * ── THE JOIN KEY ─────────────────────────────────────────────────────────────
 * Every stored MSI url is an Impact deep link carrying ?prodsku=<n>, and on the
 * current catalog all 157 are present and all 157 are distinct. That is the
 * join: parse prodsku from the stored url, look it up in the feed. Same shape
 * as the Best Buy refresher's skuOf(deal).
 *
 * Which FEED field prodsku corresponds to is not documented in this repo, and
 * the ingest never stored it, so the first run PROBES: it tries the candidate
 * id fields in order and adopts whichever one actually joins the most rows,
 * reporting the result in the summary. This is deliberately the same answer
 * refresh-bestbuy-prices.mjs gives to its undocumented bulk-query 400s — probe,
 * adopt, and write down what answered so the next run does not have to guess.
 *
 * Exact url equality is kept as the last resort, because the feed item's Url is
 * the very string ingest stored. It is last rather than first because tracking
 * parameters are the part of a deep link most likely to be rotated upstream.
 *
 * Once a row joins, the resolved id is PINNED onto the deal as `itemId`, so
 * every run after the first is a direct lookup and the probe becomes a no-op.
 * Best Buy pins `d.sku` for the same reason.
 *
 * ── A FEED THAT STOPS MOVING MUST NOT LOOK FRESH ─────────────────────────────
 * This is the failure this whole job exists to prevent, so it does not get to
 * reintroduce it one layer up. record-price-snapshot.js appended a dated point
 * every day for retailers no job had contacted, which is how a 4-month Best Buy
 * freeze read as healthy: the signal was manufactured by the reader rather than
 * observed from the source.
 *
 * Stamping priceConfirmedAt=today on a CurrentPrice that Impact has been
 * serving unchanged since May would be the identical mistake. "We asked" is not
 * "it is current" when the thing being asked may itself be frozen.
 *
 * So the run records movement as an OBSERVATION — totals.priceChanged and
 * totals.stockChanged — and the workflow asserts on it. A run that joins every
 * row and moves nothing is reported, not celebrated, and the watcher goes red
 * when that persists. See NO_MOVEMENT_IS_SUSPICIOUS below.
 *
 * If the feed does carry an upstream per-item timestamp, this job will find it:
 * probeUpstreamStamp() records which of the candidate date fields are present
 * on the returned items and what they contain. Until one is confirmed, no row
 * is held for upstream staleness — a hold rule cannot be built on a field this
 * repo has not yet seen. The absence is reported rather than assumed either way.
 *
 * ── WHAT HOLDS A PRICE ───────────────────────────────────────────────────────
 *   identity      the feed item's name no longer describes the catalog row.
 *                 Reuses nameTokenOverlap() from ingest-msi-impact-v2.cjs — the
 *                 same safety check the ingest applies, imported rather than
 *                 re-implemented, so the two cannot drift apart.
 *   sanity        the new price classifies as an outlier against the SAME
 *                 product's Amazon/Best Buy/Newegg prices (price-sanity.js).
 *                 --no-sanity-gate disables it deliberately; there is no way to
 *                 disable it by accident.
 *   unjoined      the row's prodsku is not in the feed at all. Nothing is
 *                 written but the stock flag, which goes false: an item MSI has
 *                 dropped from its own catalog is not one you can buy.
 *
 * Every branch that holds a price still writes STOCK. Those are two facts, not
 * one, and the Best Buy audit measured 24 of 29 availability flips arriving
 * with no price event at all.
 *
 * Held rows are NOT stamped priceConfirmedAt, so the freshness gate keeps
 * seeing the true age of the last confirmed price.
 */

import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { classifyDeal, effectivePrice, CLASS, PRIMARY_RETAILERS } from './price-sanity.js';

const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');
// The identity check lives in the ingest and is exported for exactly this reuse
// ("Exported for reuse ... so the safety-check logic lives in exactly one
// place"). Requiring the module does NOT run it: its credential check is
// guarded by `require.main === module`.
const { normName, nameTokenOverlap, extractSuffix } = require('./ingest-msi-impact-v2.cjs');

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const NO_SANITY = argv.includes('--no-sanity-gate');
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const N = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) || 0 : 0;
const FROM_FEED = argOf('from-feed', null);

// Minimum share of the feed item's name tokens that must still appear in the
// catalog row's name. Same 0.4 the ingest requires for a UPC-tier match; a
// refresh has no business being more permissive about identity than the ingest
// that created the link.
const MIN_OVERLAP = Number(argOf('min-overlap', '0.4'));

const ROOT = process.cwd();
const SUMMARY_OUT = argOf('report', path.join(ROOT, 'catalog-build', 'msi-refresh-summary.json'));

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;

const CATALOG_ID = 16410;          // same catalog the ingest read
const PAGE_SIZE = 500;
const MAX_PAGES = 20;              // 10,000 items; the ingest's own safety stop
const PACE_MS = 250;
const TRIES = 3;

// ── Circuit breakers ─────────────────────────────────────────────────────────
// Same posture as the Best Buy refresher: a run that looks structurally wrong
// writes NOTHING, rather than writing a smaller amount of wrongness.
const MAX_UNJOINED_RATE = Number(argOf('max-unjoined-rate', '0.25'));
const MAX_MISMATCH_RATE = Number(argOf('max-mismatch-rate', '0.05'));
const MAX_CLIFF_RATE = Number(argOf('max-cliff-rate', '0.15'));
const CLIFF = 0.50;

// A feed that returns every row unchanged is the signature this job exists to
// catch. It is NOT a breaker — refusing to write on a quiet day would also
// refuse to write the day the feed comes back — but it is recorded on every run
// so the watcher can go red on a RUN OF them. One still day is normal; a
// fortnight of them means Impact is serving a frozen catalog and MSI prices are
// stale again, silently, exactly as they are today.
const NO_MOVEMENT_IS_SUSPICIOUS = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = '='.repeat(96);
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');
const today = new Date().toISOString().slice(0, 10);

// ── Catalog ──────────────────────────────────────────────────────────────────
// The join key, read off the stored deep link. Pinned `itemId` wins when a
// previous run resolved one; prodsku is the bootstrap for rows that have not
// been refreshed yet.
const prodskuOf = (deal) => {
  const raw = deal && (deal.url || deal.linkurl);
  if (!raw) return null;
  try { return new URL(raw).searchParams.get('prodsku') || null; } catch { return null; }
};

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
const loadedCount = parts.length;

const rows = [];
let noKey = 0;
for (const p of parts) {
  const deal = p.deals && p.deals.msi;
  if (!deal || typeof deal !== 'object') continue;
  const prodsku = prodskuOf(deal);
  const itemId = deal.itemId != null ? String(deal.itemId) : null;
  if (!prodsku && !itemId) { noKey++; continue; }
  rows.push({
    id: p.id, cat: p.c, name: p.n, product: p, deal,
    prodsku, itemId,
    storedUrl: deal.url || deal.linkurl || null,
    storedPrice: effectivePrice(deal),
    storedStock: deal.inStock !== false,
    // Peers are the three PRIMARY retailers. MSI is deliberately not among them
    // in price-sanity.js, so a price can never referee itself.
    peers: PRIMARY_RETAILERS
      .map((k) => effectivePrice((p.deals || {})[k]))
      .filter((n) => Number.isFinite(n) && n > 0),
    pr: p.pr, msrp: p.msrp,
  });
}
const targets = N ? rows.slice(0, N) : rows;

console.log(`\n${bar}\nMSI refresh — ${APPLY ? 'APPLY' : 'dry run'}`);
console.log(`${bar}`);
console.log(`  catalog rows with deals.msi ..... ${rows.length}${noKey ? `  (+${noKey} with no join key — reported, never written)` : ''}`);
console.log(`  in this run ..................... ${targets.length}${N ? `  (--n ${N})` : ''}`);

// ── Fetch ────────────────────────────────────────────────────────────────────
const BASE = `https://api.impact.com/Mediapartners/${SID}`;
const AUTH = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const redact = (s) => String(s).split(SID || ' ').join('<sid>');

async function api(pathStr, params = {}) {
  const url = new URL(BASE + pathStr);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let lastErr = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
      if (res.ok) return await res.json();
      const body = (await res.text()).slice(0, 400);
      // 401/403 are answers, not blips. Retrying a credential failure just
      // spends three times as long arriving at the same place.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Impact ${res.status} — credentials rejected. ${redact(body)}`);
      }
      lastErr = new Error(`Impact ${res.status}: ${redact(body)}`);
    } catch (e) {
      lastErr = e;
      if (/credentials rejected/.test(e.message)) throw e;
    }
    if (attempt < TRIES) await sleep(PACE_MS * attempt * 4);
  }
  throw lastErr;
}

async function fetchFeed() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await api(`/Catalogs/${CATALOG_ID}/Items`, { Page: page, PageSize: PAGE_SIZE });
    const items = data?.Items || [];
    all.push(...items);
    process.stdout.write(`\r  feed: page ${page}, ${all.length} items`);
    if (items.length < PAGE_SIZE) break;
    await sleep(PACE_MS);
  }
  console.log('');
  return all;
}

let feed;
if (FROM_FEED) {
  feed = JSON.parse(readFileSync(FROM_FEED, 'utf8'));
  if (!Array.isArray(feed)) feed = feed.Items || feed.items || [];
  console.log(`  feed replayed from ${path.relative(ROOT, path.resolve(FROM_FEED))}: ${feed.length} items`);
} else {
  if (!SID || !TOKEN) {
    console.error('\n  ✗ IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN are not set.');
    console.error('    This job cannot read the MSI catalog without them. It writes nothing.\n');
    process.exit(2);
  }
  feed = await fetchFeed();
}
if (!feed.length) {
  console.error('\n  ✗ The feed returned 0 items. Writing nothing — an empty feed is an outage,');
  console.error('    not a catalog of zero products.\n');
  process.exit(1);
}

// ── Which field is prodsku? Probe, adopt, write it down. ─────────────────────
// Candidates in the order Impact is most likely to be putting into the deep
// link. Whichever joins the most rows wins; the full scoreboard goes in the
// summary so the next person does not repeat the probe.
const ID_FIELDS = ['Sku', 'CatalogItemId', 'ItemId', 'Id', 'ManufacturerSku', 'MerchantSku'];
const keyOf = (row) => row.itemId || row.prodsku;
const wanted = new Set(targets.map(keyOf).filter(Boolean));

const idProbe = ID_FIELDS.map((f) => {
  const present = feed.filter((it) => it[f] != null).length;
  const hits = new Set(feed.map((it) => (it[f] == null ? null : String(it[f]))).filter((v) => v && wanted.has(v))).size;
  return { field: f, present, joins: hits };
}).sort((a, b) => b.joins - a.joins);

const ID_FIELD = idProbe[0] && idProbe[0].joins > 0 ? idProbe[0].field : null;

const byId = new Map();
if (ID_FIELD) for (const it of feed) { const v = it[ID_FIELD]; if (v != null) byId.set(String(v), it); }
// Last resort: the feed's own Url, which is the string the ingest stored.
const byUrl = new Map();
for (const it of feed) if (it.Url) byUrl.set(String(it.Url), it);

console.log(`  join field ..................... ${ID_FIELD || 'NONE — falling back to url equality'}`);
for (const p of idProbe) console.log(`      ${String(p.field).padEnd(16)} present ${String(p.present).padEnd(6)} joins ${p.joins}`);

// ── Does the feed carry an upstream freshness stamp? ─────────────────────────
// Reported, never acted on until one is confirmed to exist. A hold rule built
// on a field this repo has never seen would be a guess wearing a gate's clothes.
const STAMP_FIELDS = ['LastUpdated', 'ModifiedDate', 'LastModified', 'DateUpdated', 'UpdatedAt', 'CurrentPriceDate'];
const stampProbe = STAMP_FIELDS
  .map((f) => ({ field: f, present: feed.filter((it) => it[f] != null).length, sample: (feed.find((it) => it[f] != null) || {})[f] || null }))
  .filter((p) => p.present > 0);

// ── Classify ─────────────────────────────────────────────────────────────────
const buckets = { ok: [], nameMismatch: [], sanityHeld: [], unjoined: [] };
let priceChanged = 0, stockChanged = 0, comparable = 0, cliffs = 0;

const stockOf = (it) => String(it.StockAvailability ?? '').trim().toLowerCase() === 'instock';
const priceOfItem = (it) => {
  const n = parseFloat(it.CurrentPrice);
  return Number.isFinite(n) && n > 0 ? n : null;
};

for (const r of targets) {
  const k = keyOf(r);
  const viaId = ID_FIELD && k ? byId.get(k) : null;
  const it = viaId || (r.storedUrl ? byUrl.get(r.storedUrl) : null) || null;
  r.joinVia = viaId ? ID_FIELD : (it ? 'url' : null);

  if (!it) {
    // MSI no longer lists it. Not an error, and not a licence to guess a price.
    buckets.unjoined.push({ ...bare(r), reason: 'not-in-feed' });
    if (r.storedStock) stockChanged++;
    continue;
  }

  r.item = it;
  r.resolvedId = ID_FIELD && it[ID_FIELD] != null ? String(it[ID_FIELD]) : null;
  // A row that only joined on url equality still gets its id pinned when the
  // feed carries one — that is precisely the row that most needs a stable key,
  // since the url it matched on is the part upstream is free to rotate.
  const newPrice = priceOfItem(it);
  const newStock = stockOf(it);
  r.newStock = newStock;
  if (newStock !== r.storedStock) stockChanged++;

  // ── Identity, ahead of every price question ────────────────────────────────
  const overlap = nameTokenOverlap(it.Name, r.name);
  const feedSuffix = extractSuffix(it.Name);
  const rowSuffix = extractSuffix(r.name);
  const suffixOK = !feedSuffix || !rowSuffix || feedSuffix === rowSuffix;
  if (!(overlap >= MIN_OVERLAP && suffixOK)) {
    buckets.nameMismatch.push({
      ...bare(r), newStock,
      overlap: Number(overlap.toFixed(2)),
      feedName: it.Name, reason: !suffixOK ? 'suffix-mismatch' : 'low-name-overlap',
      unconfirmedReason: `msi-feed-item-names-a-different-product`,
    });
    continue;
  }

  if (newPrice == null) {
    buckets.nameMismatch.push({
      ...bare(r), newStock, overlap: Number(overlap.toFixed(2)), feedName: it.Name,
      reason: 'no-price-in-feed', unconfirmedReason: 'msi-feed-carried-no-current-price',
    });
    continue;
  }

  // ── Sanity, against this product's OTHER retailers ─────────────────────────
  const verdict = classifyDeal(newPrice, r.peers, r.pr, r.msrp);
  const suspect = verdict.cls !== CLASS.OK && verdict.cls !== CLASS.UNVERIFIED;
  if (r.storedPrice != null && newPrice != null) {
    comparable++;
    if (Math.abs(newPrice - r.storedPrice) / r.storedPrice >= CLIFF) cliffs++;
  }
  if (!NO_SANITY && suspect) {
    buckets.sanityHeld.push({
      ...bare(r), newStock, newPrice, verdict: verdict.cls, ref: verdict.ref,
      deviation: verdict.deviation == null ? null : Number(verdict.deviation.toFixed(3)),
      basis: verdict.basis,
      unconfirmedReason: `msi-price-${String(verdict.cls).toLowerCase()}-vs-${verdict.basis}`,
    });
    continue;
  }

  if (r.storedPrice == null || Math.abs(newPrice - r.storedPrice) >= 0.005) priceChanged++;
  buckets.ok.push({
    ...bare(r), newStock, newPrice,
    delta: r.storedPrice == null ? null : Number((newPrice - r.storedPrice).toFixed(2)),
    overlap: Number(overlap.toFixed(2)),
    verdict: verdict.cls, basis: verdict.basis,
    // An OK from classifyDeal with no peers is not corroboration, it is the
    // absence of a contradiction. Recorded so the summary can tell them apart.
    unrefereed: r.peers.length === 0,
  });
}

// Every bucket row is built from this, so anything the WRITE needs must be in
// here. resolvedId is the one that matters: without it applyRow() pins no
// itemId, the probe never becomes a no-op, and run 2 rediscovers the join field
// from scratch every night.
function bare(r) {
  return {
    id: r.id, cat: r.cat, name: String(r.name || '').slice(0, 70),
    prodsku: r.prodsku, itemId: r.itemId,
    resolvedId: r.resolvedId || null,
    joinVia: r.joinVia || null,
    storedPrice: r.storedPrice, storedStock: r.storedStock,
  };
}

// ── Circuit breakers ─────────────────────────────────────────────────────────
const n = (b) => buckets[b].length;
const joinedVia = (how) => [...buckets.ok, ...buckets.sanityHeld, ...buckets.nameMismatch].filter((r) => r.joinVia === how).length;
const unjoinedRate = targets.length ? n('unjoined') / targets.length : 0;
const mismatchRate = targets.length ? n('nameMismatch') / targets.length : 0;
const cliffRate = comparable ? cliffs / comparable : 0;
const breakers = [];
if (unjoinedRate > MAX_UNJOINED_RATE) breakers.push(`${(unjoinedRate * 100).toFixed(1)}% of rows did not join the feed (max ${(MAX_UNJOINED_RATE * 100).toFixed(0)}%) — the feed or the join key changed shape, this is not ${n('unjoined')} discontinued products`);
if (mismatchRate > MAX_MISMATCH_RATE) breakers.push(`${(mismatchRate * 100).toFixed(1)}% of joined rows name a different product (max ${(MAX_MISMATCH_RATE * 100).toFixed(0)}%) — the join key is mapping to the wrong items`);
if (cliffRate > MAX_CLIFF_RATE) breakers.push(`${(cliffRate * 100).toFixed(1)}% of comparable rows would move >=${CLIFF * 100}% (max ${(MAX_CLIFF_RATE * 100).toFixed(0)}%) — a catalog-wide reprice is not a daily event`);

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${bar}`);
console.log(`  price + stock refreshed ......... ${n('ok')}  (${pct(n('ok'), targets.length)})`);
console.log(`      of which price moved ........ ${priceChanged}`);
console.log(`      of which unrefereed ......... ${buckets.ok.filter((r) => r.unrefereed).length}  (no peer retailer checked the price)`);
console.log(`  stock only — sanity hold ........ ${n('sanityHeld')}`);
console.log(`  stock only — identity hold ...... ${n('nameMismatch')}`);
console.log(`  dropped from the MSI feed ....... ${n('unjoined')}  (inStock:false, price untouched)`);
console.log(`  in-stock flips .................. ${stockChanged}`);
console.log(`  comparable rows ................. ${comparable}, of which ${cliffs} move >=${CLIFF * 100}%`);
if (stampProbe.length) {
  console.log(`  upstream freshness stamp ........ ${stampProbe.map((s) => `${s.field} (${s.present})`).join(', ')}`);
} else {
  console.log(`  upstream freshness stamp ........ NONE of ${STAMP_FIELDS.join('/')} present in the feed`);
}

const show = (label, list, cols, limit = 15) => {
  if (!list.length) return;
  console.log(`\n  ${label} (${list.length}${list.length > limit ? `, first ${limit}` : ''})`);
  for (const r of list.slice(0, limit)) console.log('      ' + cols(r));
};
show('price moved', buckets.ok.filter((r) => r.delta), (r) => `${String(r.cat).padEnd(12)} ${String(r.id).padEnd(7)} $${r.storedPrice} → $${r.newPrice}  (${r.delta > 0 ? '+' : ''}${r.delta})`);
show('HELD — price looks wrong next to this product\'s other retailers', buckets.sanityHeld, (r) => `${String(r.cat).padEnd(12)} ${String(r.id).padEnd(7)} $${r.storedPrice} → $${r.newPrice} REJECTED  ${r.verdict} vs ${r.basis} ref $${r.ref}`);
show('HELD — the feed item no longer names this product', buckets.nameMismatch, (r) => `${String(r.cat).padEnd(12)} ${String(r.id).padEnd(7)} overlap ${r.overlap}  feed: ${String(r.feedName || '').slice(0, 50)}`);
show('dropped from the MSI feed', buckets.unjoined, (r) => `${String(r.cat).padEnd(12)} ${String(r.id).padEnd(7)} prodsku ${r.prodsku}  ${r.name}`);

if (breakers.length) {
  console.error(`\n  ✗ CIRCUIT BREAKER — writing nothing:`);
  for (const b of breakers) console.error(`      ${b}`);
}

// ── The write ────────────────────────────────────────────────────────────────
// After the report, so a dry run and an apply run print identical analysis and
// the only difference is whether the catalog moved.
let written = 0;
const rowById = new Map(targets.map((t) => [t.id, t]));
function applyRow(r, { price, stock, confirm, unconfirmedReason, resolvedId, moved }) {
  const t = rowById.get(r.id);
  if (!t) return;
  const d = t.deal;
  // Pin the resolved id so run 2 onward is a direct lookup, not a probe.
  if (resolvedId) d.itemId = resolvedId;
  if (stock !== undefined) d.inStock = stock;
  if (price != null) {
    d.price = price;
    // MSI selling an MSI product is first-party by construction.
    d.priceSource = '1p';
  }
  if (confirm) {
    d.priceConfidence = 'confirmed';
    d.priceConfirmedAt = today;
    delete d.priceUnconfirmedReason;
  }
  // ── The stamp that cannot be manufactured ──────────────────────────────────
  // priceConfirmedAt advances every night this job runs, whether or not the
  // feed said anything new — so it proves we ASKED, never that the answer was
  // current. That is precisely the gap record-price-snapshot.js fell into.
  //
  // priceLastMovedAt advances only when a stored number actually changed. It
  // cannot be produced by re-reading a frozen feed, so "days since any MSI
  // price moved" is an observation about MSI rather than about our own cron.
  // It lives on the deal, in the catalog, which is committed — unlike
  // catalog-build/, which is gitignored and therefore cannot carry state from
  // one Actions run to the next.
  if (moved) d.priceLastMovedAt = today;
  if (!confirm) {
    d.priceConfidence = 'unconfirmed';
    d.priceUnconfirmedReason = unconfirmedReason;
    // priceConfirmedAt deliberately untouched — the freshness gate must keep
    // seeing the real age of the last CONFIRMED price.
  }
  written++;
}

if (APPLY && !breakers.length) {
  for (const r of buckets.ok) applyRow(r, { price: r.newPrice, stock: r.newStock, confirm: true, resolvedId: r.resolvedId, moved: r.delta !== 0 && r.delta != null });
  for (const r of buckets.sanityHeld) applyRow(r, { stock: r.newStock, confirm: false, unconfirmedReason: r.unconfirmedReason, resolvedId: r.resolvedId });
  for (const r of buckets.nameMismatch) applyRow(r, { stock: r.newStock, confirm: false, unconfirmedReason: r.unconfirmedReason, resolvedId: r.resolvedId });
  // Dropped from the feed: stock goes false, price is left exactly as it was.
  // The row stops being sellable and stops being able to wear BEST; deciding
  // whether the LINK should survive is a separate question with its own job
  // (purge-dead-bestbuy-links.mjs is the precedent), not a side effect of a
  // price refresh.
  for (const r of buckets.unjoined) {
    const t = rowById.get(r.id);
    if (t) {
      t.deal.inStock = false;
      t.deal.priceConfidence = 'unconfirmed';
      t.deal.priceUnconfirmedReason = 'msi-dropped-item-from-catalog-feed';
      written++;
    }
  }
}

// ── How long has MSI itself been quiet? ──────────────────────────────────────
// Read off priceLastMovedAt across every MSI deal in the catalog — the stamp
// that only a real price change can advance. This is the number the workflow
// asserts on, and the reason a frozen Impact feed cannot masquerade as a
// healthy job: the run would still succeed, still join every row, still stamp
// priceConfirmedAt — and this would keep climbing until it goes red.
//
// 0 when no row carries the stamp yet. The first apply run establishes the
// baseline (it has 93 days of drift to move), so "no evidence of staleness" is
// the honest reading on run 1 rather than an instant false alarm.
const MS_DAY = 86400000;
const nowMs = Date.parse(today + 'T00:00:00Z');
let newestMove = null;
for (const p2 of parts) {
  const stamp = p2.deals && p2.deals.msi && p2.deals.msi.priceLastMovedAt;
  if (!stamp) continue;
  const t = Date.parse(stamp + 'T00:00:00Z');
  if (Number.isFinite(t) && (newestMove == null || t > newestMove)) newestMove = t;
}
const daysSinceAnyPriceMoved = newestMove == null ? 0 : Math.max(0, Math.round((nowMs - newestMove) / MS_DAY));

// ── Summary artifact ─────────────────────────────────────────────────────────
const movement = priceChanged + stockChanged;
const summary = {
  ranAt: new Date().toISOString(),
  apply: APPLY && !breakers.length,
  source: FROM_FEED ? { replayOf: path.relative(ROOT, path.resolve(FROM_FEED)) } : { api: 'impact-mediapartners', catalogId: CATALOG_ID },
  options: { sanityGate: !NO_SANITY, minOverlap: MIN_OVERLAP, limit: N || null },
  join: {
    field: ID_FIELD,
    probe: idProbe,
    joinedViaId: joinedVia(ID_FIELD),
    joinedViaUrl: joinedVia('url'),
    pinnedThisRun: [...buckets.ok, ...buckets.sanityHeld, ...buckets.nameMismatch].filter((r) => r.resolvedId && !r.itemId).length,
  },
  upstreamStamp: { candidates: STAMP_FIELDS, found: stampProbe },
  totals: {
    considered: targets.length,
    rowsWithoutKey: noKey,
    feedItems: feed.length,
    joined: targets.length - n('unjoined'),
    refreshed: n('ok'),
    priceChanged, stockChanged,
    movement,
    heldSanity: n('sanityHeld'),
    heldNameMismatch: n('nameMismatch'),
    unjoined: n('unjoined'),
    unrefereed: buckets.ok.filter((r) => r.unrefereed).length,
    comparable, cliffs,
    dealsWritten: written,
    // Watched by the workflow. See the block above for why this and not
    // priceConfirmedAt.
    daysSinceAnyPriceMoved,
  },
  // The observation the watcher reads. See NO_MOVEMENT_IS_SUSPICIOUS.
  movementObserved: movement > 0,
  breakers,
  refreshed: buckets.ok,
  heldSanity: buckets.sanityHeld,
  heldNameMismatch: buckets.nameMismatch,
  unjoined: buckets.unjoined,
};
mkdirSync(path.dirname(SUMMARY_OUT), { recursive: true });
writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2));
mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
writeFileSync(path.join(ROOT, 'verify-reports', `msi-refresh-${today}.json`), JSON.stringify(summary, null, 2));
console.log(`\n  Report: ${path.relative(ROOT, SUMMARY_OUT)}`);

console.log(`  days since any MSI price moved .. ${newestMove == null ? 'no stamp yet — this run establishes the baseline' : daysSinceAnyPriceMoved}`);

if (NO_MOVEMENT_IS_SUSPICIOUS && !movement && !breakers.length) {
  console.log('\n  ⚠ The feed joined but NOTHING moved — no price change, no stock flip.');
  console.log('    One still day is normal. A run of them means Impact is serving a frozen');
  console.log('    catalog, and stamping priceConfirmedAt on it would launder stale prices');
  console.log('    into fresh ones. msi-feed-watch judges the run of them.');
}

// ── Job summary ──────────────────────────────────────────────────────────────
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [];
  md.push(`## MSI refresh — ${APPLY && !breakers.length ? 'applied' : 'dry run'}`, '');
  md.push('| outcome | rows | share |', '|---|---:|---:|');
  md.push(`| price + stock refreshed | ${n('ok')} | ${pct(n('ok'), targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ price actually moved | ${priceChanged} | ${pct(priceChanged, targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ written **unrefereed** — no peer checked it | ${buckets.ok.filter((r) => r.unrefereed).length} | ${pct(buckets.ok.filter((r) => r.unrefereed).length, targets.length)} |`);
  md.push(`| stock only — a peer retailer contradicts the price | ${n('sanityHeld')} | ${pct(n('sanityHeld'), targets.length)} |`);
  md.push(`| stock only — the feed item names a different product | ${n('nameMismatch')} | ${pct(n('nameMismatch'), targets.length)} |`);
  md.push(`| dropped from the MSI feed — inStock:false only | ${n('unjoined')} | ${pct(n('unjoined'), targets.length)} |`);
  md.push('', `In-stock flips: **${stockChanged}**. Join field: \`${ID_FIELD || 'url-equality'}\`.`, '');
  if (!movement) md.push('> ⚠ Nothing moved this run. A run of still days means the feed is frozen.', '');
  if (!stampProbe.length) md.push(`> The feed carries no upstream freshness stamp (${STAMP_FIELDS.join(', ')} all absent), so no row can be held for upstream staleness the way Best Buy rows are.`, '');
  if (breakers.length) { md.push('### Circuit breakers tripped — nothing written', ''); for (const b of breakers) md.push(`- ${b}`); }
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'), { flag: 'a' });
}

if (breakers.length) process.exit(1);

if (APPLY) {
  await writeCatalog(parts, { loadedCount, reason: 'msi daily refresh' });
} else {
  console.log('  Dry run — the catalog was not written.\n');
}
