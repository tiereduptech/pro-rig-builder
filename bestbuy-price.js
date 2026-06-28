// Best Buy price sanity + gate-driven removal (Stage B3).
//
// CONFIRMED LIVE (2026-06-28): Best Buy exposes NO reliable real-price source via
// affiliate feeds. For sku 6519477 (Ryzen 7 7700X) the Developer API returns
// salePrice=399.99 (onSale:false) AND the Impact catalog returns CurrentPrice
// 399.99 / DiscountPercentage "" / Promotions [] — both the struck-through "Comp.
// Value", not the real $239.99 selling price (a My Best Buy Plus/Total member price
// that no feed publishes). So B3 is NOT a field swap: when a Best Buy price is a
// comp-signature outlier vs the product's other retailers, it must be REMOVED.
// Showing $399.99 as "the deal" when the truth is far lower misleads buyers.

import { classifyDeal, effectivePrice, dispersion, CLASS } from './price-sanity.js';

// Cross-retailer sanity for a candidate Best Buy price. Peers: amazon, newegg.
// IMPORTANT: callers in the corrective sweep should pass CORRECTED peer prices
// (post B1 New-Amazon / B2 first-party-Newegg), not the raw dirty values, so a
// comp price isn't excused by an equally-wrong peer. See peerOverride.
export function bestbuySanity(product, candidatePrice, peerOverride = null) {
  const deals = (product && product.deals) || {};
  const peers = peerOverride
    ? peerOverride.filter((v) => Number.isFinite(v) && v > 0)
    : ['amazon', 'newegg'].map((r) => effectivePrice(deals[r])).filter((v) => v != null);
  const res = classifyDeal(candidatePrice, peers, product && product.pr, product && product.msrp);
  const hypo = { deals: { ...deals, bestbuy: { price: candidatePrice } } };
  const disp = dispersion(hypo);
  const perRetailerOk = res.cls === CLASS.OK || res.cls === CLASS.UNVERIFIED;
  return {
    pass: perRetailerOk && !disp.conflicting,
    cls: res.cls, ref: res.ref, deviation: res.deviation,
    dispConflict: disp.conflicting, spread: disp.spread,
  };
}

// Decide what to do with a Best Buy price at attach/sweep time.
// Returns { action: 'keep' | 'drop', reason, sanity }.
//   drop  -> comp-signature outlier (SUSPECT_HIGH / SUSPECT_VS_LIST high) OR a
//            >threshold disagreement with a sole peer (SUSPECT_PAIR) where BB is
//            the higher side. We only DROP when Best Buy is the HIGH outlier — a
//            low BB price is not the comp bug and is left for normal review.
//   keep  -> within tolerance, or unverifiable (no peers) — kept as-is.
export function bestbuyDecision(product, candidatePrice, peerOverride = null) {
  const sanity = bestbuySanity(product, candidatePrice, peerOverride);
  if (sanity.pass) return { action: 'keep', reason: 'sane', sanity };
  // Only remove when Best Buy is the HIGH side (comp/list signature).
  const isHigh =
    sanity.cls === CLASS.SUSPECT_HIGH ||
    (sanity.cls === CLASS.SUSPECT_VS_LIST && sanity.deviation != null && sanity.deviation > 0) ||
    (sanity.cls === CLASS.SUSPECT_PAIR && sanity.deviation != null && sanity.deviation > 0);
  if (isHigh) return { action: 'drop', reason: `comp-signature ${sanity.cls}`, sanity };
  return { action: 'keep', reason: `flagged ${sanity.cls} (not high-outlier)`, sanity };
}
