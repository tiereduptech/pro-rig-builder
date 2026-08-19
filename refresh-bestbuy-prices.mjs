#!/usr/bin/env node
/**
 * refresh-bestbuy-prices.mjs — re-price and re-stock every Best Buy deal from
 * Best Buy's own Developer API, once a day.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node refresh-bestbuy-prices.mjs                      # report, writes nothing
 *   node refresh-bestbuy-prices.mjs --apply              # refresh + write the catalog
 *   node refresh-bestbuy-prices.mjs --from-report=<json> # replay an audit artifact, no API
 *   node refresh-bestbuy-prices.mjs --n 200              # smoke run over the first 200 skus
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 * The 2026-08-19 audit measured what our stored Best Buy prices are worth: of
 * 1,040 rows, 603 disagree with the API's salePrice and 450 disagree by more
 * than 10%. The median row's price was last stamped by Best Buy 12.7 days ago;
 * 13.8% of rows carry a stamp older than 90 days. Nothing in the repo re-reads
 * a Best Buy price after ingest, so the catalog has been drifting since.
 *
 * The audit also settled the field question that blocked this: sku 6601910
 * showed salePrice 42.99 / regularPrice 52.99 / onSale true against a page
 * showing $42.99 with a $52.99 comp. `salePrice` is what a customer pays. The
 * API is not publishing comp value in that field, so it is safe to write.
 *
 * ── PRICE AND AVAILABILITY COME BACK IN ONE CALL ─────────────────────────────
 * `show=` asks for salePrice, regularPrice, onSale, active, orderable and
 * onlineAvailability together, so a row's price and its buyability are always
 * read from the same response — they can never describe two different moments.
 * `buyable` is computed exactly as bestbuy-dead-sku-audit.mjs computes it, so
 * the daily job and the audit cannot disagree about what "unbuyable" means.
 *
 * That they arrive together does not make them one fact. Measured across the
 * 32.3h between the two audits, of 29 rows that flipped buyability only 5 had
 * their priceUpdateDate move at all — 24 changed availability with no price
 * event whatsoever. Every branch below that holds a price still writes stock.
 *
 * ── THE ANCIENT ROWS ARE NOT REFRESHED INTO LOOKING CURRENT ──────────────────
 * 143 alive skus carry a priceUpdateDate older than 90 days; the oldest has not
 * been repriced in 1,961 days (5.4 years). Only 7.0% of them are onSale against
 * 60.5% of rows stamped in the last week — they are overwhelmingly discontinued
 * inventory Best Buy still serves a record for.
 *
 * Copying a five-year-old number into the catalog and stamping it
 * priceConfirmedAt=today would launder a dead price into a fresh one, and the
 * freshness gate would never see it again. So a stale row:
 *
 *    - keeps its stored price. No write.
 *    - gets its availability refreshed anyway (see above — different fact).
 *    - is NOT stamped priceConfirmedAt.
 *    - carries priceConfidence:'unconfirmed' + priceUnconfirmedReason, using
 *      drift-gate.js's existing vocabulary rather than a third enum value.
 *
 * The reason string embeds the UPSTREAM stamp date, not an age in days, so a
 * row Best Buy has not touched produces a byte-identical write every night
 * instead of churning the diff.
 *
 * Rows with no priceUpdateDate at all (4 today) take the same path. A missing
 * stamp is not evidence of freshness.
 *
 * ── WHAT ELSE HOLDS A PRICE ──────────────────────────────────────────────────
 * price-sanity.js was written to be "wired into the fetch/refresh paths at
 * Stage B (attach time + refresh time)" and names "Best Buy comp/list price ->
 * SUSPECT_HIGH" as one of its three target bugs. This is that wiring. A new
 * price that classifies as an outlier against the same product's other
 * retailers is held, not written, and reported. --no-sanity-gate disables it
 * deliberately; there is no way to disable it by accident.
 *
 * ── WHAT THIS SCRIPT DOES NOT DO ─────────────────────────────────────────────
 * It does not delete deals, quarantine rows, or purge dead skus. A sku the API
 * 404s gets inStock:false — that is an availability fact, self-healing, and the
 * same statement stamp-unbuyable-bestbuy.mjs makes — and is then reported and
 * left alone. Removing the deal and quarantining the orphan is
 * purge-dead-bestbuy-links.mjs's job, deliberately kept separate so a daily
 * automated job can never delete anything.
 *
 * ── CIRCUIT BREAKERS ─────────────────────────────────────────────────────────
 * Nothing is written if:
 *   - more than 5% of skus come back UNKNOWN (the same completeness gate the
 *     audit uses: a run with that many holes has not measured the catalog), or
 *   - more than 5% of comparable rows would move by 50% or more (a healthy day
 *     moves 4.6% of rows at all, and the largest real move measured was 44.6%;
 *     a cliff like that is the API publishing something else, not a sale).
 *
 * ── HOW IT WRITES ────────────────────────────────────────────────────────────
 * Through scripts/write-catalog.cjs, the sanctioned path, which does the
 * mandatory re-split. This run touches fields only — no row is added or removed
 * — so the size brakes are left at their defaults precisely so a bug that lost
 * rows would hit them.
 *
 * Rate limit: Best Buy documents 5 req/sec. This paces at ~3/sec.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { classifyDeal, effectivePrice, CLASS } from './price-sanity.js';

const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');

// ── Args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const NO_SANITY = argv.includes('--no-sanity-gate');
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const N = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) || 0 : 0;
const FROM_REPORT = argOf('from-report', null);
const STALE_DAYS = Number(argOf('stale-days', '90'));
const ROOT = process.cwd();
const SUMMARY_OUT = argOf('report', path.join(ROOT, 'catalog-build', 'bestbuy-refresh-summary.json'));

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY && !FROM_REPORT) {
  console.error('ERROR: BESTBUY_API_KEY required (or pass --from-report=<audit json> to replay one).');
  process.exit(1);
}

const CHUNK = 100;      // skus per bulk query; also the API's pageSize ceiling
const PACE_MS = 340;    // ~3 req/sec, under the documented 5/sec
const TRIES = 3;
const MAX_UNKNOWN_RATE = 0.05;
const CLIFF = 0.50;
// Share of comparable rows allowed to move by CLIFF or more before the run is
// treated as a broken feed rather than a busy day.
//
// This started at 5% and that was wrong, for a reason worth writing down: the
// 32.3h audit-to-audit drift (4.6% of rows moving AT ALL, largest single move
// 44.6%) measures ONE DAY of API-vs-API movement, but this job's first run
// measures MONTHS of stored-vs-API divergence. They are different quantities
// and the first is not a bound on the second. The catch-up dry run puts 45 of
// 1,040 rows (4.3%) over the cliff — it would have squeaked under a 5% ceiling
// and tripped on any slightly worse day, killing the run that fixes the drift.
//
// What this breaker is actually for is a SYSTEMIC break — the API starting to
// publish regularPrice in the salePrice field, a units error, a currency
// change. That shows up at tens of percent, not at four. 15% clears a genuine
// catch-up by 3x and still catches a systemic break by an order of magnitude.
// Steady-state daily runs should sit near zero; if they do not, the number to
// change is this one, deliberately, with the reason recorded.
const MAX_CLIFF_RATE = Number(argOf('max-cliff-rate', '0.15'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = '='.repeat(96);
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');
const today = new Date().toISOString().slice(0, 10);
const NOW = Date.now();

// ── Catalog ──────────────────────────────────────────────────────────────────
// Only a handful of bestbuy deals carry an explicit .sku; the rest keep it in
// the affiliate wrapper's prodsku= param. Same derivation as the audit.
const skuOf = (deal) => {
  if (deal.sku) return String(deal.sku);
  const m = String(deal.url || '').match(/[?&]prodsku=(\d+)/);
  return m ? m[1] : null;
};

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }
const loadedCount = parts.length;

const rows = [];
let noSku = 0;
for (const p of parts) {
  const d = p.deals && p.deals.bestbuy;
  if (!d || typeof d !== 'object') continue;
  const sku = skuOf(d);
  if (!sku) { noSku++; continue; }
  rows.push({ p, deal: d, sku, id: p.id, cat: p.c, name: String(p.n || ''), stored: effectivePrice(d) });
}
const targets = N ? rows.slice(0, N) : rows;
const skus = [...new Set(targets.map((r) => r.sku))];
console.log(`Catalog: ${parts.length} products, ${rows.length} Best Buy rows` +
  (noSku ? ` (${noSku} skipped — no recoverable sku)` : '') +
  ` → ${skus.length} distinct skus` + (N ? ` (--n ${N})` : ''));

// ── Fetch ────────────────────────────────────────────────────────────────────
// The five fields the refresh needs, in one request each. Ordering matches the
// audit's SHOW list so the two jobs read the same projection.
const SHOW = ['sku', 'name', 'salePrice', 'regularPrice', 'onSale', 'active',
  'orderable', 'onlineAvailability', 'priceUpdateDate'].join(',');

async function get(url, label) {
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { ok: true, json: await res.json(), status: res.status };
      if (res.status === 404) return { ok: false, status: 404, err: 'HTTP 404' };
      last = `HTTP ${res.status}${res.status === 403 ? ' (key rejected / quota)' : ''}`;
    } catch (e) { last = e.message; }
    if (attempt < TRIES) await sleep(1200 * attempt);
  }
  return { ok: false, status: null, err: last };
}

const pick = (p, via, extra = {}) => ({
  status: 'alive', via,
  name: p.name ?? null, salePrice: p.salePrice ?? null, regularPrice: p.regularPrice ?? null,
  onSale: p.onSale ?? null, active: p.active ?? null, orderable: p.orderable ?? null,
  onlineAvailability: p.onlineAvailability ?? null, priceUpdateDate: p.priceUpdateDate ?? null,
  ...extra,
});

/** sku -> {status:'alive'|'dead'|'unknown', ...fields}. Two strikes, as the audit. */
async function fetchFacts(skuList) {
  const bySku = new Map();
  const missed = [];
  let bulkErrors = 0;
  const bulkErrorSamples = [];

  const chunks = [];
  for (let i = 0; i < skuList.length; i += CHUNK) chunks.push(skuList.slice(i, i + CHUNK));
  console.log(`STRIKE 1 — bulk: ${chunks.length} request(s) covering ${skuList.length} skus`);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const url = `https://api.bestbuy.com/v1/products(sku%20in(${c.join(',')})).json` +
      `?apiKey=${KEY}&show=${SHOW}&pageSize=${CHUNK}&format=json`;
    const res = await get(url, `bulk ${i + 1}/${chunks.length}`);
    if (!res.ok) {
      // A failed bulk chunk is not evidence about its skus — they all fall
      // through to the individual pass, which is authoritative anyway.
      //
      // The error TEXT is captured because the audit only ever counted these.
      // Both 2026-08 audit runs had every single bulk chunk fail (11/11 and
      // 16/16) and resolved all 1,039 skus individually, and the artifact could
      // not say why. A run that pays 1,039 requests for work 11 could do should
      // be able to explain itself.
      bulkErrors++;
      if (bulkErrorSamples.length < 3) bulkErrorSamples.push(res.err);
      console.log(`[${i + 1}/${chunks.length}] BULK FAILED (${res.err}) — ${c.length} skus deferred`);
      missed.push(...c);
    } else {
      const found = new Map((res.json.products || []).map((p) => [String(p.sku), p]));
      for (const sku of c) {
        const p = found.get(sku);
        if (p) bySku.set(sku, pick(p, 'bulk'));
        else missed.push(sku);
      }
      console.log(`[${i + 1}/${chunks.length}] ${c.length} asked → ${found.size} returned | absent so far ${missed.length}`);
    }
    await sleep(PACE_MS);
  }

  console.log(`STRIKE 2 — individual GET for ${missed.length} sku(s)`);
  for (let i = 0; i < missed.length; i++) {
    const sku = missed[i];
    const url = `https://api.bestbuy.com/v1/products/${sku}.json?apiKey=${KEY}&show=all&format=json`;
    const res = await get(url, `sku ${sku}`);
    if (res.status === 404) bySku.set(sku, { status: 'dead', via: 'individual-404' });
    else if (res.ok) bySku.set(sku, pick(res.json || {}, 'individual',
      { bulkMissReason: res.json?.active === false ? 'active:false' : 'unclear' }));
    else bySku.set(sku, { status: 'unknown', via: 'individual', err: res.err });
    if ((i + 1) % 100 === 0 || i === missed.length - 1) {
      console.log(`  … ${i + 1}/${missed.length}`);
    }
    await sleep(PACE_MS);
  }
  return { bySku, bulkErrors, bulkErrorSamples };
}

