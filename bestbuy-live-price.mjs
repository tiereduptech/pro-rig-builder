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
 * ── WHY EVERY RUN AFTER THAT ALSO FOUND NOTHING: THE PATH ────────────────────
 * The fixes above were never exercised. Runs 32153401588 and 32168477366, and
 * the 20/20 before them, all died on the same envelope — task 40402 "Invalid
 * Path.", tasks_error 1 — because step 1 was posted to
 * `merchant/google/products/live/advanced`, a path that does not exist.
 *
 * DataForSEO's Google Shopping endpoints are task-based WITHOUT EXCEPTION:
 * products, sellers, product_info and reviews each expose task_post,
 * tasks_ready and task_get/advanced, and not one of them has a live variant.
 * Merchant AMAZON does have live/advanced — import-expansion-cards.js:94 calls
 * it and works — and that is where the wrong path came from. The two halves of
 * the Merchant API do not share a shape.
 *
 * 40402 comes back with HTTP 200 and an empty `items`, so the transport check
 * waved it through and every row landed UNRESOLVED with the keyword blamed.
 * No run so far has reached the seller matching, the keyword, or the sellers
 * arm — none of them is evidence for or against any of that work.
 *
 * NOTE ON COST AND LATENCY: both steps are now task_post + poll task_get, so
 * step 1 costs one task per row and waits for it. Step 2 costs another and
 * still runs only when step 1 fails to find a Best Buy row directly.
 */

const PRODUCTS_POST_URL = 'https://api.dataforseo.com/v3/merchant/google/products/task_post';
const PRODUCTS_GET_URL = 'https://api.dataforseo.com/v3/merchant/google/products/task_get/advanced/';
const SELLERS_POST_URL = 'https://api.dataforseo.com/v3/merchant/google/sellers/task_post';
const SELLERS_GET_URL = 'https://api.dataforseo.com/v3/merchant/google/sellers/task_get/advanced/';

// task_get answers HTTP 200 while the task is still working. These two codes
// mean "ask again"; any other non-20000 code is terminal and worth quoting.
const PENDING_STATUS = new Set([40601, 40602]); // Task Handed, Task In Queue

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
 * Whatever the envelope says about itself: "task 40402 Invalid Path.;
 * tasks_error 1". Empty string when it says nothing.
 *
 * DataForSEO reports a request that never ran with HTTP 200 and a non-20000
 * status on the task, plus a non-zero `tasks_error` — a rejected field, an
 * exhausted balance, a queue error, a path that does not exist. The transport
 * check waves all of that through, so every caller that reports a failure
 * quotes this instead of guessing at a cause.
 */
export function taskEnvelopeReason(json) {
  const task = json?.tasks?.[0];
  const code = task?.status_code ?? null;
  const message = task?.status_message ?? null;
  const tasksError = json?.tasks_error ?? null;

  const parts = [];
  if (code != null || message != null) parts.push(`task ${code ?? 'no status_code'} ${message ?? 'no status_message'}`);
  if (tasksError != null) parts.push(`tasks_error ${tasksError}`);
  return parts.join('; ');
}

/**
 * Why a finished products task came back with no items.
 *
 * An empty `items` is two different failures wearing the same face. Either
 * Shopping genuinely indexed nothing for the keyword — task 20000 "Ok.",
 * tasks_error 0 — or the task finished badly. Run 32153401588 was read as a
 * keyword problem on exactly this evidence, so the reason carries the envelope
 * and the next run does not have to guess which of the two it hit.
 */
export function emptyProductsReason(json) {
  const detail = taskEnvelopeReason(json);
  return detail ? `no shopping results for keyword (${detail})` : 'no shopping results for keyword';
}

/**
 * Is this task_get answer finished, still working, or dead?
 *
 * A task that has not written its result yet comes back with no items — the
 * same shape as a task that genuinely found nothing. `status_code` is what
 * separates them: 20000 with an empty result is a real, empty answer, while a
 * queue code is a reason to wait. An envelope with no status at all is treated
 * as still working, so a slow task is never read as an empty one.
 */
