/**
 * bestbuy-live-price.mjs — resolve what a customer actually pays at Best Buy,
 * via DataForSEO Google Shopping.
 *
 * Extracted from probe-bestbuy-price-truth.mjs so the response parsing can be
 * tested without credentials or network. The probe's whole purpose is to settle
 * whether `deals.bestbuy.price` is the price a customer pays; if THIS file is
 * wrong, the probe returns UNRESOLVED and settles nothing — which is exactly
 * what happened on the 2026-08-17 run: 20/20 UNRESOLVED, no Best Buy offer
 * found for any sku.
 *
 * ── WHY THE FIRST VERSION FOUND NOTHING ──────────────────────────────────────
 * Three defects, all verified against the DataForSEO v3 field reference rather
 * than assumed:
 *
 *  1. WRONG URL FIELD. It matched on `item.url`. The products endpoint has no
 *     `url` — the documented fields are `product_id`, `title`, `seller` and
 *     `shopping_url`. So the domain half of the seller test read `undefined`
 *     every time and only the `seller` string could ever match.
 *
 *  2. NO ITEM-TYPE FILTER. `items` mixes `google_shopping_serp`,
 *     `google_shopping_paid`, two carousel types and `related_searches`. The
 *     last carries no seller and no price at all, so it dilutes `depth` and
 *     can win a `.find()` before a real offer is reached.
 *
 *  3. WRONG ENDPOINT FOR THE QUESTION — the structural one. `merchant/google/
 *     products` answers "what products match this keyword", one row per
 *     LISTING, and DataForSEO's own overview says it comes "without per-seller
 *     breakdowns". Whether Best Buy happens to surface in the top 20 for a
 *     verbose catalog product name is close to chance. The endpoint that
 *     answers "what does seller X charge for product Y" is `merchant/google/
 *     sellers`, keyed by `product_id` — and you can only get a `product_id`
 *     from the products call. It is inherently two steps.
 *
 * A fourth, smaller: `price ? … : 'offer has no price'` treats a legitimate
 * 0.00 as missing. Checked against null now.
 *
 * ── SHAPES, VERBATIM FROM THE FIELD REFERENCE ────────────────────────────────
 *   products  items[].type ∈ google_shopping_serp | google_shopping_paid |
 *                            google_shopping_sponsored_carousel |
 *                            google_shopping_carousel | related_searches
 *             items[].seller        string   — the merchant name
 *             items[].price         float    — PLAIN NUMBER, not {current}
 *             items[].product_id    string   — feeds step 2
 *             items[].shopping_url  string
 *
 *   sellers   items[].type          "shops_list"
 *             items[].seller_name   string
 *             items[].base_price    number   — excludes tax + shipping
 *             items[].total_price   number   — includes tax + shipping
 *             items[].domain        string
 *             items[].url           string
 *
 * `base_price` is the comparable to Best Buy's `salePrice`; `total_price` folds
 * in tax and shipping and would manufacture a FIELD-WRONG verdict on every row.
 *
 * NOTE ON COST AND LATENCY: sellers has no `live` variant — it is task_post,
 * then poll task_get. That is why step 2 runs only when step 1 fails to find a
 * Best Buy row directly, and why it is capped.
 */

const PRODUCTS_URL = 'https://api.dataforseo.com/v3/merchant/google/products/live/advanced';
const SELLERS_POST_URL = 'https://api.dataforseo.com/v3/merchant/google/sellers/task_post';
const SELLERS_GET_URL = 'https://api.dataforseo.com/v3/merchant/google/sellers/task_get/advanced/';

// related_searches carries no offer; the carousels and paid slots do.
const OFFER_TYPES = new Set([
  'google_shopping_serp',
  'google_shopping_paid',
  'google_shopping_sponsored_carousel',
  'google_shopping_carousel',
]);

// Word boundaries are load-bearing. An unanchored /best\s*buy/i matches inside
// "Bestbuyer Electronics" and "notbestbuy.example.com", so a substring of an
// unrelated merchant would have been read as a Best Buy offer and priced the
// comparison against the wrong shop. `buy\b` rejects "buyer"; the leading `\b`
// rejects "notbestbuy". The domain arm is anchored to a host boundary so it
// cannot match a lookalike registered under someone else's domain.
//
// Residual limitation, accepted knowingly: a genuinely different company whose
// name contains the exact words — "Best Buy Metals" — still matches on the name
// arm. Google Shopping publishes the retailer as exactly "Best Buy", and no
// such lookalike sells PC components, so tightening further would cost more
// true matches than it saves.
export const isBestBuy = (...vals) =>
  vals.some((v) => {
    const s = String(v ?? '');
    return /\bbest\s*buy\b/i.test(s) || /(^|\/\/|\.)bestbuy\.com\b/i.test(s);
  });

/** tasks[0].result[0].items, tolerating every level being absent. */
export function itemsOf(json) {
  const it = json?.tasks?.[0]?.result?.[0]?.items;
  return Array.isArray(it) ? it : [];
}