/** Replay an audit artifact instead of spending quota. Review path, not production. */
function factsFromReport(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!j?.bySku) throw new Error(`${file} has no bySku map — not a dead-sku audit report`);
  const bySku = new Map(Object.entries(j.bySku));
  console.log(`Replaying ${path.relative(ROOT, file)} (audited ${j.auditedAt}) — ${bySku.size} skus, no API calls.`);
  return { bySku, bulkErrors: 0, bulkErrorSamples: [], auditedAt: j.auditedAt };
}

const { bySku, bulkErrors, bulkErrorSamples, auditedAt } =
  FROM_REPORT ? factsFromReport(path.resolve(FROM_REPORT)) : await fetchFacts(skus);

// ── Classify ─────────────────────────────────────────────────────────────────
// Identical to bestbuy-dead-sku-audit.mjs. The daily job and the audit must not
// hold two definitions of "unbuyable".
const buyableOf = (v) => v && v.status === 'alive'
  ? (v.active !== false && v.onlineAvailability !== false &&
     (v.orderable == null || /^(available|preorder|backorder)$/i.test(String(v.orderable))))
  : false;

const ageDays = (stamp) => {
  if (!stamp) return null;
  // Best Buy publishes priceUpdateDate without a zone; it is Central, but the
  // difference is hours against a 90-day threshold. Read as UTC and move on.
  const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : stamp + 'Z');
  return Number.isFinite(t) ? (NOW - t) / 86400000 : null;
};

