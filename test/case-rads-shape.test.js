// Case.rads must be an array of integers, because that is the only shape the
// site can read.
//
// The AIO/Radiator Support filter in src/App.jsx is:
//
//   extract: p => { const arr = Array.isArray(p.rads) ? p.rads : []; if(!arr.length) return "None"; ... }
//
// Every other shape is silently bucketed as "None". A joined string like
// "240mm,360mm" therefore renders a 360mm-capable case as having no AIO support
// and drops it out of the filter entirely — a field that reads as coverage and
// is not. Worse, a coverage count keyed on truthiness counts it as filled, so
// the gap is hidden rather than reported: the 2026-08-19 case enrichment
// reported rads coverage of 383 while the filter could read 341.
//
// normalize-case-rads.js settled this shape once; the DataForSEO enrichment
// reintroduced strings on the 42 rows it wrote. This test is the guard that
// makes a third reintroduction fail in CI rather than on the site.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import PARTS from '../src/data/parts.js';
import { RAD_SIZES } from '../scripts/case-spec-parser.mjs';

const cases = PARTS.filter(p => p.c === 'Case');
const withRads = cases.filter(p => p.rads != null);

test('the catalog actually has Case rows carrying rads', () => {
  assert.ok(cases.length > 500, `only ${cases.length} Case rows — the fixture looks wrong`);
  assert.ok(withRads.length > 100, `only ${withRads.length} Case rows carry rads`);
});

test('every Case.rads is an array — the one shape the App.jsx filter reads', () => {
  const bad = withRads
    .filter(p => !Array.isArray(p.rads))
    .map(p => `${p.id} ${JSON.stringify(p.rads)} (${typeof p.rads})`);
  assert.deepEqual(bad, [], `these rads are invisible to the AIO filter:\n  ${bad.join('\n  ')}`);
});

test('every Case.rads entry is a positive integer, not "360mm"', () => {
  const bad = withRads
    .filter(p => Array.isArray(p.rads))
    .flatMap(p => p.rads.filter(v => !Number.isInteger(v) || v <= 0).map(v => `${p.id}: ${JSON.stringify(v)}`));
  assert.deepEqual(bad, [], `Math.max() over these yields NaN:\n  ${bad.join('\n  ')}`);
});

test('rads holds no duplicate sizes', () => {
  // Deliberately NOT asserting an order: plenty of pre-existing rows are
  // descending ([360,280,240]) and the filter takes Math.max(...arr), so order
  // never mattered. The writers emit ascending anyway.
  const duped = withRads
    .filter(p => Array.isArray(p.rads) && new Set(p.rads).size !== p.rads.length)
    .map(p => `${p.id}: ${JSON.stringify(p.rads)}`);
  assert.deepEqual(duped, [], `duplicate sizes:\n  ${duped.join('\n  ')}`);
});

test('every rads entry is a size radiators actually come in', () => {
  // Three Corsair 5000D rows carried 200 — the case's 200mm FAN mount read as a
  // radiator by rebuild-corsair-cases*.js (#38). max(120,140,200) is 200, which
  // clears none of the display thresholds, so all three product pages read
  // "AIO Support: 120mm only" for cases that take a 420mm radiator. A wrong size
  // does not just add noise; it drags the bucket down and inverts the answer.
  //
  // RAD_SIZES is imported, not redeclared, so the writers and this guard cannot
  // drift apart.
  const bad = withRads
    .filter(p => Array.isArray(p.rads))
    .flatMap(p => p.rads.filter(v => !RAD_SIZES.includes(v)).map(v => `${p.id}: ${v} (rads ${JSON.stringify(p.rads)})`));
  assert.deepEqual(bad, [], `no radiator is made in these sizes:\n  ${bad.join('\n  ')}`);
});

test('the filter buckets every rads-carrying Case somewhere other than "None"', () => {
  // Mirrors src/App.jsx exactly. If this ever returns "None" for a row that
  // declares radiator support, the field is not reaching the filter.
  const extract = (p) => {
    const arr = Array.isArray(p.rads) ? p.rads : [];
    if (!arr.length) return 'None';
    return 'Up to ' + Math.max(...arr) + 'mm';
  };
  const lost = withRads.filter(p => extract(p) === 'None').map(p => `${p.id} ${JSON.stringify(p.rads)}`);
  assert.deepEqual(lost, [], `declare radiator support but filter as "None":\n  ${lost.join('\n  ')}`);
});
