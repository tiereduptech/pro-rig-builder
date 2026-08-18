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
  titleScore, bestTitleMatch, modelMismatch, provenance, MIN_TITLE_OVERLAP,
  identityCheck, variantClash, packSize, packClash,
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
  assert.equal(hit.clash, 'model 9950x3d', 'the model number is what gives it away, and the note says so');
});

test('overlap alone cannot do this: a variant scores well above the floor', () => {
  // The measurement that shapes the rule, restated on real pairs from run
  // 32178925976. Category vocabulary carries a WRONG variant to 58-67%, well
  // clear of the floor, while a RIGHT match that loses marketing words the
  // listing drops sits at 60%. No single threshold separates those, which is
  // why the model number is checked separately.
  //
  // (The pair this test used to cite — i3-12100F against 9950X3D — no longer
  // inverts, because `i3` is a token now and drops it to 33%. The tokenizer
  // fix narrowed the overlap rule's blind spot; it did not remove it.)
  const wrongVariant = titleScore('NZXT - H7 Flow 2024 Mid-Tower ATX PC Case with RGB Fans - White', 'NZXT H9 Flow RGB+ Dual-Chamber Mid-Tower ATX Case');
  const rightProduct = titleScore('NZXT - H7 Flow 2024 Mid-Tower ATX PC Case - White', 'NZXT H7 Flow Mid-Tower Case');
  assert.ok(wrongVariant >= MIN_TITLE_OVERLAP, `the wrong variant clears the floor on its own (${wrongVariant})`);
  assert.ok(rightProduct - wrongVariant < 0.1, `no threshold separates these two (wrong ${wrongVariant}, right ${rightProduct})`);
  assert.equal(modelMismatch('NZXT - H7 Flow 2024 Mid-Tower ATX PC Case with RGB Fans - White', 'NZXT H9 Flow RGB+ Dual-Chamber Mid-Tower ATX Case'), 'h9');
  assert.equal(modelMismatch('NZXT - H7 Flow 2024 Mid-Tower ATX PC Case - White', 'NZXT H7 Flow Mid-Tower Case'), null);
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
  assert.equal(titleScore('-', 'anything at all'), 1, 'a name with no scorable token has nothing to compare');
  assert.equal(titleScore('a', 'anything at all'), 1, 'a single character is not a token');
});

// ── the variant blind spot: run 32178925976 ──────────────────────────────
//
// That run resolved 13 of 20 rows and called 5 of them FIELD-WRONG. Three of
// the five were the wrong VARIANT of the right product — an H9 case priced as
// our H7, an 8G card priced as our 16G, an RX120 kit priced as our LX120 —
// and each got through the gate rather than past it. These pin the three
// defects that let them through, on the exact strings the run printed.

test('REGRESSION: the tokens that separate variants are the short ones', () => {
  // A three-character floor deleted Ti, H7, H9 and 8G before the gate saw
  // them, which is the whole vocabulary of a variant. "RTX 5060 Ti" scored a
  // clean 100% against an 8G non-Ti card because `ti` was not a token at all.
  assert.ok(titleScore('NVIDIA GeForce RTX 5060 Ti', 'ASUS Dual -RTX5060-8G NVIDIA GeForce RTX 5060 8 GB GDDR7') < 1,
    'the Ti has to cost something');
  assert.equal(identityCheck('NVIDIA GeForce RTX 5060 Ti', 'ASUS Dual -RTX5060-8G NVIDIA GeForce RTX 5060 8 GB GDDR7').ok, false);
  assert.equal(modelMismatch('NZXT - H7 Flow 2024 Mid-Tower ATX PC Case with RGB Fans - White', 'NZXT H9 Flow RGB+ Dual-Chamber Mid-Tower ATX Case'), 'h9');
});