// Peers = the other retailers' effective prices on the same product. Excludes
// bestbuy so the new price is never compared against itself.
const peersOf = (p) => Object.entries(p.deals || {})
  .filter(([k]) => k !== 'bestbuy')
  .map(([, d]) => effectivePrice(d))
  .filter((n) => Number.isFinite(n) && n > 0);

const OUT = {
  OK: 'ok',                 // price + stock written, stamped confirmed
  STALE: 'stale',           // upstream stamp is ancient — stock only, price held
  FLAGGED: 'flagged',       // sanity gate rejected the new price — stock only
  DEAD: 'dead',             // API 404 — stock only (inStock:false), never deleted here
  UNKNOWN: 'unknown',       // no verdict — nothing written at all
};

const buckets = { ok: [], stale: [], flagged: [], dead: [], unknown: [] };
const noted = [];   // written, but a list-price objection was recorded against them
let priceChanged = 0, stockChanged = 0, comparable = 0, cliffs = 0;

for (const r of targets) {
  const v = bySku.get(r.sku) || { status: 'unknown', err: 'not fetched' };

  if (v.status === 'unknown') {
    buckets.unknown.push({ ...bare(r), err: v.err || null });
    continue;
  }
  if (v.status === 'dead') {
    buckets.dead.push({ ...bare(r), wasInStock: r.deal.inStock !== false, willBeInStock: false });
    continue;
  }

  const buyable = buyableOf(v);
  const apiPrice = Number.isFinite(v.salePrice) && v.salePrice > 0 ? v.salePrice : null;
  const age = ageDays(v.priceUpdateDate);
  const stale = age == null || age > STALE_DAYS;

  const row = {
    ...bare(r),
    p_pr: r.p.pr ?? null,
    api: {
      salePrice: v.salePrice ?? null, regularPrice: v.regularPrice ?? null,
      onSale: v.onSale ?? null, active: v.active ?? null, orderable: v.orderable ?? null,
      onlineAvailability: v.onlineAvailability ?? null,
      priceUpdateDate: v.priceUpdateDate ?? null,
    },
    stampAgeDays: age == null ? null : Number(age.toFixed(1)),
    wasInStock: r.deal.inStock !== false,
    willBeInStock: buyable,
    delta: apiPrice != null && r.stored != null ? Number((apiPrice - r.stored).toFixed(2)) : null,
    deltaPct: apiPrice != null && r.stored > 0 ? Number(((apiPrice - r.stored) / r.stored).toFixed(4)) : null,
  };
  if (row.wasInStock !== row.willBeInStock) stockChanged++;
  if (row.deltaPct != null) { comparable++; if (Math.abs(row.deltaPct) >= CLIFF) cliffs++; }

  if (stale) {
    row.holdReason = v.priceUpdateDate
      ? `price stamp ${v.priceUpdateDate.slice(0, 10)} is ${Math.round(age)}d old (> ${STALE_DAYS}d)`
      : 'no priceUpdateDate — upstream age unknown';
    // Embeds the upstream DATE, not an age, so an untouched row writes an
    // identical value every night instead of churning the diff daily.
    row.unconfirmedReason = v.priceUpdateDate
      ? `bestbuy:price-stamp-${v.priceUpdateDate.slice(0, 10)}`
      : 'bestbuy:price-stamp-missing';
    buckets.stale.push(row);
    continue;
  }
  if (apiPrice == null) {
    row.holdReason = 'API returned no usable salePrice';
    row.unconfirmedReason = 'bestbuy:no-saleprice';
    buckets.stale.push(row);
    continue;
  }

  const cls = NO_SANITY
    ? { cls: CLASS.OK, ref: null, deviation: null, basis: 'gate-disabled' }
    : classifyDeal(apiPrice, peersOf(r.p), r.p.pr, r.p.msrp);
  row.sanity = cls;
  const objection = cls.cls !== CLASS.OK && cls.cls !== CLASS.UNVERIFIED;
  // ONLY AN INDEPENDENT RETAILER MAY VETO A PRICE.
  //
  // classifyDeal falls back to the product's own pr/msrp when no peer exists,
  // and for Best Buy that fallback is circular: `pr` equals the stored Best Buy
  // price on 690 of 1,040 rows (66.3%), so "price > pr * 1.4" degenerates into
  // "the price went up a lot" — measured against the very number this job is
  // here to correct. Every one of the 29 list-basis objections in the first dry
  // run had ZERO priced peers, 16 of them had pr identical to the stored Best
  // Buy price, and several had the new price landing exactly on the product's
  // own msrp (20415 -> $195.99, 20430 -> $399.99, 90183 -> $1599.99) — the
  // signature of an ingest-time sale that has since ended. Letting `pr` veto
  // would pin those rows to an expired sale price permanently: held every
  // night, never confirmed, with no path back.
  //
  // A peer verdict ('median' / 'pair') is different — another retailer is real,
  // independent evidence, and price-sanity.js's SUSPECT_LOW/HIGH/PAIR classes
  // exist for exactly that. Those still hold.
  //
  // The list-basis objection is not discarded, just demoted: it rides along on
  // the row and gets its own report section so the population stays visible.
  const peerBacked = cls.basis === 'median' || cls.basis === 'pair';
  if (objection && peerBacked) {
    row.holdReason = `sanity ${cls.cls} (${cls.basis}, ref $${cls.ref}, ${(cls.deviation * 100).toFixed(0)}%)`;
    row.unconfirmedReason = `bestbuy:sanity-${cls.cls.toLowerCase().replace(/_/g, '-')}`;
    buckets.flagged.push(row);
    continue;
  }
  if (objection) {
    row.listObjection = `${cls.cls} (${cls.basis}, ref $${cls.ref}, ${(cls.deviation * 100).toFixed(0)}%) — no peer to corroborate, written anyway`;
    noted.push(row);
  }

  if (row.delta !== 0 && row.delta != null) priceChanged++;
  buckets.ok.push(row);
}

