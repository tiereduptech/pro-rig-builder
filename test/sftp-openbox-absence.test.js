// =============================================================================
//  test/sftp-openbox-absence.test.js
//
//  deals.newegg_openbox had inflow and no exit. From 2026-08-27 to 09-14 the
//  lane grew 182 -> 238 rows and removed 0. The absence sweep stamped the rows
//  the feed stopped carrying, but a stamp is not an exit, so every sold
//  single-unit listing stayed in the catalog for good.
//
//  The rule (decided 2026-09-15): three consecutive full-feed nights absent and
//  the DEAL is dropped. Never the product. A product left with no priced deal is
//  hidden with a recorded cause, the same rule as purge-dead-bestbuy-links.mjs.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { recordQuarantine } from '../drift-gate.js';

const require = createRequire(import.meta.url);
const {
  settleOpenboxAbsence, laneKey, OPENBOX_ABSENT_NIGHTS, OPENBOX_MIN_CONFIRMED_SHARE, OPENBOX_ORPHAN_REASON,
} = require('../sftp-ingest.cjs');

const LANE = 'newegg_openbox';

// A lane of `size` rows. Row 0 is the one under test and carries a new-condition
// Newegg deal too, so it is NOT an orphan unless a test says so. Rows 1..size-1
// are confirmed every night, which keeps the breaker quiet.
function lane(size = 10) {
  return Array.from({ length: size }, (_, i) => ({
    id: 1000 + i, c: 'GPU', n: `Card ${i}`,
    deals: {
      [LANE]: { sku: `ob-${i}`, price: 199 + i, inStock: true },
      ...(i === 0 ? { newegg: { price: 249, inStock: true } } : {}),
    },
  }));
}
const others = (parts, except = [0]) =>
  new Set(parts.filter((_, i) => !except.includes(i)).map((p) => laneKey(p, LANE)));
const night = (parts, today, { confirmed = others(parts), fullFeed = true } = {}) =>
  settleOpenboxAbsence(parts, { confirmed, fullFeed, today, recordQuarantine });

test('the rule is three nights', () => {
  assert.equal(OPENBOX_ABSENT_NIGHTS, 3);
});

test('absent on three consecutive full-feed nights: the DEAL goes, the product stays', () => {
  const parts = lane();
  night(parts, '2026-09-16');
  night(parts, '2026-09-17');
  assert.ok(parts[0].deals[LANE], 'two nights is not three');
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, 2);

  const r = night(parts, '2026-09-18');
  assert.deepEqual(r.dropped, [1000]);
  assert.equal(parts.length, 10, 'no product is ever removed');
  assert.equal(parts[0].deals[LANE], undefined);
  assert.ok(parts[0].deals.newegg, 'the other deals are untouched');
  assert.equal(parts[0].neweggOpenboxRemovedAbsent, '2026-09-18');
  assert.equal(parts[0].needsReview, undefined, 'it still sells new at Newegg, so it is not hidden');
});

test('a row never confirmed at all is held to the same three nights, no more, no less', () => {
  const parts = lane();
  delete parts[0].deals[LANE].priceConfirmedAt;
  parts[0].deals[LANE].priceUnconfirmedAt = '2026-09-14';
  for (const d of ['2026-09-16', '2026-09-17']) assert.deepEqual(night(parts, d).dropped, []);
  assert.deepEqual(night(parts, '2026-09-18').dropped, [1000]);
});

test('any confirmation clears the streak, and the count starts over', () => {
  const parts = lane();
  night(parts, '2026-09-16');
  night(parts, '2026-09-17');
  const r = night(parts, '2026-09-18', { confirmed: others(parts, []) });
  assert.equal(r.cleared, 1);
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, undefined);
  assert.equal(parts[0].deals[LANE].feedAbsentLastAt, undefined);
  night(parts, '2026-09-19');
  night(parts, '2026-09-20');
  assert.ok(parts[0].deals[LANE], 'two absences after a sighting is not three');
});

test('a delta-only run neither advances a streak nor drops anything, but a sighting in it still clears', () => {
  const parts = lane();
  night(parts, '2026-09-16');
  night(parts, '2026-09-17');
  const quiet = night(parts, '2026-09-18', { fullFeed: false, confirmed: new Set() });
  assert.equal(quiet.counted, false);
  assert.match(quiet.reason, /no full Newegg feed/);
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, 2, 'nothing was looked at, so nothing is absent');

  night(parts, '2026-09-19', { fullFeed: false, confirmed: others(parts, []) });
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, undefined, 'a delta that offers the listing proves it had not sold');
});

test('two full-feed runs on the same day are one night, not two', () => {
  const parts = lane();
  night(parts, '2026-09-16');
  night(parts, '2026-09-16');
  night(parts, '2026-09-16');
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, 1);
  assert.ok(parts[0].deals[LANE]);
});

test('BREAKER: a full feed that lost open-box counts as nothing, and says so', () => {
  const parts = lane(20);
  night(parts, '2026-09-16');
  night(parts, '2026-09-17');
  // 1 of 20 confirmed = 5%, under the 10% floor.
  const r = night(parts, '2026-09-18', { confirmed: new Set([laneKey(parts[5], LANE)]) });
  assert.ok(1 / 20 < OPENBOX_MIN_CONFIRMED_SHARE);
  assert.equal(r.counted, false);
  assert.match(r.reason, /^BREAKER/);
  assert.deepEqual(r.dropped, []);
  assert.equal(parts[0].deals[LANE].feedAbsentStreak, 2, 'the breaker night advanced nothing');
  assert.equal(parts[1].deals[LANE].feedAbsentStreak, undefined, 'and put no fresh streak on rows it could not see');
});

test('a product left with no priced deal is HIDDEN with a cause, never dropped', () => {
  const parts = lane();
  delete parts[0].deals.newegg;
  parts[0].deals.amazon = { price: 0 };  // an unpriced deal is not a peer
  for (const d of ['2026-09-16', '2026-09-17', '2026-09-18']) night(parts, d);
  assert.equal(parts.length, 10);
  assert.equal(parts[0].deals[LANE], undefined);
  assert.equal(parts[0].needsReview, true);
  assert.equal(parts[0].quarantinedAt, '2026-09-18');
  assert.equal(parts[0].quarantineReason, OPENBOX_ORPHAN_REASON);
});

test('an orphan that was ALREADY hidden keeps the cause it was hidden for', () => {
  const parts = lane();
  delete parts[0].deals.newegg;
  Object.assign(parts[0], { needsReview: true, quarantinedAt: '2026-09-01', quarantineReason: 'title_mismatch' });
  for (const d of ['2026-09-16', '2026-09-17', '2026-09-18']) night(parts, d);
  assert.equal(parts[0].quarantineReason, 'title_mismatch');
  assert.equal(parts[0].quarantinedAt, '2026-09-01');
  assert.deepEqual(parts[0].quarantineAlso, [OPENBOX_ORPHAN_REASON]);
});

test('only the open-box lane is ever dropped', () => {
  const parts = lane();
  parts[0].deals.newegg_refurb = { price: 150 };
  for (const d of ['2026-09-16', '2026-09-17', '2026-09-18']) night(parts, d);
  assert.ok(parts[0].deals.newegg, 'deals.newegg belongs to the re-pricer');
  assert.ok(parts[0].deals.newegg_refurb, 'other condition lanes are not part of this rule');
});

test('without recordQuarantine it refuses to run rather than leave an orphan bare', () => {
  assert.throws(() => settleOpenboxAbsence(lane(), { confirmed: new Set(), fullFeed: true, today: '2026-09-16' }),
    /recordQuarantine/);
});
