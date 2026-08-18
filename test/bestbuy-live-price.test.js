// DataForSEO Google Shopping resolution for Best Buy — the parser that decides
// whether probe-bestbuy-price-truth.mjs can answer its question at all.
//
// The 2026-08-17 probe run returned 20/20 UNRESOLVED: Akamai blocked the page
// fetch and the DataForSEO arm found "no Best Buy offer" for every sku. The
// probe was working; this parser was not. These tests pin it against the
// documented response shapes so the next run fails for a real reason or not at
// all — nobody should have to burn credentials to find a typo'd field name.
//
// FIXTURES ARE SHAPED FROM THE DataForSEO v3 FIELD REFERENCE, not invented:
//   products items[]: type, seller, price (plain float), product_id, shopping_url
//   sellers  items[]: type "shops_list", seller_name, base_price, total_price,
//                     currency, domain, url
//
//   node --test test/bestbuy-live-price.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  itemsOf, isBestBuy, pickBestBuyFromProducts, pickProductId,
  pickBestBuyFromSellers, liveBestBuyPrice, shoppingKeyword, emptyProductsReason,
  titleScore, bestTitleMatch, modelMismatch, MIN_TITLE_OVERLAP,
} from '../bestbuy-live-price.mjs';

const productsJson = (items) => ({ tasks: [{ result: [{ items }] }] });

// ── the three defects that produced 20/20 UNRESOLVED ──────────────────────

test('REGRESSION: a Best Buy row is found via shopping_url, not the absent `url`', () => {
  // The products endpoint has no `url` field. Matching on it meant the domain
  // half of the seller test always compared against undefined.
  const items = [
    { type: 'google_shopping_serp', seller: 'Walmart', price: 219.99, product_id: '1', shopping_url: 'https://www.google.com/shopping/product/1' },
    { type: 'google_shopping_serp', seller: 'BestBuy', price: 239.99, product_id: '2', shopping_url: 'https://www.bestbuy.com/site/x.p?skuId=6519477' },
  ];
  const hit = pickBestBuyFromProducts(items);
  assert.equal(hit.price, 239.99);
  assert.equal(hit.productId, '2');
});

test('REGRESSION: related_searches carries no offer and must not be selected', () => {
  const items = [
    { type: 'related_searches', items: ['best buy tv deals'] },
    { type: 'google_shopping_serp', seller: 'Best Buy', price: 399.99, product_id: '9' },
  ];
  const hit = pickBestBuyFromProducts(items);
  assert.equal(hit.price, 399.99);
});

test('REGRESSION: price is a plain float, never {current}', () => {
  const hit = pickBestBuyFromProducts([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 384.99 }]);
  assert.equal(hit.price, 384.99);
});

test('REGRESSION: a legitimate 0.00 is a price, not a missing one', () => {
  const hit = pickBestBuyFromProducts([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 0 }]);
  assert.equal(hit.price, 0);
});

// ── seller identification ─────────────────────────────────────────────────

test('Best Buy is recognised by name spelling and by domain', () => {
  assert.ok(isBestBuy('Best Buy'));
  assert.ok(isBestBuy('BestBuy'));
  assert.ok(isBestBuy('best buy'));
  assert.ok(isBestBuy('https://www.bestbuy.com/site/x.p'));
  assert.ok(isBestBuy('bestbuy.com'));
});

test('a lookalike merchant is not Best Buy', () => {
  assert.equal(isBestBuy('Best Buy Metals'), true);   // honest limitation: name-only match is broad
  assert.equal(isBestBuy('notbestbuy.example.com'), false);
  assert.equal(isBestBuy('Bestbuyer Electronics Depot'), false);
  assert.equal(isBestBuy(null, undefined, ''), false);
});

// ── sellers (shops_list) ──────────────────────────────────────────────────

test('sellers result reads seller_name and base_price', () => {
  const items = [
    { type: 'shops_list', seller_name: 'Walmart', base_price: 249.0, total_price: 265.5, domain: 'walmart.com' },
    { type: 'shops_list', seller_name: 'Best Buy', base_price: 239.99, total_price: 259.13, domain: 'bestbuy.com', url: 'https://www.bestbuy.com/x' },
  ];
  const hit = pickBestBuyFromSellers(items);
  assert.equal(hit.price, 239.99);        // base_price
  assert.equal(hit.totalPrice, 259.13);
});