function bare(r) {
  return { id: r.id, sku: r.sku, cat: r.cat, name: r.name.slice(0, 70), stored: r.stored };
}

// ── Circuit breakers ─────────────────────────────────────────────────────────
const unknownRate = targets.length ? buckets.unknown.length / targets.length : 0;
const cliffRate = comparable ? cliffs / comparable : 0;
const breakers = [];
if (unknownRate > MAX_UNKNOWN_RATE) {
  breakers.push(`${buckets.unknown.length} of ${targets.length} skus (${pct(buckets.unknown.length, targets.length)}) came back UNKNOWN, over the ${(MAX_UNKNOWN_RATE * 100).toFixed(0)}% ceiling — this run did not read the catalog.`);
}
if (cliffRate > MAX_CLIFF_RATE) {
  breakers.push(`${cliffs} of ${comparable} comparable rows (${pct(cliffs, comparable)}) would move by ${(CLIFF * 100).toFixed(0)}% or more, over the ${(MAX_CLIFF_RATE * 100).toFixed(0)}% ceiling — the API is publishing something other than today's selling price.`);
}

// ── Report ───────────────────────────────────────────────────────────────────
const n = (b) => buckets[b].length;
console.log('');
console.log(bar);
console.log(`BEST BUY DAILY REFRESH — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
console.log(`source ${FROM_REPORT ? `replay of ${path.relative(ROOT, path.resolve(FROM_REPORT))} (audited ${auditedAt})` : 'Best Buy Developer API'}` +
  ` | stale cutoff ${STALE_DAYS}d | sanity gate ${NO_SANITY ? 'DISABLED' : 'on'}`);
console.log(bar);
console.log(`  rows considered ..................... ${targets.length}`);
console.log(`  -> price + stock refreshed .......... ${n('ok')}  (${pct(n('ok'), targets.length)})`);
console.log(`       of which the price moved ....... ${priceChanged}`);
console.log(`  -> stock only, price HELD ........... ${n('stale') + n('flagged')}`);
console.log(`       upstream stamp ancient ......... ${n('stale')}`);
console.log(`       failed the sanity gate ......... ${n('flagged')}`);
console.log(`       (written, list-price objection noted) ${noted.length}`);
console.log(`  -> dead sku (404), stock only ....... ${n('dead')}  <- purge-dead-bestbuy-links.mjs owns removal`);
console.log(`  -> UNKNOWN, nothing written ......... ${n('unknown')}`);
console.log('');
console.log(`  in-stock flips (either direction) ... ${stockChanged}`);
console.log(`  price comparable rows ............... ${comparable}, of which >=${(CLIFF * 100).toFixed(0)}% move: ${cliffs} (${pct(cliffs, comparable)})`);
if (bulkErrors) {
  console.log('');
  console.log(`  bulk chunks that failed ............. ${bulkErrors}  (resolved individually)`);
  bulkErrorSamples.forEach((e) => console.log(`      ${e}`));
}

const show = (label, list, cols, limit = 15) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length}${list.length > limit ? `, first ${limit}` : ''})`);
  for (const r of list.slice(0, limit)) console.log('  ' + cols(r));
  if (list.length > limit) console.log(`  … and ${list.length - limit} more (full list in the report)`);
};

