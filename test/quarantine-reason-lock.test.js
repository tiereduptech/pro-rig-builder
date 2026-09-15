// =============================================================================
//  test/quarantine-reason-lock.test.js
//
//  Scheduled code hides a row ONLY through recordQuarantine(), with its cause.
//
//  Why this exists: quarantining wrote only `needsReview = true` and
//  `quarantinedAt`. The cause lived solely in the run report — a CI artifact with
//  90-day retention — never on the row. Measured on the 2026-08-25 tier-1 run,
//  66% of no_new_offer rows and 77% of the healthy-but-quarantined rows carried
//  no recorded cause at all.
//
//  That is not cosmetic. A quarantine with no recorded cause cannot be safely
//  lifted by anything: a good price does not resolve a wrong-ASIN hold or a
//  manual flag, and with no cause stored you cannot tell which you are looking
//  at. And a hide that writes the row directly, even with a cause, replaces the
//  cause an already-hidden row was held for. recordQuarantine() is the one
//  place that knows not to.
//
//  This lock first read a hand-kept list of four `.js` files. Most of the code
//  that hides rows is `.cjs` and `.mjs`: on 2026-09-15 five scheduled writers
//  hid rows with no cause and none of them was on the list, the nightly sftp
//  ingest, the identity audit, and both Newegg discovery paths among them. The
//  detector also looked for a literal `true`, so `needsReview: HELD.has(...)`
//  hid every discovered CPU and GPU with no cause and no date, unseen.
//
//  The rule, over every .js / .cjs / .mjs file (see helpers/live-code.js):
//    - LIVE code (named by a workflow, or loaded by a file that is) never sets
//      needsReview on a row itself. It calls recordQuarantine(), with a reason.
//      The only other live sites are VERDICT records: a fix object carrying
//      its cause, which applyFixes() hands to recordQuarantine().
//    - Everything else that hides a row is a one-shot script and is LISTED
//      below. The list is exact. A new file that hides fails until it is
//      listed. A listed file that a workflow starts running fails. Their sites
//      stay in the tally, missing causes included, visible rather than exempted.
//
//  Output is a TALLY, not a boolean. A gate that only says FAIL cannot be
//  sanity-checked.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { codeFiles, liveFiles, scan, HIDES, IS_COMMENT } from './helpers/live-code.js';

// The one door. Its own hiding line must sit inside this function.
const DOOR = { file: 'drift-gate.js', fn: 'recordQuarantine' };

// Live code that builds a quarantine VERDICT on a fix object rather than a row.
// verify-catalog-asins.js applyFixes() hands each one to recordQuarantine()
// (asserted below). Each must carry its cause.
const VERDICT_RECORDS = {
  'drift-gate.js': /\bfixes\.needsReview\b/,
  'verify-catalog-asins.js': /\bperProductFixes\[[^\]]+\]\.needsReview\b/,
};

// Hiding code no workflow runs and no live file loads. Each is a script a
// person runs by hand, and none can be test-run here, so they are listed, not
// edited. Most record no cause; the tally says which.
const ONE_SHOT_HIDERS = [
  'apply-amazon-cases.mjs',
  'apply-amazon-discoveries.cjs',
  'audit-categories.cjs',
  'bestbuy-merge.js',
  'c3b-cleanup.mjs',
  'case-ingest.mjs',
  'corrective-remove-comp-bestbuy.mjs',
  'fix-bad-category-v2.cjs',
  'fix-bad-category.cjs',
  'patch-frontend-quarantine-filter.js',
  'patch-verifier-strategy2.js',
  'purge-dead-bestbuy-links.mjs',
  'quarantine-prebuilt-bundles.cjs',
  'quarantine-wrong-product.mjs',
  'recheck-dead-asins.mjs',
  'replay-c1-amazon.mjs',
  'stamp-unbuyable-bestbuy.mjs',
  'verify-new-products.js',
  'weekend-amazon-ingest.mjs',
];

// One-shots that DO record a cause. The lock used to hold them to it; it still does.
const ONE_SHOTS_WITH_CAUSE = ['bestbuy-merge.js', 'verify-new-products.js'];

const files = codeFiles();
const live = liveFiles(files);
const hiders = scan(HIDES, files);

const hasCause = (w) => /quarantineReason|recordQuarantine\(/.test(w);
const role = (f) => (f === DOOR.file ? 'door    ' : live.has(f) ? 'LIVE    ' : 'one-shot');

function doorRange() {
  const lines = readFileSync(DOOR.file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`export function ${DOOR.fn}(`));
  assert.ok(start >= 0, `${DOOR.fn} not found in ${DOOR.file}`);
  const end = lines.findIndex((l, i) => i > start && /^}/.test(l));
  return [start + 1, end + 1];
}

test('the derivation sees the scheduled writers — a lock that finds nothing proves nothing', () => {
  for (const f of ['sftp-ingest.cjs', 'refresh-newegg-prices.cjs', 'amazon-asin-identity-audit.mjs',
                   'apply-newegg-discoveries.cjs', 'fetch-newegg-via-rakuten.cjs',
                   'verify-catalog-asins.js', 'drift-gate.js']) {
    assert.ok(live.has(f), `${f} should be live`);
  }
  assert.ok(hiders.size >= ONE_SHOT_HIDERS.length, `found ${hiders.size} hiding files`);
});