test('base_price is preferred over total_price — tax and shipping would fake a FIELD-WRONG', () => {
  const hit = pickBestBuyFromSellers([
    { type: 'shops_list', seller_name: 'Best Buy', base_price: 399.99, total_price: 441.2, domain: 'bestbuy.com' },
  ]);
  assert.equal(hit.price, 399.99);
  assert.notEqual(hit.price, 441.2);
});

test('total_price is used only when base_price is absent', () => {
  const hit = pickBestBuyFromSellers([
    { type: 'shops_list', seller_name: 'Best Buy', total_price: 120.0, domain: 'bestbuy.com' },
  ]);
  assert.equal(hit.price, 120.0);
});

test('a sellers list with no Best Buy row returns null, not a wrong seller', () => {
  assert.equal(pickBestBuyFromSellers([
    { type: 'shops_list', seller_name: 'Walmart', base_price: 249.0, domain: 'walmart.com' },
    { type: 'shops_list', seller_name: 'Target', base_price: 244.0, domain: 'target.com' },
  ]), null);
});

// ── product_id selection ──────────────────────────────────────────────────

test('product_id comes from the title that best matches the catalog name', () => {
  const items = [
    { type: 'google_shopping_serp', product_id: 'ACC', title: 'Wall Mount Bracket for Samsung 65 inch TV' },
    { type: 'google_shopping_serp', product_id: 'RIGHT', title: 'Samsung 65 inch Class QLED 4K Smart TV' },
  ];
  assert.equal(pickProductId(items, 'Samsung 65 inch Class QLED 4K Smart TV'), 'RIGHT');
});

test('items with no product_id are skipped', () => {
  assert.equal(pickProductId([{ type: 'google_shopping_serp', title: 'no id here' }], 'anything'), null);
});

// ── envelope tolerance ────────────────────────────────────────────────────

test('a missing or malformed envelope yields no items rather than throwing', () => {
  for (const j of [undefined, null, {}, { tasks: [] }, { tasks: [{}] }, { tasks: [{ result: [] }] }, { tasks: [{ result: [{}] }] }]) {
    assert.deepEqual(itemsOf(j), []);
  }
});

// ── the two-step flow, driven with an injected fetch ──────────────────────
//
// BOTH steps are task_post + poll task_get. Google Shopping has no live
// endpoint — products, sellers, product_info and reviews are task-based
// without exception — so a fixture is a routing table keyed on the path, not
// one canned response. Runs 32153401588 and 32168477366 both posted step 1 to
// `products/live/advanced` and got task 40402 "Invalid Path." with HTTP 200
// and an empty result, which read downstream as a keyword that matched
// nothing. A single-response mock cannot catch that; these route on the URL.

const postedJson = (id) => ({ tasks_error: 0, tasks: [{ id, status_code: 20100, status_message: 'Task Created.' }] });
const okTask = (items) => ({ tasks_error: 0, tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ items }] }] });

function router(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    for (const [match, handler] of routes) {
      if (!url.includes(match)) continue;
      const body = typeof handler === 'function' ? handler(url) : handler;
      return { ok: true, json: async () => body };
    }
    throw new Error(`unrouted request: ${url}`);
  };
  return { fetchImpl, seen };
}

test('REGRESSION: step 1 posts a task — there is no live path to shortcut to', async () => {
  const { fetchImpl, seen } = router([
    ['/products/task_post', postedJson('PT-1')],
    ['/products/task_get/advanced/', okTask([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 239.99, product_id: 'P1', title: 'Some TV' }])],
  ]);
  const r = await liveBestBuyPrice('Some TV', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 239.99);
  assert.equal(r.via, 'dataforseo:products');
  assert.ok(!seen.some((u) => u.includes('/live/')), 'no request may go to a live path');
  assert.match(seen[0], /\/v3\/merchant\/google\/products\/task_post$/);
  assert.match(seen[1], /\/v3\/merchant\/google\/products\/task_get\/advanced\/PT-1$/);
});