const moved = buckets.ok.filter((r) => r.delta !== 0 && r.delta != null)
  .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
show('PRICE CHANGES THAT WOULD BE WRITTEN — biggest first:', moved,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} $${String(r.stored).padEnd(9)} -> $${String(r.api.salePrice).padEnd(9)} ` +
         `${(r.deltaPct * 100 >= 0 ? '+' : '')}${(r.deltaPct * 100).toFixed(1)}%`.padEnd(9) +
         ` reg $${r.api.regularPrice ?? '—'} onSale ${r.api.onSale} | ${r.name.slice(0, 34)}`, 25);

show('HELD — upstream stamp too old to trust:', buckets.stale.sort((a, b) => (b.stampAgeDays ?? 1e9) - (a.stampAgeDays ?? 1e9)),
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} stored $${String(r.stored).padEnd(9)} api $${String(r.api?.salePrice ?? '—').padEnd(9)} ` +
         `${r.stampAgeDays == null ? 'no stamp' : Math.round(r.stampAgeDays) + 'd'}`.padEnd(10) + ` | ${r.holdReason}`);

show('HELD — the new price failed the cross-retailer sanity gate:', buckets.flagged,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} stored $${String(r.stored).padEnd(9)} api $${String(r.api.salePrice).padEnd(9)} | ${r.holdReason}`);

show('WRITTEN OVER A LIST-PRICE OBJECTION — no peer retailer to corroborate:', noted,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} stored $${String(r.stored).padEnd(9)} -> $${String(r.api.salePrice).padEnd(9)} pr $${String(r.p_pr ?? '—').padEnd(9)} | ${r.listObjection}`);

