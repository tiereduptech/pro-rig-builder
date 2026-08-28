// =============================================================================
//  test/price-stamp-vocabulary.test.js
//
//  Two gates in this repo ask different questions about the same stamps, and
//  the difference is load-bearing:
//
//    scripts/assert-retailer-freshness.cjs  "has anything contacted this LANE
//                                            lately?" — workflow health.
//                                            matchedAt COUNTS: a SKU rebind is
//                                            evidence the feed was read.
//
//    src/price-freshness.js                 "do we stand behind THIS PRICE?"
//                                            matchedAt does NOT count: a rebind
//                                            is not evidence about a number.
//
//  record-price-snapshot.js writes "on date D the price was P", which is the
//  second question, and it had been importing the first list. That admitted 78
//  points/day (76 newegg, 2 newegg_openbox) that the price vocabulary
//  withholds — ~7,020 manufactured points across the 90-day retention, into the
//  one lane whose re-pricer has been off since 2026-07-20.
//
//  These tests exist so nobody "helpfully" unifies the two lists. They are
//  supposed to differ. What must not happen again is a third caller reaching
//  for whichever one it found first.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PRICE_CONFIRMATION_STAMPS, priceStampOf, isFresh } from '../src/price-freshness.js';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const laneGate = require('../scripts/assert-retailer-freshness.cjs');

test('the PRICE vocabulary excludes matchedAt', () => {
  assert.ok(Array.isArray(PRICE_CONFIRMATION_STAMPS));
  assert.ok(PRICE_CONFIRMATION_STAMPS.includes('refreshedAt'));
  assert.ok(PRICE_CONFIRMATION_STAMPS.includes('priceConfirmedAt'));
  assert.equal(PRICE_CONFIRMATION_STAMPS.includes('matchedAt'), false,
    'matchedAt records a SKU binding, not a price confirmation');
});

test('the LANE vocabulary includes matchedAt — deliberately, and must keep doing so', () => {
  // Not a mistake to be tidied up. sftp-ingest rebinding a row IS evidence that
  // something read the Newegg feed, which is what that gate measures.
  assert.ok(laneGate.CONFIRMATION_STAMPS.includes('matchedAt'),
    'the lane-health gate needs matchedAt; it asks about contact, not about a price');
});

test('the two vocabularies are NOT the same list', () => {
  const lane = [...laneGate.CONFIRMATION_STAMPS].sort().join(',');
  const price = [...PRICE_CONFIRMATION_STAMPS].sort().join(',');
  assert.notEqual(lane, price,
    'unifying these would either certify SKU rebinds as prices or report a live feed as a dead lane');
});

test('priceStampOf still refuses a matchedAt-only row', () => {
  const row = { price: 449.99, matchedAt: '2026-08-28' };
  assert.equal(priceStampOf(row), null);
  assert.equal(isFresh(row, Date.parse('2026-08-28T12:00:00Z')), false);
});

test('priceStampOf prefers refreshedAt, and reads either alone', () => {
  assert.equal(priceStampOf({ refreshedAt: 'R', priceConfirmedAt: 'P' }), 'R');
  assert.equal(priceStampOf({ priceConfirmedAt: 'P' }), 'P');
  assert.equal(priceStampOf({ refreshedAt: 'R' }), 'R');
  assert.equal(priceStampOf({}), null);
  assert.equal(priceStampOf(null), null);
});

test('record-price-snapshot.js sources its stamps from the PRICE gate', () => {
  // The recorder runs its work at import time, so it cannot be imported here
  // without writing price history. Read the source instead: what matters is
  // that it no longer keeps a private copy of the list, which is how it came to
  // hold the lane vocabulary in the first place.
  const src = fs.readFileSync(path.join(REPO, 'record-price-snapshot.js'), 'utf8');
  assert.match(src, /import\s*\{\s*PRICE_CONFIRMATION_STAMPS\s*\}\s*from\s*'\.\/src\/price-freshness\.js'/,
    'the recorder must import the price vocabulary, not restate one');
  assert.doesNotMatch(src, /const\s+CONFIRMATION_STAMPS\s*=/,
    'a local stamp list in the recorder is how this drifted before');
});
