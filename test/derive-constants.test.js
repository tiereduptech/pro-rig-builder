// Derived constants — the guarantee that the admin dashboard cannot show a
// stale number.
//
// The value of scripts/derive-constants.cjs is its ASSERTIONS, not its JSON: a
// renamed or moved constant must fail the deploy rather than render as a
// confident wrong figure. So these tests prove the extractors FAIL on each
// defect class, not merely that they succeed on the current tree. An extractor
// only ever seen succeeding is not known to be discriminating — the same lesson
// as verify-main-writer-lock.cjs.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const derive = require('./../scripts/derive-constants.cjs');

test('derive() succeeds against the real tree', async () => {
  const out = await derive.derive();
  assert.ok(out.groups.length >= 8, 'expected the full set of constant groups');
  assert.ok(out.groups.every((g) => g.entries.length > 0), 'no group may be empty');
  assert.ok(['green', 'amber', 'red', 'mixed'].includes(out.groups[0].exposure));
});

test('every derived entry carries a real file and line', async () => {
  const out = await derive.derive();
  for (const g of out.groups) {
    for (const e of g.entries) {
      assert.ok(e.file, `${e.name} has no file`);
      assert.ok(Number.isInteger(e.line) && e.line > 0, `${e.name} has no line`);
      assert.ok(fs.existsSync(path.join(process.cwd(), e.file)), `${e.name} points at a missing file ${e.file}`);
      assert.notEqual(e.value, undefined, `${e.name} derived as undefined`);
    }
  }
});

test('the four verification tiers are derived, non-empty, and disjoint', async () => {
  const out = await derive.derive();
  const tiers = out.tiers;
  assert.deepEqual(Object.keys(tiers).sort(), ['1', '2', '3', '4']);
  const seen = new Set();
  for (const cats of Object.values(tiers)) {
    assert.ok(cats.length > 0);
    for (const c of cats) {
      assert.ok(!seen.has(c), `${c} appears in more than one tier`);
      seen.add(c);
    }
  }
});

