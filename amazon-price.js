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

// DataForSEO sellers `condition` values seen: "New", "Used - Very Good",
// "Used - Like New", "Used - Good", "Renewed", "Open Box", "Collectible".
// Only an exact "New" counts as a first-party / new-condition offer.
export function isNewCondition(offer) {
  return /^new$/i.test(String(offer && offer.condition || '').trim());
}

// Lowest offer price of ANY condition — i.e. what the OLD asin-endpoint code
// (price_from) effectively grabbed. Used only to show the before/after contrast.
export function lowestAnyConditionPrice(result0) {
  const offers = Array.isArray(result0 && result0.items) ? result0.items : [];
  const prices = offers.map(o => Number(o && o.price && o.price.current)).filter(n => n > 0);
  return prices.length ? Math.min(...prices) : null;
}

// Select the NEW-condition Buy Box price from a /merchant/amazon/sellers result.
//   result0 = task.result[0] = { asin, title, items: [offers...], ... }
// Returns { price, seller, condition, source } or null when NO New offer exists.
//   source: 'buybox'      -> the Buy Box winner (main item) is New
//           'lowest_new'  -> Buy Box not New; took the cheapest New offer
export function selectNewOffer(result0) {
  const offers = Array.isArray(result0 && result0.items) ? result0.items : [];
  const priceOf = o => Number(o && o.price && o.price.current);

  // 1) Buy Box winner. Amazon badges only USED conditions ("Used - …", "Renewed",
  //    "Open Box"); the default featured (New) offer is often returned with a
  //    null/empty condition. So the buybox counts as New when it is explicitly
  //    "New" OR unlabeled — but never when it carries a used/refurb badge.
  const main = offers.find(o => o && o.type === 'amazon_seller_main_item');
  if (main && priceOf(main) > 0) {
    const c = String(main.condition || '').trim();
    if (c === '' || /^new$/i.test(c)) {
      return { price: priceOf(main), seller: main.seller_name || main.ships_from || null,
               condition: main.condition || 'New (unlabeled buybox)', source: 'buybox' };
    }
  }
  // 2) Buy Box is used/absent — take the cheapest EXPLICITLY New offer. (Non-buybox
  //    offers get no unlabeled benefit; an unbadged side offer is too ambiguous.)
  const news = offers.filter(o => isNewCondition(o) && priceOf(o) > 0)
                     .sort((a, b) => priceOf(a) - priceOf(b));
  if (news.length) {
    const o = news[0];
    return { price: priceOf(o), seller: o.seller_name || o.ships_from || null,
             condition: o.condition, source: 'lowest_new' };
  }
  return null;
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
