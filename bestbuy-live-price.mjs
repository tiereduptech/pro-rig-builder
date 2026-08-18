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
 * ── NOTHING VERIFIED THAT THE PRICE WAS FOR THE SAME PRODUCT ─────────────────
 * Run 32174849780 resolved 19 of 20 rows and produced 9 FIELD-WRONG. It also
 * returned $899.99 as the live price of a CPU stored at $95.79. Shopping was
 * asked for a keyword and answered with the FIRST Best Buy row it had; nothing
 * compared that listing to the product we asked about. A wrong number that
 * looks like an answer is worse than no number, because it votes.
 *
 * Every offer is now scored on how much of the keyword survives in its title,
 * and anything under MIN_TITLE_OVERLAP is refused with its score said out
 * loud. The sellers arm is gated the same way: its product_id is chosen by
 * title too, so an unchecked pick there buys a confident price for the wrong
 * product.
 *
 * ── WHAT THE GATE COULD NOT SEE: THE TOKENS THAT NAME A VARIANT ──────────────
 * Run 32178925976 (20 rows, sellers on) resolved 13 and called 5 FIELD-WRONG.
 * Reading the titles it printed, three of those five were the wrong VARIANT of
 * the right product — the gate's stated blind spot, and each one was let
 * through by the tokenizer rather than by the threshold:
 *
 *   case/70280      H7 Flow 2024 ......... priced as an H9 Flow RGB+   +$150.00
 *   gpu/30111       RTX 5060 Ti 16G ...... priced as a 5060 Ti 8G      -$188.00
 *   case-fan/85271  iCUE LINK LX120 kit .. priced as an RX120 kit       -$88.00
 *
 * A verdict built on those is not evidence about `salePrice`; it is evidence
 * that we compared two different products. Three defects, in the order they
 * matter:
 *
 *  1. THE TOKENIZER DROPPED EVERYTHING UNDER THREE CHARACTERS. Ti, XT, H7, H9,
 *     8G — the tokens that separate variants are exactly the short ones, so the
 *     gate was blind to precisely what it exists to catch. "NVIDIA GeForce RTX
 *     5060 Ti" scored 100% against "ASUS Dual -RTX5060-8G ... RTX 5060 8 GB"
 *     because `ti` was not a token at all. Two-character tokens now survive;
 *     only English filler is dropped.
 *
 *  2. ONE SHARED SPEC TOKEN SILENCED THE MODEL RULE. modelMismatch stood down
 *     as soon as ANY model token was shared, and `120mm`, `gddr7`, `ddr5` and
 *     `am5` are model-shaped without naming a model. LX120 vs RX120 shares
 *     120mm; 16G vs 8G shares gddr7. Both walked. The rule now compares the
 *     tokens each side does NOT share, and a pair that names the same thing
 *     with a different value — H7/H9, LX120/RX120, 16G/8G, B840/B850 — is a
 *     mismatch even when the rest of the spec agrees.
 *
 *  3. OVERLAP IS ONE-DIRECTIONAL, SO EXTRA VARIANT WORDS WERE FREE. The score
 *     is the fraction of OUR tokens found in the title; a title that adds Ti,
 *     Pro, Max or a 3-pack to a name we otherwise match still scores 100%.
 *     Those words are now checked in both directions: a variant word or pack
 *     size on one side only is a mismatch, whatever the score says.
 *
 * WHAT THIS GATE STILL DOES NOT DO: colour is deliberately not a variant word
 * (a black and a white 3-pack of the same fan are the same price, and refusing
 * both would cost rows to buy nothing), and a bundle that states no pack size
 * is invisible. That is why the resolved title is printed next to the price:
 * the gate narrows the field, and a human settles the rest by reading it.
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

// How much of the keyword has to survive in a listing title before its price
// is allowed to stand for our product. Sized to catch a different product, not
// a different variant; the score travels with the answer so it can be tuned
// against real titles rather than guessed at twice.
export const MIN_TITLE_OVERLAP = 0.5;

/**
 * Fraction of the keyword's tokens present in a listing title.
 *
 * A keyword with no scorable tokens leaves nothing to compare against, so it
 * scores 1 and the gate stands down rather than refusing every row. Production
 * always has one — shoppingKeyword() falls back to the catalog name — so that
 * case is for callers that pass no name at all.
 */
export function titleScore(name, title) {
  const want = tokens(name || '');
  return want.size ? overlap(want, tokens(title)) : 1;
}

