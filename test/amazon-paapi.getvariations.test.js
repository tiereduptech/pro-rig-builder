// getVariations() failover + pagination contract.
//
// GetVariations is the third Creators-API surface (after resolveItems/searchItems):
// it resolves a PARENT asin's variation family — the child SKUs that differ by
// colour/size/capacity. Like the other two it MUST inherit the exact same circuit
// breaker and pacing: a dead credential costs one call not one per page, an already
// open circuit makes zero calls, nothing throws. These tests stub fetch (no network)
// and lock those guarantees plus child-ASIN dedup and variationDimension extraction.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';

// See amazon-paapi.searchitems.test.js for why these placeholders exist: loadCreds()
// otherwise falls back to a Windows CSV path absent on Linux/CI, and the circuit
// would open with 'not_configured' before the stub is ever consulted. Never sent.
process.env.AMAZON_CREATORS_CLIENT_ID ||= 'test-client-id';
process.env.AMAZON_CREATORS_CLIENT_SECRET ||= 'test-client-secret';

import { getVariations, resolveItems, paapiStatus, resetPaapi, VARIATION_PAGE_MAX } from '../amazon-paapi.js';

const realFetch = globalThis.fetch;
function stubFetch(handler) { globalThis.fetch = handler; }
function restore() { globalThis.fetch = realFetch; }

const tokenOK = () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } });

const varResp = (items, dims = ['Size'], total) => new Response(
  JSON.stringify({ variationsResult: {
    items,
    variationSummary: { variationCount: total ?? items.length, variationDimensions: dims.map(name => ({ name })) },
  } }),
  { status: 200, headers: { 'content-type': 'application/json' } });

test.afterEach(() => { restore(); resetPaapi(); });

test('empty asin never calls the network', async () => {
  let called = 0;
  stubFetch(async () => { called++; return tokenOK(); });
  const r = await getVariations('');
  assert.deepEqual(r, { items: [], variationDimensions: [], totalResultCount: null, pagesFetched: 0 });
  assert.equal(called, 0);
});

test('happy path returns children + variation dimensions', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    assert.ok(String(url).includes('/getVariations'), 'must hit the getVariations endpoint');
    return varResp([
      { asin: 'C1', itemInfo: { title: { displayValue: 'SSD 1TB' } } },
      { asin: 'C2', itemInfo: { title: { displayValue: 'SSD 2TB' } } },
    ], ['Capacity'], 2);
  });
  const r = await getVariations('PARENT');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.variationDimensions, ['Capacity']);
  assert.equal(r.totalResultCount, 2);
  assert.equal(r.pagesFetched, 1);
  assert.equal(paapiStatus().available, true);
});

test('asin / paging params ride in the request body', async () => {
  const bodies = [];
  stubFetch(async (url, opts) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    bodies.push(JSON.parse(opts.body));
    return varResp([{ asin: 'P' + bodies.length }], ['Color'], 40);
  });
  await getVariations('PARENT', { pages: 3, pace: 0 });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map(b => b.variationPage), [1, 2, 3]);   // pages 1..N
  assert.equal(bodies[0].asin, 'PARENT');
  assert.equal(bodies[0].variationCount, VARIATION_PAGE_MAX);
});

test('child ASINs are de-duplicated across pages', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return varResp([{ asin: 'DUP1' }, { asin: 'DUP2' }, { asin: 'X1' }], ['Size'], 10);
  });
  const r = await getVariations('PARENT', { pages: 3, pace: 0 });
  const ids = r.items.map(i => i.asin).sort();
  assert.deepEqual(ids, ['DUP1', 'DUP2', 'X1']);   // deduped, not 9
});

test('a page that returns zero children stops paging early', async () => {
  let calls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    calls++;
    return calls === 1 ? varResp([{ asin: 'A' }], ['Size'], 1) : varResp([], ['Size'], 1);
  });
  const r = await getVariations('PARENT', { pages: 10, pace: 0 });
  assert.equal(r.items.length, 1);
  assert.equal(calls, 2, 'stops after the first empty page, not all 10');
});

test('401 opens the circuit and returns empty — one call, does not throw', async () => {
  let varCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    varCalls++;
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  });
  const r = await getVariations('PARENT', { pages: 5, pace: 0 });
  assert.deepEqual(r.items, []);
  assert.equal(varCalls, 1, 'circuit opens on the first 401 — no per-page thrash');
  assert.equal(paapiStatus().disabledReason, 'unauthorized');
});

test('AssociateNotEligible degrades getVariations the same way', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response('{"__type":"AssociateNotEligible","message":"not eligible"}', { status: 400 });
  });
  const r = await getVariations('PARENT');
  assert.deepEqual(r.items, []);
  assert.equal(paapiStatus().disabledReason, 'associate_not_eligible');
});

test('getVariations shares the circuit with resolveItems — once open, it makes no calls', async () => {
  let varCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    if (String(url).includes('/getVariations')) { varCalls++; return varResp([{ asin: 'Z' }]); }
    return new Response('{"message":"Unauthorized"}', { status: 401 });   // getItems 401 opens the circuit
  });
  await resolveItems(['A']);                       // trips the breaker
  assert.equal(paapiStatus().available, false);
  const r = await getVariations('PARENT', { pages: 5, pace: 0 });
  assert.deepEqual(r.items, []);
  assert.equal(varCalls, 0, 'an already-open circuit short-circuits getVariations entirely');
});

test('a network throw degrades to an empty result, not a rejection', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    throw new TypeError('socket hang up');
  });
  const r = await getVariations('PARENT', { pace: 0 });   // must not reject
  assert.deepEqual(r.items, []);
  assert.equal(paapiStatus().stats.batchErrors, 1);
});
