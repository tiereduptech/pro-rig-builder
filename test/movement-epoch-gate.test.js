// =============================================================================
//  test/movement-epoch-gate.test.js
//
//  Assert that no refresher gates the price-movement epoch on its breakers.
//
//  Why this exists: both refreshers passed `apply && !breakers.length` into
//  movementFor. A tripped breaker blocks REMOVALS — it does not block
//  priceLastMovedAt stamps, which are written on the same run — but it did
//  block the epoch that dates them.
//
//  That made the alarm unable to start because of the condition it exists to
//  detect. Newegg run 33189471054 wrote 482 stamps, tripped the 20% feed-failure
//  breaker, and left src/data/price-movement-watch.json without a `newegg` key.
//  The next run reads no epoch, calls it day zero, and reports "warming up — 0d
//  of 14d" again. While the feed stays unhealthy the 14-day movedShare alarm
//  cannot arm, and an unhealthy feed is exactly when it is needed.
//
//  A rule enforced by convention rots the moment someone adds the third
//  refresher, so this is a source scan, in the same shape as
//  test/quarantine-reason-lock.test.js and for the same reason.
//
//  Output is a TALLY, not a boolean: a gate that only says FAIL cannot be
//  sanity-checked.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;

// Everything that may start a retailer's movement watch. The repo-wide scan
// below is what stops this list from going stale.
// NOTE: git grep, not grep. refresh-msi-impact.mjs is classified as binary by
// plain grep and is silently skipped by it — which is how it was missed when
// this list was first written. The scan below uses git grep for that reason.
const CALLER_FILES = [
  'refresh-newegg-prices.cjs',
  'refresh-bestbuy-prices.mjs',
  'refresh-msi-impact.mjs',
];

// The call's options object, from `movementFor(` to its closing `});`.
function callBlocks(src) {
  const blocks = [];
  let i = 0;
  while ((i = src.indexOf('movementFor({', i)) !== -1 && i >= 0) {
    const end = src.indexOf('});', i);
    if (end === -1) break;
    blocks.push(src.slice(i, end + 3));
    i = end;
  }
  return blocks;
}

// Strip line and block comments — the fix's own comments say the word
// "breakers" to explain why it is absent, and must not read as a violation.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('no refresher gates the movement epoch on breakers', () => {
  const tally = [];
  for (const f of CALLER_FILES) {
    const src = readFileSync(ROOT + f, 'utf8');
    const blocks = callBlocks(src);
    assert.ok(blocks.length > 0, `${f}: expected a movementFor({...}) call`);
    for (const raw of blocks) {
      const block = stripComments(raw);
      const flag = block.match(/wroteStamps\s*:\s*([^,\n}]+)/);
      assert.ok(flag, `${f}: movementFor must pass wroteStamps (was it renamed back to apply?)`);
      const expr = flag[1].trim();
      assert.ok(
        !/breaker/i.test(expr),
        `${f}: wroteStamps is gated on breakers (${expr}). A breaker blocks removals, ` +
        `not stamps — gating the epoch on it stops the warm-up clock exactly when ` +
        `the feed is unhealthy, which is when the alarm is needed.`,
      );
      tally.push(`  ${f.padEnd(28)} wroteStamps: ${expr}`);
    }
  }
  console.log(`movementFor call sites checked: ${tally.length}\n${tally.join('\n')}`);
});

test('no movementFor call site outside the known list', () => {
  // Tracked files only, so a stray copy in a scratch dir does not fail the gate.
  const hits = execSync(
    "git grep -l 'movementFor' -- '*.cjs' '*.mjs' '*.js' || true",
    { cwd: ROOT, encoding: 'utf8' },
  ).split('\n').filter(Boolean);

  const known = new Set([...CALLER_FILES, 'scripts/price-movement.cjs', 'test/price-movement.test.js', 'test/movement-epoch-gate.test.js']);
  const unknown = hits.filter((h) => !known.has(h));
  assert.deepStrictEqual(
    unknown, [],
    `new movementFor caller(s) not covered by this gate: ${unknown.join(', ')}. ` +
    `Add them to CALLER_FILES so their wroteStamps flag is checked too.`,
  );
  console.log(`movementFor referenced in ${hits.length} tracked file(s), all known.`);
});
