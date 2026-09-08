// =============================================================================
//  src/offer-schema.js
//
//  Which deals may be asserted to a search engine as a schema.org Offer.
//
//  Extracted from App.jsx for the same reason src/price-freshness.js and
//  src/retailer-badges.js were: the decision and the check on the decision must
//  be the same code. Here the check is a test that runs the predicate against
//  the live catalog, because the defect was not a wrong rule — it was a correct
//  rule pointed at a field that does not exist.
//
//  ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//  ProductSchema filtered candidate offers with `d.url && dealPrice(d) != null`
//  and then kept only the confirmed ones, on the stated grounds that "asserting
//  a price nobody has checked in PRICE_STALE_AFTER_DAYS to a search engine" is
//  a lie. The filter never saw a Newegg row. All 3,198 `deals.newegg` rows
//  carry `linkurl`; exactly zero carry `url`. So the freshness filter it fed
//  was applied to a set that could not contain the lane with the worst
//  freshness in the catalog, and reported as working the whole time.
//
//  That is the third guard this month to read as applied because it could not
//  read the field it tests — see test/offer-schema.test.js, which asserts the
//  predicate matches something real in EVERY retailer lane rather than only
//  that it returns the right answer for a hand-written fixture. A predicate
//  tested solely against fixtures it was written beside can only tell you it
//  agrees with itself.
//
//  ── AND NO FALL-BACK TO THE UNCONFIRMED ─────────────────────────────────────
//  The old code ended `freshOffers.length ? freshOffers : allOffers`, which
//  republished every price it had just declined to stand behind whenever
//  nothing on the product was confirmed — precisely the case the guard was
//  written for. A fall-back that fires exactly when the check fails is not a
//  fall-back, it is an exemption. Measured on main 2026-09-08, that exemption
//  covered 1,541 of 6,936 products.
//
//  Nothing confirmed means no `offers` key. The page still shows the price,
//  under an UNCONFIRMED tag (src/retailer-badges.js), because a reader can see
//  the tag and a rich snippet cannot carry one.
// =============================================================================

import { isFresh } from './price-freshness.js';

// The fields a deal may carry its link in, in preference order.
//
// Two, not one, and this list is the whole bug: the Amazon and Best Buy write
// paths set `url`, the Newegg feed sets `linkurl` (a LinkSynergy tracking
// redirect), and consumers that knew about only one of them silently skipped
// the other's entire lane. `retailers()` in App.jsx has always read the pair.
//
// A new retailer lane whose link lands in a THIRD field belongs here, and
// test/offer-schema.test.js fails until it is added — that test walks every
// lane in the live catalog rather than the ones someone remembered.
export const OFFER_LINK_FIELDS = ['url', 'linkurl'];

/** The deal's link, or null when it has none we can publish. */
export function offerLinkOf(d) {
  if (!d || typeof d !== 'object') return null;
  for (const field of OFFER_LINK_FIELDS) {
    const v = d[field];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

// The price a deal quotes.
//
// Moved here from App.jsx rather than duplicated: this is the number the Offer
// publishes, so the rule that picks it belongs with the rule that decides
// whether to publish at all. App.jsx imports it back for the ~15 places that
// quote a price on the page, so there is still exactly one definition.
//
// Take the LOWER of price and saleprice rather than preferring saleprice
// outright: 19 rows carry a saleprice ABOVE price (bad feed data), and
// preferring it there would overstate instead of understate. A missing, null
// or zero saleprice falls back to price.
export function dealPrice(d) {
  if (!d || typeof d !== 'object') return null;
  const list = Number(d.price);
  const sale = Number(d.saleprice);
  const hasList = Number.isFinite(list) && list > 0;
  const hasSale = Number.isFinite(sale) && sale > 0;
  if (hasList && hasSale) return Math.min(list, sale);
  if (hasSale) return sale;
  return hasList ? list : null;
}

/**
 * Every deal on a product that COULD be published — it has a link and a price.
 *
 * Publishable, not publishABLE-and-true: this is the candidate set the
 * freshness rule then filters. Exported so the coverage test can ask the
 * question that matters — "does this predicate match anything in lane X" —
 * without reaching into confirmedOffers and getting an empty answer it cannot
 * distinguish from a lane that is merely all stale.
 *
 * @returns {Array<[string, object]>} [retailerName, deal] entries
 */
export function offerCandidates(deals) {
  if (!deals || typeof deals !== 'object') return [];
  return Object.entries(deals).filter(
    ([, d]) => d && typeof d === 'object' && offerLinkOf(d) && dealPrice(d) != null,
  );
}

/**
 * The offers we are willing to assert to a search engine: linked, priced, and
 * confirmed within PRICE_STALE_AFTER_DAYS.
 *
 * Returns [] when nothing qualifies, and [] must render as no `offers` key.
 * There is deliberately no fall-back — see the header.
 */
export function confirmedOffers(deals, now = Date.now()) {
  return offerCandidates(deals).filter(([, d]) => isFresh(d, now));
}

// ─── The offer the SHIPPED product page publishes ────────────────────────────
//
// src/PageMeta.jsx builds the Product schema that reaches a crawler: it is in
// 4,596 of the 4,605 prerendered product pages, where App.jsx's ProductSchema
// (gated on `isExp`) appears in none. Its selection rule lives here rather than
// inline in the .jsx because a rule inside a .jsx file cannot be imported by
// `node --test`, and a rule no test can reach is how the guard in ProductSchema
// spent its whole life passing while never running against a Newegg row.

// Retailer precedence for the single published Offer, in the order PageMeta has
// always used. Not price order: this picks WHOSE listing to name, and the
// in-stock preference below then overrides it.
//
// The per-retailer price reads differ from dealPrice() — Newegg is read as
// `saleprice || price` here versus the lower of the two there, so the ~19 rows
// carrying a saleprice ABOVE price publish a different number than the page
// shows. Preserved exactly as-is: unifying them changes published prices and is
// its own change, not a rider on a freshness fix.
export const PRIMARY_OFFER_ORDER = [
  ['amazon', (d) => d?.price],
  ['bestbuy', (d) => d?.price],
  ['newegg', (d) => d?.saleprice || d?.price],
  ['msi', (d) => d?.price],
];

/**
 * The one Offer the product page may publish, or null when nothing on the
 * product has been confirmed within PRICE_STALE_AFTER_DAYS.
 *
 * null means NO `offers` key. It must not fall back to product.pr: that is a
 * catalog reference price no retailer ever confirmed, and publishing it as an
 * InStock Offer put the least-evidenced number on the page into the strongest
 * claim the page makes. 519 products were doing exactly that.
 */
export function confirmedPrimaryOffer(deals, now = Date.now()) {
  const priced = PRIMARY_OFFER_ORDER
    .map(([key, priceOf]) => {
      const deal = deals && typeof deals === 'object' ? deals[key] : null;
      return { key, deal, price: priceOf(deal), url: offerLinkOf(deal) };
    })
    .filter((o) => typeof o.price === 'number' && o.price > 0 && isFresh(o.deal, now));
  // Buyable ahead of not, within that precedence.
  return priced.find((o) => o.deal.inStock !== false) || priced[0] || null;
}
