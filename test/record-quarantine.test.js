// =============================================================================
//  test/record-quarantine.test.js
//
//  A quarantine verdict landing on a row that is ALREADY hidden must not replace
//  the cause the row was hidden for.
//
//  Both verdict writers used to overwrite quarantineReason on every quarantine
//  verdict. That is harmless while nothing reads the field, and a hole the
//  moment anything lifts on it: a row held for asin_repair_no_match that later
//  read a used-only listing became no_new_offer, indistinguishable from a row
//  hidden for no_new_offer alone. A legacy row hidden with no recorded cause
//  acquired one the same way.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordQuarantine } from '../drift-gate.js';
import { applyFixes } from '../verify-catalog-asins.js';

const hidden = (over = {}) => ({
  id: 7, n: 'Test Part', c: 'Case', deals: {},
  needsReview: true, quarantinedAt: '2026-09-01', quarantineReason: 'no_new_offer', ...over,
});

test('a visible row is hidden with its cause', () => {
  const p = { id: 9, deals: {} };
  recordQuarantine(p, { at: '2026-09-08', reason: 'no_new_offer' });
  assert.equal(p.needsReview, true);
  assert.equal(p.quarantinedAt, '2026-09-08');
  assert.equal(p.quarantineReason, 'no_new_offer');
  assert.equal('quarantineAlso' in p, false);
});

test('the same cause again refreshes the date of the latest verdict', () => {
  const p = hidden();
  recordQuarantine(p, { at: '2026-09-08', reason: 'no_new_offer' });
  assert.equal(p.quarantinedAt, '2026-09-08');
  assert.equal(p.quarantineReason, 'no_new_offer');
  assert.equal('quarantineAlso' in p, false);
});

test('a different cause on a hidden row is added, never substituted', () => {
  const p = hidden({ quarantineReason: 'asin_repair_no_match' });
  recordQuarantine(p, { at: '2026-09-08', reason: 'no_new_offer' });
  recordQuarantine(p, { at: '2026-09-09', reason: 'no_new_offer' });
  assert.equal(p.quarantineReason, 'asin_repair_no_match');
  assert.equal(p.quarantinedAt, '2026-09-01');
  assert.deepEqual(p.quarantineAlso, ['no_new_offer']);
});

test('a row hidden with no recorded cause does not acquire one', () => {
  const p = hidden();
  delete p.quarantineReason;
  recordQuarantine(p, { at: '2026-09-08', reason: 'no_new_offer' });
  assert.equal('quarantineReason' in p, false);
  assert.deepEqual(p.quarantineAlso, ['no_new_offer']);
});

test('the verifier\'s writer keeps the original cause and records the new one beside it', () => {
  const p = hidden({ id: 42, quarantineReason: 'asin_repair_no_match' });
  applyFixes([p], { 42: { needsReview: true, quarantinedAt: '2026-09-08', quarantineReason: 'no_new_offer' } });
  assert.equal(p.quarantineReason, 'asin_repair_no_match');
  assert.equal(p.quarantinedAt, '2026-09-01');
  assert.deepEqual(p.quarantineAlso, ['no_new_offer']);
});

test('the verifier\'s writer still hides a visible row with its cause', () => {
  const p = { id: 43, n: 'Test Part', c: 'Case', deals: {} };
  const changed = applyFixes([p], { 43: { needsReview: true, quarantinedAt: '2026-09-08', quarantineReason: 'no_new_offer' } });
  assert.equal(changed, 1);
  assert.equal(p.needsReview, true);
  assert.equal(p.quarantineReason, 'no_new_offer');
  assert.equal(p.quarantinedAt, '2026-09-08');
});