// A token carrying both letters and digits: 12100f, 9950x3d, rs120, x870e,
// gddr7, 8gb — and, since 2026-08-18, the two-character ones that do the same
// job: h7, 8g, x3. These are the part of a product name that identifies WHICH
// product it is; everything else is category vocabulary.
const MODEL_TOKEN = /^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{2,}$/;
const modelTokens = (s) => new Set([...tokens(s)].filter((t) => MODEL_TOKEN.test(t)));

// letters, digits, letters — h7 -> (h, 7, ''), 16gb -> ('', 16, gb),
// lx120 -> (lx, 120, ''). A token that mixes them further (9950x3d) has no
// shape and is compared by identity alone.
const SHAPE = /^([a-z]*)(\d+)([a-z]*)$/;

/**
 * Do these two tokens name the same thing with a different value?
 *
 * This is the difference between "the listing added its own part code" and
 * "the listing is the other variant". H7 vs H9 share a prefix, 16G vs 8G share
 * a unit, LX120 vs RX120 share a number — each pair is one product apart.
 *
 * The same-number arm requires three digits or more: `ddr5` and `pcie5` share
 * a 5 and are not a variant apart, while `lx120`/`rx120` and `rtx5060`/
 * `rtx5070` are exactly what it exists to catch.
 */
function tokenConflict(a, b) {
  const x = SHAPE.exec(a);
  const y = SHAPE.exec(b);
  if (!x || !y) return false;
  const [, xPre, xNum, xSuf] = x;
  const [, yPre, yNum, ySuf] = y;
  if (xPre && xPre === yPre && xNum !== yNum) return true;
  if (xSuf && xSuf === ySuf && xNum !== yNum) return true;
  if (xNum === yNum && xNum.length >= 3 && xPre && yPre && xPre !== yPre) return true;
  return false;
}

/**
 * The model number in the title that says this is a different product.
 *
 * Overlap alone cannot do this job. "Intel - Core i3-12100F Desktop Processor"
 * against "AMD Ryzen 9 9950X3D 16-Core Desktop Processor" scores 0.6 — core,
 * desktop and processor carry it — while a CORRECT match, "HyperX - Cloud
 * Stinger 2 Wired Gaming Headset for PS5 and PS4 - White" against "HyperX
 * Cloud Stinger 2 Gaming Headset - White", scores 0.55. Category vocabulary
 * swamps the signal in both directions; the model number is the signal.
 *
 * The rule is deliberately narrow, because a false reject costs a row and a
 * false accept costs a verdict. It fires on two shapes:
 *
 *   - the title states a model number and states NONE of ours, or
 *   - a model token we do not share names the same thing with a different
 *     value: H7 against H9, LX120 against RX120, 16G against 8G.
 *
 * The second arm is why "any shared token means a match" had to go. Until
 * 2026-08-18 the rule stood down the moment one model token was shared, and
 * `120mm`, `gddr7`, `ddr5` and `am5` are model-shaped without naming a model:
 * an LX120 kit and an RX120 kit share 120mm, so run 32178925976 priced our
 * $84.99 LX120 3-pack at the RX120's $51.99 and called it FIELD-WRONG.
 * Comparing only the tokens each side does NOT share keeps the original
 * concession intact — a listing that appends its own part code
 * ("DUAL-RTX5060-O8G") to a name we match still keeps its match, because
 * nothing in ours conflicts with it — while the variant pair no longer hides
 * behind the spec it shares.
 *
 * A listing with no model number at all is still left to the overlap floor.
 */
export function modelMismatch(name, title) {
  const want = modelTokens(name);
  if (!want.size) return null;
  const have = modelTokens(title);
  if (!have.size) return null;

  // Only the unshared tokens can conflict. A name that lists both PS4 and PS5
  // against a title that lists PS5 agrees on PS5; it is not two products.
  const wantOnly = [...want].filter((t) => !have.has(t));
  const haveOnly = [...have].filter((t) => !want.has(t));
  for (const h of haveOnly) for (const w of wantOnly) if (tokenConflict(w, h)) return h;

  if (wantOnly.length < want.size) return null; // something of ours is in there
  return haveOnly[0] ?? null;
}

/**
 * Words that name a distinct product rather than describe one.
 *
 * The overlap score is one-directional — the fraction of OUR tokens found in
 * the title — so a title that ADDS one of these to a name we otherwise match
 * scores 100% while being a different sku. "NVIDIA GeForce RTX 5060 Ti" and
 * "ASUS Dual RTX 5060 8GB" are one word apart and $67 apart.
 *
 * Colour is deliberately absent. A black and a white 3-pack of the same fan
 * carry the same price, and half the listings drop the colour entirely, so
 * refusing on it would cost real rows and buy nothing.
 */
