// =============================================================================
//  test/newegg-rate-pacing.test.js
//
//  The pacing constant governed ROWS; Rakuten's ceiling counts REQUESTS.
//
//  searchNewegg issues a ladder of up to six queries per row and stops at the
//  first non-empty response, so a row costs one to six requests. Pacing at
//  720ms/row was reasoned as "≈83/min, real headroom" — true of rows, false of
//  requests, and the break-even is only 1.56 queries per row.
//
//  Run 33189471054 measured it: 3,178 rows at 64.2 rows/min, 362 http_errors
//  (11.4% of the catalog) arriving in bursts of 10-27 a minute with quiet
//  minutes between. The 200-row dry runs that same afternoon, same constant,
//  drew zero. Errors that scale with run LENGTH are throttling, not a feed.
//
//  These tests pin both halves of the fix: the limiter counts requests, and the
//  status of every non-2xx is recorded so the next run MEASURES which it was
//  instead of inferring it from run length.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, searchNewegg } from '../newegg-match.js';

// Virtual clock — a real one would make these tests take minutes.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

const product = { n: 'Corsair Vengeance 32GB DDR5 6000', b: 'Corsair', c: 'RAM' };

test('the limiter admits exactly perMinute requests before it makes one wait', async () => {
  const c = clock();
  const acquire = createRateLimiter({ perMinute: 80, sleep: c.sleep, now: c.now });
  for (let i = 0; i < 80; i++) await acquire();
  assert.equal(c.now(), 0, 'the first 80 must not wait at all');
  await acquire();
  assert.ok(c.now() >= 60000, `the 81st must wait out the window, waited ${c.now()}ms`);
});

test('the window slides — it does not reset on a wall-clock minute', async () => {
  const c = clock();
  const acquire = createRateLimiter({ perMinute: 10, sleep: c.sleep, now: c.now });
  // Ten requests spread over the first 50s.
  for (let i = 0; i < 10; i++) { await acquire(); c.advance(5000); }
  // t=50s. A fixed-window counter would reset at t=60s and admit ten more at
  // once, putting 20 requests in the 10 seconds either side of the seam. The
  // sliding window admits one only as each individual slot ages out.
  const before = c.now();
  await acquire();
  assert.ok(c.now() > before, 'must wait for the oldest slot to age out, not for a boundary');
  assert.ok(c.now() < 60000 + 5000, 'and must not wait longer than that slot needs');
});

test('never exceeds the budget in any 60s window, under a full ladder', async () => {
  const c = clock();
  const PER_MIN = 80;
  const acquire = createRateLimiter({ perMinute: PER_MIN, sleep: c.sleep, now: c.now });
  const stamps = [];
  // 300 rows x 6 queries — the worst case the old per-row sleep priced as 1.
  for (let i = 0; i < 300 * 6; i++) { await acquire(); stamps.push(c.now()); c.advance(40); }
  for (let i = 0; i < stamps.length; i++) {
    const inWindow = stamps.filter((t) => t > stamps[i] - 60000 && t <= stamps[i]).length;
    assert.ok(inWindow <= PER_MIN, `${inWindow} requests in the 60s ending at ${stamps[i]}ms, budget ${PER_MIN}`);
  }
});

test('perMinute 0 or absent is a no-op, so other callers are unaffected', async () => {
  const c = clock();
  const off = createRateLimiter({ perMinute: 0, sleep: c.sleep, now: c.now });
  for (let i = 0; i < 500; i++) await off();
  assert.equal(c.now(), 0);
  await createRateLimiter()();  // no args must not throw
});

// ── status recording ────────────────────────────────────────────────────────

const res = (status, body = '<xml></xml>') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('a 429 is recorded as 429, not collapsed into a bare error count', async () => {
  const r = await searchNewegg(product, { token: 't', mid: '1', fetchImpl: async () => res(429) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'http_error');
  assert.ok(r.httpStatuses.length > 0);
  assert.ok(r.httpStatuses.every((s) => s === '429'), `got ${JSON.stringify(r.httpStatuses)}`);
  assert.equal(r.httpErrors, r.queriesTried, 'every query errored');
});

test('a 500 is distinguishable from a 429 — the whole point of recording it', async () => {
  const r = await searchNewegg(product, { token: 't', mid: '1', fetchImpl: async () => res(500) });
  assert.ok(r.httpStatuses.every((s) => s === '500'));
  assert.ok(!r.httpStatuses.includes('429'), 'a server error must not read as us being throttled');
});

test('a thrown fetch lands in the same tally as network', async () => {
  const r = await searchNewegg(product, { token: 't', mid: '1', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.ok(r.httpStatuses.every((s) => s === 'network'));
});

test('statuses are recorded even when a later query in the ladder succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? res(429) : res(200, '<item><productname>Corsair Vengeance 32GB DDR5 6000</productname><sku>N82E1</sku><price>150</price></item>'));
  const r = await searchNewegg(product, { token: 't', mid: '1', fetchImpl });
  assert.deepEqual(r.httpStatuses, ['429'], 'budget overspent on a row that recovered still counts');
  assert.notEqual(r.reason, 'http_error', 'the row itself did not fail');
});

test('searchNewegg awaits the limiter once per request, not once per row', async () => {
  let acquired = 0, requests = 0;
  await searchNewegg(product, {
    token: 't', mid: '1',
    acquire: async () => { acquired++; },
    fetchImpl: async () => { requests++; return res(200, '<xml></xml>'); },  // no items -> full ladder
  });
  assert.ok(requests > 1, 'this fixture should exhaust the ladder');
  assert.equal(acquired, requests, `${acquired} acquires for ${requests} requests`);
});

test('no_cat_mapping spends no budget at all', async () => {
  let acquired = 0;
  const r = await searchNewegg({ n: 'RTX 5080', b: 'ASUS', c: 'GPU' }, {
    token: 't', mid: '1',
    acquire: async () => { acquired++; },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(r.reason, 'no_cat_mapping');
  assert.equal(acquired, 0);
  assert.deepEqual(r.httpStatuses, []);
});
