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

test('the cheap path returns without ever calling the sellers endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => productsJson([{ type: 'google_shopping_serp', seller: 'Best Buy', price: 239.99, product_id: 'P1' }]) };
  };
  const r = await liveBestBuyPrice('Some TV', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 239.99);
  assert.equal(r.via, 'dataforseo:products');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /merchant\/google\/products/);
});

test('no Best Buy row in products escalates to sellers and resolves there', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('/products/')) {
      return { ok: true, json: async () => productsJson([{ type: 'google_shopping_serp', seller: 'Walmart', price: 249, product_id: 'PID42', title: 'Samsung 65 QLED' }]) };
    }
    if (url.includes('/sellers/task_post')) {
      return { ok: true, json: async () => ({ tasks: [{ id: 'TASK-1' }] }) };
    }
    return { ok: true, json: async () => productsJson([{ type: 'shops_list', seller_name: 'Best Buy', base_price: 239.99, domain: 'bestbuy.com' }]) };
  };
  const r = await liveBestBuyPrice('Samsung 65 QLED', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {} });
  assert.equal(r.live, 239.99);
  assert.equal(r.via, 'dataforseo:sellers');
  assert.equal(r.productId, 'PID42');
  assert.ok(seen.some((u) => u.includes('/sellers/task_post')));
  assert.ok(seen.some((u) => u.includes('/sellers/task_get/advanced/TASK-1')));
});

test('--no-sellers stops after the products call', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => productsJson([{ type: 'google_shopping_serp', seller: 'Walmart', price: 249, product_id: 'X' }]) };
  };
  const r = await liveBestBuyPrice('thing', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, useSellers: false });
  assert.equal(r.error, 'no bestbuy offer in shopping results');
  assert.equal(calls.length, 1);
});

test('a sellers task that never becomes ready reports that, and is bounded', async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/products/')) return { ok: true, json: async () => productsJson([{ type: 'google_shopping_serp', seller: 'Walmart', price: 1, product_id: 'P', title: 't' }]) };
    if (url.includes('task_post')) return { ok: true, json: async () => ({ tasks: [{ id: 'T' }] }) };
    polls++;
    return { ok: true, json: async () => ({ tasks: [{ result: [] }] }) };
  };
  const r = await liveBestBuyPrice('t', { login: 'u', pw: 'p', fetchImpl, sleep: async () => {}, sellersPollAttempts: 3 });
  assert.match(r.error, /not ready after 3 polls/);
  assert.equal(polls, 3);
});

test('a sellers result that lists other merchants says so, rather than "no offer"', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/products/')) return { ok: true, json: async () => productsJson([{ type: 'google_shopping_serp', seller: 'Walmart', price: 1, product_id: 'P9', title: 't' }]) };
    if (url.includes('task_post')) return { ok: true, json: async () => ({ tasks: [{ id: 'T' }] }) };
    return { ok: true, json: async () => productsJson([{ type: 'shops_list', seller_name: 'Target', base_price: 5, domain: 'target.com' }]) };
  };
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
  const r = await liveBestBuyPrice('x', {
    login: 'u', pw: 'p', sleep: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => productsJson([]) }),
  });
  assert.equal(r.error, 'no shopping results for keyword');
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
