// stale-quarantine-report.mjs
//
// Sorts every row currently hidden by `needsReview` into what could come back,
// what is deliberately held, and what has nowhere to send a buyer.
//
// This script NEVER writes to the catalog. It reads src/data/parts.js and
// writes one JSON report. Lifting a quarantine is a separate, human-approved
// step — a sweep that both decides and applies is a sweep nobody reviews.
//
//   node stale-quarantine-report.mjs [out.json]
//
// WHY THIS EXISTS
//
// 2054 rows sat quarantined with no recorded cause (fixed forward by the
// quarantineReason field, which does not backfill history). So the question
// "can this row come back?" cannot be answered by reading why it was held —
// it has to be answered from whether it still QUALIFIES today.
//
// TWO THINGS THE FIRST RUN FOUND, both of which shape the rule below:
//
//   1. Being hidden does not stop the refresh jobs. Rows quarantined in July
//      carry priceConfirmedAt of the current day, and no candidate had a
//      confirmed price older than 20 days. Price AGE is therefore not the
//      staleness signal it looks like. The real gap is rows that have never
//      been stamped at all — no confirmation on record, at any age. Those read
//      as blank rather than old, so an age sort floats them to the top as if
//      they were fine.
//
//   2. A fresh price is not a sane price. Rows confirmed the same day sat at
//      4x MSRP (a Ryzen 3 8300G at $534 against a $129 MSRP). Confirmation
//      records that a number was observed, not that it is right.
//
// So the report separates UNVERIFIED and IMPLAUSIBLE from liftable, rather than
// ranking everything on one freshness axis.

import { readFileSync, writeFileSync } from 'node:fs';

// ── how the SITE reads a deal ────────────────────────────────────────────────
//
// Copied in behaviour from src/App.jsx and src/ProductPage.jsx. This matters
// more than it looks: the catalog stores retailer links as `url` on some rows
// and `linkurl` on others, and prices as `price`/`saleprice`. A liveness check
// that reads only `url` and `price` reports the Best Buy and Newegg shapes as
// dead and undercounts what is actually buyable. A field in a shape the site
// cannot read is not coverage — and a field in a shape THIS script cannot read
// is not a dead link.

export const dealPrice = (d) => {
  if (!d || typeof d !== 'object') return null;
  const list = Number(d.price);
  const sale = Number(d.saleprice);
  const hasList = Number.isFinite(list) && list > 0;
  const hasSale = Number.isFinite(sale) && sale > 0;
  if (hasList && hasSale) return Math.min(list, sale);
  if (hasSale) return sale;
  return hasList ? list : null;
};

export const dealUrl = (d) => (d && (d.url || d.linkurl)) || null;

// A deal a customer can actually act on: a link the site would render, a price
// the site would quote, and not explicitly out of stock.
export const buyableDeals = (p) =>
  Object.entries(p.deals || {})
    .filter(([, d]) => d && typeof d === 'object' && dealUrl(d) && dealPrice(d) != null && d.inStock !== false)
    .map(([retailer, d]) => ({
      retailer,
      price: dealPrice(d),
      confirmedAt: d.priceConfirmedAt || null,
      confidence: d.priceConfidence || null,
    }));

// A link the site would still render, but with no usable price or stamped out
// of stock. Tracked separately so "no live deal" is not overstated — these rows
// have something to repair, which is different from having nothing at all.
export const deadLinkRetailers = (p) =>
  Object.entries(p.deals || {})
    .filter(([, d]) => d && typeof d === 'object' && dealUrl(d))
    .filter(([, d]) => dealPrice(d) == null || d.inStock === false)
    .map(([retailer]) => retailer);

// The ASIN is stored inconsistently: a top-level field on some rows, inside the
// amazon deal on others, and on the rest only as the /dp/ segment of the URL.
// Reading one of the three reports rows as having no ASIN when they do.
export const asinOf = (p) =>
  p.asin ||
  p.deals?.amazon?.asin ||
  String(p.deals?.amazon?.url || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1] ||
  null;

// ── the boundary rule ────────────────────────────────────────────────────────
//
// A row is DELIBERATELY HELD when it carries a cause a healthy price can never
// resolve. This is the one knob in the report: every row not matching these is
// judged on price and liveness alone, so widening or narrowing this set is what
// moves rows between "held" and "candidate".

const TAXONOMY   = /^(cpu_ff|storage_ff|storage_brand|nas_appliance|server_redundant|prebuilt-system)/;
const PRICE_BAND = /^(cpu_price|storage_price)/;
const IDENTITY   = /^(detector:wrong-asin|wrong-asin|relink:mismatch)/;

export function deliberateHold(p) {
  const flags = p.reviewFlags || [];
  const hit = (re) => flags.find((f) => re.test(f));

  const taxonomy = hit(TAXONOMY);
  if (taxonomy) return { reason: 'out-of-scope product', flag: taxonomy };

  const band = hit(PRICE_BAND);
  if (band) return { reason: 'price outside category band', flag: band };

  // A wrong or unconfirmed ASIN is the case a good price actively disguises:
  // the price is real, it is just the price of a different product.
  const identity = hit(IDENTITY);
  if (identity) return { reason: 'wrong/unconfirmed product identity', flag: identity };

  if (p.bundle) return { reason: 'bundle, not a single part', flag: 'bundle:true' };
  if (p.used) return { reason: 'used/refurbished', flag: 'used:true' };
  if (p.condition && !/new/i.test(String(p.condition)))
    return { reason: 'non-new condition', flag: `condition:${p.condition}` };

  return null;
}

