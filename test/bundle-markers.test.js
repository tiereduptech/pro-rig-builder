// =============================================================================
//  test/bundle-markers.test.js
//
//  Tests the CHECKER, not the bundle. It runs in the normal suite with no
//  build: it points scripts/assert-bundle-markers.cjs at synthetic chunk
//  directories and asserts it reaches the right verdict.
//
//  The real assertion — against a real build — runs in .github/workflows where
//  a build already exists. Building here would put 17s and a dist/ wipe into
//  every `npm test`.
//
//  What matters most below is the vacuous-pass case. A checker that silently
//  finds nothing to check is worse than no checker: it reports green forever
//  and nobody looks again.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { check, loadMarkers } = require('../scripts/assert-bundle-markers.cjs');

function chunkDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-markers-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('the marker contract is read from src/retailer-badges.js and is non-empty', () => {
  const markers = loadMarkers();
  assert.ok(markers.includes('UNCONFIRMED'));
  assert.ok(markers.includes('BEST'));
});

test('passes when every marker is present in some chunk', () => {
  const dir = chunkDir({ 'App-abc123.js': 'x={children:"BEST"};y="UNCONFIRMED "+n+"d";' });
  const { missing } = check(dir);
  assert.deepEqual(missing, []);
});

test('fails when a marker was tree-shaken out — the #73 failure exactly', () => {
  // The bundle as it actually shipped: the BEST badge present, the UNCONFIRMED
  // tag gone because it lived in a component nothing rendered.
  const dir = chunkDir({ 'App-DMUdDTlA.js': 'x={children:"BEST"};' });
  const { missing } = check(dir);
  assert.deepEqual(missing, ['UNCONFIRMED']);
});

test('a marker in ANY chunk counts — manualChunks may move it', () => {
  const dir = chunkDir({
    'App-abc.js': 'x={children:"BEST"};',
    'upgrade-page-def.js': 'y="UNCONFIRMED";',
  });
  assert.deepEqual(check(dir).missing, []);
});

test('an empty or missing bundle directory is an ERROR, never a pass', () => {
  // The vacuous pass is the failure mode that matters: a check finding zero
  // chunks must not report that zero markers are missing.
  const empty = chunkDir({});
  assert.throws(() => check(empty), /no \.js chunks/, 'empty dir must throw, not pass');
  assert.throws(() => check(path.join(empty, 'nope')), /not found/, 'missing dir must throw, not pass');
});

test('non-JS files in the bundle dir are not scanned for markers', () => {
  // dist/assets also holds CSS and images. A marker appearing only in a
  // sourcemap or stylesheet is not the marker reaching the page.
  const dir = chunkDir({
    'App-abc.js': 'x={children:"BEST"};',
    'style-xyz.css': '.unconfirmed{}/* UNCONFIRMED */',
  });
  assert.deepEqual(check(dir).missing, ['UNCONFIRMED']);
});
