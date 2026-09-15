/**
 * test/assert-paapi-outcome.test.js
 *
 * The behaviour under test is the one that hid a PA API outage for three days:
 * a verify-catalog run that PA could not serve must FAIL, and must not be
 * confused with a run PA served or with a transient blip.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { paapiOutcome, OUTCOMES } from '../scripts/assert-paapi-outcome.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/assert-paapi-outcome.mjs', import.meta.url));

const report = (paapi, meta = {}) => JSON.stringify({ meta: { tier: 1, checked: 1533, paapi, ...meta }, issues: [] });
const status = (available, disabledReason = null) => ({
  available, disabledReason, alerts: [], stats: { calls: 1, items: 0, throttled: 0, batchErrors: 0 },
});

// The report shape of verify-catalog run 34758432671 (2026-09-13, tier 1): green,
// with PA having confirmed nothing.
const SEPT_13 = report({ paConfirmed: 0, dfsFallback: 1533, quarantineSkipped: 1041, ...status(false, 'associate_not_eligible') });

test('the 2026-09-13 run — associate_not_eligible, 0 PA confirmations — is red', () => {
  const r = paapiOutcome(SEPT_13);
  assert.equal(r.outcome, 'gated');
  assert.equal(r.fail, true);
  assert.match(r.message, /associate_not_eligible/);
  assert.match(r.message, /1041 hidden/, 'names the rows nothing checked');
});

test('unauthorized is the same gate', () => {
  assert.equal(paapiOutcome(report({ paConfirmed: 0, dfsFallback: 10, ...status(false, 'unauthorized') })).outcome, 'gated');
});

test('eligibility lost MID-run is red even though PA confirmed some rows first', () => {
  const r = paapiOutcome(report({ paConfirmed: 400, dfsFallback: 900, ...status(false, 'associate_not_eligible') }));
  assert.equal(r.outcome, 'gated');
  assert.equal(r.fail, true);
});

test('a wiring fault that surfaces after the preflight is red and called ours', () => {
  for (const reason of ['not_configured', 'credentials_rejected']) {
    const r = paapiOutcome(report({ paConfirmed: 0, dfsFallback: 10, ...status(false, reason) }));
    assert.equal(r.outcome, 'our_bug', reason);
    assert.equal(r.fail, true, reason);
  }
});

test('a transient degrade stays green, with a warning outcome', () => {
  for (const reason of ['token_failed', 'network', 'http_503']) {
    const r = paapiOutcome(report({ paConfirmed: 0, dfsFallback: 10, ...status(false, reason) }));
    assert.equal(r.outcome, 'degraded', reason);
    assert.equal(r.fail, false, reason);
  }
});

test('a run PA served is green', () => {
  const r = paapiOutcome(report({ paConfirmed: 1913, dfsFallback: 179, quarantineSkipped: 482, ...status(true) }));
  assert.equal(r.outcome, 'ok');
  assert.equal(r.fail, false);
});

test('no report, an unparseable one, and one with no PA summary are three different failures', () => {
  assert.equal(paapiOutcome(null).outcome, 'no-report');
  assert.equal(paapiOutcome('').outcome, 'no-report');
  assert.equal(paapiOutcome('{"meta":{"paapi":').outcome, 'unreadable');
  assert.equal(paapiOutcome(JSON.stringify({ meta: {} })).outcome, 'no-pa-summary');
  assert.equal(paapiOutcome(JSON.stringify({ meta: { paapi: null } })).outcome, 'no-pa-summary');
  assert.equal(paapiOutcome(report({ paConfirmed: 0 })).outcome, 'no-pa-summary', 'available missing is not "available"');
  for (const raw of [null, '{', JSON.stringify({ meta: {} })]) assert.equal(paapiOutcome(raw).fail, true);
});

test('CONTRACT: every input ends in exactly one named outcome with a definite verdict', () => {
  const reasons = ['not_configured', 'credentials_rejected', 'associate_not_eligible', 'unauthorized',
    'token_failed', 'network', 'a_reason_nobody_has_seen_yet', null, undefined];
  const inputs = [null, '', 'not json', '[]', 'null', JSON.stringify({}), report(null),
    report({ ...status(true) }), ...reasons.map(r => report({ paConfirmed: 0, ...status(false, r) }))];
  for (const raw of inputs) {
    const r = paapiOutcome(raw);
    assert.ok(OUTCOMES.includes(r.outcome), `${raw} -> ${r.outcome}`);
    assert.equal(typeof r.fail, 'boolean', `${raw}`);
    assert.ok(r.message, `${raw}`);
  }
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
function tmp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paapi-outcome-'));
  const p = path.join(dir, 'report-x.json');
  fs.writeFileSync(p, text);
  return p;
}

test('CLI: a gated report exits 1 with an ::error:: annotation', () => {
  const r = run([tmp(SEPT_13)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error title=PA API gated::/m);
});

test('CLI: the workflow\'s empty $REPORT (no file matched) exits 1, not 0', () => {
  assert.equal(run(['']).status, 1);
  assert.equal(run([]).status, 1);
  assert.equal(run(['verify-reports/report-does-not-exist.json']).status, 1);
});

test('CLI: a served run exits 0; a degraded one exits 0 with a warning', () => {
  assert.equal(run([tmp(report({ paConfirmed: 5, dfsFallback: 0, ...status(true) }))]).status, 0);
  const d = run([tmp(report({ paConfirmed: 0, dfsFallback: 5, ...status(false, 'network') }))]);
  assert.equal(d.status, 0);
  assert.match(d.stdout, /^::warning title=PA API degraded::/m);
});