show('DEAD SKU — inStock:false only, deal left in place:', buckets.dead,
  (r) => `${String(r.id).padEnd(8)} sku ${r.sku.padEnd(9)} ${String(r.cat || '').padEnd(12)} $${String(r.stored ?? '—').padEnd(9)} | ${r.name.slice(0, 44)}`);

show('UNKNOWN — no verdict, nothing written:', buckets.unknown,
  (r) => `${String(r.id).padEnd(8)} sku ${r.sku.padEnd(9)} ${r.err || ''}`);

// ── The write ────────────────────────────────────────────────────────────────
// Applied AFTER the report, so a dry run and an apply run print the identical
// analysis and the only difference is whether the catalog moved.
let written = 0;
const byId = new Map(targets.map((t) => [t.id, t]));
function applyRow(r, { price, stock, confirm, unconfirmedReason }) {
  const t = byId.get(r.id);
  if (!t) return;
  const d = t.deal;
  d.sku = r.sku;                                  // pin it; the url param is not a field
  if (stock !== undefined) d.inStock = stock;
  if (price != null) {
    d.price = price;
    // Provenance is claimed only for a price this run actually wrote. A held
    // row keeps whatever wrote its price at ingest, and saying '1p' about it
    // would attribute someone else's number to Best Buy's API.
    d.priceSource = '1p';
  }
  if (confirm) {
    d.priceConfidence = 'confirmed';
    d.priceConfirmedAt = today;
    delete d.priceUnconfirmedReason;
  } else {
    d.priceConfidence = 'unconfirmed';
    d.priceUnconfirmedReason = unconfirmedReason;
    // priceConfirmedAt is deliberately NOT touched. Whatever it was stays: the
    // freshness gate should keep seeing the real age of the last CONFIRMED
    // price, and a held row has not produced one.
  }
  written++;
}

