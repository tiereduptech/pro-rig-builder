// verify-quarantine-lift.mjs
//
// The step stored state cannot do: ask Amazon, today, whether a shortlisted
// row's link still resolves and its price is still right.
//
// REPORT ONLY. Writes one JSON report under catalog-build/ and never touches
// the catalog. Nothing is un-hidden here — a pass that both verifies and lifts
// is a pass nobody reviews.
//
//   node verify-quarantine-lift.mjs [out.json]
//
// WHERE THE INPUT COMES FROM
//
// stale-quarantine-report.mjs narrows 2070 hidden rows to a shortlist using
// only what the catalog stores. This script takes the strictest tier of that
// shortlist — liftable AND priceConfidence === 'confirmed' — and re-checks it
// live. Stored state can only narrow the field; it cannot tell us whether the
// price matches Amazon today or the link resolves.
//
// WHAT COUNTS AS VERIFIED
//
// A row is `confirmed` only when ALL THREE hold:
//
//   1. PA API returns the item at all       — the ASIN still exists
//   2. classifyBuyBox says CONFIRMED        — a New, in-stock Buy Box
//   3. the live price matches what we store — within PRICE_TOLERANCE
//
// Every other outcome keeps the row hidden, and each has its own verdict so the
// list stays actionable rather than collapsing to pass/fail:
//
//   price_moved   link and Buy Box are fine, our stored price is stale. Not a
//                 lift — it is a re-price, which is a different action. The live
//                 price travels with the row so that action is one step away.
//   unconfirmed   the listing exists but a New Buy Box could not be confirmed.
//                 Ambiguous is not wrong (see classifyBuyBox) — but ambiguous is
//                 also not grounds to put a row back on the site.
//   bad           affirmatively wrong: Buy Box out of stock, or nothing New is
//                 offered at all.
//   not_returned  PA API returned no item for the ASIN. The affiliate link is
//                 dead; this row needs a relink, not a lift.
//   unverifiable  no Amazon ASIN on the row (Best Buy / Newegg only). PA API
//                 has nothing to say about it, so it cannot clear this bar.
//                 Reported, never silently dropped.
//
// A DEGRADED RUN MUST NOT READ AS A CLEAN ONE
//
// resolveItems never throws and returns an empty Map when the client is
// circuit-open. Without a check, a fully-degraded run would mark all 548 rows
// `not_returned` and look like the catalog had rotted overnight. So the run
// asserts PA API health at the end and marks the whole report degraded, and the
// workflow fails, rather than emitting a confident wrong answer.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { sweep } from './stale-quarantine-report.mjs';
import { resolveItems, paapiStatus, onPaapiAlert, DEFAULT_RESOURCES, preflightPaapi } from './amazon-paapi.js';
import { classifyBuyBox, BUYBOX_STATE } from './amazon-price.js';

// A live price this close to the stored one is the same price. Wider than a
// rounding wobble, far tighter than a real price move — a row outside it is
// reported as price_moved rather than quietly lifted at the wrong number.
export const PRICE_TOLERANCE = 0.02;

export const priceAgrees = (stored, live) => {
  if (!(Number.isFinite(stored) && stored > 0) || !(Number.isFinite(live) && live > 0)) return false;
  return Math.abs(live - stored) / stored <= PRICE_TOLERANCE;
};

/**
 * Verdict for one shortlisted row against the PA API item it resolved to.
 * Pure — no I/O — so the decision table is testable without network.
 */
export function verdictFor(row, item) {
  const stored = row.amazonPrice;

  if (!row.asin) {
    return { verdict: 'unverifiable', reason: 'no Amazon ASIN on the row', livePrice: null };
  }
  if (!item) {
    return { verdict: 'not_returned', reason: 'PA API returned no item for this ASIN', livePrice: null };
  }

  const box = classifyBuyBox(item);
  if (box.state === BUYBOX_STATE.BAD) {
    return { verdict: 'bad', reason: box.reason, livePrice: null };
  }
  if (box.state === BUYBOX_STATE.UNCONFIRMED) {
    return { verdict: 'unconfirmed', reason: box.reason, livePrice: null };
  }

  const live = box.offer?.price ?? null;
  if (!priceAgrees(stored, live)) {
    return {
      verdict: 'price_moved', reason: 'New Buy Box confirmed, stored price does not match',
      livePrice: live, seller: box.offer?.seller ?? null, source: box.offer?.source ?? null,
    };
  }
  return {
    verdict: 'confirmed', reason: box.reason, livePrice: live,
    seller: box.offer?.seller ?? null, source: box.offer?.source ?? null,
  };
}

