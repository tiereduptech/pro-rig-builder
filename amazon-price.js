// Amazon price selection + cross-retailer sanity gate (Stage B1).
//
// Shared by verify-catalog-asins.js (production) and the B1 sample test, so both
// exercise identical logic. Pure functions + classifier; no network, no writes.
//
// Why this exists: the /merchant/amazon/asin endpoint exposes only price_from
// (the LOWEST offer of ANY condition) — which silently grabbed "Used - Very Good"
// offers. The /merchant/amazon/sellers endpoint instead returns per-offer
// `condition` + `seller_name`, letting us pick the NEW-condition Buy Box price.

import { classifyDeal, effectivePrice, dispersion, CLASS } from './price-sanity.js';

// Two offer shapes reach this module:
//
//   DataForSEO sellers  { type: 'amazon_seller_main_item', condition: 'New',
//                         price: { current }, seller_name, ships_from }
//   Amazon PA API v2    { isBuyBoxWinner: true, condition: { value: 'New' },
//                         price: { money: { amount } }, merchantInfo: { name } }
//
// normalizeOffer() flattens both so the selection rule below is written once.
// PA API is the better source: it labels condition on EVERY listing and states
// buy-box ownership as an explicit boolean, so nothing has to be inferred.
export function normalizeOffer(o) {
  if (!o || typeof o !== 'object') return null;
  const paCondition = o.condition && typeof o.condition === 'object' ? o.condition.value : null;
  const condition = String(paCondition ?? o.condition ?? '').trim();
  const price = Number(
    o.price && o.price.money ? o.price.money.amount : (o.price ? o.price.current : NaN)
  );
  // isBuyBoxWinner is authoritative when present (PA API). The DataForSEO feed
  // has no such field, so fall back to its main-item marker.
  const isBuyBox = typeof o.isBuyBoxWinner === 'boolean'
    ? o.isBuyBoxWinner
    : o.type === 'amazon_seller_main_item';
  const seller = (o.merchantInfo && o.merchantInfo.name) || o.seller_name || o.ships_from || null;
  // Availability: PA API gives availability.type ('OUT_OF_STOCK' | 'IN_STOCK' | …);
  // the DataForSEO feed has no such field, so absence reads as in-stock (a returned
  // priced offer implies purchasable there). An out-of-stock Buy Box must never be
  // priced from — its number is a stale/placeholder figure no buyer can transact on.
  const availRaw = o.availability && (typeof o.availability === 'object' ? o.availability.type : o.availability);
  const outOfStock = /out.?of.?stock|unavailable/i.test(String(availRaw || ''));
  return { condition, price, isBuyBox, seller, outOfStock, explicitBuyBox: typeof o.isBuyBoxWinner === 'boolean' };
}

// First-party vs marketplace. Amazon's own retail offer lists the seller as
// "Amazon.com"; anything else is a 3P marketplace seller. A blank/unknown seller on
// a New Buy Box is treated as 3P — conservative, so it still has to clear the harder
// 3P gate before a write. ("Amazon Warehouse" / "Amazon Resale" are USED and never
// reach here, having failed the New check.)
export function sellerTier(seller) {
  return /^amazon(\.com)?$/i.test(String(seller || '').trim()) ? '1p' : '3p';
}

// DataForSEO sellers `condition` values seen: "New", "Used - Very Good",
// "Used - Like New", "Used - Good", "Renewed", "Open Box", "Collectible".
// PA API uses condition.value: "New" | "Used" | "Collectible" | "Refurbished".
// Only an exact "New" counts as a first-party / new-condition offer.
export function isNewCondition(offer) {
  const n = normalizeOffer(offer);
  return !!n && /^new$/i.test(n.condition);
}

function offersOf(result0) {
  if (Array.isArray(result0 && result0.items)) return result0.items;                 // DataForSEO
  if (Array.isArray(result0 && result0.offersV2 && result0.offersV2.listings)) {     // PA API item
    return result0.offersV2.listings;
  }
  if (Array.isArray(result0 && result0.listings)) return result0.listings;           // PA API offersV2
  return [];
}

// Lowest offer price of ANY condition — i.e. what the OLD asin-endpoint code
// (price_from) effectively grabbed. Used only to show the before/after contrast.
//
// NOTE: only meaningful on a DataForSEO sellers result, which returns the full
// offer table. PA API caps offersV2.listings at buy-box + one alternate, so this
// figure is NOT reproducible from PA API data — that is why DataForSEO is
// retained for full offer scans rather than replaced.
export function lowestAnyConditionPrice(result0) {
  const prices = offersOf(result0).map(o => normalizeOffer(o))
    .map(n => n && n.price).filter(n => n > 0);
  return prices.length ? Math.min(...prices) : null;
}

