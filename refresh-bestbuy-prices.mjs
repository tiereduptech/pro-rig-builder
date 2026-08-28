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
 * ── A CHECK WITH NO INDEPENDENT REFERENCE REPORTS "UNREFEREED", NOT "OK" ─────
 * When a product has no other priced retailer, price-sanity.js falls back to
 * the product's own `pr`. On this catalog `pr` is mostly a copy of the Best Buy
 * price taken at ingest, so that fallback compares Best Buy to itself and its
 * verdict is empty in both directions — an OK that means "the new price is near
 * the old one", an objection that means "the new price is far from the old
 * one", against the very number this job exists to correct.
 *
 * The 2026-08-19 dry run put 404 of 869 classified rows on that list basis and
 * 371 of them were circular: 343 published a PASSED sanity check and 28
 * published an objection, and none of the 371 had been checked against
 * anything. Reporting either verdict overstates what is known, so those rows
 * are now labelled UNREFEREED and counted separately. Only 33 rows had a `pr`
 * genuinely independent of the Best Buy price; exactly one of those objected
 * (50485), and it was right — a mismapped sku.
 *
 * UNREFEREED is not a hold. The price still comes from Best Buy's own API,
 * which is the authority on what Best Buy charges; it is uncorroborated, not
 * suspect, and holding all 371 would pin them to the stale numbers this job was
 * written to fix. But a >=50% move with nothing to check it against is the
 * shape a mismapped sku makes, so --unrefereed-cliffs=hold keeps the stored
 * price on that population. The trade is real in both directions, so it is a
 * flag rather than a default.
 *
 * ── THE SKU MUST NAME THE PRODUCT ON THE ROW ────────────────────────────────
 * Before any price question is asked, the row's name is checked against the
 * name Best Buy returns for its sku. This catches the one error class no price
 * gate can: a mismapped sku, where the price is not wrong at all — it is the
 * correct price for a different product.
 *
 * 50485 reads "WD Blue SA510 2TB SATA" and its prodsku resolves to "WD BLACK
 * SN850P 2TB for PS5". The $877.99 is the SN850P's real, current price. The
 * sanity gate had nothing to say about it, and certified two of its siblings
 * (50465, 50466 — both pointing at Samsung T7 externals) as OK, because their
 * only reference was the wrong product's own stored price.
 *
 * It compares MODEL DESIGNATIONS, not prose. Catalog names come from
 * manufacturers and Best Buy's come from Best Buy, so the words differ
 * constantly on rows that are the same product; what does not drift is SA510 vs
 * SN850P, 970 EVO vs T7, SN770 vs SN850X. Over all 1,040 rows, 773 carry a
 * model token on both sides and 6 disagree — 5 confirmed mismaps and 90365,
 * which is held for a reason worth reading before anyone cites it as proof the
 * check works (see below).
 *
 * A mismatch holds the price, stamps priceUnconfirmedReason
 * 'bestbuy:name-mismatch', and names the row in a CI warning. Unlike every
 * other hold here, it does NOT self-heal: tomorrow's run re-reads the same
 * wrong sku and agrees with itself. Each one needs a relink, which is
 * deliberately a person's job and not this script's.
 *
 * ── ONE REQUEST PER 100 SKUS, NOT ONE PER SKU ───────────────────────────────
 * Every bulk chunk this repo has ever sent has come back `HTTP 400`: 11/11 and
 * 16/16 on the two dead-sku audits and 11/11 here. So a job that needs 11
 * requests pays 1,039 and 16 minutes for them, and that bill grows with the
 * catalog while the fix does not.
 *
 * Nothing could say why, because the rejection body was discarded and only the
 * status kept. It is kept now. And the failing call is no longer assumed
 * correct: it appended `.json` to a parenthesised QUERY, which Best Buy
 * documents only on the single-resource form (`/products/6354884.json`) — the
 * one thing it did that every working Best Buy call in this repo does not.
 *
 * That cannot be tested from a laptop: Best Buy validates the key before it
 * parses the query, so every keyless probe answers 403 whatever is wrong with
 * it. So the run tests it. On the first rejection it asks the same two-sku
 * question four ways — documented form, the old `.json` form, without `show=`,
 * and `sku=A|sku=B` — prints what the API says to each, adopts whichever
 * answers, and records all four verdicts in the summary. One dispatch settles
 * it either way.
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
 *     a cliff like that is the API publishing something else, not a sale), or
 *   - more than 5% of rows fail the identity check (the real rate is 0.6%; at
 *     ten times that the matcher has regressed, not the catalog).
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
import { namesAgreeOnModel } from './normalize-product-name.js';

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
// What to do with a >=CLIFF move on a row nothing independent can check.
// 'write' is the behaviour that shipped; 'hold' keeps the stored price and
// leaves the row unconfirmed. See the UNREFEREED block below for why this is a
// choice and not a default.
const UNREFEREED_CLIFFS = argOf('unrefereed-cliffs', 'write');
if (!['write', 'hold'].includes(UNREFEREED_CLIFFS)) {
  console.error(`ERROR: --unrefereed-cliffs must be 'write' or 'hold', got '${UNREFEREED_CLIFFS}'.`);
  process.exit(1);
}
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
// Share of rows allowed to fail the identity check before the run is treated as
// a broken matcher rather than a broken catalog. Measured over all 1,040 rows
// the real rate is 6 (0.6%); 5% is an order of magnitude of headroom and still
// stops a tokenizer regression from holding the entire catalog in one run.
const MAX_MISMATCH_RATE = Number(argOf('max-mismatch-rate', '0.05'));

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