test('REGRESSION: a shared spec token no longer silences the model rule', () => {
  // Both kits are 120mm and both cards are GDDR7, and one shared model-shaped
  // token used to stand the rule down entirely. gpu/30111 was priced $188
  // below its salePrice on an 8G card because 16G and 8G share `gddr7`.
  assert.equal(modelMismatch(
    'CORSAIR - iCUE LINK LX120 RGB 120mm PWM Case Fans Starter Kit (3-pack) - White',
    'CORSAIR iCUE LINK RX120 RGB 120mm PWM Triple Starter Kit',
  ), 'rx120');
  assert.equal(modelMismatch(
    'GIGABYTE - GeForce RTX 5060 Ti Gaming OC 16G Graphics Card 16GB GDDR7',
    'GIGABYTE GeForce RTX 5060 Ti Eagle MAX OC 8G Graphics Card 8GB GDDR7',
  ), '8g');
  assert.equal(modelMismatch('ASUS Prime B840-PLUS WiFi AMD AM5 B840 ATX', 'ASUS PRIME B850-PLUS WIFI ATX Motherboard'), 'b850',
    'AM5 and ATX are shared, and the board is still a different board');
});

test('a shared spec token still cannot invent a mismatch out of a matching pair', () => {
  // The other half of the same rule: the concession for vendor part codes has
  // to survive, or every listing that appends its own sku is refused.
  assert.equal(modelMismatch('CORSAIR - RS120 ARGB 120mm PWM Case Fans (3-pack) - Black', 'Corsair Rs120 Argb PWM 120mm Fans Triple Pack Simplified Control'), null);
  assert.equal(modelMismatch('NZXT - Kraken Elite RGB 280mm 2024 Radiator Liquid Cooler', 'NZXT Kraken Elite RGB 280mm AIO Liquid Cooler Black'), null);
  // ddr5 against pcie5 is the false positive the same-number arm has to avoid:
  // they share a 5 and are not a variant apart. Three digits or more is what
  // separates that from lx120 against rx120.
  assert.equal(modelMismatch('ASUS Prime B840 DDR5 Motherboard', 'ASUS Prime B840 PCIe5 Motherboard'), null);
});

test('REGRESSION: a variant word the title adds is not free', () => {
  // The score is the fraction of OUR tokens found in the title, so anything
  // the title ADDS costs nothing — a Ti, a Pro, a 3-pack, or a bracket that
  // names our TV in full. Those are read in both directions now.
  assert.equal(variantClash('NVIDIA GeForce RTX 5060 Ti', 'ASUS Dual RTX 5060 8GB GDDR7'), 'ti');
  assert.equal(variantClash('GIGABYTE GeForce RTX 5060 Gaming OC', 'GIGABYTE GeForce RTX 5060 Eagle MAX OC'), 'max');
  assert.equal(variantClash('Samsung 65 inch Class QLED 4K Smart TV', 'Wall Mount Bracket for Samsung 65 inch Class QLED TV'), 'mount');
  assert.ok(titleScore('Samsung 65 inch Class QLED 4K Smart TV', 'Wall Mount Bracket for Samsung 65 inch Class QLED TV') >= MIN_TITLE_OVERLAP,
    'the accessory clears the overlap floor, which is why the word is checked');
});

test('an omitted word is not a contradiction — wired against silent still matches', () => {
  // Half of Shopping's titles drop "Wired" from a wired headset. Refusing on
  // the omission would cost the rows the probe exists to price; refusing on
  // "Wireless" is the point.
  assert.equal(variantClash('HyperX - Cloud Stinger 2 Wired Gaming Headset for PS5 and PS4 - White', 'HyperX Cloud Stinger 2 Gaming Headset - White'), null);
  assert.equal(variantClash('HyperX - Cloud Stinger 2 Wired Gaming Headset', 'HyperX Cloud Stinger 2 Wireless Gaming Headset'), 'wireless');
});

