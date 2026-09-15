// =============================================================================
//  test/quarantine-lift-lock.test.js
//
//  Scheduled code un-hides a row ONLY by asking why it was hidden.
//
//  refresh-newegg-prices.cjs lifted any row carrying its own priceQuarantined
//  marker the moment the price recovered. It never asked whether something
//  else had hidden the row since, such as a wrong-ASIN hold or an identity
//  mismatch. That is how a product comes back on the site with an identity
//  problem still unresolved. It sat in a .cjs file, and the lifter check in
//  quarantine-reason-lock.test.js read a hand-kept list of two files. Nothing
//  could see it.
//
//  The rule, over every .js / .cjs / .mjs file:
//    - LIVE code (named by a workflow, or loaded by a file that is) never
//      deletes needsReview itself. It calls resolveQuarantineCause() in
//      drift-gate.js, which lifts only when the evidence answers the row's LAST
//      recorded cause.
//    - Everything else that un-hides a row is a one-shot script and is LISTED
//      below. The list is exact. A new file that un-hides fails until it is
//      listed. A listed file that a workflow starts running fails. Their sites
//      stay in the tally, visible rather than exempted.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { codeFiles, liveFiles, scan, UNHIDES } from './helpers/live-code.js';

// The one door. Its own un-hiding lines must sit inside this function.
const DOOR = { file: 'drift-gate.js', fn: 'resolveQuarantineCause' };

// Un-hiding code no workflow runs and no live file loads. Each is a script a
// person runs by hand, and none can be test-run here. lift-quarantine.mjs
// is the reviewed manual lift. It keys on the recorded cause and clears it,
// which is the behaviour this lock asks of live code.
const ONE_SHOT_LIFTERS = [
  'c3-reconcile-deferred-amazon.mjs',
  'case-ingest.mjs',
  'fix-no-new-offer-amazon.mjs',
  'lift-quarantine.mjs',
  'patch-verifier-strategy2.js',
  'relink-bucketA.cjs',
  'repair-broken-asins.js',
  'verify-discoveries.cjs',
];

const files = codeFiles();
const live = liveFiles(files);
const lifters = scan(UNHIDES, files);

const clears = (w, field) => new RegExp(`delete\\s+[\\w.[\\]]*\\.${field}\\b`).test(w);
const role = (f) => (f === DOOR.file ? 'door    ' : live.has(f) ? 'LIVE    ' : 'one-shot');

test('the derivation sees the scheduled code — a lock that finds nothing proves nothing', () => {
  for (const f of ['refresh-newegg-prices.cjs', 'sftp-ingest.cjs', 'verify-catalog-asins.js', 'drift-gate.js']) {
    assert.ok(live.has(f), `${f} should be live`);
  }
  assert.ok(lifters.size >= ONE_SHOT_LIFTERS.length, `found ${lifters.size} un-hiding files`);
});

test('tally: every line that un-hides a row, and whether it clears the cause', () => {
  const rows = [];
  for (const [f, sites] of lifters) {
    for (const s of sites) {
      rows.push(`  ${role(f)}  ${f}:${s.line}  quarantinedAt:${clears(s.window, 'quarantinedAt') ? 'y' : 'N'} ` +
                `reason:${clears(s.window, 'quarantineReason') ? 'y' : 'N'}  ${s.text.slice(0, 50)}`);
    }
  }
  console.log(`\nun-hiding sites: ${rows.length} in ${lifters.size} files (${[...lifters.keys()].filter((f) => live.has(f)).length} live)`);
  rows.forEach((r) => console.log(r));
  assert.ok(rows.length > 0);
});

test('no live code un-hides a row except through resolveQuarantineCause()', () => {
  const offenders = [];
  for (const [f, sites] of lifters) {
    if (!live.has(f) || f === DOOR.file) continue;
    for (const s of sites) offenders.push(`${f}:${s.line}  ${s.text.slice(0, 60)}`);
  }
  assert.deepEqual(offenders, [], 'scheduled code deletes needsReview directly — lift through resolveQuarantineCause()');
});

test('the door un-hides only inside resolveQuarantineCause()', () => {
  const lines = readFileSync(DOOR.file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`export function ${DOOR.fn}(`));
  assert.ok(start >= 0, `${DOOR.fn} not found in ${DOOR.file}`);
  const end = lines.findIndex((l, i) => i > start && /^}/.test(l));
  for (const s of lifters.get(DOOR.file) || []) {
    assert.ok(s.line > start && s.line <= end + 1, `${DOOR.file}:${s.line} un-hides outside ${DOOR.fn}`);
  }
});

test('anything else that un-hides a row is a LISTED one-shot', () => {
  const unlisted = [...lifters.keys()].filter((f) => !live.has(f) && !ONE_SHOT_LIFTERS.includes(f));
  assert.deepEqual(unlisted, [], 'a new file un-hides rows — make it go through resolveQuarantineCause(), or list it as a one-shot');
});

test('the one-shot list is exact: every entry exists and still un-hides', () => {
  const stale = ONE_SHOT_LIFTERS.filter((f) => !lifters.has(f));
  assert.deepEqual(stale, [], 'listed one-shot no longer un-hides anything (or was removed) — drop it from the list');
});

test('no workflow runs a one-shot lifter, and no live file loads one', () => {
  const promoted = ONE_SHOT_LIFTERS.filter((f) => live.has(f));
  assert.deepEqual(promoted, [], 'a one-shot un-hider is now scheduled — it must lift through resolveQuarantineCause()');
});
