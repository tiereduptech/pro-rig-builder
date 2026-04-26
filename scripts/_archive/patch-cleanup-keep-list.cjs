// =============================================================================
//  patch-cleanup-keep-list.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Adds the score-*-bench.cjs scripts and generate-seo-files.cjs to the
//  KEEP_LIST in audit-cjs-cleanup.cjs so they're not flagged for archive.
//  These are re-runnable utilities (recompute benchmark scores, regenerate
//  SEO assets) rather than one-shot fixes.
// =============================================================================

const fs = require('fs');

const FILE = 'audit-cjs-cleanup.cjs';
let src = fs.readFileSync(FILE, 'utf8');

const additions = [
  "  'score-accessory-bench.cjs',",
  "  'score-accessory-bench-v2.cjs',",
  "  'score-case-bench.cjs',",
  "  'score-cooler-fan-bench.cjs',",
  "  'score-cpucooler-bench-v2.cjs',",
  "  'score-monitor-bench.cjs',",
  "  'score-motherboard-bench.cjs',",
  "  'score-storage-bench.cjs',",
  "  'generate-seo-files.cjs',",
];

// Insert just before the closing `]);` of KEEP_LIST.
const marker = "  'apply-enrichments.cjs',";
if (!src.includes(marker)) {
  console.error('  ✗ Could not find anchor in KEEP_LIST');
  process.exit(1);
}

// Skip any that are already present.
const newAdditions = additions.filter((a) => !src.includes(a.trim().replace(/,$/, '')));
if (newAdditions.length === 0) {
  console.log('  – All entries already present');
  process.exit(0);
}

src = src.replace(marker, marker + '\n' + newAdditions.join('\n'));
fs.writeFileSync(FILE, src, 'utf8');
console.log(`  ✓ Added ${newAdditions.length} entries to KEEP_LIST in ${FILE}`);
console.log('  Re-run: node audit-cjs-cleanup.cjs');