/**
 * A Best Buy offer sitting directly in the products result — the cheap path.
 * Returns { price, seller, productId, shoppingUrl } or null.
 */
export function pickBestBuyFromProducts(items) {
  for (const i of items || []) {
    if (i?.type && !OFFER_TYPES.has(i.type)) continue;
    if (!isBestBuy(i?.seller, i?.shopping_url, i?.url, i?.domain)) continue;
    const price = numberOrNull(i?.price);
    if (price == null) continue;
    return { price, seller: i.seller ?? null, productId: i.product_id ?? null, shoppingUrl: i.shopping_url ?? null };
  }
  return null;
}

/**
 * The product_id to hand to the sellers endpoint. Prefers the offer whose title
 * best overlaps the catalog name, so a keyword that returns accessories for the
 * product does not send step 2 after a case for the monitor we asked about.
 */
export function pickProductId(items, name) {
  const want = tokens(name);
  let best = null;
  for (const i of items || []) {
    if (i?.type && !OFFER_TYPES.has(i.type)) continue;
    if (!i?.product_id) continue;
    const score = want.size ? overlap(want, tokens(i.title)) : 0;
    if (!best || score > best.score) best = { score, productId: String(i.product_id) };
  }
  return best?.productId ?? null;
}

/**
 * Best Buy's row in a sellers (shops_list) result.
 * Returns { price, totalPrice, sellerName, url } or null.
 * `price` is base_price — tax- and shipping-exclusive, matching salePrice.
 */
export function pickBestBuyFromSellers(items) {
  for (const i of items || []) {
    if (i?.type && i.type !== 'shops_list') continue;
    if (!isBestBuy(i?.seller_name, i?.domain, i?.url)) continue;
    const base = numberOrNull(i?.base_price);
    const total = numberOrNull(i?.total_price);
    const price = base ?? total;
    if (price == null) continue;
    return { price, totalPrice: total, sellerName: i.seller_name ?? null, url: i.url ?? null };
  }
  return null;
}

const numberOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const tokens = (s) =>
  new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3));
const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return a.size ? n / a.size : 0;
};

/**
 * Two-step resolution. `deps` is injected so tests drive it without network.
 *   deps.fetchImpl(url, init) -> Response-like
 *   deps.sleep(ms)
 * Returns { live, via, productId? } or { error }.
 */
export async function liveBestBuyPrice(name, deps = {}) {
  const {
    login = process.env.DATAFORSEO_LOGIN,
    pw = process.env.DATAFORSEO_PASSWORD,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    location_code = 2840,
    language_code = 'en',
    depth = 40,
    sellersPollAttempts = 6,
    sellersPollMs = 5000,
    useSellers = true,
  } = deps;

  if (!login || !pw) return { error: 'no dataforseo creds' };
  const auth = 'Basic ' + Buffer.from(`${login}:${pw}`).toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  let products;
  try {
    const r = await fetchImpl(PRODUCTS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ keyword: String(name).slice(0, 120), location_code, language_code, depth }]),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { error: `dataforseo products HTTP ${r.status}` };
    products = await r.json();
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'dataforseo timeout' : String(e?.message || e) };
  }

  const items = itemsOf(products);
  if (!items.length) return { error: 'no shopping results for keyword' };

  const direct = pickBestBuyFromProducts(items);
  if (direct) return { live: direct.price, via: 'dataforseo:products', productId: direct.productId };

  if (!useSellers) return { error: 'no bestbuy offer in shopping results' };

  const productId = pickProductId(items, name);
  if (!productId) return { error: 'no product_id to query sellers with' };

  // Step 2 — sellers has no live variant: task_post, then poll task_get.
  let taskId;
  try {
    const r = await fetchImpl(SELLERS_POST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ product_id: productId, location_code, language_code }]),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { error: `dataforseo sellers HTTP ${r.status}` };
    const j = await r.json();
    taskId = j?.tasks?.[0]?.id ?? null;
    if (!taskId) return { error: `sellers task_post returned no id (${j?.tasks?.[0]?.status_message || 'no message'})` };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'sellers post timeout' : String(e?.message || e) };
  }

  for (let attempt = 0; attempt < sellersPollAttempts; attempt++) {
    await sleep(sellersPollMs);
    let j;
    try {
      const r = await fetchImpl(SELLERS_GET_URL + encodeURIComponent(taskId), { headers, signal: AbortSignal.timeout(60000) });
      if (!r.ok) continue;
      j = await r.json();
    } catch {
      continue;
    }
    const sellerItems = itemsOf(j);
    if (!sellerItems.length) continue;
    const hit = pickBestBuyFromSellers(sellerItems);
    if (hit) return { live: hit.price, via: 'dataforseo:sellers', productId };
    return { error: `product ${productId} has ${sellerItems.length} sellers, none Best Buy` };
  }
  return { error: `sellers task ${taskId} not ready after ${sellersPollAttempts} polls` };
}