test('pack size is read in words as well as digits, and only clashes when both are stated', () => {
  // "(3-pack)", "Triple Pack" and "Triple Starter Kit" are the same three
  // fans; a kit that states no size states nothing, and guessing 1 would
  // refuse every kit.
  assert.equal(packSize('CORSAIR - RS120 ARGB 120mm PWM Case Fans (3-pack) - Black'), 3);
  assert.equal(packSize('Corsair Rs120 Argb PWM 120mm Fans Triple Pack'), 3);
  assert.equal(packSize('CORSAIR iCUE LINK RX120 RGB 120mm PWM Triple Starter Kit'), 3);
  assert.equal(packSize('CORSAIR iCUE LINK LX120 RGB 120mm PWM Starter Kit'), null);
  assert.equal(packClash('CORSAIR - RS120 ARGB 120mm Case Fans (3-pack)', 'Corsair RS120 ARGB 120mm Case Fan Single Pack'), '1-pack vs 3');
  assert.equal(packClash('CORSAIR - RS120 ARGB 120mm Case Fans (3-pack)', 'Corsair RS120 ARGB 120mm PWM Case Fan'), null);
});

test('the three run-32178925976 variant rows are all refused, and the right ones are not', () => {
  // The end-to-end statement of what this change is for: the rows that voted
  // FIELD-WRONG on a different variant stop voting, and the rows that agreed
  // with salePrice still resolve.
  const refused = [
    ['NZXT - H7 Flow 2024 Mid-Tower ATX PC Case with RGB Fans - White', 'NZXT H9 Flow RGB+ Dual-Chamber Mid-Tower ATX Case'],
    ['GIGABYTE - GeForce RTX 5060 Ti Gaming OC 16G Graphics Card 16GB GDDR7', 'GIGABYTE GeForce RTX 5060 Ti Eagle MAX OC 8G Graphics Card 8GB'],
    ['CORSAIR - iCUE LINK LX120 RGB 120mm PWM Case Fans Starter Kit (3-pack) - White', 'CORSAIR iCUE LINK RX120 RGB 120mm PWM Triple Starter Kit'],
    ['NVIDIA GeForce RTX 5060 Ti', 'ASUS Dual -RTX5060-8G NVIDIA GeForce RTX 5060 8 GB GDDR7'],
  ];
  for (const [name, title] of refused) {
    const r = identityCheck(name, title);
    assert.equal(r.ok, false, `expected a refusal: ${title}`);
    assert.ok(r.clash, `the refusal has to name itself: ${title}`);
  }
  const kept = [
    ['NZXT - H7 Flow 2024 Mid-Tower ATX PC Case - White', 'NZXT H7 Flow Mid-Tower Case'],
    ['CORSAIR - RS120 ARGB 120mm PWM Case Fans (3-pack) - Black', 'Corsair Rs120 Argb PWM 120mm Fans Triple Pack Simplified Control'],
    ['HyperX - Cloud Stinger 2 Wired Gaming Headset', 'HyperX Cloud Stinger 2 Wired Gaming Headset'],
    ['ASUS Prime B840-PLUS WiFi AMD AM5 B840 ATX Motherboard', 'ASUS PRIME B840-PLUS WIFI ATX Motherboard'],
  ];
  for (const [name, title] of kept) {
    assert.equal(identityCheck(name, title).ok, true, `expected a match: ${title}`);
  }
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

// ── provenance: what a live number was a price FOR ────────────────────────

test('an accepted price says which arm answered, how well it matched, and what it matched', () => {
  assert.equal(
    provenance({ via: 'dataforseo:sellers', matchScore: 0.857, matchTitle: 'Samsung 65 inch Class QLED 4K Smart TV' }),
    'via dataforseo:sellers 86%: "Samsung 65 inch Class QLED 4K Smart TV"',
  );
});

test('provenance degrades rather than throwing when a field is absent', () => {
  assert.equal(provenance({ via: 'dataforseo:products' }), 'via dataforseo:products');
  assert.equal(provenance({}), 'via unknown');
  assert.equal(provenance(null), 'via unknown');
});

test('a long listing title is trimmed, not printed whole into the table', () => {
  const long = 'A'.repeat(200);
  assert.ok(provenance({ via: 'x', matchTitle: long }).length < 100);
});
