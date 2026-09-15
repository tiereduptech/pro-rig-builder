// =============================================================================
//  test/identity-audit-gated.test.js
//
//  A night the ASIN identity audit could not check ends RED, never as a green
//  no-op.
//
//  On AssociateNotEligible the audit warned in yellow and exited 0: "a clean
//  no-op, nothing quarantined, job stays green". A gated run checks 0 ASINs. It
//  counts no dead-ASIN strike and measures no attach rate, and on a green job
//  that reads exactly like a night that checked every link and found nothing
//  wrong. verify-catalog had the same shape until #110; PA lapsed on 2026-09-12
//  and nothing looked wrong for three days.
//
//  These run the real script end to end, with fetch stubbed by a preload
//  (helpers/stub-amazon-fetch.mjs), in both places eligibility can surface:
//  the token endpoint, and getItems after a token was issued.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB = pathToFileURL(path.join(ROOT, 'test', 'helpers', 'stub-amazon-fetch.mjs')).href;
const CREDS = { AMAZON_CREATORS_CLIENT_ID: 'test-id', AMAZON_CREATORS_CLIENT_SECRET: 'test-secret' };

// Everything the workflow commits after the audit step.
const WRITES = ['src/data/parts.js', 'src/data/parts', 'amazon-asin-audit-state.json',
                'relink-review-queue.json', 'amazon-asin-identity-audit.json'];
const written = () => execSync(`git status --porcelain -- ${WRITES.join(' ')}`, { cwd: ROOT, encoding: 'utf8' });

// Run the nightly exactly as asin-identity-audit.yml does (--apply included).
function runAudit(env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'identity-audit-'));
  const out = path.join(dir, 'github-output');
  writeFileSync(out, '');
  const base = { ...process.env };
  delete base.AMAZON_CREATORS_CLIENT_ID;
  delete base.AMAZON_CREATORS_CLIENT_SECRET;
  const r = spawnSync(process.execPath,
    ['--import', STUB, 'amazon-asin-identity-audit.mjs', '--nightly', '--apply', '--limit=3'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...base, PRORIG_AMAZON_CREDS: path.join(dir, 'no-such.csv'), GITHUB_OUTPUT: out, ...env } });
  return { status: r.status, log: `${r.stdout}\n${r.stderr}`, stdout: r.stdout, outputs: readFileSync(out, 'utf8') };
}

for (const [mode, where] of [['token-gated', 'the token endpoint'], ['items-gated', 'getItems, after a token was issued']]) {
  test(`gated at ${where}: red, under the gate's own title, and nothing written`, () => {
    const before = written();
    const r = runAudit({ ...CREDS, STUB_AMAZON: mode });
    assert.equal(r.status, 1, `a gated run must fail the job (exit ${r.status})\n${r.log}`);
    assert.match(r.stdout, /::error title=PA API gated by Amazon \(AssociateNotEligible\)::/);
    assert.doesNotMatch(r.stdout, /::warning title=PA API gated/, 'the gate is no longer a warning');
    assert.doesNotMatch(r.stdout, /PA API not configured/, 'Amazon\'s gate must never read as our missing secret');
    assert.match(r.outputs, /^degraded_reason=associate_not_eligible$/m);
    assert.match(r.outputs, /^quarantined=0$/m);
    assert.equal(written(), before, 'a gated run writes nothing the workflow would commit');
  });
}

test('a missing secret is still red, and still reads as our bug rather than the gate', () => {
  const r = runAudit({ STUB_AMAZON: 'token-gated' });
  assert.equal(r.status, 1, r.log);
  assert.match(r.stdout, /::error title=PA API not configured::/);
  assert.doesNotMatch(r.stdout, /PA API gated/);
});