// Select the Buy Box price to write for a listing.
//   result0 = DataForSEO task.result[0] = { asin, title, items: [offers...] }
//          OR a PA API item             = { asin, offersV2: { listings: [...] } }
// Returns { price, seller, condition, source } or null when there is nothing safe
// to write.
//   source: '1p' -> Buy Box won by Amazon.com (first-party), New, in stock
//           '3p' -> Buy Box won by a marketplace seller, New, in stock
//
// THE ONLY offer we price from is the Buy Box winner, in stock, EXPLICITLY New.
//   - Never a non-buybox side offer. Writing the cheapest 3P New *side* offer as
//     "the price" (the old `lowest_new` fallback) is what put a marketplace price
//     on the row for ~68% of a run's writes; a side offer is not the price a buyer
//     sees at the link, so it is never written.
//   - Never Used/Renewed/Refurb, never an unlabeled/absent Buy Box, never OOS.
//   - Both 1P and 3P New buyboxes ARE written — most legitimate Amazon listings are
//     3P even for genuinely new product, so 1P-only would gut coverage. The source
//     tag drives harder downstream gating + buyer disclosure, not exclusion.
// Anything that is not a New, in-stock Buy Box → null. Callers must NOT read a
// null as "quarantine": use classifyBuyBox() to tell ambiguous from wrong.
export function selectNewOffer(result0) {
  const offers = offersOf(result0).map(normalizeOffer).filter(Boolean);
  const main = offers.find(o => o.isBuyBox);
  if (!main || !(main.price > 0) || main.outOfStock || !/^new$/i.test(main.condition)) {
    return null;
  }
  return { price: main.price, seller: main.seller, condition: main.condition,
           source: sellerTier(main.seller) };
}

// AMBIGUOUS IS NOT WRONG.
//
// Buy-Box-only pricing is right, but treating every non-confirmable listing as a
// defect is not: measured over a 250-row tier-1 sample, nulling them would have
// blanked ~655 tier-1 rows, the large majority of which are perfectly good rows
// whose Buy Box merely could not be confirmed New from the DataForSEO feed
// (which, unlike PA API, has no isBuyBoxWinner field and often returns a blank
// condition on the featured offer).
//
// So the verdict is three-way, not two:
//
//   'confirmed'   New, in stock, Buy Box     -> write the price
//   'unconfirmed' cannot confirm, but the product IS available New somewhere on
//                 the listing (or the Buy Box is merely unlabeled)
//                                            -> KEEP the existing price, tag it,
//                                               do NOT quarantine
//   'bad'         affirmatively wrong: Buy Box out of stock, or nothing New is
//                 offered at all (Used/Renewed/Refurb only)
//                                            -> quarantine
//
// Note the deliberate call on a Used/Renewed Buy Box: if an explicitly New offer
// exists elsewhere on the listing, the row still describes a real, purchasable
// New product and is only 'unconfirmed'. It is 'bad' only when NOTHING on the
// listing is New — that is the pre-existing no_new_offer case, unchanged. Price
// gates (ceiling, drift, 3P sanity) run downstream on 'confirmed' and can still
// quarantine on their own.
export const BUYBOX_STATE = { CONFIRMED: 'confirmed', UNCONFIRMED: 'unconfirmed', BAD: 'bad' };

export function classifyBuyBox(result0) {
  const offers = offersOf(result0).map(normalizeOffer).filter(Boolean);
  const main = offers.find(o => o.isBuyBox);
  const newElsewhere = offers.some(o => /^new$/i.test(o.condition) && o.price > 0);

  if (!main || !(main.price > 0)) {
    return newElsewhere
      ? { state: BUYBOX_STATE.UNCONFIRMED, reason: 'no_buybox_but_new_offer_exists' }
      : { state: BUYBOX_STATE.BAD, reason: 'no_buybox_no_new_offer' };
  }
  if (main.outOfStock) {
    return { state: BUYBOX_STATE.BAD, reason: 'buybox_out_of_stock' };
  }
  if (/^new$/i.test(main.condition)) {
    return {
      state: BUYBOX_STATE.CONFIRMED, reason: 'buybox_new',
      offer: { price: main.price, seller: main.seller, condition: main.condition,
               source: sellerTier(main.seller) },
    };
  }
  if (main.condition === '') {
    // Blank == UNKNOWN. Never New, but never proof of wrong either.
    return { state: BUYBOX_STATE.UNCONFIRMED, reason: 'unlabeled_buybox' };
  }
  // Buy Box carries an explicit non-New badge.
  return newElsewhere
    ? { state: BUYBOX_STATE.UNCONFIRMED, reason: 'buybox_not_new_but_new_offer_exists' }
    : { state: BUYBOX_STATE.BAD, reason: 'buybox_not_new_no_new_offer' };
}

// Cross-retailer sanity check for a candidate Amazon price. Uses BOTH signals:
//   - per-retailer classification (candidate vs the product's other retailers,
//     or vs its list price when it's the sole retailer)
//   - product-level dispersion (price spread across all present retailers, with
//     the candidate substituted in for Amazon)
// per-retailer alone is weak with only 3 retailers (a contaminated peer median
// can mislead), so dispersion is a required second gate.
// Returns { pass, cls, ref, deviation, dispConflict, spread }.
//   pass === true ONLY when per-retailer is OK/UNVERIFIED AND no dispersion conflict.
export function amazonPriceSanity(product, candidatePrice) {
  const deals = (product && product.deals) || {};
  const peers = ['bestbuy', 'newegg'].map(r => effectivePrice(deals[r])).filter(v => v != null);
  const res = classifyDeal(candidatePrice, peers, product && product.pr, product && product.msrp);
  const hypo = { deals: { ...deals, amazon: { price: candidatePrice } } };
  const disp = dispersion(hypo);
  const perRetailerOk = res.cls === CLASS.OK || res.cls === CLASS.UNVERIFIED;
  return {
    pass: perRetailerOk && !disp.conflicting,
    cls: res.cls, ref: res.ref, deviation: res.deviation,
    dispConflict: disp.conflicting, spread: disp.spread,
  };
}
