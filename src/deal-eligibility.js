// =============================================================================
//  src/deal-eligibility.js
//
//  Which savings claims the site is willing to make, and which products may be
//  FEATURED for making them.
//
//  ── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
//  `msrp` is not a manufacturer list price. It is whatever price we happened to
//  observe when the row was ingested. Every discovery writer sets it from the
//  number it had just read:
//
//      apply-amazon-cases.mjs:205   pr: price ?? null, msrp: price ?? null
//      case-ingest.mjs:226          pr: a.price ?? null, msrp: a.price ?? null
//      apply-amazon-discoveries.cjs:222   msrp: d.price
//      case-ingest.mjs:173          p.msrp = p.msrp ?? p.pr ?? c.price
//
//  On 2026-08-28, 4,342 of 6,937 rows carried msrp === pr: the "was" price was
//  a frozen copy of our own observed price. There is no other list-price field
//  in the catalog and no provenance on this one.
//
//  ── AND WHY GATING THE DISPLAY WAS NOT ENOUGH ───────────────────────────────
//  The homepage sorted every deal by (msrp - price) descending and took the top
//  three. Eligibility was trivial — any row with msrp > price, 2,635 of them —
//  so RANKING did all the selection work. A maximum taken over a noisy estimate
//  returns the noise: the biggest gap and the worst data are the same rows, so
//  the three most suspect rows in the catalog were guaranteed the three slots a
//  visitor sees first. It showed an ASUS case at "$399.99, was $1,206.66, save
//  $807" — a number no ASUS case has ever listed at, produced by a 0.75 fuzzy
//  brand+name match binding a bad discovery row to a real $399.99 listing.
//
//  A ceiling alone does not fix that shape. It caps how absurd the winner may
//  be and then hands the slot to the largest error under the cap; measured, a
//  40% ceiling still put an msrp === pr row in the top slot.
//
//  So the burden moves from RANKING to ELIGIBILITY. Rank only inside a pool
//  where every member is already defensible, and ranking can no longer
//  manufacture a claim.
//
//  ── WHAT THIS IS NOT (YET) ──────────────────────────────────────────────────
//  The right long-run reference is a drop we WATCHED: today's confirmed price
//  against the trailing prevailing price for the same retailer in that
//  product's own price history. That is not available today. The evidence rule
//  in record-price-snapshot.js — a point is recorded only if CONFIRMED or
//  MOVED — landed 2026-08-28 (a01a61bf845), so the entire 90-day window is
//  pre-rule and, in its own words, "a snapshot of parts.js" rather than of
//  prices. Tested against it, the WD_BLACK 8TB still qualified at 61% off a
//  "was" price of $3,799.99, because that bad number sat flat for 20 days and
//  had been laundered into the record as an observation.
//
//  These rules need no history, and they stay as the floor once history is
//  usable — the witnessed drop becomes an ADDITIONAL requirement, not a
//  replacement, precisely because it alone would have passed the WD_BLACK.
// =============================================================================

// A reference price more than this far above what we charge today is treated as
// evidence about the reference, not about the discount. 60% is not a claim that
// 61% off is impossible; it is the point past which a bad ingest is likelier
// than a real sale, and being wrong here costs a missing badge rather than a
// fabricated one.
export const MAX_IMPLIED_DISCOUNT = 0.60;

// A featured deal must be corroborated by a second priced retailer. This is the
// most aggressive of the guards (it alone takes 2,635 rows to 811) and the most
// blunt, since it excludes single-retailer products regardless of merit. It
// earns its place anyway: a single-retailer reference price is exactly the one
// we have no way to check, and the front page is where being wrong is loudest.
// If the pool ever gets too thin to rotate, this is the dial to turn first.
export const MIN_CORROBORATING_RETAILERS = 2;

// Below this, the row may not be the product we think it is. 115 current deals
// are driven by a row bound at under 0.90 — the ASUS case among them, at 0.75.
export const MIN_MATCH_SCORE = 0.9;

/**
 * The evidence a caller must supply. Kept as a plain object rather than a
 * product so this module holds POLICY only and the plumbing stays in App.jsx,
 * the same split as src/price-freshness.js.
 *
 * @typedef {Object} DealEvidence
 * @property {number|null} msrp            p.msrp, raw
 * @property {number|null} pr              p.pr, raw
 * @property {number|null} price           the best price we would quote today
 * @property {boolean}     fresh           is that price confirmed within PRICE_STALE_AFTER_DAYS
 * @property {number}      retailerCount   priced retailers on the row
 * @property {number|null} minMatchScore   lowest matchScore across its deals, null if none carry one
 */

/** The implied discount, or null when it cannot be computed. */
export function impliedDiscount(ev) {
  if (!ev) return null;
  const ref = Number(ev.msrp);
  const cur = Number(ev.price);
  if (!Number.isFinite(ref) || !Number.isFinite(cur) || ref <= 0 || cur <= 0) return null;
  if (cur >= ref) return null;
  return (ref - cur) / ref;
}

/**
 * May we show this product's `msrp` as a struck-through "was" price at all?
 *
 * Three questions about the REFERENCE, not about the deal:
 *   - is it independent of our own observed price, or a frozen copy of it?
 *   - is the row even the product we think it is?
 *   - is the implied discount inside the range where a reference is credible?
 *
 * Deliberately does NOT require freshness or corroboration. Those are about
 * whether this is a good enough deal to FEATURE, which is a higher bar than
 * whether the number may be printed.
 */
export function msrpIsTrustworthy(ev) {
  if (!ev) return false;
  // msrp === pr is the ingest signature: the "was" price is our own first
  // observation, wearing the name of a list price.
  if (ev.msrp == null || ev.pr == null || ev.msrp === ev.pr) return false;
  if (ev.minMatchScore != null && ev.minMatchScore < MIN_MATCH_SCORE) return false;
  const pct = impliedDiscount(ev);
  if (pct == null) return false;
  return pct <= MAX_IMPLIED_DISCOUNT;
}

/**
 * May this product occupy one of the three slots on the front page?
 *
 * Everything msrpIsTrustworthy asks, plus the two questions that make it worth
 * pointing at: is the price we are quoting confirmed, and does a second
 * retailer corroborate the reference.
 *
 * Measured 2026-08-28: 2,635 -> 339. The three that surface are a Samsung 870
 * QVO 8TB, an LG UltraFine 6K and a Ryzen 9 7950X3D, all against plausible real
 * list prices; the ASUS case, the WD_BLACK and the RTX 5090 are all excluded.
 */
export function featuredDealEligible(ev) {
  if (!msrpIsTrustworthy(ev)) return false;
  if (!ev.fresh) return false;
  return (ev.retailerCount || 0) >= MIN_CORROBORATING_RETAILERS;
}
