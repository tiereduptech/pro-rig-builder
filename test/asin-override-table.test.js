// A known-good ASIN belongs to ONE product.
//
// The table is keyed by canonicalizeProductName(), which is a class key for
// GPUs, cases and boards. Before these guards, "NVIDIA|RTX|5080" answered for
// 31 distinct cards with one ASIN at score 1.0, and that answer is step 1 of
// ASIN repair in a job that runs every two days with --fix-asins.
//
//   node --test test/asin-override-table.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { buildOverrideIndex, normalizeForBinding } = await import('../asin-override-table.js');

const gpu = (id, n) => ({ id, c: 'GPU', n });
const CARDS = [
  gpu(30003, 'NVIDIA GeForce RTX 5080'),
  gpu(30070, 'ASUS TUF RTX 5080 OC'),
  gpu(30071, 'MSI RTX 5080 Gaming X Trio'),
];

test('a key that answers for more than one product is refused, not answered at 1.0', () => {
  const table = { 'NVIDIA|RTX|5080': { asin: 'B0DSXJ5QF4', verifiedName: 'ASUS TUF RTX 5080 OC' } };
  const { lookup, stats } = buildOverrideIndex(CARDS, table);
  for (const c of CARDS) assert.equal(lookup(c), null, `${c.n} was answered`);
  assert.equal(stats.refusedAmbiguous, 3);
  assert.equal(stats.hits, 0);
});

test('the same entry answers once the key is no longer a class', () => {
  const table = { 'NVIDIA|RTX|5080': { asin: 'B0DSXJ5QF4', verifiedName: 'ASUS TUF RTX 5080 OC' } };
  const only = [gpu(30070, 'ASUS TUF RTX 5080 OC')];
  const { lookup } = buildOverrideIndex(only, table);
  assert.deepEqual(lookup(only[0]), { asin: 'B0DSXJ5QF4', source: 'known-good-table', score: 1.0 });
});

test('the binding refuses a product the entry was not verified for', () => {
  // Same key, unique in this catalog, but a different product than the one the
  // ASIN was verified against. The count guard cannot see this one.
  const table = { 'NVIDIA|RTX|5080': { asin: 'B0DSXJ5QF4', verifiedName: 'ASUS TUF RTX 5080 OC' } };
  const other = [gpu(30071, 'MSI RTX 5080 Gaming X Trio')];
  const { lookup, stats } = buildOverrideIndex(other, table);
  assert.equal(lookup(other[0]), null);
  assert.equal(stats.refusedBinding, 1);
});

test('an entry that names no verified product is refused', () => {
  const table = { 'NVIDIA|RTX|5080': { asin: 'B0DSXJ5QF4' } };
  const only = [gpu(30070, 'ASUS TUF RTX 5080 OC')];
  const { lookup, stats } = buildOverrideIndex(only, table);
  assert.equal(lookup(only[0]), null);
  assert.equal(stats.refusedUnbound, 1);
});

test('the same product listed twice does not make its key a class', () => {
  // Two rows, one product, spelled differently. Punishing the override for a
  // dedupe problem would refuse a correct answer.
  const rows = [gpu(30070, 'ASUS TUF RTX 5080 OC'), gpu(31070, 'ASUS  TUF   RTX 5080 OC!')];
  const table = { 'NVIDIA|RTX|5080': { asin: 'B0DSXJ5QF4', verifiedName: 'ASUS TUF RTX 5080 OC' } };
  const { lookup } = buildOverrideIndex(rows, table);
  assert.equal(lookup(rows[0]).asin, 'B0DSXJ5QF4');
});

test('binding comparison ignores punctuation and case, not words', () => {
  assert.equal(normalizeForBinding('ASUS TUF RTX 5080 OC'), normalizeForBinding('asus-tuf, rtx 5080 (oc)'));
  assert.notEqual(normalizeForBinding('ASUS TUF RTX 5080 OC'), normalizeForBinding('ASUS TUF RTX 5080'));
});

test('the shipped table is bound and no key in it answers for two products', async () => {
  const table = JSON.parse(readFileSync('./src/data/asin-overrides.json', 'utf8'));
  const { PARTS } = await import('../src/data/parts.js');
  const { namesPerKey } = buildOverrideIndex(PARTS, table);
  const unbound = Object.entries(table).filter(([, e]) => !e.verifiedName);
  assert.deepEqual(unbound.map(([k]) => k), [], 'every entry must name the product it was verified for');
  const classy = Object.keys(table).filter((k) => (namesPerKey.get(k)?.size || 0) > 1);
  assert.deepEqual(classy, [], 'a shipped key answers for more than one product');
});

test('an ASIN claimed by two entries answers for neither', () => {
  // Both keys are unique, both entries name their own product, and one Amazon
  // listing still stands for two CPUs. Neither guard above sees this.
  const rows = [{ id: 10014, c: 'CPU', n: 'AMD Ryzen 9 7900X' }, { id: 10016, c: 'CPU', n: 'AMD Ryzen 9 7900' }];
  const table = {
    'AMD|Ryzen 9|7900X': { asin: 'B0BBJ59WJ4', verifiedName: 'AMD Ryzen 9 7900X' },
    'AMD|Ryzen 9|7900': { asin: 'B0BBJ59WJ4', verifiedName: 'AMD Ryzen 9 7900' },
  };
  const { lookup, stats } = buildOverrideIndex(rows, table);
  assert.equal(lookup(rows[0]), null);
  assert.equal(lookup(rows[1]), null);
  assert.equal(stats.refusedContested, 2);
});

test('no ASIN in the shipped table is claimed twice', async () => {
  const table = JSON.parse(readFileSync('./src/data/asin-overrides.json', 'utf8'));
  const seen = new Map();
  for (const [k, e] of Object.entries(table)) {
    assert.ok(!seen.has(e.asin), `${e.asin} is claimed by ${seen.get(e.asin)} and ${k}`);
    seen.set(e.asin, k);
  }
});