/**
 * The strictest tier of the stored-state shortlist: liftable AND the price we
 * hold is marked confirmed. `unconfirmed` and absent-confidence rows are
 * excluded here for the same reason never-stamped rows are excluded upstream —
 * observed is not verified.
 */
export function shortlist(parts, today) {
  return sweep(parts, today).liftable
    .filter(r => r.priceConfidence === 'confirmed')
    .map(r => ({
      id: r.id, name: r.name, category: r.category, asin: r.asin,
      // Compare against the AMAZON price specifically. r.price is the cheapest
      // buyable retailer, which on a multi-retailer row is often Newegg — and
      // checking a Newegg price against an Amazon Buy Box would fail every one.
      amazonPrice: r.amazonPrice,
      price: r.price, retailer: r.retailer,
      quarantinedAt: r.quarantinedAt, priceConfirmedAt: r.priceConfirmedAt,
      buyableRetailers: r.buyableRetailers, msrp: r.msrp, msrpRatio: r.msrpRatio,
    }));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (invokedDirectly) {
  const OUT = process.argv[2] || 'catalog-build/quarantine-lift-verification.json';
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);

  const alerts = [];
  onPaapiAlert(a => { alerts.push(a); console.log(`  ⚠ PA API alert: ${a.reason} — ${a.detail || ''}`); });
  // preflightPaapi calls resetPaapi(), so alerts raised while probing say
  // nothing about the run itself. Only alerts AFTER it degrade the result.

  const { PARTS } = await import('./src/data/parts.js');
  const rows = shortlist(PARTS, today);
  const asins = [...new Set(rows.map(r => r.asin).filter(Boolean))];

  console.log(`Shortlist: ${rows.length} rows (${asins.length} unique ASINs, ` +
              `${rows.filter(r => !r.asin).length} with no ASIN to check).`);

  // Fail loudly BEFORE spending a run if the client cannot authenticate at all.
  await preflightPaapi(asins.slice(0, 2));
  if (!paapiStatus().available) {
    console.error(`::error::PA API unavailable before the run started — ${paapiStatus().disabledReason || 'unknown'}. ` +
                  `No verification performed; every row stays hidden.`);
    process.exit(1);
  }

  const alertsBeforeRun = alerts.length;
  console.log(`Resolving ${asins.length} ASINs (batches of 10, ~1 req/s)...`);
  const items = await resolveItems(asins, { resources: DEFAULT_RESOURCES });
  console.log(`PA API returned ${items.size} of ${asins.length} ASINs.`);

  const results = rows.map(r => ({ ...r, ...verdictFor(r, r.asin ? items.get(r.asin) || null : null) }));

  const by = v => results.filter(r => r.verdict === v);
  const status = paapiStatus();

  // A run that degraded partway through has already mismarked rows as
  // not_returned. Say so instead of publishing the count as if it were real.
  const runAlerts = alerts.slice(alertsBeforeRun);
  const degraded = !status.available || runAlerts.length > 0;

  const report = {
    generatedFor: today,
    degraded,
    paapi: { ...status, alerts: runAlerts },
    totals: {
      shortlist: results.length,
      confirmed: by('confirmed').length,
      priceMoved: by('price_moved').length,
      unconfirmed: by('unconfirmed').length,
      bad: by('bad').length,
      notReturned: by('not_returned').length,
      unverifiable: by('unverifiable').length,
    },
    confirmed: by('confirmed'),
    priceMoved: by('price_moved'),
    unconfirmed: by('unconfirmed'),
    bad: by('bad'),
    notReturned: by('not_returned'),
    unverifiable: by('unverifiable'),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  const t = report.totals;
  console.log(`\nShortlist verified against Amazon:  ${t.shortlist}`);
  console.log(`  CONFIRMED — link + Buy Box + price ${t.confirmed}`);
  console.log(`  price moved (re-price, not lift)   ${t.priceMoved}`);
  console.log(`  Buy Box unconfirmed                ${t.unconfirmed}`);
  console.log(`  affirmatively bad                  ${t.bad}`);
  console.log(`  ASIN returned nothing (dead link)  ${t.notReturned}`);
  console.log(`  not checkable via PA API           ${t.unverifiable}`);

  const byCat = {};
  for (const r of report.confirmed) byCat[r.category] = (byCat[r.category] || 0) + 1;
  console.log('\nConfirmed by category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${c}`);

  console.log(`\nWrote ${OUT} — the catalog was not modified.`);

  if (degraded) {
    console.error(`::error::PA API degraded during the run (${status.disabledReason || 'see alerts'}). ` +
                  `Counts above are NOT a clean result — rerun before acting on them.`);
    process.exit(1);
  }
}
