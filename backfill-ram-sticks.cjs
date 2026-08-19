#!/usr/bin/env node
/**
 * backfill-ram-sticks.cjs — fill the stick count on RAM rows the old extractor
 * left blank.
 *
 * WHY THIS EXISTS
 * The ingest extractor matched one shape of kit notation — parenthesised
 * "(2 x 16GB)". Titles write it a dozen other ways, so rows ingested before the
 * fix carry no `sticks` at all. That is not a cosmetic gap: the RAM "Sticks"
 * filter is a check-list built from the values present, so a blank row is
 * absent from every bucket. The 1-stick bucket showed 5 rows.
 *
 * The extractor fix (ramSticks in catalog-classify.cjs) only helps rows ingested
 * from now on. This pass re-reads the titles already in the catalog with the
 * same function, so ingest and backfill can never disagree about what a title
 * means — there is one implementation of the rules, not two.
 *
 * WHAT IT WILL NOT DO
 *   - It does not guess. ramSticks returns null for a title with no kit
 *     evidence, and those rows stay blank. The largest such class is "a single
 *     capacity with no kit notation" ("16GB DDR4 3200 UDIMM"), which usually
 *     means one module — usually is not evidence, and a wrong count silently
 *     breaks the build compatibility check (RAM sticks vs mobo ramSlots). Those
 *     rows are counted and listed in the report, not stamped.
 *   - It does not overwrite an existing count. Rows that already have `sticks`
 *     are only CHECKED: if ramSticks reads the title differently, that is
 *     reported as a disagreement for a human, and nothing is written.
 *   - It refuses a count that contradicts the row's own capacity. If `cap` is
 *     present and cap % sticks !== 0, the title is telling us two different
 *     things and we believe neither.
 *
 * Run:
 *   node backfill-ram-sticks.cjs              (dry run — default)
 *   node backfill-ram-sticks.cjs --apply
 */

const fs = require('fs');
const path = require('path');
const { ramSticks } = require('./catalog-classify.cjs');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const REPORT = path.join(ROOT, 'verify-reports', `ram-sticks-backfill-${new Date().toISOString().slice(0, 10)}.json`);

const APPLY = process.argv.includes('--apply');

// The class we deliberately leave blank — recorded so the report can say how
// much of the remaining gap is "no evidence" versus "evidence we cannot read".
const bareCapacity = (t) => /\b\d{1,3}\s*GB\b/i.test(t || '') && !/\b(kit|pack|module|stick|dimm\s*x)\b/i.test(t || '');

(async () => {
  const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }
  const loadedCount = parts.length;
  console.log(`Loaded ${loadedCount} products\n`);

  const ram = parts.filter((p) => p.c === 'RAM');
  const visible = ram.filter((p) => !p.needsReview && !p.bundle);
  const has = (p) => p.sticks !== undefined && p.sticks !== null && p.sticks !== '';

  const stamped = [], disagreements = [], contradictions = [], stillBlank = [];

  for (const p of ram) {
    const read = ramSticks(p.n);

    if (has(p)) {
      // Never overwrite. Only check that the two readings agree.
      if (read != null && read !== p.sticks) {
        disagreements.push({ id: p.id, name: p.n, stored: p.sticks, titleSays: read, cap: p.cap ?? null });
      }
      continue;
    }

    if (read == null) {
      stillBlank.push({ id: p.id, name: p.n, cap: p.cap ?? null, reason: bareCapacity(p.n) ? 'bare-capacity-no-kit-notation' : 'no-readable-evidence' });
      continue;
    }

    // The row's own capacity must be divisible by the count, or the title is
    // making two claims that cannot both be true.
    if (typeof p.cap === 'number' && p.cap > 0 && p.cap % read !== 0) {
      contradictions.push({ id: p.id, name: p.n, titleSays: read, cap: p.cap });
      continue;
    }

    stamped.push({ id: p.id, name: p.n, sticks: read, cap: p.cap ?? null, visible: !p.needsReview && !p.bundle, _part: p });
  }

  const visibleBefore = visible.filter(has).length;
  const visibleStamped = stamped.filter((s) => s.visible).length;

  console.log(`RAM rows: ${ram.length} total, ${visible.length} visible (not needsReview/bundle)`);
  console.log(`  visible with a stick count before: ${visibleBefore} (${(visibleBefore / visible.length * 100).toFixed(0)}%)`);
  console.log(`  would stamp:                       ${stamped.length} rows (${visibleStamped} of them visible)`);
  console.log(`  visible with a stick count after:  ${visibleBefore + visibleStamped} (${((visibleBefore + visibleStamped) / visible.length * 100).toFixed(0)}%)\n`);

  const buckets = {};
  for (const s of stamped) buckets[s.sticks] = (buckets[s.sticks] || 0) + 1;
  console.log('  new counts by bucket: ' + Object.entries(buckets).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x: ${v}`).join('  ') + '\n');

  if (disagreements.length) {
    console.log(`⚠  ${disagreements.length} row(s) already carry a count the title reads differently — NOT touched, listed for review:`);
    for (const d of disagreements.slice(0, 15)) console.log(`     [${d.id}] stored ${d.stored}, title says ${d.titleSays} — ${d.name.slice(0, 90)}`);
    if (disagreements.length > 15) console.log(`     … and ${disagreements.length - 15} more (full list in the report)`);
    console.log('');
  }
  if (contradictions.length) {
    console.log(`⚠  ${contradictions.length} row(s) where the title's count does not divide the row's capacity — left blank:`);
    for (const c of contradictions.slice(0, 10)) console.log(`     [${c.id}] ${c.titleSays} sticks vs cap ${c.cap}GB — ${c.name.slice(0, 80)}`);
    console.log('');
  }

  const byReason = stillBlank.reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
  console.log(`  still blank after this pass: ${stillBlank.length} — ${Object.entries(byReason).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  for (const s of stamped) s._part.sticks = s.sticks;

  await writeCatalog(parts, { loadedCount, reason: `backfill RAM stick counts (${stamped.length} rows)` });

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({
    appliedAt: new Date().toISOString(),
    source: 'ramSticks() in catalog-classify.cjs — the same function the ingest path uses',
    ramRows: ram.length,
    visibleRows: visible.length,
    visibleCoverageBefore: visibleBefore,
    visibleCoverageAfter: visibleBefore + visibleStamped,
    stamped: stamped.map(({ _part, ...s }) => s),
    disagreements,
    contradictions,
    stillBlank,
  }, null, 2), 'utf8');
  console.log(`\nWrote ${stamped.length} stick counts. Report: ${path.relative(ROOT, REPORT)}`);
})().catch((e) => { console.error(e); process.exit(1); });