// The accessory words are the same rule wearing a different hat: a bracket FOR
// our TV names our TV in full and scores 75% on a one-directional overlap, so
// the words that make it an accessory have to be read as identity too.
const VARIANT_WORDS = [
  'ti', 'super', 'xt', 'xtx', 'pro', 'max', 'plus', 'elite', 'lite', 'mini', 'refurbished', 'renewed', 'bundle',
  'mount', 'bracket', 'sleeve', 'replacement', 'adapter', 'protector', 'decal', 'skin',
];

// Words that come in opposing pairs are checked for CONTRADICTION, not for
// presence. Half of Shopping's titles drop "Wired" from a wired headset, and
// refusing on the omission would cost the very rows the probe is here to
// price; "Wired" against "Wireless" is a different matter.
const OPPOSED = [['wired', 'wireless']];

/** The variant word that says these are two products, or null. */
export function variantClash(name, title) {
  const a = tokens(name);
  const b = tokens(title);
  for (const [x, y] of OPPOSED) {
    if (a.has(x) && b.has(y)) return y;
    if (a.has(y) && b.has(x)) return x;
  }
  for (const w of VARIANT_WORDS) if (a.has(w) !== b.has(w)) return w;
  return null;
}

const PACK_WORDS = { single: 1, dual: 2, double: 2, twin: 2, triple: 3, quad: 4 };
const PACK_WORD_RE = new RegExp(`\\b(${Object.keys(PACK_WORDS).join('|')})\\b(?:\\s+[a-z0-9]+){0,2}\\s+(?:pack|kit)\\b`);

/**
 * How many units a listing sells, when it says so. "(3-pack)", "Triple Pack"
 * and "Triple Starter Kit" are the same three fans; "Starter Kit" alone states
 * nothing and returns null, because guessing 1 would refuse every kit.
 */
export function packSize(s) {
  const t = normalize(s);
  const n = /\b(\d+)\s*packs?\b/.exec(t) || /\bpack\s+of\s+(\d+)\b/.exec(t);
  if (n) return Number(n[1]);
  const w = PACK_WORD_RE.exec(t);
  return w ? PACK_WORDS[w[1]] : null;
}

/** The listing's pack size when both sides state one and they differ. */
export function packClash(name, title) {
  const a = packSize(name);
  const b = packSize(title);
  return a != null && b != null && a !== b ? `${b}-pack vs ${a}` : null;
}

/**
 * Does this listing's title say it is our product?
 *
 * `clash` is the phrase that goes in the row note, so a refusal names the
 * token that caused it and a floor that turns out to be wrong can be seen
 * rather than guessed at.
 */
export function identityCheck(name, title, minOverlap = MIN_TITLE_OVERLAP) {
  const score = titleScore(name, title);
  const model = modelMismatch(name, title);
  const variant = model ? null : variantClash(name, title);
  const pack = model || variant ? null : packClash(name, title);
  const clash = model ? `model ${model}` : variant ? `variant ${variant}` : pack ? `pack ${pack}` : null;
  return { score, clash, ok: clash == null && score >= minOverlap };
}

/**
 * The best-matching Best Buy offer in the products result — the cheap path.
 * Returns { price, seller, productId, shoppingUrl, title, score } or null, with
 * `rejected: true` when the best one Best Buy has does not look like our
 * product. A rejected offer is still returned so the caller can say WHICH
 * listing it refused and at what score.
 */