test('REGRESSION: 40402 Invalid Path names itself instead of blaming the keyword', async () => {
  // The exact envelope from run 32168477366, on all three rows.
  const r = await liveBestBuyPrice('x', {
    login: 'u', pw: 'p', sleep: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ tasks_error: 1, tasks: [{ status_code: 40402, status_message: 'Invalid Path.' }] }) }),
  });
  assert.match(r.error, /task_post failed/);
  assert.match(r.error, /40402 Invalid Path\./);
  assert.doesNotMatch(r.error, /no shopping results for keyword/);
});

test('the cheap path returns without ever calling the sellers endpoint', async () => {
  const { fetchImpl, seen } = router([
    ['/products/task_post', postedJson('T1')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 239.99, product_id: 'P1', title: 'Some TV' }])],
  ]);
  const r = await liveBestBuyPrice('Some TV', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 239.99);
  assert.equal(r.via, 'dataforseo:products');
  assert.ok(!seen.some((u) => u.includes('/sellers/')));
});

test('a task still in the queue is polled again, not read as an empty result', async () => {
  // 40602 with no result is "come back later" wearing the same shape as a
  // genuine miss. Reading it as a miss would blame the keyword all over again.
  let gets = 0;
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T2')],
    ['/products/task_get', () => (++gets < 3
      ? { tasks_error: 0, tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] }
      : okTask([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 10, product_id: 'P' }]))],
  ]);
  const r = await liveBestBuyPrice('x', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 10);
  assert.equal(gets, 3);
});

test('a products task that never becomes ready reports that, and is bounded', async () => {
  let gets = 0;
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T3')],
    ['/products/task_get', () => { gets++; return { tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] }; }],
  ]);
  const r = await liveBestBuyPrice('x', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, productsPollAttempts: 4 });
  assert.match(r.error, /products task T3 not ready after 4 polls/);
  assert.equal(gets, 4);
});

test('a products task that dies after creation is quoted, not silently empty', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T4')],
    ['/products/task_get', { tasks_error: 1, tasks: [{ status_code: 40200, status_message: 'Payment Required.' }] }],
  ]);
  const r = await liveBestBuyPrice('x', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.match(r.error, /products task T4 failed/);
  assert.match(r.error, /40200 Payment Required\./);
});

test('no Best Buy row in products escalates to sellers and resolves there', async () => {
  const { fetchImpl, seen } = router([
    ['/products/task_post', postedJson('PT')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Walmart', price: 249, product_id: 'PID42', title: 'Samsung 65 QLED' }])],
    ['/sellers/task_post', postedJson('TASK-1')],
    ['/sellers/task_get', okTask([{ type: 'shops_list', seller_name: 'Best Buy', base_price: 239.99, domain: 'bestbuy.com' }])],
  ]);
  const r = await liveBestBuyPrice('Samsung 65 QLED', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 239.99);
  assert.equal(r.via, 'dataforseo:sellers');
  assert.equal(r.productId, 'PID42');
  assert.ok(seen.some((u) => u.includes('/sellers/task_post')));
  assert.ok(seen.some((u) => u.includes('/sellers/task_get/advanced/TASK-1')));
});

test('--no-sellers stops after step 1', async () => {
  const { fetchImpl, seen } = router([
    ['/products/task_post', postedJson('T5')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Walmart', price: 249, product_id: 'X' }])],
  ]);
  const r = await liveBestBuyPrice('thing', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, useSellers: false });
  assert.equal(r.error, 'no bestbuy offer in shopping results');
  assert.equal(seen.length, 2);
});

test('a sellers task that never becomes ready reports that, and is bounded', async () => {
  let polls = 0;
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('PT')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Walmart', price: 1, product_id: 'P', title: 't' }])],
    ['/sellers/task_post', postedJson('T')],
    ['/sellers/task_get', () => { polls++; return { tasks: [{ result: [] }] }; }],
  ]);
  const r = await liveBestBuyPrice('t', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, sellersPollAttempts: 3 });
  assert.match(r.error, /sellers task T not ready after 3 polls/);
  assert.equal(polls, 3);
});

