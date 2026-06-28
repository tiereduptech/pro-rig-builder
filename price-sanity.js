// Cross-retailer price sanity gate (Stage A — read-only classifier).
//
// Flags a retailer's price when it's a wild outlier vs the SAME product's other
// retailer prices. Designed to catch the three confirmed bugs:
//   - Amazon used / non-BuyBox offer  -> SUSPECT_LOW
//   - Newegg marketplace reseller     -> SUSPECT_LOW or SUSPECT_HIGH
//   - Best Buy comp/list ("Comp. Value") price -> SUSPECT_HIGH
//
// Pure logic: no network, no writes. Intended to be wired into the fetch/refresh
// paths at Stage B (attach time + refresh time), mirroring the capacity guard.

// ── Tunable thresholds ───────────────────────────────────────────────────────
// Stage A starting values. Tune after seeing the deviation histogram.
export const LOW_THRESH = 0.45;     // price <= median*(1-LOW_THRESH) below peers -> SUSPECT_LOW
export const HIGH_THRESH = 0.40;    // price >= median*(1+HIGH_THRESH) above peers -> SUSPECT_HIGH
export const DISAGREE_THRESH = 1.5; // exactly one peer: max/min > this -> SUSPECT_PAIR
export const LOW_FLOOR = 0.30;      // no peers: price < pr*LOW_FLOOR -> SUSPECT_VS_LIST (too low)
                                    //           price > pr*(1+HIGH_THRESH) -> SUSPECT_VS_LIST (too high)

export const CLASS = {
  OK: 'OK',                     // within tolerance of peers (or list)
  SUSPECT_LOW: 'SUSPECT_LOW',   // far below peer median (used / mispriced-low marketplace)
  SUSPECT_HIGH: 'SUSPECT_HIGH', // far above peer median (list / comp / overpriced marketplace)
  SUSPECT_PAIR: 'SUSPECT_PAIR', // only one peer; the two disagree wildly (can't tell which is wrong)
  SUSPECT_VS_LIST: 'SUSPECT_VS_LIST', // no peer; outlier vs the product's own list price (pr/msrp)
  UNVERIFIED: 'UNVERIFIED',     // no peer and no usable list price -> can't cross-check
};

export const PRIMARY_RETAILERS = ['amazon', 'bestbuy', 'newegg'];

// Effective price for a retailer deal: prefer a real saleprice, else price.
// Mirrors the frontend (saleprice ?? price).
export function effectivePrice(deal) {
  if (!deal || typeof deal !== 'object') return null;
  const sale = Number(deal.saleprice);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const p = Number(deal.price);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export function median(nums) {
  const a = (nums || []).filter(n => Number.isFinite(n) && n > 0).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Classify ONE retailer's effective price against its peers (the other present
// retailers' effective prices for the same product).
//   price       : number under test
//   peerPrices  : array of the OTHER present retailers' effective prices
//   pr, msrp    : product list price, used only as a weak fallback when no peers
// returns { cls, ref, deviation, basis }
//   ref       : the comparison reference (peer median / sole peer / list price)
//   deviation : (price - ref) / ref   (signed; null when no ref)
//   basis     : which rule decided it ('median' | 'pair' | 'list-high' | 'list-low' | 'list' | 'no-peers' | 'no-price')
export function classifyDeal(price, peerPrices, pr = null, msrp = null) {
  if (!Number.isFinite(price) || price <= 0) {
    return { cls: CLASS.UNVERIFIED, ref: null, deviation: null, basis: 'no-price' };
  }
  const peers = (peerPrices || []).filter(n => Number.isFinite(n) && n > 0);

  if (peers.length >= 2) {
    const ref = median(peers);
    const deviation = (price - ref) / ref;
    if (price <= ref * (1 - LOW_THRESH)) return { cls: CLASS.SUSPECT_LOW, ref, deviation, basis: 'median' };
    if (price >= ref * (1 + HIGH_THRESH)) return { cls: CLASS.SUSPECT_HIGH, ref, deviation, basis: 'median' };
    return { cls: CLASS.OK, ref, deviation, basis: 'median' };
  }

  if (peers.length === 1) {
    const other = peers[0];
    const ratio = Math.max(price, other) / Math.min(price, other);
    const deviation = (price - other) / other;
    if (ratio > DISAGREE_THRESH) return { cls: CLASS.SUSPECT_PAIR, ref: other, deviation, basis: 'pair' };
    return { cls: CLASS.OK, ref: other, deviation, basis: 'pair' };
  }

  // No corroborating retailer — weak list-price fallback.
  const list = Number(pr) > 0 ? Number(pr) : (Number(msrp) > 0 ? Number(msrp) : null);
  if (list) {
    const deviation = (price - list) / list;
    if (price > list * (1 + HIGH_THRESH)) return { cls: CLASS.SUSPECT_VS_LIST, ref: list, deviation, basis: 'list-high' };
    if (price < list * LOW_FLOOR)         return { cls: CLASS.SUSPECT_VS_LIST, ref: list, deviation, basis: 'list-low' };
    return { cls: CLASS.OK, ref: list, deviation, basis: 'list' };
  }

  return { cls: CLASS.UNVERIFIED, ref: null, deviation: null, basis: 'no-peers' };
}

// Classify every primary-retailer deal on a product.
// returns { eff: {retailer: price}, results: {retailer: classifyDeal(...)} }
export function classifyProduct(product) {
  const deals = (product && product.deals) || {};
  const eff = {};
  for (const r of PRIMARY_RETAILERS) {
    const e = effectivePrice(deals[r]);
    if (e != null) eff[r] = e;
  }
  const results = {};
  for (const r of Object.keys(eff)) {
    const peers = Object.entries(eff).filter(([k]) => k !== r).map(([, v]) => v);
    results[r] = classifyDeal(eff[r], peers, product && product.pr, product && product.msrp);
  }
  return { eff, results };
}

// Product-level "something is wrong here" signal, independent of per-retailer
// classification: do any two present retailers disagree by > (DISAGREE_THRESH-1)?
// Returns { conflicting:boolean, spread:number|null, min, max } over present peers.
export function dispersion(product) {
  const deals = (product && product.deals) || {};
  const prices = PRIMARY_RETAILERS.map(r => effectivePrice(deals[r])).filter(n => n != null);
  if (prices.length < 2) return { conflicting: false, spread: null, min: null, max: null, n: prices.length };
  const min = Math.min(...prices), max = Math.max(...prices);
  const spread = max / min;
  return { conflicting: spread >= DISAGREE_THRESH, spread, min, max, n: prices.length };
}

// Is a Newegg deal a marketplace (3rd-party) listing rather than Newegg-Official?
// Newegg-Official item numbers start "N82E"; marketplace sellers start "9SI".
export function neweggSkuClass(deal) {
  const sku = String((deal && deal.sku) || '').toUpperCase().trim();
  if (!sku) return 'none';
  if (sku.startsWith('9SI')) return 'marketplace';
  if (sku.startsWith('N82E')) return 'official';
  return 'other';
}