if (APPLY && !breakers.length) {
  for (const r of buckets.ok) applyRow(r, { price: r.api.salePrice, stock: r.willBeInStock, confirm: true });
  for (const r of buckets.stale) applyRow(r, { stock: r.willBeInStock, confirm: false, unconfirmedReason: r.unconfirmedReason });
  for (const r of buckets.flagged) applyRow(r, { stock: r.willBeInStock, confirm: false, unconfirmedReason: r.unconfirmedReason });
  for (const r of buckets.dead) {
    const t = byId.get(r.id);
    if (t) { t.deal.inStock = false; written++; }
  }
  // UNKNOWN: untouched, by construction. Never let an API blip change data.
}

// ── Summary artifact ─────────────────────────────────────────────────────────
const summary = {
  ranAt: new Date().toISOString(),
  apply: APPLY && !breakers.length,
  source: FROM_REPORT ? { replayOf: path.relative(ROOT, path.resolve(FROM_REPORT)), auditedAt } : { api: 'bestbuy-developer' },
  options: { staleDays: STALE_DAYS, sanityGate: !NO_SANITY, limit: N || null },
  totals: {
    considered: targets.length, rowsWithoutSku: noSku,
    refreshed: n('ok'), priceChanged, stockChanged,
    heldStale: n('stale'), heldFlagged: n('flagged'),
    dead: n('dead'), unknown: n('unknown'), notedListObjections: noted.length,
    comparable, cliffs, bulkChunkErrors: bulkErrors,
    dealsWritten: written,
  },
  breakers,
  bulkErrorSamples,
  refreshed: buckets.ok, heldStale: buckets.stale, heldFlagged: buckets.flagged,
  dead: buckets.dead, unknown: buckets.unknown, notedListObjections: noted,
};
mkdirSync(path.dirname(SUMMARY_OUT), { recursive: true });
writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2));
mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
writeFileSync(path.join(ROOT, 'verify-reports', `bestbuy-refresh-${today}.json`), JSON.stringify(summary, null, 2));
console.log(`\nReport: ${path.relative(ROOT, SUMMARY_OUT)}`);