test('a sellers result that lists other merchants says so, rather than "no offer"', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('PT')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Walmart', price: 1, product_id: 'P9', title: 't' }])],
    ['/sellers/task_post', postedJson('T')],
    ['/sellers/task_get', okTask([{ type: 'shops_list', seller_name: 'Target', base_price: 5, domain: 'target.com' }])],
  ]);
  const r = await liveBestBuyPrice('t', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.match(r.error, /1 sellers, none Best Buy/);
});

test('missing credentials are reported before any request is made', async () => {
  let called = false;
  const r = await liveBestBuyPrice('x', { login: '', pw: '', fetchImpl: async () => { called = true; } });
  assert.equal(r.error, 'no dataforseo creds');
  assert.equal(called, false);
});

test('an HTTP error is surfaced with its status, not swallowed as "no offer"', async () => {
  const r = await liveBestBuyPrice('x', { login: 'u', pw: 'p', fetchImpl: async () => ({ ok: false, status: 402 }) });
  assert.equal(r.error, 'dataforseo products HTTP 402');
});

test('an empty products result is distinguishable from a result with no Best Buy', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T6')],
    ['/products/task_get', okTask([])],
  ]);
  const r = await liveBestBuyPrice('x', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.match(r.error, /^no shopping results for keyword \(task 20000 Ok\./);
});

// An empty `items` with HTTP 200 covers both "Shopping had nothing" and "the
// task never ran". The envelope distinguishes them; the error string has to
// carry that, or the next run re-investigates the keyword for a rejected
// field or a drained balance.

test('a task that failed with HTTP 200 reports its own status, not the keyword', async () => {
  const r = await liveBestBuyPrice('x', {
    login: 'u', pw: 'p', sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ tasks_error: 1, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'keyword'." }] }),
    }),
  });
  assert.match(r.error, /40501/);
  assert.match(r.error, /Invalid Field: 'keyword'\./);
  assert.match(r.error, /tasks_error 1/);
});

test('a genuinely empty but successful task says so, so the keyword is the suspect', async () => {
  const r = await liveBestBuyPrice('x', {
    login: 'u', pw: 'p', sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ tasks_error: 0, tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ items: [] }] }] }),
    }),
  });
  assert.match(r.error, /task 20000 Ok\./);
  assert.match(r.error, /tasks_error 0/);
});

test('an envelope carrying no status at all falls back to the plain message', () => {
  assert.equal(emptyProductsReason({}), 'no shopping results for keyword');
  assert.equal(emptyProductsReason(productsJson([])), 'no shopping results for keyword');
});

test('a half-populated envelope reports the half it has', () => {
  assert.match(emptyProductsReason({ tasks: [{ status_code: 40200 }] }), /task 40200 no status_message/);
  assert.match(emptyProductsReason({ tasks_error: 3 }), /tasks_error 3/);
});

// ── product identity: is this price even for our product? ────────────────
//
// Run 32174849780 resolved 19 of 20 rows and returned $899.99 as the live
// price of a CPU stored at $95.79. The products path took the FIRST Best Buy
// row in the result and never compared it to what we asked for, so a wrong
// number arrived wearing the same shape as a right one — and voted FIELD-WRONG.

test('REGRESSION: a Best Buy row for a different product is refused, not priced', () => {
  const items = [
    { type: 'google_shopping_serp', seller: 'Best Buy', price: 899.99, product_id: 'X', title: 'AMD Ryzen 9 9950X3D 16-Core Desktop Processor' },
  ];
  const hit = pickBestBuyFromProducts(items, 'Intel - Core i3-12100F Desktop Processor');
  assert.equal(hit.rejected, true, 'the price must not stand for our product');
  assert.equal(hit.price, 899.99, 'the refused offer is still reported, so the note can name it');
  assert.equal(hit.clash, '9950x3d', 'the model number is what gives it away — overlap alone scores it 0.6');
});