test('tally: every line that hides a row, and whether it records a cause', () => {
  const rows = [];
  let missing = 0;
  for (const [f, sites] of hiders) {
    for (const s of sites) {
      if (!hasCause(s.window)) missing++;
      rows.push(`  ${role(f)}  ${hasCause(s.window) ? 'ok  ' : 'MISS'}  ${f}:${s.line}  ${s.text.slice(0, 56)}`);
    }
  }
  console.log(`\nhiding sites: ${rows.length} in ${hiders.size} files ` +
              `(${[...hiders.keys()].filter((f) => live.has(f)).length} live), recording no cause: ${missing}`);
  rows.forEach((r) => console.log(r));
  assert.ok(rows.length > 0);
});

test('no live code hides a row except through recordQuarantine()', () => {
  const [start, end] = doorRange();
  const offenders = [];
  for (const [f, sites] of hiders) {
    if (!live.has(f)) continue;
    for (const s of sites) {
      if (f === DOOR.file && s.line > start && s.line <= end) continue;
      if (VERDICT_RECORDS[f] && VERDICT_RECORDS[f].test(s.text)) {
        if (!/quarantineReason/.test(s.window)) offenders.push(`${f}:${s.line}  verdict with no quarantineReason`);
        continue;
      }
      offenders.push(`${f}:${s.line}  ${s.text.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], 'scheduled code sets needsReview directly — hide through recordQuarantine()');
});

test('every live recordQuarantine() call names its cause', () => {
  // recordQuarantine(p, { at }) is legal, and hides a row with no cause. That is
  // the hole this lock closes, reopened through the door itself.
  const bare = [];
  for (const f of live) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (IS_COMMENT(l) || !/\brecordQuarantine\(/.test(l) || /function\s+recordQuarantine\(/.test(l)) return;
      if (!/reason\s*:/.test(lines.slice(i, i + 3).join('\n'))) bare.push(`${f}:${i + 1}  ${l.trim().slice(0, 60)}`);
    });
  }
  assert.deepEqual(bare, [], 'recordQuarantine() called without a reason');
});

test('anything else that hides a row is a LISTED one-shot', () => {
  const unlisted = [...hiders.keys()].filter((f) => !live.has(f) && !ONE_SHOT_HIDERS.includes(f));
  assert.deepEqual(unlisted, [], 'a new file hides rows — make it go through recordQuarantine(), or list it as a one-shot');
});

test('the one-shot list is exact: every entry exists and still hides', () => {
  const stale = ONE_SHOT_HIDERS.filter((f) => !hiders.has(f));
  assert.deepEqual(stale, [], 'listed one-shot no longer hides anything (or was removed) — drop it from the list');
});

test('no workflow runs a one-shot hider, and no live file loads one', () => {
  const promoted = ONE_SHOT_HIDERS.filter((f) => live.has(f));
  assert.deepEqual(promoted, [], 'a one-shot hider is now scheduled — it must hide through recordQuarantine()');
});

test('the one-shots that record a cause still do', () => {
  const lost = ONE_SHOTS_WITH_CAUSE.flatMap((f) =>
    (hiders.get(f) || []).filter((s) => !hasCause(s.window)).map((s) => `${f}:${s.line}`));
  assert.deepEqual(lost, [], 'a one-shot stopped recording the cause it hides for');
});

test('verdict writers record a quarantine through recordQuarantine, never over the cause', () => {
  // lift-quarantine.mjs is keyed on quarantineReason, so a verdict landing on a
  // row that is ALREADY hidden must not replace the cause it was hidden for.
  // These two apply verdicts to rows loaded from the catalog, hidden or not.
  for (const file of ['verify-catalog-asins.js', 'verify-new-products.js']) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /recordQuarantine\(/, `${file} applies quarantine verdicts without recordQuarantine()`);
    const direct = src.split('\n').filter((l) => !IS_COMMENT(l) && /\bp\.quarantineReason\s*=/.test(l));
    assert.deepEqual(direct, [], `${file} assigns p.quarantineReason directly`);
  }
});

test('every lifter clears the reason along with the flag', () => {
  // A stale quarantineReason on an un-quarantined row is worse than none: it reads
  // as a live hold to anything inspecting the row later, which is exactly the
  // confusion this field exists to remove.
  const LIFTERS = ['repair-broken-asins.js', 'lift-quarantine.mjs'];
  for (const file of LIFTERS) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (IS_COMMENT(lines[i]) || !/delete\s+[\w.[\]]*\.needsReview/.test(lines[i])) continue;
      const window = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
      assert.match(window, /delete\s+[\w.[\]]*\.quarantinedAt/,
        `${file}:${i + 1} clears needsReview without clearing quarantinedAt`);
      assert.match(window, /delete\s+[\w.[\]]*\.quarantineReason/,
        `${file}:${i + 1} clears needsReview without clearing quarantineReason`);
    }
  }
});
