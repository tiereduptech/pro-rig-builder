#!/usr/bin/env node
/**
 * scripts/assert-bundle-markers.cjs
 *
 * Asserts that user-visible strings which are supposed to reach the page
 * actually survive into the built JS bundle.
 *
 * Usage:  node scripts/assert-bundle-markers.cjs [--dir dist/assets]
 *
 * ── WHY A CHECK ON THE ARTIFACT AND NOT ON THE SOURCE ───────────────────────
 * Because a source-level check passes while the bug is live. That is not a
 * hypothesis; it is what happened.
 *
 * #73 added a freshness guard to the BEST badge and an UNCONFIRMED tag beside
 * stale prices. The JSX was correct. It was also unreachable: it lived in
 * PriceCompare, a component `git log -S"<PriceCompare"` shows was never once
 * rendered anywhere in this repo's history. Rollup drops an unreferenced
 * component, so the shipped bundle contained "UNCONFIRMED" zero times. Any test
 * that read src/App.jsx would have found the markup and gone green, while the
 * page it was meant to protect showed the pre-#73 badge.
 *
 * Reachability is a property of the BUILD. It can only be checked after one.
 *
 * ── WHAT THIS DOES AND DOES NOT PROVE ──────────────────────────────────────
 * It proves a string is present in a chunk, which is to say the code emitting
 * it was not tree-shaken away. It does not prove the component renders under
 * the right conditions — that the BEST badge still checks freshness, say. That
 * is a decision, it lives in src/retailer-badges.js as a pure predicate, and
 * test/retailer-badges.test.js exercises it directly.
 *
 * Two failure modes, two checks, deliberately not merged:
 *   - wrong rule       -> unit test on the predicate  (fast, no build)
 *   - unreachable rule -> this script                 (needs a build)
 *
 * Neither catches the other. Tonight's bug was the second kind, and the repo
 * had no check of that kind at all.
 *
 * ── WHY THE MARKER LIST LIVES IN src/retailer-badges.js ────────────────────
 * So that renaming a badge updates the assertion in the same edit. A checker
 * with its own private copy of the strings drifts into greping for text nothing
 * emits any more, and then reports green because it is looking at nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');

// src/retailer-badges.js is ESM and this script is CJS, because every other
// script in scripts/ is. Rather than convert the module or the script, read the
// contract out of the source. The parse is deliberately strict: a shape it does
// not recognise is a hard error, never an empty marker list, because an empty
// list is a check that passes by looking at nothing — the exact failure this
// file exists to prevent one layer up.
function loadMarkers() {
  const src = fs.readFileSync(path.join(REPO, 'src', 'retailer-badges.js'), 'utf8');
  const block = src.match(/REQUIRED_BUNDLE_MARKERS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) {
    throw new Error('could not find REQUIRED_BUNDLE_MARKERS in src/retailer-badges.js');
  }
  const markers = [...block[1].matchAll(/marker:\s*'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
  if (!markers.length) {
    throw new Error('REQUIRED_BUNDLE_MARKERS parsed to an empty list — refusing to pass vacuously');
  }
  return markers;
}

function jsChunks(dir) {
  if (!fs.existsSync(dir)) throw new Error(`bundle directory not found: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  if (!files.length) throw new Error(`no .js chunks in ${dir} — did the build run?`);
  return files.map(f => path.join(dir, f));
}

// Scans every chunk, not just the App chunk. manualChunks in vite.config.js can
// move code between chunks without anyone editing it, and a marker landing in a
// different chunk is a moved string, not a missing one.
function check(dir) {
  const markers = loadMarkers();
  const chunks = jsChunks(dir);
  const found = new Map(markers.map(m => [m, []]));

  for (const file of chunks) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of markers) {
      if (text.includes(m)) found.get(m).push(path.basename(file));
    }
  }

  const missing = markers.filter(m => found.get(m).length === 0);
  return { markers, chunks, found, missing };
}

function main(argv) {
  const i = argv.indexOf('--dir');
  const dir = i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(REPO, 'dist', 'assets');

  let result;
  try {
    result = check(dir);
  } catch (err) {
    console.error(`assert-bundle-markers: ${err.message}`);
    return 1;
  }

  const { markers, chunks, found, missing } = result;
  console.log(`assert-bundle-markers: ${markers.length} marker(s) against ${chunks.length} chunk(s) in ${dir}`);
  for (const m of markers) {
    const where = found.get(m);
    console.log(where.length ? `  ok      ${JSON.stringify(m)} -> ${where.join(', ')}` : `  MISSING ${JSON.stringify(m)}`);
  }

  if (missing.length) {
    console.error('');
    console.error(`assert-bundle-markers: ${missing.length} marker(s) did not survive the build.`);
    console.error('A marker present in src/ but absent here means the code emitting it is');
    console.error('UNREACHABLE and was tree-shaken — the component is defined but never');
    console.error('rendered. That is how #73 shipped its logic without its UI. Find the');
    console.error('render path, do not re-add the markup.');
    return 1;
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { check, loadMarkers };
