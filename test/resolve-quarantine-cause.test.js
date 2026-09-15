// =============================================================================
//  test/resolve-quarantine-cause.test.js
//
//  Evidence answers ONE cause. A recovered price must never un-hide a row that
//  something else hid. That is how a product comes back on the site with an
//  identity problem still unresolved.
//
//  refresh-newegg-prices.cjs used to lift any row carrying its priceQuarantined
//  marker the moment the price recovered, without asking why the row was
//  hidden. It now records its own cause (price_suspect_3strikes) and answers
//  only that one.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as drift from '../drift-gate.js';

const { resolveQuarantineCause, recordQuarantine, RESOLVE_OUTCOMES } = drift;
const require = createRequire(import.meta.url);
const { recoverPriceHold, PRICE_HOLD_REASON } = require('../refresh-newegg-prices.cjs');

const AT = '2026-09-15';
const priceHeld = (over = {}) => ({
  id: 20196, n: 'Test Part', deals: {},
  needsReview: true, quarantinedAt: '2026-09-01', quarantineReason: PRICE_HOLD_REASON, priceQuarantined: true, ...over,
});

// ── the door ────────────────────────────────────────────────────────────────

test('the last recorded cause, answered, un-hides the row and says so on it', () => {
  const p = priceHeld();
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'lifted');
  assert.equal(p.needsReview, undefined);
  assert.equal(p.quarantinedAt, undefined);
  assert.equal(p.quarantineReason, undefined);
  assert.equal(p.quarantineLiftedAt, AT);
  assert.equal(p.quarantineLiftedFrom, PRICE_HOLD_REASON);
});

test('THE HOLE: a row hidden for price, then for identity, stays hidden when the price recovers', () => {
  const p = { id: 1, deals: {} };
  recordQuarantine(p, { at: '2026-09-01', reason: PRICE_HOLD_REASON });
  recordQuarantine(p, { at: '2026-09-03', reason: 'title_mismatch' });
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'still-hidden');
  assert.equal(p.needsReview, true);
  assert.equal(p.quarantineReason, 'title_mismatch', 'the cause still standing is now the one on file');
  assert.equal('quarantineAlso' in p, false);
});

test('answering a SECONDARY cause removes it and leaves the primary standing', () => {
  const p = priceHeld({ quarantineReason: 'asin_repair_no_match', quarantineAlso: [PRICE_HOLD_REASON, 'price_3p_flagged'] });
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'still-hidden');
  assert.equal(p.quarantineReason, 'asin_repair_no_match');
  assert.deepEqual(p.quarantineAlso, ['price_3p_flagged']);
});

test('a row hidden for a reason nobody recorded is not lifted by anything', () => {
  const p = priceHeld({ quarantineReason: undefined });
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'no-recorded-cause');
  assert.equal(p.needsReview, true);
});

test('recordQuarantine on an unexplained hold keeps the original unknown, and so stays un-liftable', () => {
  const p = { id: 2, deals: {}, needsReview: true, quarantinedAt: '2026-08-20' };
  recordQuarantine(p, { at: '2026-09-01', reason: PRICE_HOLD_REASON });
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'no-recorded-cause');
  assert.equal(p.needsReview, true);
});

test('a different cause is untouched', () => {
  const p = priceHeld({ quarantineReason: 'no_new_offer' });
  const before = JSON.stringify(p);
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'different-cause');
  assert.equal(JSON.stringify(p), before);
});

test('a review flag keeps the row hidden even when its only cause is answered', () => {
  const p = priceHeld({ reviewFlags: ['relink:mismatch'] });
  assert.equal(resolveQuarantineCause(p, { cause: PRICE_HOLD_REASON, at: AT }), 'review-flags');
  assert.equal(p.needsReview, true);
  assert.equal(p.quarantineReason, PRICE_HOLD_REASON);
});

test('a visible row is not-hidden, and changes nothing', () => {
  assert.equal(resolveQuarantineCause({ id: 3, deals: {} }, { cause: PRICE_HOLD_REASON, at: AT }), 'not-hidden');
});

test('a lift must name the cause its evidence answers', () => {
  assert.throws(() => resolveQuarantineCause(priceHeld(), { at: AT }), /cause/);
});

test('CONTRACT: every shape of row ends in exactly one named outcome', () => {
  const shapes = [
    {}, { needsReview: true }, priceHeld(), priceHeld({ quarantineReason: 'x' }),
    priceHeld({ quarantineAlso: ['y'] }), priceHeld({ quarantineReason: 'x', quarantineAlso: [PRICE_HOLD_REASON] }),
    priceHeld({ reviewFlags: ['z'] }), priceHeld({ quarantineReason: undefined, quarantineAlso: [PRICE_HOLD_REASON] }),
  ];
  for (const s of shapes) {
    const out = resolveQuarantineCause({ id: 9, deals: {}, ...s }, { cause: PRICE_HOLD_REASON, at: AT });
    assert.ok(RESOLVE_OUTCOMES.includes(out), `${JSON.stringify(s)} -> ${out}`);
  }
});

// ── the re-pricer ───────────────────────────────────────────────────────────

test('re-pricer: its own hold, recovered, lifts the row and drops the marker', () => {
  const p = priceHeld();
  assert.equal(recoverPriceHold(p, AT, drift), 'lifted');
  assert.equal(p.needsReview, undefined);
  assert.equal(p.priceQuarantined, undefined);
});

test('re-pricer: a recovered price on a row ALSO held for identity keeps it hidden', () => {
  const p = priceHeld({ quarantineAlso: ['asin_identity_mismatch'] });
  assert.equal(recoverPriceHold(p, AT, drift), 'still-hidden');
  assert.equal(p.needsReview, true);
  assert.equal(p.quarantineReason, 'asin_identity_mismatch');
  assert.equal(p.priceQuarantined, undefined, 'the price hold itself is answered');
});

test('re-pricer: a legacy hold with no recorded cause stays hidden and keeps its marker', () => {
  // The 8 rows on main as of 2026-09-15 carry priceQuarantined and no quarantineReason.
  const p = priceHeld({ quarantineReason: undefined });
  assert.equal(recoverPriceHold(p, AT, drift), 'no-recorded-cause');
  assert.equal(p.needsReview, true);
  assert.equal(p.priceQuarantined, true);
});

test('re-pricer: a stale marker on a visible row is cleared', () => {
  const p = { id: 4, deals: {}, priceQuarantined: true };
  assert.equal(recoverPriceHold(p, AT, drift), 'not-hidden');
  assert.equal(p.priceQuarantined, undefined);
});