// A 4xx here is a verdict on the request, not weather: the same bytes sent
// again get the same answer. Retrying one three times only spends three times
// the quota to learn it three times — 22 wasted requests and ~26s per run at
// the failure rate below. 403 and 429 stay retryable because Best Buy answers
// an exceeded rate limit with a 403, and that one IS weather.
const DETERMINISTIC = new Set([400, 401, 404, 414, 422]);

// Best Buy explains a rejection in the response body and this job was throwing
// it away, which is why two audits and a refresh run could report `HTTP 400`
// 27 times and not one of them could say what the API objected to.
function errDetail(status, body) {
  let msg = null;
  if (body) {
    try { msg = JSON.parse(body).errorMessage || null; } catch {
      const m = body.match(/<(?:errorMessage|message)>([^<]+)</i);
      if (m) msg = m[1];
    }
    if (!msg) msg = body.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  }
  return `HTTP ${status}${msg ? ` — ${msg}` : ''}`;
}

async function get(url, label) {
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { ok: true, json: await res.json(), status: res.status };
      last = errDetail(res.status, await res.text().catch(() => ''));
      if (res.status === 404) return { ok: false, status: 404, err: 'HTTP 404' };
      if (DETERMINISTIC.has(res.status)) return { ok: false, status: res.status, err: last };
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

// ── The bulk query, four ways ────────────────────────────────────────────────
// Every bulk chunk has been rejected on every run this repo has ever made:
// 11/11 and 16/16 on the two dead-sku audits and 11/11 on the refresh, all
// `HTTP 400`, so all 1,039 skus resolve one at a time and a job that needs 11
// requests pays 1,039 and 16 minutes for them. That cost grows with the
// catalog; the fix does not.
//
// A 400 with no body could not say why, so the first thing here is that the
// body is now kept (see errDetail). The second is that the form the job was
// sending is no longer assumed to be the right one:
//
//   `/products(sku in(…)).json?…`  — a `.json` extension appended to a QUERY.
//
// Best Buy documents the extension on the single-resource form,
// `/products/6354884.json`, and documents queries as `/products(<filter>)`
// with `format=json` as a parameter. Every other Best Buy call in this repo
// that works — case-sweep, discover, the category audits — uses the parameter
// form and none of them append `.json` to a parenthesised path. That makes the
// extension the one thing the failing calls do that the working calls do not,
// and it explains the shape of the evidence: EVERY chunk fails, including the
// 22-sku tail chunk, so it is not length, not quota (the individual calls that
// follow all succeed on the same key) and not the sku list.
//
// It is still a hypothesis, and it cannot be tested from here — Best Buy
// validates the key before it parses the query, so without the secret every
// probe answers 403. So the run tests it: on the first rejection it asks the
// same two-sku question in each of these forms, prints what the API says about
// each, and adopts whichever one actually answers. One dispatch settles it, and
// if the answer is "the .json was fine, something else is wrong", the probe
// says that too instead of leaving another run with `HTTP 400` and no body.
const API = 'https://api.bestbuy.com/v1';
const BULK_FORMS = [
  { id: 'query',
    why: 'documented query form — filter in the path, format as a parameter',
    url: (c) => `${API}/products(sku%20in(${c.join(',')}))` +
      `?apiKey=${KEY}&show=${SHOW}&pageSize=${CHUNK}&format=json` },
  { id: 'query.json',
    why: "what this job has always sent — '.json' appended to a query path",
    url: (c) => `${API}/products(sku%20in(${c.join(',')})).json` +
      `?apiKey=${KEY}&show=${SHOW}&pageSize=${CHUNK}&format=json` },
  { id: 'query-no-show',
    why: 'no show= — isolates a rejected field name in the projection',
    url: (c) => `${API}/products(sku%20in(${c.join(',')}))` +
      `?apiKey=${KEY}&pageSize=${CHUNK}&format=json` },
  { id: 'or-list',
    why: 'sku=A|sku=B|… — in case in() is the part being rejected',
    url: (c) => `${API}/products(${c.map((x) => `sku=${x}`).join('%7C')})` +
      `?apiKey=${KEY}&show=${SHOW}&pageSize=${CHUNK}&format=json` },
];
const redact = (u) => String(u).split(KEY || '\u0000').join('<key>');

/**
 * Ask the same two-sku question every way and report which ones the API takes.
 * Four requests, once per run, only after a chunk has already been rejected.
 *
 * "Worked" means the response came back AND contained both skus asked for — a
 * form that 200s with an empty product list has not answered the question, and
 * adopting it would silently push every sku into the individual pass while
 * reporting the bulk pass as healthy.
 */
async function probeBulkForms(sample) {
  const out = [];
  for (const f of BULK_FORMS) {
    const res = await get(f.url(sample));
    const returned = res.ok ? (res.json?.products || []).map((x) => String(x.sku)) : [];
    const complete = sample.every((sku) => returned.includes(sku));
    out.push({ form: f.id, why: f.why, ok: !!res.ok, complete,
      status: res.status ?? null, err: res.ok ? null : res.err,
      returned: returned.length, url: redact(f.url(sample)) });
    console.log(`      ${f.id.padEnd(14)} ${res.ok
      ? (complete ? `answered — ${returned.length}/${sample.length} skus` : `HTTP 200 but returned ${returned.length}/${sample.length} skus`)
      : res.err}`);
    await sleep(PACE_MS);
  }
  return out;
}

/** sku -> {status:'alive'|'dead'|'unknown', ...fields}. Two strikes, as the audit. */
async function fetchFacts(skuList) {
  const bySku = new Map();
  const missed = [];
  let bulkErrors = 0;
  const bulkErrorSamples = [];

  let form = BULK_FORMS[0];
  let bulkProbe = null;

  const chunks = [];
  for (let i = 0; i < skuList.length; i += CHUNK) chunks.push(skuList.slice(i, i + CHUNK));
  console.log(`STRIKE 1 — bulk: ${chunks.length} request(s) covering ${skuList.length} skus (form '${form.id}')`);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const res = await get(form.url(c), `bulk ${i + 1}/${chunks.length}`);
    if (!res.ok) {
      // The first rejection is the only chance to find out why cheaply, so take
      // it: four two-sku requests, then carry on with whichever form answered.
      if (!bulkProbe) {
        console.log(`[${i + 1}/${chunks.length}] BULK FAILED (${res.err})`);
        console.log(`   Asking the same two-sku question ${BULK_FORMS.length} ways to find out what it objects to:`);
        bulkProbe = await probeBulkForms(c.slice(0, 2));
        const winner = BULK_FORMS.find((f) => bulkProbe.some((r) => r.form === f.id && r.complete));
        if (winner && winner.id !== form.id) {
          console.log(`   -> '${winner.id}' answered; using it for the rest of the run and retrying this chunk.`);
          form = winner;
          await sleep(PACE_MS);
          i--;
          continue;
        }
        console.log(winner
          ? `   -> only '${winner.id}' answered, which is the form already in use — deferring.`
          : '   -> no form answered. Every chunk will resolve one sku at a time.');
      }
      // A failed bulk chunk is not evidence about its skus — they all fall
      // through to the individual pass, which is authoritative anyway.
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
  return { bySku, bulkErrors, bulkErrorSamples, bulkForm: form.id, bulkProbe, individualGets: missed.length };
}

/** Replay an audit artifact instead of spending quota. Review path, not production. */
function factsFromReport(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  if (!j?.bySku) throw new Error(`${file} has no bySku map — not a dead-sku audit report`);
  const bySku = new Map(Object.entries(j.bySku));
  console.log(`Replaying ${path.relative(ROOT, file)} (audited ${j.auditedAt}) — ${bySku.size} skus, no API calls.`);
  return { bySku, bulkErrors: 0, bulkErrorSamples: [], bulkForm: null, bulkProbe: null, individualGets: 0, auditedAt: j.auditedAt };
}

const { bySku, bulkErrors, bulkErrorSamples, bulkForm, bulkProbe, individualGets, auditedAt } =
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

// ── Is `pr` independent of the Best Buy price? ───────────────────────────────
// classifyDeal falls back to the product's own `pr` when no peer exists, and
// on this catalog `pr` is usually a copy of the Best Buy price taken at ingest.
// Comparing a new Best Buy price to that is comparing Best Buy to itself: the
// verdict carries no information, whichever way it lands.
//
// The tie is measured against the STORED Best Buy price — the number this run
// exists to correct — because that is what `pr` was copied from. A dollar of
// slack catches the rounding the catalog does at ingest (99.99 -> 100,
// 169.99 -> 170, 40.99 -> 41), and 1% covers the same rounding on dear rows.
const prTracksBestBuy = (r) => {
  const pr = r.p?.pr;
  return Number.isFinite(pr) && r.stored > 0 &&
    Math.abs(pr - r.stored) <= Math.max(1, r.stored * 0.01);
};

// Not added to price-sanity.js's CLASS. That enum answers "what does the
// evidence say about this price"; this answers "is there any evidence" — a
// fact about THIS catalog's pr provenance, which price-sanity.js has no view of.
const UNREFEREED = 'UNREFEREED';

// ── Does this sku describe the product on the row? ───────────────────────────
// No price check can catch a mismapped sku, because the price is not wrong —
// it is the right price for the wrong product. 50485 reads "WD Blue SA510 2TB
// SATA" and its prodsku resolves to "WD BLACK SN850P 2TB for PS5"; $877.99 is
// the SN850P's real price, correctly read, about to be written onto a SATA
// drive. The sanity gate certified two of its siblings (50465, 50466) as OK.
//
// The API already returns `name` on every response and this job already asks
// for it. Comparing it to the row's own name is the check that catches the
// class — and it is the one error a daily job cannot recover from by waiting,
// because tomorrow's run re-reads the same wrong sku and agrees with itself.
//
// MODEL TOKENS, NOT PROSE. Catalog names come from manufacturers, Best Buy's
// come from Best Buy, so the words differ constantly on rows that are the same
// product ("Fractal Design - North Charcoal Black" vs "North - Genuine Walnut
// Wood Front"). What does NOT drift is the model designation: SA510 vs SN850P,
// 970 EVO vs T7, SN770 vs SN850X. So the check ignores prose entirely and asks
// one question — do these two names name the same model?
//
// Measured over all 1,040 rows: 773 have a model token on both sides and 6 of
// those disagree. Five are confirmed mismaps: 50465, 50466, 50480, 50485, 50501.
//
// THE SIXTH IS NOT A MODEL CONFLICT, whatever the hold reason reads like.
// 90365 is held on this comparison:
//
//   catalog  "Lenovo - ThinkVision P24Q-40 24" Class WQHD …"   -> [p24q]
//   Best Buy "Lenovo - ThinkVision 23.8" IPS LED QHD (2560x1440) 48Hz - 120Hz …"
//                                                              -> [2560x1440]
//
// Best Buy's name carries no model designation at all. What it does carry is a
// resolution, and "2560x1440" is alphanumeric, contains digits, and is not in
// UNIT_TOKEN — so it is read as a designation, and "p24q != 2560x1440" is
// recorded as a model conflict. The outcome is right (a 48-120Hz QHD panel is
// not a 60Hz P24q-40) and holding an unidentifiable row is right, but the
// evidence is a resolution mismatched against a model number.
//
// So do not read 90365 as the check catching a mismap: on that row, the check
// answered a question it was not asked. It is pinned in
// test/product-identity.test.js so a change to the tokenizer has to decide
// about it deliberately — if resolutions ever stop counting as designations,
// 90365 becomes 'unverifiable' and its price stops being held.
// The tokenizer and the verdict live in normalize-product-name.js, with the
// canonical keys they correct: the same question is asked when a matcher DECIDES
// to attach a sku and when this job checks one it inherited, and two copies of
// it would drift into two answers.

const OUT = {
  OK: 'ok',                 // price + stock written, stamped confirmed
  STALE: 'stale',           // upstream stamp is ancient — stock only, price held
  FLAGGED: 'flagged',       // sanity gate rejected the new price — stock only
  DEAD: 'dead',             // API 404 — stock only (inStock:false), never deleted here
  UNKNOWN: 'unknown',       // no verdict — nothing written at all
};

const buckets = { ok: [], stale: [], flagged: [], unrefereedHeld: [], nameMismatch: [], dead: [], unknown: [] };
let nameChecked = 0, nameUnverifiable = 0;
const noted = [];       // written, but a REAL list price objected — see below
const unrefereed = [];  // written with nothing independent to check them at all
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
      name: v.name ?? null,
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

  // ── The identity gate, ahead of every price question ───────────────────────
  // Asked first because it is not a question about the price. If the sku names
  // a different product, "is this price plausible" has no meaning — the answer
  // would be about something we do not sell. Reporting such a row as merely
  // stale or merely suspect would file a mismap under a heading that implies
  // it self-heals, and this one does not: tomorrow's run reads the same wrong
  // sku and agrees with itself.
  const nv = namesAgreeOnModel(r.name, v.name);
  row.nameCheck = { verdict: nv.verdict, rowModels: nv.a, apiModels: nv.b, why: nv.why };
  if (nv.verdict === 'mismatch') {
    row.holdReason = `sku ${r.sku} names a different product — row names model [${nv.a.join(' ')}], sku resolves to [${nv.b.join(' ')}]`;
    row.unconfirmedReason = 'bestbuy:name-mismatch';
    buckets.nameMismatch.push(row);
    continue;
  }
  if (nv.verdict === 'unverifiable') nameUnverifiable++; else nameChecked++;

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
  // A peer verdict ('median' / 'pair') is real, independent evidence — another
  // retailer selling the same product — and price-sanity.js's SUSPECT_LOW /
  // HIGH / PAIR classes exist for exactly that. Those hold the price.
  const peerBacked = cls.basis === 'median' || cls.basis === 'pair';
  if (objection && peerBacked) {
    row.holdReason = `sanity ${cls.cls} (${cls.basis}, ref $${cls.ref}, ${(cls.deviation * 100).toFixed(0)}%)`;
    row.unconfirmedReason = `bestbuy:sanity-${cls.cls.toLowerCase().replace(/_/g, '-')}`;
    buckets.flagged.push(row);
    continue;
  }

  // ── UNREFEREED: no peer, and `pr` is the Best Buy price wearing a hat ───────
  //
  // With no peer, classifyDeal falls back to the product's own pr/msrp. On this
  // catalog that fallback is usually circular — `pr` was copied from the Best
  // Buy price at ingest — so BOTH of its answers are empty:
  //
  //   the OK        degenerates into "the new price is near the old price"
  //   the objection degenerates into "the new price is far from the old price"
  //
  // and this job exists precisely because the old price is the thing that is
  // wrong. Measured on the 2026-08-19 dry run: 404 rows landed on a list basis,
  // 371 of them circular — 343 reported a PASSED sanity check and 28 reported
  // an objection, and not one of the 371 had been checked against anything.
  // Only 33 rows had a `pr` that was genuinely independent of the Best Buy
  // price, and exactly one of those objected (50485, which turned out to be a
  // mismapped sku — the check earning its keep on the one row it could).
  //
  // So neither verdict is reported for a circular row. It is labelled
  // UNREFEREED, which is the true statement: nothing checked this.
  //
  // Held? Not by default. An unrefereed price is not a suspect price — it comes
  // from Best Buy's own API, which is the authority on what Best Buy charges —
  // it is an UNCORROBORATED one, and holding all of them would pin 371 rows to
  // the stale numbers this job was written to fix. But a >=CLIFF move with
  // nothing to check it against is the shape a mismapped sku makes, so
  // --unrefereed-cliffs=hold makes that population stock-only. The choice is
  // explicit because the trade is real in both directions.
  const circularPr = String(cls.basis).startsWith('list') && prTracksBestBuy(r);
  if (circularPr) {
    row.sanity = {
      cls: UNREFEREED, ref: null, deviation: null, basis: 'unrefereed',
      // Kept so the demotion is auditable rather than a silent swallow.
      suppressed: { cls: cls.cls, basis: cls.basis, ref: cls.ref, deviation: cls.deviation },
    };
    row.unrefereedReason = `no peer retailer, and pr $${r.p.pr} is the stored Best Buy price $${r.stored} — nothing checked this`;
    const isCliff = row.deltaPct != null && Math.abs(row.deltaPct) >= CLIFF;
    if (isCliff && UNREFEREED_CLIFFS === 'hold') {
      row.holdReason = `unrefereed cliff — ${(row.deltaPct * 100).toFixed(0)}% move with no independent price to check it against`;
      row.unconfirmedReason = 'bestbuy:unrefereed-cliff';
      buckets.unrefereedHeld.push(row);
      continue;
    }
    if (isCliff) row.unrefereedCliff = true;
    unrefereed.push(row);
  } else if (objection) {
    // A genuinely independent list price objected. Still written — pinning a
    // row to an expired ingest-time sale price would hold it every night with
    // no path back — but recorded, and now the population is only the rows
    // where the objection actually means something.
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
const mismatchRate = targets.length ? buckets.nameMismatch.length / targets.length : 0;
if (mismatchRate > MAX_MISMATCH_RATE) {
  breakers.push(`${buckets.nameMismatch.length} of ${targets.length} rows (${pct(buckets.nameMismatch.length, targets.length)}) name a different product than their sku, over the ${(MAX_MISMATCH_RATE * 100).toFixed(0)}% ceiling — at that rate the matcher is broken, not the catalog.`);
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
console.log(`  -> stock only, price HELD ........... ${n('stale') + n('flagged') + n('unrefereedHeld') + n('nameMismatch')}`);
console.log(`       THE SKU NAMES ANOTHER PRODUCT .. ${n('nameMismatch')}  <- not self-healing; needs a relink`);
console.log(`       upstream stamp ancient ......... ${n('stale')}`);
console.log(`       a peer retailer vetoed it ...... ${n('flagged')}`);
console.log(`       unrefereed cliff (--unrefereed-cliffs=hold) ${n('unrefereedHeld')}`);
console.log('');
console.log(`  identity: ${nameChecked} rows confirmed to name the same model as their sku, ` +
  `${n('nameMismatch')} contradicted, ${nameUnverifiable} unverifiable (no model designation on one side)`);
console.log('');
console.log(`  of the rows written, how well checked:`);
console.log(`       a peer retailer agreed ......... ${buckets.ok.filter((r) => r.sanity && ['median', 'pair'].includes(r.sanity.basis)).length}`);
console.log(`       an independent list agreed ..... ${buckets.ok.length - unrefereed.length - noted.length - buckets.ok.filter((r) => r.sanity && ['median', 'pair'].includes(r.sanity.basis)).length}`);
console.log(`       an independent list OBJECTED ... ${noted.length}  <- written anyway, listed below`);
console.log(`       UNREFEREED — nothing checked it. ${unrefereed.length}  (of which >=${(CLIFF * 100).toFixed(0)}% moves: ${unrefereed.filter((r) => r.unrefereedCliff).length})`);
console.log(`  -> dead sku (404), stock only ....... ${n('dead')}  <- purge-dead-bestbuy-links.mjs owns removal`);
console.log(`  -> UNKNOWN, nothing written ......... ${n('unknown')}`);
console.log('');
console.log(`  in-stock flips (either direction) ... ${stockChanged}`);
console.log(`  price comparable rows ............... ${comparable}, of which >=${(CLIFF * 100).toFixed(0)}% move: ${cliffs} (${pct(cliffs, comparable)})`);
if (bulkErrors) {
  console.log('');
  console.log(`  bulk chunks that failed ............. ${bulkErrors}  (${individualGets} skus then read one at a time)`);
  bulkErrorSamples.forEach((e) => console.log(`      ${e}`));
  if (bulkProbe) {
    console.log(`  query forms probed .................. ${bulkProbe.length}`);
    bulkProbe.forEach((r) => console.log(`      ${r.form.padEnd(14)} ${r.complete ? 'ANSWERED' : (r.ok ? 'empty' : r.err)}   ${r.why}`));
  }
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

show('HELD — THE SKU NAMES A DIFFERENT PRODUCT (relink required; no run fixes this):', buckets.nameMismatch,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} sku ${r.sku.padEnd(9)} stored $${String(r.stored).padEnd(9)} not written $${String(r.api.salePrice).padEnd(9)}\n` +
         `           row: ${r.name.slice(0, 74)}\n` +
         `           api: ${String(r.api.name || '—').slice(0, 74)}\n` +
         // The tokens the verdict actually rests on. Print them: on 90365 they
         // are [p24q] against [2560x1440], which is a resolution standing in
         // for a model designation, and a reader who only sees "the sku names a
         // different product" would file that as a caught mismap.
         `           held on: [${(r.nameCheck?.rowModels || []).join(' ') || '—'}] vs [${(r.nameCheck?.apiModels || []).join(' ') || '—'}]`, 25);

show('HELD — an unrefereed cliff (--unrefereed-cliffs=hold):', buckets.unrefereedHeld,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} stored $${String(r.stored).padEnd(9)} api $${String(r.api.salePrice).padEnd(9)} | ${r.holdReason}`);

show('WRITTEN OVER A LIST-PRICE OBJECTION — an INDEPENDENT list price disagrees:', noted,
  (r) => `${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} stored $${String(r.stored).padEnd(9)} -> $${String(r.api.salePrice).padEnd(9)} pr $${String(r.p_pr ?? '—').padEnd(9)} | ${r.listObjection}`);

// Sorted by move size: the whole point of the section is that the biggest
// numbers in it are the ones nothing corroborated.
show(`UNREFEREED — no peer, and pr is the Best Buy price itself (nothing checked these, written ${UNREFEREED_CLIFFS === 'hold' ? 'except the cliffs' : 'anyway'}):`,
  unrefereed.slice().sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0)),
  (r) => `${r.unrefereedCliff ? 'CLIFF ' : '      '}${String(r.id).padEnd(8)} ${String(r.cat || '').padEnd(12)} $${String(r.stored).padEnd(9)} -> $${String(r.api.salePrice).padEnd(9)} ` +
         `${(r.deltaPct * 100 >= 0 ? '+' : '')}${((r.deltaPct ?? 0) * 100).toFixed(1)}%`.padEnd(9) +
         ` pr $${String(r.p_pr ?? '—').padEnd(9)} | ${r.name.slice(0, 30)}`, 25);

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
    // ── The stamp that cannot be manufactured ─────────────────────────────────
    // priceConfirmedAt below advances every night this job runs, whether or not
    // Best Buy said anything new — so it proves we ASKED, never that the answer
    // was current. Four months of frozen Best Buy prices looked healthy through
    // exactly that gap.
    //
    // priceLastMovedAt advances only when the stored number actually changed,
    // so it cannot be produced by re-reading a frozen API. Compared against the
    // value already on the deal rather than against r.delta, so a row written
    // by some other path still reads correctly here.
    // scripts/price-movement.cjs turns these into the distribution the workflow
    // asserts on.
    if (d.price !== price) d.priceLastMovedAt = today;
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
  for (const r of buckets.unrefereedHeld) applyRow(r, { stock: r.willBeInStock, confirm: false, unconfirmedReason: r.unconfirmedReason });
  // Stock still moves, as it does on every other hold — but note that on a
  // mismapped row it is the WRONG product's stock. The row is broken until it
  // is relinked; this only refuses to make it worse by writing a price too.
  for (const r of buckets.nameMismatch) applyRow(r, { stock: r.willBeInStock, confirm: false, unconfirmedReason: r.unconfirmedReason });
  for (const r of buckets.dead) {
    const t = byId.get(r.id);
    if (t) { t.deal.inStock = false; written++; }
  }
  // UNKNOWN: untouched, by construction. Never let an API blip change data.
}

// ── How much of Best Buy is actually repricing? ──────────────────────────────
// This job has always asserted that it RAN (considered>0) and warned that it
// wrote something (refreshed>0). Neither asks whether Best Buy is still moving
// prices, which is the failure that actually happened here: prices captured
// once at merge time, refreshed by nothing, invisible for four months because
// every derived artifact downstream kept looking alive.
//
// A max over the catalog would not have caught it either — a handful of active
// SKUs hold "newest move" at 0 forever. scripts/price-movement.cjs measures the
// distribution instead. See its header for the threshold derivation, which was
// measured off eight days of THIS job's own summaries.
const { movementFor, report: movementReport } = require('./scripts/price-movement.cjs');
const priceMovement = movementFor({
  parts, retailer: 'bestbuy', today, apply: APPLY && !breakers.length,
});
console.log('');
for (const line of movementReport(priceMovement)) console.log(line);

// ── Summary artifact ─────────────────────────────────────────────────────────
const summary = {
  ranAt: new Date().toISOString(),
  apply: APPLY && !breakers.length,
  source: FROM_REPORT ? { replayOf: path.relative(ROOT, path.resolve(FROM_REPORT)), auditedAt } : { api: 'bestbuy-developer' },
  options: { staleDays: STALE_DAYS, sanityGate: !NO_SANITY, limit: N || null, unrefereedCliffs: UNREFEREED_CLIFFS },
  totals: {
    considered: targets.length, rowsWithoutSku: noSku,
    refreshed: n('ok'), priceChanged, stockChanged,
    heldStale: n('stale'), heldFlagged: n('flagged'), heldUnrefereedCliff: n('unrefereedHeld'),
    heldNameMismatch: n('nameMismatch'), nameChecked, nameUnverifiable,
    dead: n('dead'), unknown: n('unknown'), notedListObjections: noted.length,
    unrefereed: unrefereed.length,
    unrefereedCliffs: unrefereed.filter((r) => r.unrefereedCliff).length + n('unrefereedHeld'),
    comparable, cliffs, bulkChunkErrors: bulkErrors,
    dealsWritten: written,
  },
  // `totals` counts what THIS run did; this counts what Best Buy has been doing
  // across the catalog, which is the question a frozen API answers wrongly.
  movement: priceMovement,
  breakers,
  // What the bulk pass actually did, so the next run does not have to guess:
  // which form was used, what the API said about each form it was asked, and
  // the raw rejection text this job used to discard.
  bulk: { form: bulkForm, chunkErrors: bulkErrors, individualGets, probe: bulkProbe },
  bulkErrorSamples,
  refreshed: buckets.ok, heldStale: buckets.stale, heldFlagged: buckets.flagged,
  heldUnrefereedCliff: buckets.unrefereedHeld, heldNameMismatch: buckets.nameMismatch,
  dead: buckets.dead, unknown: buckets.unknown, notedListObjections: noted,
  unrefereed,
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
  md.push(`| stock only — unrefereed cliff (\`--unrefereed-cliffs=hold\`) | ${n('unrefereedHeld')} | ${pct(n('unrefereedHeld'), targets.length)} |`);
  md.push(`| **stock only — the sku names a different product** | **${n('nameMismatch')}** | ${pct(n('nameMismatch'), targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ written despite an **independent** list-price objection | ${noted.length} | ${pct(noted.length, targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ written **unrefereed** — nothing checked the price | ${unrefereed.length} | ${pct(unrefereed.length, targets.length)} |`);
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
if (bulkErrors) {
  const winner = bulkProbe && bulkProbe.find((r) => r.complete);
  const msg = `${bulkErrors} bulk chunks were rejected, so ${individualGets} skus were read one at a time. ` +
    (bulkProbe
      ? (winner
        ? `Form '${winner.form}' answered and was used for the rest of the run — make it the default in BULK_FORMS.`
        : `No query form answered: ${bulkProbe.map((r) => `${r.form}=${r.err || 'empty'}`).join(' | ')}`)
      : 'No form probe ran.');
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
if (n('dead')) {
  const msg = `${n('dead')} skus return 404. They were marked out of stock but NOT removed — run purge-dead-bestbuy-links.mjs to retire them.`;
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
if (n('nameMismatch')) {
  const msg = `${n('nameMismatch')} rows have a sku that names a DIFFERENT product than the row. Their prices were held. ` +
    `This does not self-heal — tomorrow's run reads the same wrong sku — so each one needs a relink: ` +
    buckets.nameMismatch.map((r) => r.id).join(', ');
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
const writtenCliffs = unrefereed.filter((r) => r.unrefereedCliff).length;
if (writtenCliffs) {
  const msg = `${writtenCliffs} rows would move by ${(CLIFF * 100).toFixed(0)}% or more with nothing independent to check the new price against. ` +
    `They are being WRITTEN — pass --unrefereed-cliffs=hold to keep the stored price on those rows instead.`;
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
  reason: `bestbuy daily refresh — ${n('ok')} repriced (${priceChanged} moved), ${stockChanged} stock flips, ${n('stale') + n('flagged') + n('unrefereedHeld') + n('nameMismatch')} held`,
});
console.log('Done.');
