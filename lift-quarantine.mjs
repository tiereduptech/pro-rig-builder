// lift-quarantine.mjs
//
// The way back for a hidden row whose recorded cause has been disproved.
//
// Quarantine was a one-way door. verify-catalog keeps hidden rows on the free PA
// pass on purpose — "a row that recovers is still SEEN to recover"
// (partitionPaidPass) — and it stamps a confirmed New buy box on them, but no
// scheduled job ever acts on that stamp. From 2026-08-26 to 2026-09-11 hidden
// rows carrying an Amazon deal went 1219 -> 1488: 269 hidden, 0 lifted. A
// product Amazon went back to selling New stayed off the site for good.
//
// DRY RUN BY DEFAULT. `--apply` writes the catalog, and the resulting diff is the
// review: merging it is what puts the rows back on the site. A sweep that both
// decides and applies is a sweep nobody reviews (stale-quarantine-report.mjs),
// so the decision is pure and printed, and the write is a separate, deliberate
// invocation.
//
//   node lift-quarantine.mjs                  # print the cohort, write nothing
//   node lift-quarantine.mjs --json out.json  # the same, machine-readable
//   node lift-quarantine.mjs --apply          # lift the cohort into the catalog
//
// ── ONE CAUSE, AND THE VERDICT THAT NEGATES IT ──────────────────────────────
// A lift is keyed on the recorded cause and needs the verdict that is its exact
// negation, NEWER than the hold:
//
//   no_new_offer   the verifier read the listing and found nothing New to buy
//                  (classifyBuyBox BAD, drift-gate.js). Negated by a later
//                  CONFIRMED verdict on the same listing: a New, in-stock buy
//                  box — priceConfidence 'confirmed', priceConfirmedAt after
//                  quarantinedAt.
//
// Every other cause is out of reach here, deliberately:
//
//   price_3p_flagged, reviewFlags (relink:*, wrong-asin, taxonomy, ...),
//   asin_repair_*, priceQuarantine
//       A confirmed price is a price, not an identity. It is the case a good
//       price actively disguises: the number is real, it is just the number
//       for a different product.
//   no recorded cause
//       Cannot be lifted by anything until it has a cause. A good price does not
//       tell you which hold you are looking at.
//
// The recorded cause is only trustworthy because recordQuarantine() (drift-gate.js)
// stopped a later verdict from overwriting it. Before that, a row hidden for
// asin_repair_no_match that later read a used-only listing became no_new_offer,
// and this script would have put it back the day Amazon showed a New buy box.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

import { classify } from './stale-quarantine-report.mjs';

const require = createRequire(import.meta.url);
const gate = require('./scripts/assert-retailer-freshness.cjs');

// The one cause this path lifts. See the header for why it is only one.
export const CAUSE = 'no_new_offer';

// How recent the confirming verdict must be. Not a new number: it is the budget
// the freshness gate holds every Amazon row to, derived from verify-catalog's cron
// the same way the gate derives it. A confirmation the gate would call stale
// cannot vouch that Amazon is selling the product New today.
export const CONFIRM_FRESH_DAYS =
  gate.budgetDaysFor(gate.slowestIntervalDays(gate.citesFor(gate.CADENCE.amazon)));

const day = (t) => (t ? String(t).slice(0, 10) : null);
const ageDays = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

/**
 * Decide one row. Pure — no I/O.
 *
 *   null                       not hidden for CAUSE; this path has no opinion
 *   { lift: true, evidence }   the cause is disproved by a newer verdict
 *   { lift: false, why }       hidden for CAUSE and still held; `why` names the
 *                              first check it failed, so no row drops out of the
 *                              count
 */
export function liftDecision(p, today, freshDays = CONFIRM_FRESH_DAYS) {
  if (!p?.needsReview || p.quarantineReason !== CAUSE) return null;

  // Anything else the row is held for is a second question this path cannot
  // answer. A New buy box says nothing about identity or a 3P markup.
  if (p.quarantineAlso?.length) return { lift: false, why: `also held for ${p.quarantineAlso.join(', ')}` };
  if (p.reviewFlags?.length) return { lift: false, why: 'review flag' };
  if (p.priceQuarantine || p.priceQuarantined) return { lift: false, why: 'price quarantine' };

  // The report's own judgment of whether the row is fit for the site at all:
  // not deliberately held, something buyable, a stamp on record, a price inside
  // the MSRP band. A lift never overrules it.
  const row = classify(p, today);
  if (row.bucket !== 'liftable') return { lift: false, why: `report bucket: ${row.bucket}` };

  const a = p.deals?.amazon;
  if (!a) return { lift: false, why: 'no amazon deal' };
  const confirmedAt = day(a.priceConfirmedAt);
  if (a.priceConfidence !== 'confirmed' || !confirmedAt) return { lift: false, why: 'buy box not confirmed New' };
  if (a.inStock === false) return { lift: false, why: 'out of stock' };
  const failedAt = day(a.priceUnconfirmedAt);
  if (failedAt && failedAt >= confirmedAt) return { lift: false, why: 'unconfirmed since' };

  // The verdict that hid the row and the one that would lift it can land on the
  // same day, and the hold can be the later of the two — quarantinedAt is the
  // date of the LATEST no_new_offer verdict. Only a confirmation strictly after
  // it means Amazon's most recent word on the listing is "New, in stock".
  const heldAt = day(p.quarantinedAt);
  if (!heldAt || confirmedAt <= heldAt) return { lift: false, why: 'no confirmation since the hold' };
  if (ageDays(confirmedAt, today) > freshDays) return { lift: false, why: `confirmation older than ${freshDays}d` };

  return {
    lift: true,
    evidence: {
      heldAt, confirmedAt, price: a.price ?? null, seller: a.priceSeller ?? null,
      source: a.priceSource ?? null, via: a.priceResolvedVia ?? null, msrpRatio: row.msrpRatio,
    },
  };
}

