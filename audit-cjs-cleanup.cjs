// =============================================================================
//  audit-cjs-cleanup.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Catalogs every .cjs file in repo root into 3 categories:
//    KEEP       — referenced by package.json scripts or imported by other code
//    UTILITY    — useful tools (audit, enrichment) we want to keep
//    ORPHAN     — appears to be a one-shot helper from past work, candidate
//                 for deletion or moving to /scripts/_archive/
//
//  Then writes:
//    - CLEANUP_PLAN.txt  — review-able list of categories and recommended
//                          action per file
//    - cleanup-cjs.ps1   — PowerShell script that moves orphans to
//                          /scripts/_archive/ on confirmation (no deletes)
//
//  Run safely:
//    node audit-cjs-cleanup.cjs            # generates plan + script
//    .\cleanup-cjs.ps1                     # archives orphans
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const ARCHIVE_DIR = path.join('scripts', '_archive');
const PLAN_FILE = 'CLEANUP_PLAN.txt';
const PS_SCRIPT = 'cleanup-cjs.ps1';

// ─── Active scripts (always KEEP) ───────────────────────────────────────────
// These are core tooling we use regularly or that the build/deploy pipeline
// depends on. Update this list when adding permanent scripts.
const KEEP_LIST = new Set([
  'prerender.cjs',
  'prerender-products.cjs',
  'prerender-products-fast.cjs',
  'server.cjs',
  'seo-audit.cjs',
  'audit-spec-coverage.cjs',
  'audit-image-alts.cjs',
  'audit-cjs-cleanup.cjs',  // this script itself
  'submit-for-indexing.cjs',
  'generate-image-sitemap.cjs',
  'verify-catalog-asins.cjs',
  'normalize-product-name.cjs',
  'seed-asin-overrides.cjs',
  'repair-broken-asins.cjs',
  'enrich-from-dataforseo.cjs',
  'enrich-from-dataforseo-v2.cjs',
  'enrich-from-bb-details.cjs',
  'enrich-from-bb-details-v2.cjs',
  'enrich-cpu-specs.cjs',
  'enrich-gpu-clocks-pcie.cjs',
  'enrich-gpu-length.cjs',
  'enrich-monitor-specs.cjs',
  'enrich-psu-specs.cjs',
  'enrich-ram-specs.cjs',
  'enrich-cooler-specs.cjs',
  'enrich-cooler-cfm.cjs',
  'enrich-fan-specs.cjs',
  'enrich-case-specs.cjs',
  'enrich-accessory-specs.cjs',
  'apply-enrichments.cjs',
  'score-accessory-bench.cjs',
  'score-accessory-bench-v2.cjs',
  'score-case-bench.cjs',
  'score-cooler-fan-bench.cjs',
  'score-cpucooler-bench-v2.cjs',
  'score-monitor-bench.cjs',
  'score-motherboard-bench.cjs',
  'score-storage-bench.cjs',
  'generate-seo-files.cjs',
]);

// ─── Patterns that suggest one-shot work (likely ORPHANS) ───────────────────
// fix-*.cjs, wire-*.cjs, diagnose-*.cjs, test-*.cjs, inspect-*.cjs etc.
const ORPHAN_PATTERNS = [
  /^fix-/,         // one-shot fixes
  /^wire-/,        // one-shot wiring scripts
  /^diagnose-/,    // one-shot diagnostics
  /^inspect-/,     // one-shot inspection
  /^test-/,        // ad-hoc tests
  /^check-/,       // ad-hoc checks
  /^drain-/,       // ad-hoc queue drains
  /^find-/,        // ad-hoc lookups
  /^merge-/,       // one-shot merges
  /^add-/,         // one-shot adds
  /^auto-fix-/,    // one-shot fixes
  /^recheck-/,     // ad-hoc rechecks
  /^validate-/,    // ad-hoc validation
  /^dump-/,        // dump scripts
  /^clean-/,
  /^curate-/,
  /^dedupe-/,
  /^fetch-/,
  /^import-/,
  /^migrate-/,
  /^patch-/,
  /^prepend-/,
  /^regenerate-/,
  /^remove-/,
  /^tune-/,
  /^upgrade-/,
  /^apply-/,
  /^value-/,
  /^enrich-mobo-from-dataforseo/,
];

function isOrphan(name) {
  return ORPHAN_PATTERNS.some((p) => p.test(name));
}

// ─── Find every .cjs in repo root (not subdirs, not archives) ───────────────
const allCjs = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.cjs'))
  .filter((f) => fs.statSync(path.join(ROOT, f)).isFile())
  .sort();

// ─── Check if a file is referenced from package.json or other code ──────────
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const scriptsBlob = JSON.stringify(pkg.scripts || {});
function referencedInPackageJson(name) {
  return scriptsBlob.includes(name);
}