export function pickBestBuyFromProducts(items, name, minOverlap = MIN_TITLE_OVERLAP) {
  let best = null;   // best offer that passes identity
  let nearest = null; // best-scoring offer overall, for the refusal note
  for (const i of items || []) {
    if (i?.type && !OFFER_TYPES.has(i.type)) continue;
    if (!isBestBuy(i?.seller, i?.shopping_url, i?.url, i?.domain)) continue;
    const price = numberOrNull(i?.price);
    if (price == null) continue;
    const { score, clash, ok } = identityCheck(name, i?.title, minOverlap);
    const offer = { price, seller: i.seller ?? null, productId: i.product_id ?? null, shoppingUrl: i.shopping_url ?? null, title: i.title ?? null, score, clash };
    if (ok && (!best || score > best.score)) best = offer;
    if (!nearest || score > nearest.score) nearest = offer;
  }
  if (best) return best;
  return nearest ? { ...nearest, rejected: true } : null;
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
export function bestTitleMatch(items, name, minOverlap = MIN_TITLE_OVERLAP) {
  let best = null;
  let nearest = null;
  for (const i of items || []) {
    if (i?.type && !OFFER_TYPES.has(i.type)) continue;
    if (!i?.product_id) continue;
    const { score, clash, ok } = identityCheck(name, i?.title, minOverlap);
    const m = { score, clash, ok, productId: String(i.product_id), title: i.title ?? null };
    if (ok && (!best || score > best.score)) best = m;
    if (!nearest || score > nearest.score) nearest = m;
  }
  return best ?? nearest;
}

export function pickProductId(items, name, minOverlap = MIN_TITLE_OVERLAP) {
  const best = bestTitleMatch(items, name, minOverlap);
  return best?.ok ? best.productId : null;
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
// Two-character tokens are dropped only when they are English filler. "Ti",
// "H7" and "8G" are not filler — they are the entire difference between two
// products, and a floor of three characters deleted them before the gate ever
// saw them.
const STOPWORDS = new Set(['of', 'to', 'in', 'on', 'at', 'by', 'is', 'it', 'as', 'or', 'an', 'vs', 'and', 'the', 'for', 'with', 'w']);

// "8 GB" and "8GB" name the same thing; a space must not hide a capacity from
// the comparison. Units only — `pack` is left alone so packSize() can read it.
const UNIT_SPLIT = /\b(\d+)\s+(gb|tb|mb|kb|mm|cm|hz|khz|mhz|ghz|rpm|bit|pin|core|thread)\b/g;

const normalize = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(UNIT_SPLIT, '$1$2').trim();

const tokens = (s) => new Set(normalize(s).split(' ').filter((t) => t.length >= 2 && !STOPWORDS.has(t)));
const overlap = (a, b) => {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return a.size ? n / a.size : 0;
};

/**
 * Why a price was refused, in the row note — naming the listing, so a floor
 * that turns out to be wrong can be seen and moved rather than guessed at.
 *   not our product (model 9950x3d, title 60%): "AMD Ryzen 9 9950X3D 16-Core…"
 *   not our product (model h9, title 64%): "NZXT H9 Flow RGB+ Dual-Chamber…"
 *   not our product (variant ti, title 100%): "ASUS Dual -RTX5060-8G NVIDIA…"
 *   not our product (title 31% < 50%): "Wall Mount Bracket for 65 inch TVs"
 */
export function rejectedReason(m) {
  const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
  const why = m?.clash ? `${m.clash}, title ${pct(m.score)}` : `title ${pct(m?.score)} < ${pct(MIN_TITLE_OVERLAP)}`;
  const title = m?.title ? `: "${String(m.title).slice(0, 60)}"` : '';
  return `not our product (${why})${title}`;
}

/**
 * Where an accepted price came from — the mirror of rejectedReason().
 *   via dataforseo:sellers 86%: "Samsung 65 inch Class QLED 4K Smart TV"
 *
 * A live price is evidence only if you can see what it was a price FOR. The
 * identity gate refuses a different product; it cannot refuse a different
 * VARIANT of the right one — a 3-pack, a capacity, a bundle — because those
 * share nearly every token. Printing the matched title is how a human settles
 * those, so it travels with every number the probe reports.
 */
export function provenance(live) {
  const pct = live?.matchScore != null ? ` ${Math.round(live.matchScore * 100)}%` : '';
  const title = live?.matchTitle ? `: "${String(live.matchTitle).slice(0, 62)}"` : '';
  return `via ${live?.via ?? 'unknown'}${pct}${title}`;
}

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
 * Worst case is ~4 minutes for a row that reaches sellers — though the two
 * ceilings rarely both apply, since a step 1 that burns its whole budget
 * returns pending and never posts a sellers task. The workflow's job timeout
 * has to cover limit × that: 20 rows x 4 min is 80, so it is 120 minutes.
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

  const direct = pickBestBuyFromProducts(items, name);
  if (direct && !direct.rejected) {
    return { live: direct.price, via: 'dataforseo:products', productId: direct.productId, matchTitle: direct.title, matchScore: direct.score };
  }

  if (!useSellers) {
    return { error: direct ? rejectedReason(direct) : 'no bestbuy offer in shopping results' };
  }

  const match = bestTitleMatch(items, name);
  if (!match) return { error: 'no product_id to query sellers with' };
  if (!match.ok) return { error: rejectedReason(direct ?? match) };
  const productId = match.productId;

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
  if (hit) return { live: hit.price, via: 'dataforseo:sellers', productId, matchTitle: match.title, matchScore: match.score };
  return { error: `product ${productId} has ${sellerItems.length} sellers, none Best Buy` };
}