/**
 * Lift one row in place. All four hold fields go together — a stale
 * quarantineReason on a visible row reads as a live hold to anything that
 * inspects it later (test/quarantine-reason-lock.test.js).
 */
export function applyLift(p, today) {
  const from = p.quarantineReason;
  delete p.needsReview;
  delete p.quarantinedAt;
  delete p.quarantineReason;
  delete p.quarantineAlso;
  // Kept so a row that bounces back into quarantine is recognisable as one.
  p.quarantineLiftedAt = today;
  p.quarantineLiftedFrom = from;
}

/** Every row hidden for CAUSE, split into lift and stay. */
export function sweepLifts(parts, today, freshDays = CONFIRM_FRESH_DAYS) {
  const lift = [];
  const stay = [];
  for (const p of parts) {
    const d = liftDecision(p, today, freshDays);
    if (d) (d.lift ? lift : stay).push({ p, ...d });
  }
  return { lift, stay };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const jsonAt = args.indexOf('--json');
  const today = process.env.REPORT_DATE || new Date().toISOString().slice(0, 10);

  const { PARTS } = await import('./src/data/parts.js');
  const loadedCount = PARTS.length;
  const { lift, stay } = sweepLifts(PARTS, today);

  console.log(`Hidden for ${CAUSE}: ${lift.length + stay.length}   lift: ${lift.length}   stay hidden: ${stay.length}`);
  console.log(`Evidence: a confirmed New buy box after the hold, no older than ${CONFIRM_FRESH_DAYS}d on ${today}.`);

  if (lift.length) {
    console.log('\nLIFT');
    for (const { p, evidence: e } of lift) {
      console.log(
        `  ${String(p.id).padEnd(7)} ${String(p.c).padEnd(16)} held ${e.heldAt}  confirmed ${e.confirmedAt}  ` +
        `$${String(e.price).padEnd(8)} ${String(e.source).padEnd(3)} ${String(e.seller).slice(0, 28).padEnd(28)} ` +
        `${String(e.via).padEnd(10)} ${String(p.n).slice(0, 48)}`,
      );
    }
  }

  const byWhy = {};
  for (const s of stay) (byWhy[s.why] ??= []).push(s.p.id);
  if (stay.length) {
    console.log('\nSTAY HIDDEN');
    for (const [why, ids] of Object.entries(byWhy).sort((x, y) => y[1].length - x[1].length)) {
      console.log(`  ${String(ids.length).padStart(4)}  ${why.padEnd(34)} ${ids.join(' ')}`);
    }
  }

  if (jsonAt >= 0) {
    const out = args[jsonAt + 1];
    if (!out) throw new Error('--json needs a path');
    writeFileSync(out, JSON.stringify({
      generatedFor: today, cause: CAUSE, freshDays: CONFIRM_FRESH_DAYS,
      lift: lift.map(({ p, evidence }) => ({ id: p.id, category: p.c, name: p.n, ...evidence })),
      stay: stay.map(({ p, why }) => ({ id: p.id, category: p.c, name: p.n, why })),
    }, null, 2));
    console.log(`\nWrote ${out}`);
  }

  if (!APPLY) {
    console.log('\nDry run — the catalog was not modified. Re-run with --apply to lift these rows.');
  } else if (!lift.length) {
    console.log('\nNothing to lift.');
  } else {
    for (const { p } of lift) applyLift(p, today);
    const { writeCatalog } = require('./scripts/write-catalog.cjs');
    await writeCatalog(PARTS, { loadedCount, reason: `lift ${lift.length} ${CAUSE} quarantines` });
    console.log(`\nLifted ${lift.length} rows. Land the diff through a PR — merging it puts them back on the site.`);
  }
}
