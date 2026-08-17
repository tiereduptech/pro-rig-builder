#!/usr/bin/env node
/**
 * probe-bestbuy-price-truth.mjs — READ-ONLY. Writes no catalog, no parts.js.
 *
 * THE QUESTION: is the Best Buy Developer API's salePrice the real selling
 * price, or the struck-through "Comp. Value"?
 *
 * The 6/28 finding (see bestbuy-price.js header) showed salePrice=399.99 for
 * sku 6519477 while the real selling price was 239.99. That was ONE sku and a
 * FIXED field list. Before scheduling any refresh we need to know two things
 * that single observation cannot answer:
 *
 *   A. Does the API carry the real price in some field we never asked for?
 *      The 6/28 probe used an explicit `show=` list. This one uses show=all
 *      and dumps EVERY price-ish key, so "no field has it" becomes a finding
 *      rather than an assumption.
 *
 *   B. Does the API move at all? If salePrice equals our frozen stored price
 *      for ~every sku, a cron would rewrite the same number daily and stamp it
 *      fresh — strictly worse than no cron. If it differs widely, the API is
 *      live and the catalog is merely stale.
 *
 * WHAT THIS CANNOT DO: establish ground truth. www.bestbuy.com is behind
 * Akamai and refuses datacenter IPs (verified: HTTP/2 INTERNAL_ERROR on even
 * /robots.txt, from this box). A GitHub runner will fare no better. So the
 * probe prints a short BROWSER CHECKLIST of skus for a human to eyeball on the
 * real PDP. That human read is the only ground truth available; everything
 * above it is corroboration.
 *
 * Usage:
 *   railway run node probe-bestbuy-price-truth.mjs           # 50 skus (default)
 *   railway run node probe-bestbuy-price-truth.mjs --n 200
 *
 * Rate limit: Best Buy allows 5 req/sec. This paces at ~3/sec.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY required.');
  console.error('  Railway dashboard → prorigbuilder project → service → Variables tab,');
  console.error('  or:  railway variables            (lists them)');
  console.error('  then: railway run node probe-bestbuy-price-truth.mjs');
  process.exit(1);
}

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const N = Number((argv[argv.indexOf('--n') + 1] || 50)) || 50;
const OUT = path.join(ROOT, 'catalog-build', 'bestbuy-price-truth.json');

// The 6/28 control. If the probe reproduces salePrice=399.99 here, the bug is
// still live; if salePrice now tracks the real price, something changed upstream.
const CONTROL_SKU = '6519477';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = '─'.repeat(96);

// ── Load catalog + recover skus ───────────────────────────────────────────
// Only 9 of 1,523 bestbuy deals carry an explicit .sku; the rest keep it in the
// affiliate wrapper's prodsku= param. Derive rather than skip.
const mod = await import('file://' + path.join(ROOT, 'src', 'data', 'parts.js') + '?t=' + Date.now());
const parts = mod.PARTS || mod.default;
if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }

const skuOf = (deal) => {
  if (deal.sku) return String(deal.sku);
  const m = String(deal.url || '').match(/[?&]prodsku=(\d+)/);
  return m ? m[1] : null;
};

const rows = [];
for (const p of parts) {
  const d = p.deals && p.deals.bestbuy;
  if (!d || typeof d !== 'object' || !(d.price > 0)) continue;
  const sku = skuOf(d);
  if (!sku) continue;
  const peers = ['amazon', 'newegg']
    .map((r) => p.deals[r] && p.deals[r].price)
    .filter((v) => typeof v === 'number' && v > 0);
  rows.push({
    id: p.id, name: p.n, cat: p.c, sku,
    stored: d.price,
    confirmedAt: d.priceConfirmedAt || null,
    peers,
    peerMin: peers.length ? Math.min(...peers) : null,
  });
}
console.log(`Catalog: ${rows.length} Best Buy rows with a recoverable sku (of ${parts.length} products)`);

// ── Stratified sample ─────────────────────────────────────────────────────
// Deterministic (no Math.random — reruns must be comparable). Three strata so a
// correlation between "BB sits far above its peers" and "API returns comp" is
// visible rather than averaged away.
const withPeers = rows.filter((r) => r.peerMin != null);
const highVsPeers = withPeers
  .filter((r) => r.stored > r.peerMin * 1.25)
  .sort((a, b) => b.stored / b.peerMin - a.stored / a.peerMin);
const inlineWithPeers = withPeers.filter((r) => r.stored <= r.peerMin * 1.25);
const soleRetailer = rows.filter((r) => r.peerMin == null);
const recentlyConfirmed = rows.filter((r) => r.confirmedAt);

const take = (arr, n, stride) => {
  const out = [];
  const step = Math.max(1, stride || Math.floor(arr.length / Math.max(1, n)));
  for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
};

const sample = [];
const seen = new Set();
const add = (r, stratum) => {
  if (!r || seen.has(r.sku)) return;
  seen.add(r.sku);
  sample.push({ ...r, stratum });
};

// control first, even if it is no longer in the catalog
if (!rows.some((r) => r.sku === CONTROL_SKU)) {
  add({ id: null, name: '(6/28 control — Ryzen 7 7700X)', cat: null, sku: CONTROL_SKU,
        stored: null, confirmedAt: null, peers: [], peerMin: null }, 'control');
} else {
  add(rows.find((r) => r.sku === CONTROL_SKU), 'control');
}
recentlyConfirmed.forEach((r) => add(r, 'recently-confirmed'));
take(highVsPeers, Math.ceil(N * 0.35)).forEach((r) => add(r, 'high-vs-peers'));
take(inlineWithPeers, Math.ceil(N * 0.35)).forEach((r) => add(r, 'inline-vs-peers'));
take(soleRetailer, Math.ceil(N * 0.2)).forEach((r) => add(r, 'sole-retailer'));

console.log(`Sample: ${sample.length} skus — ` +
  Object.entries(sample.reduce((a, r) => (a[r.stratum] = (a[r.stratum] || 0) + 1, a), {}))
    .map(([k, v]) => `${k}:${v}`).join(', '));
console.log(bar);

// ── Fetch ─────────────────────────────────────────────────────────────────
// show=all so an unknown field carrying the true price cannot hide from us.
const PRICEY = /price|sale|save|saving|deal|offer|promo|member|plan|discount|msrp|regular|value/i;

const results = [];
let apiErrors = 0;
for (let i = 0; i < sample.length; i++) {
  const r = sample[i];
  const url = `https://api.bestbuy.com/v1/products/${r.sku}.json?apiKey=${KEY}&show=all&format=json`;
  let api = null, err = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      api = await res.json();
    } else {
      err = `HTTP ${res.status}`;
      if (res.status === 403) err += ' (key rejected / quota)';
      if (res.status === 404) err += ' (sku not in API — delisted?)';
    }
  } catch (e) { err = e.message; }
  if (err) apiErrors++;

  // every price-ish field the API actually returned, whether or not we knew of it
  const priceFields = {};
  if (api) {
    for (const [k, v] of Object.entries(api)) {
      if (PRICEY.test(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) {
        priceFields[k] = v;
      }
    }
  }

  const rec = {
    sku: r.sku, name: r.name, stratum: r.stratum, cat: r.cat,
    stored: r.stored, peers: r.peers, peerMin: r.peerMin,
    confirmedAt: r.confirmedAt,
    err,
    apiName: api ? api.name : null,
    salePrice: api ? api.salePrice : null,
    regularPrice: api ? api.regularPrice : null,
    onSale: api ? api.onSale : null,
    priceUpdateDate: api ? api.priceUpdateDate : null,
    activeUpdateDate: api ? api.activeUpdateDate : null,
    orderable: api ? api.orderable : null,
    onlineAvailability: api ? api.onlineAvailability : null,
    priceFields,
  };
  rec.movedVsStored = (rec.salePrice != null && r.stored != null)
    ? Number((rec.salePrice - r.stored).toFixed(2)) : null;
  results.push(rec);

  const tag = err ? `ERR ${err}` :
    `api $${rec.salePrice} | stored ${r.stored == null ? '-' : '$' + r.stored} | ` +
    `reg $${rec.regularPrice} | onSale ${rec.onSale} | upd ${rec.priceUpdateDate || '-'}`;
  console.log(`[${String(i + 1).padStart(3)}/${sample.length}] ${r.sku.padEnd(9)} ${r.stratum.padEnd(19)} ${tag}`);

  await sleep(340); // ~3/sec, under the documented 5/sec ceiling
}

// ── Analysis ──────────────────────────────────────────────────────────────
const ok = results.filter((r) => !r.err && r.salePrice != null);
const comparable = ok.filter((r) => r.stored != null);
const identical = comparable.filter((r) => Math.abs(r.movedVsStored) < 0.005);
const moved = comparable.filter((r) => Math.abs(r.movedVsStored) >= 0.005);
const onSaleTrue = ok.filter((r) => r.onSale === true);
const saleEqRegular = ok.filter((r) => r.regularPrice != null && Math.abs(r.salePrice - r.regularPrice) < 0.005);

// every distinct price-ish key the API emitted, across the whole sample
const fieldUniverse = {};
for (const r of ok) for (const k of Object.keys(r.priceFields)) fieldUniverse[k] = (fieldUniverse[k] || 0) + 1;

// does a field OTHER than salePrice ever undercut salePrice? that would be the
// real price hiding in plain sight — the single most important thing to check.
const undercuts = [];
for (const r of ok) {
  for (const [k, v] of Object.entries(r.priceFields)) {
    if (k === 'salePrice') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0 && n < r.salePrice * 0.95) {
      undercuts.push({ sku: r.sku, field: k, value: n, salePrice: r.salePrice });
    }
  }
}

console.log(bar);
console.log('RESULT');
console.log(bar);
console.log(`  fetched ok ............... ${ok.length} / ${sample.length}  (errors: ${apiErrors})`);
console.log(`  API price == our stored .. ${identical.length} / ${comparable.length}` +
  (comparable.length ? `  (${(100 * identical.length / comparable.length).toFixed(0)}%)` : ''));
console.log(`  API price differs ........ ${moved.length} / ${comparable.length}`);
console.log(`  onSale:true .............. ${onSaleTrue.length} / ${ok.length}`);
console.log(`  salePrice == regularPrice  ${saleEqRegular.length} / ${ok.length}   <- comp signature`);
console.log('');
console.log('  price-ish fields the API returned under show=all:');
Object.entries(fieldUniverse).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`    ${k.padEnd(28)} ${v}`));
console.log('');
if (undercuts.length) {
  console.log(`  *** ${undercuts.length} case(s) where another field UNDERCUTS salePrice — inspect these first:`);
  undercuts.slice(0, 20).forEach((u) =>
    console.log(`    sku ${u.sku}  ${u.field} = ${u.value}  (salePrice ${u.salePrice})`));
} else {
  console.log('  No field undercuts salePrice anywhere in the sample.');
  console.log('  => the API does not publish the real selling price under ANY key. B3 stands.');
}

// ── Browser checklist — the only ground truth ─────────────────────────────
// Spread across strata; a human opens these and writes down what the PDP says.
const checklist = [];
for (const s of ['control', 'high-vs-peers', 'inline-vs-peers', 'sole-retailer', 'recently-confirmed']) {
  ok.filter((r) => r.stratum === s).slice(0, 2).forEach((r) => checklist.push(r));
}
console.log('');
console.log(bar);
console.log('BROWSER CHECKLIST — open each, write down the price actually shown');
console.log('(Akamai blocks datacenter IPs, so this cannot be automated from CI.)');
console.log(bar);
for (const r of checklist) {
  console.log(`  sku ${r.sku}  ${String(r.name || r.apiName || '').slice(0, 62)}`);
  console.log(`      API says $${r.salePrice} (reg $${r.regularPrice}, onSale ${r.onSale}) | we show ${r.stored == null ? '-' : '$' + r.stored}`);
  console.log(`      https://www.bestbuy.com/site/-/${r.sku}.p?skuId=${r.sku}`);
  console.log(`      PDP shows: ______   member price shown? ______`);
}

if (!existsSync(path.dirname(OUT))) mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  probedAt: new Date().toISOString(),
  sampleSize: sample.length,
  summary: {
    ok: ok.length, apiErrors,
    identicalToStored: identical.length, movedVsStored: moved.length, comparable: comparable.length,
    onSaleTrue: onSaleTrue.length, saleEqRegular: saleEqRegular.length,
    fieldUniverse, undercuts,
  },
  results,
}, null, 2));
console.log('');
console.log('Report written: ' + OUT);
console.log('');
console.log('HOW TO READ IT:');
console.log('  saleEqRegular high + no undercuts  -> API publishes list/comp only. Do NOT cron it.');
console.log('  identicalToStored ~100%            -> API is static vs our snapshot; a cron adds');
console.log('                                        fresh-looking timestamps and nothing else.');
console.log('  movedVsStored high + PDP agrees    -> API is live and correct; cron is justified.');
console.log('  movedVsStored high + PDP disagrees -> API is live and WRONG; worst case, cron banned.');
