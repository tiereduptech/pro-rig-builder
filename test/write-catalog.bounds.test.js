// writeCatalog size brakes — the shrink brake existed; the growth brake is new.
// These exercise the pure bounds check (no filesystem) AND prove writeCatalog
// itself refuses an oversized write before touching parts.js (dryRun runs the
// preflight, so an out-of-bounds dryRun must throw, not return null).
//
//   node --test test/write-catalog.bounds.test.js

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkSizeBounds, writeCatalog, MAX_SHRINK, MAX_GROWTH } = require('../scripts/write-catalog.cjs');

test('constants: 5% shrink, 15% growth', () => {
  assert.strictEqual(MAX_SHRINK, 0.05);
  assert.strictEqual(MAX_GROWTH, 0.15);
});

test('no loadedCount → no opinion (brakes disabled)', () => {
  assert.strictEqual(checkSizeBounds(999999, undefined).ok, true);
  assert.strictEqual(checkSizeBounds(1, 0).ok, true);
});

test('unchanged / small delta → ok', () => {
  assert.strictEqual(checkSizeBounds(5428, 5428).ok, true);
  assert.strictEqual(checkSizeBounds(5478, 5428).ok, true); // +50, +0.9%
});

test('a full RAM run (+605, +11%) passes the default growth ceiling', () => {
  assert.strictEqual(checkSizeBounds(6033, 5428).ok, true);
});

test('growth just over 15% is refused', () => {
  const ceil = Math.ceil(5428 * 1.15); // 6243
  assert.strictEqual(checkSizeBounds(ceil, 5428).ok, true);
  const over = checkSizeBounds(ceil + 1, 5428);
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.kind, 'growth');
});

test('shrink beyond 5% is still refused (unchanged behavior)', () => {
  const floor = Math.floor(5428 * 0.95); // 5156
  assert.strictEqual(checkSizeBounds(floor, 5428).ok, true);
  const under = checkSizeBounds(floor - 1, 5428);
  assert.strictEqual(under.ok, false);
  assert.strictEqual(under.kind, 'shrink');
});

test('opts.maxGrowth raises the ceiling for a deliberate sweep', () => {
  assert.strictEqual(checkSizeBounds(9000, 5428).ok, false);            // default 15%
  assert.strictEqual(checkSizeBounds(9000, 5428, { maxGrowth: 1.0 }).ok, true); // +100% allowed
});

test('writeCatalog dryRun runs the brake: oversized array throws, does not return null', async () => {
  const huge = Array.from({ length: 7000 }, (_, i) => ({ id: i, c: 'RAM', n: 'x' }));
  await assert.rejects(
    () => writeCatalog(huge, { loadedCount: 5428, dryRun: true, reason: 'test' }),
    /catastrophic growth/,
  );
});

test('writeCatalog dryRun within bounds returns null (nothing written)', async () => {
  const ok = Array.from({ length: 5450 }, (_, i) => ({ id: i, c: 'RAM', n: 'x' }));
  const res = await writeCatalog(ok, { loadedCount: 5428, dryRun: true, reason: 'test' });
  assert.strictEqual(res, null);
});