test('overlap alone cannot do this: the wrong CPU outscores the right headset', () => {
  // The measurement that shaped the rule. Category vocabulary (core, desktop,
  // processor) carries a mismatch above the floor, while a correct match loses
  // points to marketing words the listing drops. No single threshold separates
  // these two, which is why the model number is checked separately.
  const wrong = titleScore('Intel - Core i3-12100F Desktop Processor', 'AMD Ryzen 9 9950X3D 16-Core Desktop Processor');
  const right = titleScore(
    'HyperX - Cloud Stinger 2 Wired Gaming Headset for PS5 and PS4 - White',
    'HyperX Cloud Stinger 2 Gaming Headset - White',
  );
  assert.ok(wrong > right, `expected the inversion that motivates modelMismatch (wrong ${wrong}, right ${right})`);
  assert.ok(wrong >= MIN_TITLE_OVERLAP, 'the wrong product clears the overlap floor on its own');
  assert.equal(modelMismatch('Intel - Core i3-12100F Desktop Processor', 'AMD Ryzen 9 9950X3D 16-Core Desktop Processor'), '9950x3d');
  assert.equal(modelMismatch('HyperX - Cloud Stinger 2 Wired Gaming Headset for PS5 and PS4 - White', 'HyperX Cloud Stinger 2 Gaming Headset - White'), null);
});

test('a vendor part code on a name we do match is not a mismatch', () => {
  // Listings append their own SKU. Rejecting on any unfamiliar model token
  // would cost real rows, so the rule fires only when NONE of ours is present.
  assert.equal(modelMismatch(
    'ASUS - DUAL NVIDIA GeForce RTX 5060 OC Edition 8GB GDDR7 PCI Express 5.0 Graphics Card',
    'ASUS Dual GeForce RTX 5060 OC DUAL-RTX5060-O8G 8GB GDDR7 Graphics Card',
  ), null);
});

test('a title with no model number at all is left to the overlap floor', () => {
  assert.equal(modelMismatch('Intel - Core i3-12100F Desktop Processor', 'AMD Ryzen Desktop Processor'), null);
  assert.ok(titleScore('Intel - Core i3-12100F Desktop Processor', 'AMD Ryzen Desktop Processor') < MIN_TITLE_OVERLAP);
});

test('the best-matching Best Buy row wins, not the first one', () => {
  const items = [
    { type: 'google_shopping_serp', seller: 'Best Buy', price: 24.99, product_id: 'ACC', title: 'Wall Mount Bracket for Samsung 65 inch Class QLED TV' },
    { type: 'google_shopping_serp', seller: 'Best Buy', price: 999.99, product_id: 'RIGHT', title: 'Samsung 65 inch Class QLED 4K Smart TV' },
  ];
  const hit = pickBestBuyFromProducts(items, 'Samsung 65 inch Class QLED 4K Smart TV');
  assert.equal(hit.productId, 'RIGHT');
  assert.ok(!hit.rejected);
});

test('a matching row carries its evidence out with the price', () => {
  const hit = pickBestBuyFromProducts(
    [{ type: 'google_shopping_serp', seller: 'Best Buy', price: 29.99, product_id: 'P', title: 'HyperX Cloud Stinger 2 Gaming Headset - White' }],
    'HyperX - Cloud Stinger 2 Wired Gaming Headset for PS5 and PS4 - White',
  );
  assert.equal(hit.title, 'HyperX Cloud Stinger 2 Gaming Headset - White');
  assert.ok(hit.score >= MIN_TITLE_OVERLAP);
});

test('the sellers arm is gated too — an unchecked product_id buys the wrong price confidently', () => {
  const items = [
    { type: 'google_shopping_serp', product_id: 'WRONG', title: 'Wall Mount Bracket for 65 inch TVs' },
  ];
  assert.equal(pickProductId(items, 'Samsung 65 inch Class QLED 4K Smart TV'), null);
  assert.equal(bestTitleMatch(items, 'Samsung 65 inch Class QLED 4K Smart TV').ok, false);
  assert.equal(bestTitleMatch(items, 'Samsung 65 inch Class QLED 4K Smart TV').productId, 'WRONG',
    'the near-miss is still reported, so the note can name what it refused');
});

test('a keyword with nothing to score stands the gate down rather than refusing every row', () => {
  // shoppingKeyword() always supplies a name in production; this is the shape
  // a caller with no name at all gets, and it must not reject silently.
  assert.equal(titleScore('', 'anything at all'), 1);
  assert.equal(titleScore('ab', 'anything at all'), 1, 'sub-token names score nothing to compare');
});

