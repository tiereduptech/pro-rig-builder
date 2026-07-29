// Link-verification marker: a human "this link is correct" flag that the nightly
// honors ONLY while still current. The contract that matters: it invalidates the
// moment the deal's link identity changes, and is never a bare-boolean permanent
// bypass. These tests pin that contract.
import test from 'node:test';
import assert from 'node:assert';
import {
  lastDealChangedAt, linkVerificationCurrent, stampDealChange, markLinkVerified,
  LINK_VERIFIED_SOURCE,
} from '../drift-gate.js';

test('lastDealChangedAt picks the most-recent signal, null when none', () => {
  assert.strictEqual(lastDealChangedAt({}), null);
  assert.strictEqual(lastDealChangedAt({ addedAt: '2026-05-15T14:00:00.000Z' }), '2026-05-15');
  // newegg feed timestamps count as deal-change signals
  assert.strictEqual(
    lastDealChangedAt({ addedAt: '2026-05-15', deals: { newegg: { matchedAt: '2026-07-22', rematchedAt: '2026-07-28' } } }),
    '2026-07-28');
  // the canonical dealChangedAt wins when it is the newest
  assert.strictEqual(
    lastDealChangedAt({ addedAt: '2026-05-15', dealChangedAt: '2026-07-29', deals: { newegg: { matchedAt: '2026-07-22' } } }),
    '2026-07-29');
});

test('linkVerificationCurrent: honored only when marker >= last deal change', () => {
  // no marker → not current
  assert.strictEqual(linkVerificationCurrent({ addedAt: '2026-05-15' }), false);
  // marker newer than baseline → current
  assert.strictEqual(linkVerificationCurrent({ linkVerifiedAt: '2026-07-29', addedAt: '2026-05-15' }), true);
  // same day as baseline → current (day granularity, matches asin-overrides verifiedAt)
  assert.strictEqual(linkVerificationCurrent({ linkVerifiedAt: '2026-07-22', deals: { newegg: { matchedAt: '2026-07-22' } } }), true);
  // deal changed AFTER verification → INVALIDATED
  assert.strictEqual(linkVerificationCurrent({ linkVerifiedAt: '2026-07-22', dealChangedAt: '2026-07-29' }), false);
});

test('a marker with NO deal-change baseline is never honored (no permanent bypass)', () => {
  assert.strictEqual(linkVerificationCurrent({ linkVerifiedAt: '2026-07-29' }), false);
});

test('stampDealChange invalidates a previously-current marker', () => {
  const p = { linkVerifiedAt: '2026-07-29', addedAt: '2026-05-15', deals: { amazon: { url: 'x' } } };
  assert.strictEqual(linkVerificationCurrent(p), true);      // verified today, baseline old
  stampDealChange(p, '2026-07-30T09:00:00.000Z');            // an ingest swaps the ASIN next day
  assert.strictEqual(p.dealChangedAt, '2026-07-30');
  assert.strictEqual(linkVerificationCurrent(p), false);     // marker now stale → back through the gate
});

test('markLinkVerified sets the marker (asin-overrides vocabulary) and is current', () => {
  const p = { addedAt: '2026-05-15', deals: { amazon: { url: 'x' } } };
  markLinkVerified(p, { at: '2026-07-29', by: 'coby' });
  assert.strictEqual(p.linkVerifiedAt, '2026-07-29');
  assert.strictEqual(p.linkVerifiedSource, LINK_VERIFIED_SOURCE);
  assert.strictEqual(p.linkVerifiedBy, 'coby');
  assert.strictEqual(linkVerificationCurrent(p), true);
});

test('markLinkVerified establishes a baseline only when none exists', () => {
  // no baseline → marking guarantees one (so the marker is comparable, not a boolean)
  const bare = {};
  markLinkVerified(bare, { at: '2026-07-29' });
  assert.strictEqual(bare.dealChangedAt, '2026-07-29');
  assert.strictEqual(linkVerificationCurrent(bare), true);
  // existing baseline is left untouched
  const withBase = { addedAt: '2026-05-15' };
  markLinkVerified(withBase, { at: '2026-07-29' });
  assert.strictEqual(withBase.dealChangedAt, undefined);
});

test('gate scenario: verified-current is skipped, verified-then-swapped is re-checked', () => {
  const verifiedCurrent = { id: 1, linkVerifiedAt: '2026-07-29', addedAt: '2026-05-15', deals: { amazon: { url: 'a' } } };
  const verifiedStale   = { id: 2, linkVerifiedAt: '2026-07-22', dealChangedAt: '2026-07-29', deals: { amazon: { url: 'b' } } };
  const rows = [verifiedCurrent, verifiedStale];
  const wouldVerify = rows.filter(p => !linkVerificationCurrent(p));
  assert.deepStrictEqual(wouldVerify.map(p => p.id), [2]);   // stale one goes back through the gate
});