test('matchOnce fails on zero matches AND on two', () => {
  // Two matches is as much a defect as none: it means the anchor is ambiguous
  // and the value picked is whichever came first.
  assert.throws(() => derive.matchOnce('package.json', /"nonexistent-key-xyz"/, 'absent'), /matched 0 times/);
  assert.throws(() => derive.matchOnce('package.json', /"/, 'ambiguous'), /matched \d+ times/);
});

test('scalarConst fails loudly when a constant is renamed away', () => {
  assert.throws(
    () => derive.scalarConst('verify-catalog-asins.js', 'BATCH_SIZE_RENAMED'),
    /matched 0 times/,
    'a renamed constant must break the build, not vanish from the dashboard',
  );
});

test('scalarConst reads the live values, not a copy', () => {
  const batch = derive.scalarConst('verify-catalog-asins.js', 'BATCH_SIZE');
  assert.equal(typeof batch.value, 'number');
  assert.equal(batch.file, 'verify-catalog-asins.js');

  const removals = derive.scalarConst('refresh-newegg-prices.cjs', 'REMOVALS_ENABLED');
  assert.equal(typeof removals.value, 'boolean');
});

test('argDefault reads a CLI default, and fails if the flag moves', () => {
  const mult = derive.argDefault('apply-newegg-discoveries.cjs', 'price-mult', 'PRICE_MULT');
  assert.equal(typeof mult.value, 'number');
  assert.ok(mult.value > 0);
  assert.throws(() => derive.argDefault('apply-newegg-discoveries.cjs', 'no-such-flag', 'x'), /matched 0 times/);
});

test('braceSlice fails on a missing anchor rather than returning junk', () => {
  assert.throws(() => derive.braceSlice('verify-catalog-asins.js', 'const NOPE =', 'NOPE'), /anchor for NOPE not found/);
});

test('calibration stamps are well-formed dates with a max age', async () => {
  const out = await derive.derive();
  assert.ok(out.calibration.length >= 3);
  for (const c of out.calibration) {
    assert.match(c.calibratedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(c.maxAgeDays > 0);
  }
});

test('every scheduled cron in verify-catalog.yml maps to a tier', async () => {
  // An unmapped cron falls through to `*) tier=1` and runs the wrong tier
  // nightly with a green checkmark — DESIGN-admin-dashboard.md §4. The gate has
  // to catch that at build time.
  const schedules = derive.deriveSchedules();
  const vc = schedules.find((s) => s.file === 'verify-catalog.yml');
  assert.ok(vc, 'verify-catalog.yml not found');
  assert.equal(vc.crons.length, 4);
  for (const c of vc.crons) assert.ok(vc.tierMap[c], `cron ${c} is unmapped`);
});

test('deriveSchedules distinguishes an active cron from a commented-out one', () => {
  // Showing a disabled schedule as active is exactly the "expected every 12h,
  // last ran in July" confusion the workflows panel exists to prevent.
  //
  // Asserted against a FIXTURE, not the live tree. This test used to pin
  // refresh-newegg-prices.yml as the commented-out example, which coupled a unit
  // test to a production schedule that was always going to be re-enabled — and
  // it duly broke on 2026-08-17 when it was. The capability is what is under
  // test; which real workflow happens to be disabled today is not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-commented-'));
  const prior = process.env.WF_DIR;
  try {
    // deriveSchedules requires a tier-mapped verify-catalog.yml to be present.
    fs.copyFileSync('.github/workflows/verify-catalog.yml', path.join(dir, 'verify-catalog.yml'));
    fs.writeFileSync(path.join(dir, 'mixed.yml'), [
      'name: Mixed',
      'on:',
      '  # DISABLED because it ate the catalog',
      '  # schedule:',
      '  #   - cron: "0 6,18 * * *"',
      '  schedule:',
      '    - cron: "0 4 * * *"',
      '  workflow_dispatch:',
      'jobs:',
      '  j:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n'));
    process.env.WF_DIR = dir;

    const mixed = derive.deriveSchedules().find((s) => s.file === 'mixed.yml');
    assert.ok(mixed, 'fixture workflow not found');
    assert.deepEqual(mixed.crons, ['0 4 * * *'], 'only the uncommented cron is active');
    assert.deepEqual(mixed.disabledCrons, ['0 6,18 * * *'], 'the commented cron stays visible as disabled');
  } finally {
    if (prior === undefined) delete process.env.WF_DIR; else process.env.WF_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveSchedules fails when pointed at an empty workflow tree', () => {
  // Proves the guard is discriminating, not merely present: without it a
  // mis-resolved path renders an empty, reassuring workflow table — every
  // workflow silently absent rather than visibly broken. WF_DIR is overridable
  // for exactly this, mirroring test/verify-main-writer-lock.cjs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-empty-'));
  const prior = process.env.WF_DIR;
  try {
    process.env.WF_DIR = dir;
    assert.throws(() => derive.deriveSchedules(), /no workflows found/);
  } finally {
    if (prior === undefined) delete process.env.WF_DIR; else process.env.WF_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveSchedules fails when a cron is added without a tier mapping', () => {
  // The §4 failure in miniature: an unmapped cron falls through to `*) tier=1`
  // and runs tier 1 in another tier's slot, nightly, with a green checkmark.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-unmapped-'));
  const prior = process.env.WF_DIR;
  try {
    const real = fs.readFileSync('.github/workflows/verify-catalog.yml', 'utf8');
    // Add a fifth schedule but leave the `case` block alone.
    const doctored = real.replace("    - cron: '0 8 */2 * *'", "    - cron: '0 8 */2 * *'\n    - cron: '0 5 */4 * *'");
    fs.writeFileSync(path.join(dir, 'verify-catalog.yml'), doctored);
    process.env.WF_DIR = dir;
    assert.throws(() => derive.deriveSchedules(), /is not mapped to a tier/);
  } finally {
    if (prior === undefined) delete process.env.WF_DIR; else process.env.WF_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