test('a refused row reports the refusal, not "no bestbuy offer"', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T7')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 899.99, product_id: 'X', title: 'AMD Ryzen 9 9950X3D 16-Core Desktop Processor' }])],
  ]);
  const r = await liveBestBuyPrice('Intel - Core i3-12100F Desktop Processor', {
    login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, useSellers: false,
  });
  assert.equal(r.live, undefined, 'a refused offer resolves nothing');
  assert.match(r.error, /not our product \(model 9950x3d/);
  assert.match(r.error, /Ryzen 9 9950X3D/);
});

test('a resolved row says which arm answered and how well the title matched', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('T8')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 29.99, product_id: 'P', title: 'HyperX Cloud Stinger 2 Gaming Headset - White' }])],
  ]);
  const r = await liveBestBuyPrice('HyperX - Cloud Stinger 2 Wired Gaming Headset for PS5 and PS4 - White', {
    login: 'u', pw: 'p', fetchImpl, sleep: async () => {},
  });
  assert.equal(r.live, 29.99);
  assert.equal(r.via, 'dataforseo:products');
  assert.equal(r.matchTitle, 'HyperX Cloud Stinger 2 Gaming Headset - White');
  assert.ok(r.matchScore >= MIN_TITLE_OVERLAP);
});

test('a sellers answer carries the identity the product_id was chosen on', async () => {
  const { fetchImpl } = router([
    ['/products/task_post', postedJson('PT')],
    ['/products/task_get', okTask([{ type: 'google_shopping_serp', seller: 'Walmart', price: 249, product_id: 'PID42', title: 'Samsung 65 inch Class QLED 4K Smart TV' }])],
    ['/sellers/task_post', postedJson('TASK-1')],
    ['/sellers/task_get', okTask([{ type: 'shops_list', seller_name: 'Best Buy', base_price: 239.99, domain: 'bestbuy.com' }])],
  ]);
  const r = await liveBestBuyPrice('Samsung 65 inch Class QLED 4K Smart TV', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.via, 'dataforseo:sellers');
  assert.equal(r.matchTitle, 'Samsung 65 inch Class QLED 4K Smart TV');
  assert.equal(r.matchScore, 1);
});

// ── the keyword, which decides whether step 1 returns anything at all ─────
//
// Run 32153401588 (5 rows, sellers off, live=dataforseo) came back 5/5
// UNRESOLVED with `no shopping results for keyword` on every row. That error
// returns before the useSellers branch, so the sellers arm was never reached
// and enabling it would have changed nothing. The keyword was the catalog
// name, part number and all.

test('the Best Buy API name is preferred over the catalog name as the keyword', () => {
  const kw = shoppingKeyword(
    'HyperX HHSS1C-KB-WT/G Cloud Stinger Core – W',
    'HyperX - Cloud Stinger 2 Wired Gaming Headset',
  );
  assert.equal(kw.name, 'HyperX - Cloud Stinger 2 Wired Gaming Headset');
  assert.equal(kw.source, 'bb-api');
});

test('a 404ed sku falls back to the catalog name rather than sending an empty keyword', () => {
  // apiPrice returns { missing: true } for a 404 — no `name` at all. Sending
  // '' would make every such row fail as "no shopping results" for a reason
  // that has nothing to do with the product.
  const kw = shoppingKeyword('ASRock B650M-HDV/M.2 Motherboard', undefined);
  assert.equal(kw.name, 'ASRock B650M-HDV/M.2 Motherboard');
  assert.equal(kw.source, 'catalog');
});

test('an empty or whitespace API name is treated as absent, not as a valid keyword', () => {
  assert.equal(shoppingKeyword('Catalog Name', '').source, 'catalog');
  assert.equal(shoppingKeyword('Catalog Name', '   ').source, 'catalog');
  assert.equal(shoppingKeyword('Catalog Name', '   ').name, 'Catalog Name');
});

test('the keyword source is reported so an UNRESOLVED run says which string it whiffed on', () => {
  assert.equal(shoppingKeyword('a', 'b').source, 'bb-api');
  assert.equal(shoppingKeyword('a', null).source, 'catalog');
});
