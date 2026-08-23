// Migration 1 — verify-catalog ASIN repair moves off the paid DataForSEO products
// search onto free PA API SearchItems, with DataForSEO kept ONLY as the failover.
//
// The contract these tests lock:
//   1. PA API healthy  -> SearchItems is the source; ZERO DataForSEO calls; results
//      normalized to {asin,title,price} with the New buy-box price.
//   2. PA API healthy but empty -> authoritative "not found"; still ZERO DataForSEO
//      calls. This is the anti-regression that keeps the migration from silently
//      re-billing the very search it was meant to eliminate.
//   3. PA API gated (AssociateNotEligible) -> falls back to the paid DataForSEO
//      products endpoint so repair still runs — the Phase-3 degrade-don't-fail rule.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';

// PA API creds are read lazily at call time; placeholders satisfy loadCreds() so the
// circuit doesn't open with 'not_configured' before our fetch stub is consulted (see
// amazon-paapi.searchitems.test.js). DataForSEO creds are NOT needed: verify-catalog's
// products-search failover is only reached in test 3, where the stub answers it and
// ignores the Authorization header.
process.env.AMAZON_CREATORS_CLIENT_ID ||= 'test-client-id';
process.env.AMAZON_CREATORS_CLIENT_SECRET ||= 'test-client-secret';

import { resetPaapi, paapiStatus } from '../amazon-paapi.js';
import { searchAmazonFor, findBestASIN } from '../verify-catalog-asins.js';

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };

const tokenOK = () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const searchResp = (items) => new Response(
  JSON.stringify({ searchResult: { items, totalResultCount: items.length } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const listing = (amount, cond = 'New') => ({ isBuyBoxWinner: true, condition: { value: cond }, price: { money: { amount } } });
const paItem = (asin, title, price) => ({ asin, itemInfo: { title: { displayValue: title } }, offersV2: { listings: [listing(price)] } });

test.afterEach(() => { restore(); resetPaapi(); });

test('PA API healthy: normalized candidates from SearchItems, bills no DataForSEO', async () => {
  let dfsCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/o2/token')) return tokenOK();
    if (u.includes('/searchItems')) return searchResp([
      paItem('AAA', 'Corsair RM750e 750W PSU', 99.99),
      paItem('BBB', 'Corsair RM850e 850W PSU', 129.99),
    ]);
    if (u.includes('api.dataforseo.com')) { dfsCalls++; return new Response('{}', { status: 200 }); }
    throw new Error('unexpected fetch: ' + u);
  };
  const cands = await searchAmazonFor('Corsair RM750e 750W');
  assert.equal(dfsCalls, 0, 'PA API healthy must not touch the paid DataForSEO endpoint');
  assert.equal(cands.length, 2);
  assert.deepEqual(cands[0], { asin: 'AAA', title: 'Corsair RM750e 750W PSU', price: 99.99 });
  assert.equal(cands[1].price, 129.99, 'price comes from the New buy-box offer');
});

test('PA API healthy but empty is authoritative — no paid DataForSEO re-bill', async () => {
  let dfsCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/o2/token')) return tokenOK();
    if (u.includes('/searchItems')) return searchResp([]);
    if (u.includes('api.dataforseo.com')) { dfsCalls++; return new Response('{}', { status: 200 }); }
    throw new Error('unexpected fetch: ' + u);
  };
  const cands = await searchAmazonFor('nonexistent product xyz');
  assert.deepEqual(cands, []);
  assert.equal(dfsCalls, 0, 'a genuine PA API not-found must NOT fall back to a paid search');
  assert.equal(paapiStatus().available, true);
});

test('PA API gated (AssociateNotEligible) falls back to the paid DataForSEO products search', async () => {
  let productsPost = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/o2/token')) return tokenOK();
    if (u.includes('/searchItems')) return new Response('{"__type":"AssociateNotEligible","message":"not eligible"}', { status: 400 });
    // Return a task envelope with NO id so searchAmazonForViaDataForSEO returns
    // immediately (before its 30s poll delay) — enough to prove delegation happened.
    if (u.includes('/merchant/amazon/products/task_post')) {
      productsPost++;
      return new Response(JSON.stringify({ tasks: [{}] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  const cands = await searchAmazonFor('Corsair RM750e');
  assert.equal(paapiStatus().available, false, 'circuit opened on AssociateNotEligible');
  assert.equal(paapiStatus().disabledReason, 'associate_not_eligible');
  assert.equal(productsPost, 1, 'delegated to the DataForSEO products endpoint as failover');
  assert.equal(cands, null);
});

test('findBestASIN picks the highest title-score candidate from the PA API results', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/auth/o2/token')) return tokenOK();
    if (u.includes('/searchItems')) return searchResp([
      paItem('UNRELATED', 'Logitech G502 Hero Gaming Mouse', 39.99),
      paItem('MATCH', 'Corsair RM750e 750W 80+ Gold PSU', 99.99),
    ]);
    throw new Error('unexpected fetch: ' + u);
  };
  const best = await findBestASIN({ n: 'Corsair RM750e 750W PSU', c: 'PSU', b: 'Corsair' });
  assert.ok(best, 'a match is found');
  assert.equal(best.asin, 'MATCH');
  assert.equal(best.price, 99.99);
});
