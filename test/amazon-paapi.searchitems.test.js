// searchItems() failover + pagination contract.
//
// SearchItems is the discovery counterpart to resolveItems (GetItems): it finds
// catalog rows by keyword/brand rather than by known ASIN, and it MUST inherit the
// exact same circuit breaker and pacing — a dead credential costs one call, not one
// per page; an open circuit makes zero calls; nothing throws. These tests stub fetch
// (no network) and lock those guarantees plus the page-dedup behavior.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { searchItems, resolveItems, paapiStatus, resetPaapi, SEARCH_PAGE_MAX } from '../amazon-paapi.js';

const realFetch = globalThis.fetch;
function stubFetch(handler) { globalThis.fetch = handler; }
function restore() { globalThis.fetch = realFetch; }

const tokenOK = () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } });

const searchResp = (items, total) => new Response(
  JSON.stringify({ searchResult: { items, totalResultCount: total } }),
  { status: 200, headers: { 'content-type': 'application/json' } });

test.afterEach(() => { restore(); resetPaapi(); });

test('empty query with no brand never calls the network', async () => {
  let called = 0;
  stubFetch(async () => { called++; return tokenOK(); });
  const r = await searchItems('');
  assert.deepEqual(r, { items: [], totalResultCount: null, pagesFetched: 0 });
  assert.equal(called, 0);
});

test('happy path returns items + totalResultCount', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    assert.ok(String(url).includes('/searchItems'), 'must hit the searchItems endpoint');
    return searchResp([
      { asin: 'A', itemInfo: { title: { displayValue: 'Apevia X-QT Micro-ATX Case' } } },
      { asin: 'B', itemInfo: { title: { displayValue: 'Apevia Predator Mini Tower' } } },
    ], 222);
  });
  const r = await searchItems('Apevia case', { brand: 'Apevia' });
  assert.equal(r.items.length, 2);
  assert.equal(r.totalResultCount, 222);
  assert.equal(r.pagesFetched, 1);
  assert.equal(paapiStatus().available, true);
});

test('brand / searchIndex / paging params ride in the request body', async () => {
  const bodies = [];
  stubFetch(async (url, opts) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    bodies.push(JSON.parse(opts.body));
    return searchResp([{ asin: 'P' + bodies.length }], 40);
  });
  await searchItems('Apevia case', { brand: 'Apevia', searchIndex: 'Electronics', pages: 3, pace: 0 });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map(b => b.itemPage), [1, 2, 3]);   // pages 1..N
  assert.equal(bodies[0].brand, 'Apevia');
  assert.equal(bodies[0].searchIndex, 'Electronics');
  assert.equal(bodies[0].itemCount, SEARCH_PAGE_MAX);
  assert.equal(bodies[0].keywords, 'Apevia case');
});

test('ASINs are de-duplicated across pages', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    // every page returns the same two ASINs plus one fresh one
    return searchResp([{ asin: 'DUP1' }, { asin: 'DUP2' }, { asin: 'X' + Math.min(1, 1) }], 10);
  });
  const r = await searchItems('q', { pages: 3, pace: 0 });
  const ids = r.items.map(i => i.asin).sort();
  assert.deepEqual(ids, ['DUP1', 'DUP2', 'X1']);   // deduped, not 9
});

test('a page that returns zero items stops paging early', async () => {
  let calls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    calls++;
    return calls === 1 ? searchResp([{ asin: 'A' }], 1) : searchResp([], 1);
  });
  const r = await searchItems('q', { pages: 10, pace: 0 });
  assert.equal(r.items.length, 1);
  assert.equal(calls, 2, 'stops after the first empty page, not all 10');
});

test('pages request is capped at the API 10-page limit', async () => {
  let calls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    calls++;
    return searchResp([{ asin: 'A' + calls }], 999);   // always full so paging continues
  });
  await searchItems('q', { pages: 50, pace: 0 });
  assert.equal(calls, 10);
});

test('401 opens the circuit and returns empty — one call, does not throw', async () => {
  let searchCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    searchCalls++;
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  });
  const r = await searchItems('q', { pages: 5, pace: 0 });
  assert.deepEqual(r.items, []);
  assert.equal(searchCalls, 1, 'circuit opens on the first 401 — no per-page thrash');
  assert.equal(paapiStatus().disabledReason, 'unauthorized');
});

test('AssociateNotEligible degrades searchItems the same way', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response('{"__type":"AssociateNotEligible","message":"not eligible"}', { status: 400 });
  });
  const r = await searchItems('q');
  assert.deepEqual(r.items, []);
  assert.equal(paapiStatus().disabledReason, 'associate_not_eligible');
});

test('searchItems shares the circuit with resolveItems — once open, it makes no calls', async () => {
  let searchCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    if (String(url).includes('/searchItems')) { searchCalls++; return searchResp([{ asin: 'Z' }], 1); }
    return new Response('{"message":"Unauthorized"}', { status: 401 });   // getItems 401 opens the circuit
  });
  await resolveItems(['A']);                       // trips the breaker
  assert.equal(paapiStatus().available, false);
  const r = await searchItems('q', { pages: 5, pace: 0 });
  assert.deepEqual(r.items, []);
  assert.equal(searchCalls, 0, 'an already-open circuit short-circuits searchItems entirely');
});

test('a network throw degrades to an empty result, not a rejection', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    throw new TypeError('socket hang up');
  });
  const r = await searchItems('q', { pace: 0 });   // must not reject
  assert.deepEqual(r.items, []);
  assert.equal(paapiStatus().stats.batchErrors, 1);
});