export function taskState(json) {
  const code = json?.tasks?.[0]?.status_code ?? null;
  if (code != null && PENDING_STATUS.has(code)) return 'pending';
  if (code != null && code !== 20000) return 'failed';
  if (itemsOf(json).length) return 'done';
  return code === 20000 ? 'done' : 'pending';
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
 * The keyword to send to Google Shopping for a catalog row.
 *
 * This choice decides whether column 3 can resolve at all. Catalog names carry
 * manufacturer part numbers — "HyperX HHSS1C-KB-WT/G Cloud Stinger Core – W" —
 * and Shopping indexes nothing under them. Run 32153401588 went 5/5 UNRESOLVED
 * on `no shopping results for keyword`, dying at step 1, four lines before the
 * sellers arm was ever consulted; turning sellers on would not have moved a
 * single row. The Developer API's own name for the sku ("HyperX - Cloud
 * Stinger 2 Wired Gaming Headset") is the string Shopping does index, and the
 * probe has already fetched it for column 2 by the time it needs a keyword.
 *
 * Prefer the Best Buy name; fall back to the catalog name when the sku 404s or
 * the API errored. `source` is reported so a run that still whiffs says which
 * string it whiffed on.
 *
 * Returns { name, source: 'bb-api' | 'catalog' }.
 */
export function shoppingKeyword(catalogName, apiName) {
  const bb = String(apiName || '').trim();
  if (bb) return { name: bb, source: 'bb-api' };
  return { name: String(catalogName || '').trim(), source: 'catalog' };
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
 * Poll task_get until the task finishes, fails, or the attempt budget runs out.
 * Returns { json } | { failed: json } | { pending: true }. Transport hiccups
 * burn an attempt rather than aborting the row — the task is already paid for.
 *
 * ── THE BUDGET ───────────────────────────────────────────────────────────────
 * 20 × 6s = two minutes per step. The first task-based run, 32172326071, gave
 * step 1 only 10 × 4s and two of three rows timed out at 40s with the task
 * still queued — a budget failure, not an API one. Google Shopping tasks are
 * queued, not instant, so a budget shorter than the queue reports every row as
 * unreachable and looks exactly like a broken endpoint.
 *
 * Running out is not the same as losing the data: the task is paid for on
 * POST and DataForSEO keeps the result for 30 days, so the timeout message
 * carries the task id and a later task_get can still collect it.
 *
 * Worst case is now ~4 minutes per row with both steps. The workflow's job
 * timeout has to cover limit × that; it is 60 minutes, so a 20-row run with
 * sellers on has no headroom to spare. Keep an eye on it before raising limit.
 */
async function pollTaskGet(getUrl, id, { fetchImpl, headers, sleep, attempts, ms }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(ms);
    let j;
    try {
      const r = await fetchImpl(getUrl + encodeURIComponent(id), { headers, signal: AbortSignal.timeout(60000) });
      if (!r.ok) continue;
      j = await r.json();
    } catch {
      continue;
    }
    const state = taskState(j);
    if (state === 'pending') continue;
    return state === 'failed' ? { failed: j } : { json: j };
  }
  return { pending: true };
}

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
    productsPollAttempts = 20,
    productsPollMs = 6000,
    sellersPollAttempts = 20,
    sellersPollMs = 6000,
    useSellers = true,
  } = deps;

  if (!login || !pw) return { error: 'no dataforseo creds' };
  const auth = 'Basic ' + Buffer.from(`${login}:${pw}`).toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  // Step 1 — products. Task-based; there is no live path to shortcut to.
  let posted;
  try {
    const r = await fetchImpl(PRODUCTS_POST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ keyword: String(name).slice(0, 120), location_code, language_code, depth }]),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return { error: `dataforseo products HTTP ${r.status}` };
    posted = await r.json();
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'dataforseo timeout' : String(e?.message || e) };
  }

  const productsTaskId = posted?.tasks?.[0]?.id ?? null;
  if (!productsTaskId) {
    // The 40402 case lands here now: a rejected POST names itself instead of
    // being read downstream as a keyword that matched nothing.
    const detail = taskEnvelopeReason(posted);
    return { error: detail ? `products task_post failed (${detail})` : 'products task_post returned no id' };
  }

  const productsPoll = await pollTaskGet(PRODUCTS_GET_URL, productsTaskId, {
    fetchImpl, headers, sleep, attempts: productsPollAttempts, ms: productsPollMs,
  });
  if (productsPoll.pending) return { error: `products task ${productsTaskId} not ready after ${productsPollAttempts} polls` };
  if (productsPoll.failed) return { error: `products task ${productsTaskId} failed (${taskEnvelopeReason(productsPoll.failed)})` };
  const products = productsPoll.json;

  const items = itemsOf(products);
  if (!items.length) return { error: emptyProductsReason(products) };

  const direct = pickBestBuyFromProducts(items);
  if (direct) return { live: direct.price, via: 'dataforseo:products', productId: direct.productId };

  if (!useSellers) return { error: 'no bestbuy offer in shopping results' };

  const productId = pickProductId(items, name);
  if (!productId) return { error: 'no product_id to query sellers with' };

  // Step 2 — sellers, same task_post-then-poll shape as step 1.
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

  const sellersPoll = await pollTaskGet(SELLERS_GET_URL, taskId, {
    fetchImpl, headers, sleep, attempts: sellersPollAttempts, ms: sellersPollMs,
  });
  if (sellersPoll.pending) return { error: `sellers task ${taskId} not ready after ${sellersPollAttempts} polls` };
  if (sellersPoll.failed) return { error: `sellers task ${taskId} failed (${taskEnvelopeReason(sellersPoll.failed)})` };

  const sellerItems = itemsOf(sellersPoll.json);
  const hit = pickBestBuyFromSellers(sellerItems);
  if (hit) return { live: hit.price, via: 'dataforseo:sellers', productId };
  return { error: `product ${productId} has ${sellerItems.length} sellers, none Best Buy` };
}