// Outside this band the price is not plausible for the product regardless of
// when it was confirmed. Deliberately loose — this is a "something is wrong
// here" trip, not a pricing model, and a tight band would bury real sales.
export const MSRP_HIGH = 2;
export const MSRP_LOW = 0.5;

export const implausible = (ratio) => ratio != null && (ratio >= MSRP_HIGH || ratio <= MSRP_LOW);

export const daysBetween = (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000);

/**
 * Classify one row. Returns the row summary plus a `bucket`:
 *
 *   held        deliberately held — a healthy price cannot clear it
 *   no-deal     nothing buyable; needs a relink, not a lift
 *   unverified  no priceConfirmedAt on record, at any age
 *   implausible price outside the MSRP band despite being confirmed
 *   liftable    everything else
 *
 * The order matters. `held` outranks everything because those rows should never
 * be judged on price at all. `unverified` and `implausible` are reported as
 * their own buckets rather than dropped, so the excluded rows stay countable —
 * a row that vanishes from the report cannot be reasoned about later.
 */
export function classify(p, today) {
  const buyable = buyableDeals(p);
  const best = buyable.length ? buyable.reduce((a, b) => (a.price <= b.price ? a : b)) : null;
  const confirmedAt = best?.confirmedAt || p.deals?.amazon?.priceConfirmedAt || null;
  const msrp = typeof p.msrp === 'number' && p.msrp > 0 ? p.msrp : null;

  const row = {
    id: p.id,
    name: p.n,
    category: p.c,
    brand: p.b,
    asin: asinOf(p),
    price: best ? best.price : null,
    retailer: best ? best.retailer : null,
    // The Amazon price specifically, kept alongside the cheapest-retailer price.
    // A live PA API check compares against THIS: `price` on a multi-retailer row
    // is often Newegg, and checking a Newegg price against an Amazon Buy Box
    // would fail every one of them.
    amazonPrice: dealPrice(p.deals?.amazon) ?? null,
    msrp,
    msrpRatio: msrp && best ? +(best.price / msrp).toFixed(2) : null,
    quarantinedAt: p.quarantinedAt || null,
    quarantineAgeDays: p.quarantinedAt ? daysBetween(p.quarantinedAt, today) : null,
    priceConfirmedAt: confirmedAt,
    priceAgeDays: confirmedAt ? daysBetween(confirmedAt, today) : null,
    priceConfidence: best?.confidence || null,
    buyableRetailers: buyable.map((d) => d.retailer),
    deadLinkRetailers: deadLinkRetailers(p),
    reviewFlags: p.reviewFlags || [],
    quarantineReason: p.quarantineReason || null,
  };

  const hold = deliberateHold(p);
  if (hold) return { ...row, bucket: 'held', holdReason: hold.reason, holdFlag: hold.flag };
  if (!buyable.length) return { ...row, bucket: 'no-deal' };
  if (row.priceAgeDays == null) return { ...row, bucket: 'unverified' };
  if (implausible(row.msrpRatio)) return { ...row, bucket: 'implausible' };
  return { ...row, bucket: 'liftable' };
}

export function sweep(parts, today) {
  const rows = parts.filter((p) => p.needsReview).map((p) => classify(p, today));
  const by = (b) => rows.filter((r) => r.bucket === b);
  return {
    generatedFor: today,
    totals: {
      quarantined: rows.length,
      liftable: by('liftable').length,
      unverified: by('unverified').length,
      implausible: by('implausible').length,
      noDeal: by('no-deal').length,
      held: by('held').length,
    },
    liftable: by('liftable'),
    unverified: by('unverified'),
    implausible: by('implausible'),
    noDeal: by('no-deal'),
    held: by('held'),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const OUT = process.argv[2] || 'stale-quarantine-report.json';
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);

  const { PARTS } = await import('./src/data/parts.js');
  const report = sweep(PARTS, today);

  writeFileSync(OUT, JSON.stringify(report, null, 2));

  const t = report.totals;
  console.log(`Hidden rows (needsReview):   ${t.quarantined}`);
  console.log(`  deliberately held          ${t.held}`);
  console.log(`  no live deal               ${t.noDeal}`);
  console.log(`  unverified (never stamped) ${t.unverified}`);
  console.log(`  implausible vs MSRP        ${t.implausible}`);
  console.log(`  LIFTABLE                   ${t.liftable}`);

  const byCat = {};
  for (const r of report.liftable) byCat[r.category] = (byCat[r.category] || 0) + 1;
  console.log('\nLiftable by category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${c}`);

  // The confirmed/unconfirmed split inside the liftable set. Not an exclusion —
  // these rows have a price on record — but `unconfirmed` carries the same
  // "observed, not verified" caveat that the unverified bucket is excluded for.
  const unconf = report.liftable.filter((r) => r.priceConfidence !== 'confirmed').length;
  console.log(`\nOf the liftable rows, ${unconf} carry priceConfidence other than "confirmed".`);
  console.log(`\nWrote ${OUT} — the catalog was not modified.`);
}
