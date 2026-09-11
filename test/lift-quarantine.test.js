// =============================================================================
//  test/lift-quarantine.test.js
//
//  The way back out of quarantine, for the one cause a verdict can disprove.
//
//  no_new_offer hides a product because the verifier found nothing New on the
//  listing. A later confirmed New buy box is the exact negation, and until
//  lift-quarantine.mjs nothing acted on it: 269 rows hidden and 0 lifted between
//  2026-08-26 and 2026-09-11, while the free PA pass kept stamping confirmed
//  prices on rows no visitor could see.
//
//  Two failure modes are locked here, because both look like success:
//
//    - Lifting on evidence that is not newer than the hold. The hold and a
//      confirmation can land the same day, and the hold can be the later one.
//
//    - Lifting a row that is held for something a price cannot answer. That
//      includes the row whose recorded cause was OVERWRITTEN: before
//      recordQuarantine(), an identity hold that later read a used-only listing
//      became no_new_offer, and a lift keyed on the field would have put a row
//      back on the site with an ASIN nothing ever validated.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { liftDecision, applyLift, sweepLifts, CAUSE } from '../lift-quarantine.mjs';
import { applyFixes } from '../verify-catalog-asins.js';

const TODAY = '2026-09-11';
const FRESH = 3;

// The clean case: hidden for no_new_offer on 09-06, a New buy box confirmed today.
const held = (over = {}, amazon = {}) => ({
  id: 1, n: 'Test Mid Tower Case', c: 'Case', b: 'Test', msrp: 70,
  needsReview: true, quarantinedAt: '2026-09-06', quarantineReason: 'no_new_offer',
  deals: {
    amazon: {
      url: 'https://www.amazon.com/dp/B093S1H4G2?tag=x', price: 69.9, inStock: true,
      priceConfidence: 'confirmed', priceConfirmedAt: '2026-09-11',
      priceSource: '1p', priceSeller: 'Amazon.com', priceResolvedVia: 'paapi', ...amazon,
    },
  },
  ...over,
});

const decide = (p) => liftDecision(p, TODAY, FRESH);

test('a confirmed New buy box after the hold lifts it', () => {
  const d = decide(held());
  assert.equal(d.lift, true);
  assert.equal(d.evidence.heldAt, '2026-09-06');
  assert.equal(d.evidence.confirmedAt, '2026-09-11');
  assert.equal(d.evidence.seller, 'Amazon.com');
});

test('only a confirmation strictly after the latest hold counts', () => {
  for (const at of ['2026-09-06', '2026-09-05']) {
    const d = decide(held({}, { priceConfirmedAt: at }));
    assert.deepEqual(d, { lift: false, why: 'no confirmation since the hold' }, `confirmed ${at}, held 2026-09-06`);
  }
  // Hidden again today after yesterday's confirmation: Amazon's latest word is the hold.
  const rehidden = decide(held({ quarantinedAt: '2026-09-11' }, { priceConfirmedAt: '2026-09-10' }));
  assert.equal(rehidden.lift, false);
});

test('a confirmation the freshness gate would call stale cannot vouch for today', () => {
  const d = decide(held({ quarantinedAt: '2026-09-01' }, { priceConfirmedAt: '2026-09-04' }));
  assert.deepEqual(d, { lift: false, why: `confirmation older than ${FRESH}d` });
  assert.equal(decide(held({ quarantinedAt: '2026-09-01' }, { priceConfirmedAt: '2026-09-08' })).lift, true);
});

test('an ambiguous, failed or out-of-stock buy box keeps it hidden', () => {
  assert.equal(decide(held({}, { priceConfidence: 'unconfirmed', priceUnconfirmedReason: 'unlabeled_buybox' })).lift, false);
  assert.equal(decide(held({}, { priceUnconfirmedAt: '2026-09-11' })).lift, false);
  assert.equal(decide(held({}, { inStock: false })).lift, false);
  assert.equal(decide(held({}, { priceConfirmedAt: undefined })).lift, false);
});

test('rows hidden for another cause, or for no recorded cause, are not this path\'s to lift', () => {
  for (const quarantineReason of ['price_3p_flagged', 'asin_repair_no_match', 'implausible_price', undefined]) {
    assert.equal(decide(held({ quarantineReason })), null, String(quarantineReason));
  }
  assert.equal(decide(held({ needsReview: undefined })), null, 'a visible row is not a candidate');
});

test('a hold beside the cause keeps it hidden: identity, markup, a later cause', () => {
  const cases = [
    [{ reviewFlags: ['relink:mismatch'] }, 'review flag'],
    [{ reviewFlags: ['relink:no-price'] }, 'review flag'],
    [{ priceQuarantine: { reason: '3p_markup', mult: 1.78 } }, 'price quarantine'],
    [{ priceQuarantined: true }, 'price quarantine'],
    [{ quarantineAlso: ['asin_repair_no_match'] }, 'also held for asin_repair_no_match'],
  ];
  for (const [over, why] of cases) assert.deepEqual(decide(held(over)), { lift: false, why }, JSON.stringify(over));
});

test('a lift never overrules the report: a price outside the MSRP band stays hidden', () => {
  const d = decide(held({ msrp: 20 }));
  assert.deepEqual(d, { lift: false, why: 'report bucket: implausible' });
});

test('applyLift clears every hold field together and records what it lifted', () => {
  const p = held({ quarantineAlso: [] });
  applyLift(p, TODAY);
  for (const k of ['needsReview', 'quarantinedAt', 'quarantineReason', 'quarantineAlso']) {
    assert.equal(k in p, false, `${k} survived the lift`);
  }
  assert.equal(p.quarantineLiftedAt, TODAY);
  assert.equal(p.quarantineLiftedFrom, CAUSE);
});

test('the sweep keeps every considered row countable', () => {
  const parts = [
    held({ id: 1 }),
    held({ id: 2 }, { priceConfirmedAt: '2026-09-06' }),
    held({ id: 3, reviewFlags: ['relink:mismatch'] }),
    held({ id: 4, quarantineReason: 'price_3p_flagged' }),
    { id: 5, n: 'Visible', c: 'Case', deals: {} },
  ];
  const { lift, stay } = sweepLifts(parts, TODAY, FRESH);
  assert.deepEqual(lift.map((x) => x.p.id), [1]);
  assert.deepEqual(stay.map((x) => x.p.id), [2, 3]);
});

// ── the lift trusts the recorded cause only because the writer keeps it ─────
// recordQuarantine() itself is locked in test/record-quarantine.test.js.

test('end to end: the verifier cannot relabel an identity hold into a liftable one', () => {
  // Hidden because ASIN repair found no confident match; the link was never validated.
  const p = held({ id: 42, quarantineReason: 'asin_repair_no_match', quarantinedAt: '2026-09-01' },
                 { priceConfirmedAt: '2026-08-30' });
  // A later run reads the listing as used-only — the no_new_offer verdict, applied
  // by the real writer.
  applyFixes([p], { 42: { needsReview: true, quarantinedAt: '2026-09-08', quarantineReason: 'no_new_offer' } });
  // Then a later run confirms a New buy box on that same unvalidated listing.
  p.deals.amazon.priceConfirmedAt = '2026-09-11';

  assert.equal(p.quarantineReason, 'asin_repair_no_match');
  assert.equal(decide(p), null, 'an identity hold must never reach the lift');
});
