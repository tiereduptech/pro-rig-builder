// PA API failover contract.
//
// PA API is a FREE second opinion on rows DataForSEO cannot confirm — but access
// is revocable: it is gated on qualifying sales in a trailing 30-day window, and
// it WILL drop out at some point. When it does, the price pipeline must keep
// running on DataForSEO alone. Every failure mode degrades to an empty result
// plus an alert; nothing throws, so no caller has to defend itself.
//
// The circuit breaker matters for cost as much as correctness: without it a dead
// credential costs one failed request PER ROW across a 2,000-row run.
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';

// These tests stub globalThis.fetch, so no request ever leaves the process and
// no real credential is needed — but amazon-paapi.js checks for one BEFORE it
// would call fetch: loadCreds() falls back to a Windows CSV path that does not
// exist on Linux or in CI, and getToken() then opens the circuit with
// 'not_configured' and returns null. Every assertion below about failover,
// pacing and paging would be answered by that guard instead of by the code
// under test, which is why the suite was 18 tests red on any machine without
// the real credentials wired in — including every CI runner.
//
// Placeholders satisfy the guard. They are never sent anywhere — the stub is
// installed before the first call. The one test that must see NO credentials
// clears them itself and puts them back; see 'no credentials at all'.
process.env.AMAZON_CREATORS_CLIENT_ID ||= 'test-client-id';
process.env.AMAZON_CREATORS_CLIENT_SECRET ||= 'test-client-secret';


import { resolveItems, paapiStatus, resetPaapi, onPaapiAlert, BATCH_MAX } from '../amazon-paapi.js';

const realFetch = globalThis.fetch;
function stubFetch(handler) { globalThis.fetch = handler; }
function restore() { globalThis.fetch = realFetch; }

const tokenOK = () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } });

test.afterEach(() => { restore(); resetPaapi(); });

test('no credentials at all opens the circuit as our_bug, without a request', async () => {
  // The branch the placeholders above hide from every other test in this file.
  // It is the loudest failure mode PA API has — classifyPaapiReason maps
  // not_configured to 'our_bug', which FAILS the job rather than degrading —
  // so it is worth one test that genuinely has nothing configured.
  const { AMAZON_CREATORS_CLIENT_ID: id, AMAZON_CREATORS_CLIENT_SECRET: secret } = process.env;
  delete process.env.AMAZON_CREATORS_CLIENT_ID;
  delete process.env.AMAZON_CREATORS_CLIENT_SECRET;
  let called = 0;
  const reasons = [];
  onPaapiAlert(a => reasons.push(a.reason));
  try {
    stubFetch(async () => { called++; return tokenOK(); });
    const out = await resolveItems(['A', 'B']);
    assert.equal(out.size, 0, 'degrades to empty rather than throwing');
    assert.equal(called, 0, 'a missing credential must not cost a request');
    assert.equal(paapiStatus().available, false);
    assert.equal(paapiStatus().disabledReason, 'not_configured');
    assert.deepEqual(reasons, ['not_configured']);
  } finally {
    process.env.AMAZON_CREATORS_CLIENT_ID = id;
    process.env.AMAZON_CREATORS_CLIENT_SECRET = secret;
  }
});

test('empty / missing input never calls the network', async () => {
  let called = 0;
  stubFetch(async () => { called++; return tokenOK(); });
  assert.equal((await resolveItems([])).size, 0);
  assert.equal((await resolveItems(null)).size, 0);
  assert.equal(called, 0);
});

test('401 on getItems opens the circuit and returns empty — does not throw', async () => {
  let getItemsCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    getItemsCalls++;
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  });
  const out = await resolveItems(['A', 'B', 'C']);
  assert.equal(out.size, 0);
  const st = paapiStatus();
  assert.equal(st.available, false);
  assert.equal(st.disabledReason, 'unauthorized');
  assert.equal(getItemsCalls, 1, 'circuit must open on the first 401, not retry it');
});

test('AssociateNotEligible opens the circuit with its own reason', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response('{"__type":"AssociateNotEligible","message":"not eligible"}', { status: 400 });
  });
  const out = await resolveItems(['A']);
  assert.equal(out.size, 0);
  assert.equal(paapiStatus().disabledReason, 'associate_not_eligible');
});

test('an open circuit short-circuits later batches — a dead credential costs 1 call, not N', async () => {
  let getItemsCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    getItemsCalls++;
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  });
  // 5 full batches' worth of ASINs
  await resolveItems(Array.from({ length: BATCH_MAX * 5 }, (_, i) => `ASIN${i}`));
  assert.equal(getItemsCalls, 1);
});

test('rejected credentials open the circuit at the token step', async () => {
  stubFetch(async () => new Response('{"error":"invalid_client"}', { status: 401 }));
  const out = await resolveItems(['A']);
  assert.equal(out.size, 0);
  assert.equal(paapiStatus().disabledReason, 'credentials_rejected');
});

test('a network throw degrades to empty rather than propagating', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    throw new TypeError('socket hang up');
  });
  const out = await resolveItems(['A']);       // must not reject
  assert.equal(out.size, 0);
  assert.equal(paapiStatus().stats.batchErrors, 1);
});

test('alert listeners fire once per distinct reason and a throwing listener is contained', async () => {
  const seen = [];
  onPaapiAlert(() => { throw new Error('bad listener'); });   // must not break the run
  onPaapiAlert(a => seen.push(a.reason));
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response('{"message":"Unauthorized"}', { status: 401 });
  });
  await resolveItems(['A']);
  await resolveItems(['B']);
  assert.deepEqual(seen, ['unauthorized']);
});

test('happy path returns a Map keyed by asin', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response(JSON.stringify({ itemsResult: { items: [
      { asin: 'A', itemInfo: { title: { displayValue: 'a' } } },
      { asin: 'B', itemInfo: { title: { displayValue: 'b' } } },
    ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const out = await resolveItems(['A', 'B']);
  assert.equal(out.size, 2);
  assert.equal(out.get('A').itemInfo.title.displayValue, 'a');
  assert.equal(paapiStatus().available, true);
});

test('ASINs PA API does not return are simply absent, not errors', async () => {
  stubFetch(async (url) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    return new Response(JSON.stringify({ itemsResult: { items: [{ asin: 'A' }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const out = await resolveItems(['A', 'MISSING']);
  assert.equal(out.size, 1);
  assert.equal(out.has('MISSING'), false);
  assert.equal(paapiStatus().available, true);
});

test('batches respect the 10-ASIN API cap', async () => {
  const sizes = [];
  stubFetch(async (url, opts) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    sizes.push(JSON.parse(opts.body).itemIds.length);
    return new Response(JSON.stringify({ itemsResult: { items: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await resolveItems(Array.from({ length: 23 }, (_, i) => `A${i}`), { pace: 0 });
  assert.deepEqual(sizes, [10, 10, 3]);
  assert.ok(sizes.every(s => s <= BATCH_MAX));
});

test('duplicate ASINs are de-duplicated before hitting the API', async () => {
  const sizes = [];
  stubFetch(async (url, opts) => {
    if (String(url).includes('/auth/o2/token')) return tokenOK();
    sizes.push(JSON.parse(opts.body).itemIds.length);
    return new Response(JSON.stringify({ itemsResult: { items: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await resolveItems(['A', 'A', 'A', 'B'], { pace: 0 });
  assert.deepEqual(sizes, [2]);
});
