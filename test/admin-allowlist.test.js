// The dispatch allowlist — the only write the admin dashboard has in v1.
//
// "The workflow's own inputs are the schema" is true ONLY if the caller cannot
// invent inputs. verify-catalog.yml carries `force_paapi_unconfigured`, a
// self-test that blanks the PA API credentials to prove the fail-loud gate
// fires; it is correct for a human at the Actions tab and must never be
// reachable from a web button. These tests pin that, and pin the narrowing:
// asin-identity-audit defaults apply=true (which quarantines rows) and the
// dashboard may only ever send false.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DISPATCH_ALLOWLIST, validateDispatch, findEntry } from '../admin/functions-lib/allowlist.js';

test('a workflow that is not listed cannot be dispatched', () => {
  for (const forbidden of [
    'apply-newegg.yml',        // writes discovered rows into the catalog
    'sftp-ingest.yml',         // bulk catalog ingest
    'deploy-pages.yml',        // ships the site
    'publish-epik.yml',
    'deploy-admin.yml',
    'refresh-newegg-prices.yml',
  ]) {
    const r = validateDispatch(forbidden, {});
    assert.equal(r.ok, false, `${forbidden} must not be dispatchable`);
    assert.match(r.error, /not in the dispatch allowlist/);
  }
});

test('the PA API self-test input is not reachable from the dashboard', () => {
  const r = validateDispatch('verify-catalog.yml', { tier: '1', force_paapi_unconfigured: 'true' });
  assert.equal(r.ok, false);
  assert.match(r.error, /force_paapi_unconfigured' is not permitted/);
});

test('an unknown input is REJECTED, not silently dropped', () => {
  // Discarding an input the caller believed it was sending produces a run that
  // did something other than what was asked, and still looks successful.
  const r = validateDispatch('verify-catalog.yml', { tier: '2', ref: 'some-branch' });
  assert.equal(r.ok, false);
  assert.match(r.error, /'ref' is not permitted/);
});

test('the allowlist can be NARROWER than the workflow default', () => {
  // asin-identity-audit.yml defaults apply=true. The dashboard may only send false.
  const ok = validateDispatch('asin-identity-audit.yml', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.inputs.apply, 'false', 'the dry-run value must be sent explicitly, not left to the YAML default');

  const bad = validateDispatch('asin-identity-audit.yml', { apply: 'true' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not one of false/);
});

test('tier is required and bounded', () => {
  assert.equal(validateDispatch('verify-catalog.yml', {}).ok, false);
  assert.match(validateDispatch('verify-catalog.yml', {}).error, /'tier' is required/);
  assert.equal(validateDispatch('verify-catalog.yml', { tier: '5' }).ok, false);
  assert.equal(validateDispatch('verify-catalog.yml', { tier: '0' }).ok, false);
  assert.equal(validateDispatch('verify-catalog.yml', { tier: 'all' }).ok, false);
  assert.equal(validateDispatch('verify-catalog.yml', { tier: '3' }).ok, true);
});

test('omitted optional inputs fall back to the declared default', () => {
  const r = validateDispatch('verify-catalog.yml', { tier: '1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, { tier: '1', fix_asins: 'true' });
});

test('a free-text input is format-checked', () => {
  assert.equal(validateDispatch('discover-newegg-dry.yml', { category: 'RAM', sample: '60' }).ok, true);
  assert.equal(validateDispatch('discover-newegg-dry.yml', { category: 'RAM', sample: '99999' }).ok, false);
  assert.equal(validateDispatch('discover-newegg-dry.yml', { category: 'RAM', sample: '1; rm -rf /' }).ok, false);
  assert.equal(validateDispatch('discover-newegg-dry.yml', { category: 'NotACategory' }).ok, false);
});

test('a workflow with no inputs dispatches with an empty input set', () => {
  const r = validateDispatch('feed-overlap-audit.yml', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, {});
});

test('numbers and booleans are coerced to the strings GitHub expects', () => {
  const r = validateDispatch('verify-catalog.yml', { tier: 3, fix_asins: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs, { tier: '3', fix_asins: 'false' });
});

test('every allowlisted workflow exists on disk and is dispatchable', () => {
  for (const e of DISPATCH_ALLOWLIST) {
    const p = `.github/workflows/${e.workflow}`;
    assert.ok(fs.existsSync(p), `${e.workflow} is allowlisted but not in .github/workflows`);
    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /^\s{2}workflow_dispatch:/m, `${e.workflow} has no workflow_dispatch trigger`);
  }
});

test('every allowlisted input actually exists in its workflow', () => {
  // Guards the drift that produces a 422 from GitHub and a button that has
  // simply never worked: an input renamed in the YAML but not here.
  for (const e of DISPATCH_ALLOWLIST) {
    const text = fs.readFileSync(`.github/workflows/${e.workflow}`, 'utf8');
    for (const name of Object.keys(e.inputs || {})) {
      assert.match(text, new RegExp(`^\\s+${name}:`, 'm'), `${e.workflow} declares no input '${name}'`);
    }
  }
});

test('every entry is annotated so the UI can gate on it', () => {
  for (const e of DISPATCH_ALLOWLIST) {
    assert.equal(typeof e.writes, 'boolean', `${e.workflow} must declare writes`);
    assert.ok(e.label && e.description && e.cost, `${e.workflow} is missing operator-facing text`);
  }
  assert.ok(findEntry('verify-catalog.yml').writes, 'the verifier commits, so it must be flagged as writing');
  assert.equal(findEntry('discover-newegg-dry.yml').writes, false);
});