// ─── Categorize ─────────────────────────────────────────────────────────────
const categorized = { keep: [], utility: [], orphan: [] };

for (const name of allCjs) {
  const stat = fs.statSync(path.join(ROOT, name));
  const sizeKB = (stat.size / 1024).toFixed(1);
  const mtime = stat.mtime.toISOString().slice(0, 10);
  const entry = { name, sizeKB, mtime };

  if (KEEP_LIST.has(name) || referencedInPackageJson(name)) {
    categorized.keep.push(entry);
  } else if (isOrphan(name)) {
    categorized.orphan.push(entry);
  } else {
    categorized.utility.push(entry);
  }
}

// ─── Output report ──────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', dim: '\x1b[90m', good: '\x1b[92m', mid: '\x1b[93m', bad: '\x1b[91m' };

console.log(`\n  .cjs Cleanup Audit`);
console.log(`  ${C.dim}${allCjs.length} .cjs files in repo root${C.reset}\n`);
console.log(`  ${C.good}KEEP${C.reset}     ${categorized.keep.length}  (core tooling, referenced by build/deploy)`);
console.log(`  ${C.mid}REVIEW${C.reset}   ${categorized.utility.length}  (unmatched — needs manual decision)`);
console.log(`  ${C.bad}ARCHIVE${C.reset}  ${categorized.orphan.length}  (one-shot scripts — candidate for archive)\n`);

console.log(`  ${C.bad}ARCHIVE candidates (move to ${ARCHIVE_DIR}/):${C.reset}`);
for (const f of categorized.orphan) {
  console.log(`    ${f.name.padEnd(40)} ${C.dim}${f.sizeKB.padStart(7)} kB  ${f.mtime}${C.reset}`);
}
console.log('');

if (categorized.utility.length > 0) {
  console.log(`  ${C.mid}REVIEW (unclassified):${C.reset}`);
  for (const f of categorized.utility) {
    console.log(`    ${f.name.padEnd(40)} ${C.dim}${f.sizeKB.padStart(7)} kB  ${f.mtime}${C.reset}`);
  }
  console.log('');
}

// ─── Write the cleanup plan file ────────────────────────────────────────────
const plan = [];
plan.push('# .cjs Cleanup Plan');
plan.push(`# Generated: ${new Date().toISOString()}`);
plan.push(`# Total: ${allCjs.length} .cjs files in repo root`);
plan.push('');
plan.push('## KEEP (core tooling, will not be archived)');
for (const f of categorized.keep) plan.push(`  ${f.name}`);
plan.push('');
plan.push('## REVIEW (unclassified — neither in keep list nor matching orphan pattern)');
for (const f of categorized.utility) plan.push(`  ${f.name}`);
plan.push('');
plan.push('## ARCHIVE (one-shot scripts — will move to scripts/_archive/)');
for (const f of categorized.orphan) plan.push(`  ${f.name}`);
plan.push('');
fs.writeFileSync(PLAN_FILE, plan.join('\n'));
console.log(`  ${C.good}✓${C.reset} Wrote ${PLAN_FILE}`);

// ─── Write the PowerShell archive script ────────────────────────────────────
const ps = [];
ps.push('# cleanup-cjs.ps1 — auto-generated by audit-cjs-cleanup.cjs');
ps.push('# Moves orphan .cjs files to scripts/_archive/ (does NOT delete).');
ps.push('# Review CLEANUP_PLAN.txt before running.');
ps.push('');
ps.push(`$archiveDir = "${ARCHIVE_DIR.replace(/\\/g, '\\\\')}"`);
ps.push('New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null');
ps.push('');
ps.push(`Write-Host "Archiving ${categorized.orphan.length} orphan .cjs files to $archiveDir/" -ForegroundColor Cyan`);
ps.push('');
for (const f of categorized.orphan) {
  ps.push(`Move-Item "${f.name}" $archiveDir -Force`);
}
ps.push('');
ps.push(`Write-Host "Done. Archived ${categorized.orphan.length} files." -ForegroundColor Green`);
fs.writeFileSync(PS_SCRIPT, ps.join('\r\n'));
console.log(`  ${C.good}✓${C.reset} Wrote ${PS_SCRIPT}`);
console.log('');
console.log('  Next:');
console.log(`    1. Review ${C.mid}${PLAN_FILE}${C.reset} — confirm which files to archive`);
console.log(`    2. Run ${C.mid}.\\${PS_SCRIPT}${C.reset} to move orphans to ${ARCHIVE_DIR}/`);
console.log(`    3. ${C.dim}git add -A && git commit -m "cleanup: archive orphan .cjs scripts"${C.reset}`);
console.log('');
