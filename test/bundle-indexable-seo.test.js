// Bundle-as-indexable + bundle-aware SEO template.
//
// Splitting p.bundle: it means "exclude from the builder picker", NOT "hide from
// the index". A combo (CPU + motherboard) page ranks for "<cpu> <chipset>
// motherboard bundle" — but only when it has a live deal AND is not actually a
// whole prebuilt PC. These tests lock:
//   - prebuiltSystemReason catches a "Gaming PC" that names a CPU model + GPU model
//   - isIndexable: bundle indexable iff it has a buyable deal (price + url)
//   - bundleH1/bundleTitle/bundleLdName keep BOTH components + the word "Bundle",
//     title within 60 chars
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import cc from '../catalog-classify.cjs';
import urls from '../scripts/url-slugs.cjs';
import { bundleH1, bundleTitle, bundleLdName } from '../src/bundle-name.js';

const { prebuiltSystemReason } = cc;
const { isIndexable } = urls;

test('prebuiltSystemReason: Gaming PC naming CPU + GPU model is a prebuilt', () => {
  assert.equal(prebuiltSystemReason('Azure 3 Gaming PC, AMD Ryzen 7 9700X 3.8GHz, NVIDIA RTX 5060'), 'prebuilt_gaming');
  assert.ok(prebuiltSystemReason('ProDesk 400 G9 Business Desktop Computer, SFF')); // a prebuilt (brand/system)
  // must NOT fire on a plain component or a case whose title says "gaming pc"
  assert.equal(prebuiltSystemReason('NZXT H7 Flow Gaming PC Case ATX Mid Tower'), null); // no CPU+GPU model
  assert.equal(prebuiltSystemReason('AMD Ryzen 7 9700X'), null);
  assert.equal(prebuiltSystemReason('NVIDIA GeForce RTX 5060'), null);
});

test('isIndexable: bundle indexable only with a buyable deal', () => {
  const base = { id: 1, n: 'Ryzen 9 7900X + B650 Motherboard', c: 'CPU' };
  assert.equal(isIndexable({ ...base, bundle: true, deals: { amazon: { price: 480, url: 'https://x' } } }), true);
  assert.equal(isIndexable({ ...base, bundle: true, deals: { amazon: { price: 480 } } }), false); // no url
  assert.equal(isIndexable({ ...base, bundle: true, deals: {} }), false);                          // no deal
  assert.equal(isIndexable({ ...base, bundle: true, needsReview: true, deals: { amazon: { price: 480, url: 'https://x' } } }), false); // held
  // a NON-bundle needs no deal to be indexable (unchanged behavior)
  assert.equal(isIndexable({ ...base }), true);
});

test('bundle H1/title/LD keep both components + "Bundle"', () => {
  const p = { bundle: true, n: 'Ryzen 9 7900X + GIGABYTE B650 AORUS ELITE AX Motherboard', b: 'AMD' };
  const h1 = bundleH1(p), t = bundleTitle(p), ld = bundleLdName(p);
  for (const [label, s] of [['h1', h1], ['title', t], ['ld', ld]]) {
    assert.match(s, /bundle/i, `${label} missing "Bundle": ${s}`);
    assert.match(s, /7900X/i, `${label} missing CPU: ${s}`);
    assert.match(s, /B650/i, `${label} missing mobo: ${s}`);
  }
  assert.ok(t.length <= 60, `title over 60: "${t}" (${t.length})`);
});

test('bundleTitle stays <=60 and keeps both + Bundle for a long combo', () => {
  const p = { bundle: true, n: 'AMD Ryzen 9 9950X3D CPU Processor with MSI MAG X870E Tomahawk WiFi ATX Motherboard' };
  const t = bundleTitle(p);
  assert.ok(t.length <= 60, `title over 60: "${t}" (${t.length})`);
  assert.match(t, /9950X3D/i);
  assert.match(t, /X870E/i);
  assert.match(t, /bundle/i);
});