// ── Job summary ──────────────────────────────────────────────────────────────
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [];
  md.push(`## Best Buy refresh — ${APPLY && !breakers.length ? 'applied' : 'dry run'}`, '');
  md.push('| outcome | rows | share |', '|---|---:|---:|');
  md.push(`| price + stock refreshed | ${n('ok')} | ${pct(n('ok'), targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ price actually moved | ${priceChanged} | ${pct(priceChanged, targets.length)} |`);
  md.push(`| stock only — upstream stamp > ${STALE_DAYS}d | ${n('stale')} | ${pct(n('stale'), targets.length)} |`);
  md.push(`| stock only — a peer retailer contradicts the price | ${n('flagged')} | ${pct(n('flagged'), targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ written despite a list-price objection (no peer) | ${noted.length} | ${pct(noted.length, targets.length)} |`);
  md.push(`| dead sku (404) — inStock:false only | ${n('dead')} | ${pct(n('dead'), targets.length)} |`);
  md.push(`| UNKNOWN — nothing written | ${n('unknown')} | ${pct(n('unknown'), targets.length)} |`);
  md.push('', `In-stock flips: **${stockChanged}**. Price-comparable rows: ${comparable}, of which ${cliffs} would move ≥${(CLIFF * 100).toFixed(0)}%.`, '');
  if (n('stale')) {
    const oldest = buckets.stale.filter((r) => r.stampAgeDays != null).sort((a, b) => b.stampAgeDays - a.stampAgeDays).slice(0, 10);
    md.push(`### Held — Best Buy has not repriced these in over ${STALE_DAYS} days`, '');
    md.push('These keep their stored price and are **not** stamped `priceConfirmedAt`. Refreshing them would launder a dead price into a fresh-looking one.', '');
    md.push('| id | cat | stored | api salePrice | stamp age | name |', '|---|---|---:|---:|---:|---|');
    oldest.forEach((r) => md.push(`| ${r.id} | ${r.cat || ''} | $${r.stored ?? '—'} | $${r.api?.salePrice ?? '—'} | ${Math.round(r.stampAgeDays)}d | ${r.name.replace(/\|/g, '\\|').slice(0, 50)} |`));
    md.push('');
  }
  if (breakers.length) {
    md.push('### :rotating_light: Circuit breaker tripped — nothing was written', '');
    breakers.forEach((b) => md.push(`- ${b}`));
    md.push('');
  }
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n', { flag: 'a' });
}

const CI = !!process.env.GITHUB_ACTIONS;
if (n('stale')) {
  const msg = `${n('stale')} rows kept their stored price because Best Buy has not repriced the sku in over ${STALE_DAYS} days. They are NOT stamped as confirmed.`;
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
if (n('dead')) {
  const msg = `${n('dead')} skus return 404. They were marked out of stock but NOT removed — run purge-dead-bestbuy-links.mjs to retire them.`;
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
if (breakers.length) {
  breakers.forEach((b) => console.log(CI ? `::error::${b}` : `ERROR: ${b}`));
  console.log('\nCIRCUIT BREAKER TRIPPED — nothing written, exiting 1.');
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to refresh these Best Buy deals.');
  process.exit(0);
}

await writeCatalog(parts, {
  loadedCount,
  reason: `bestbuy daily refresh — ${n('ok')} repriced (${priceChanged} moved), ${stockChanged} stock flips, ${n('stale') + n('flagged')} held`,
});
console.log('Done.');
