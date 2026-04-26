// =============================================================================
//  patch-cleanup-orphan-patterns.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Adds more prefix patterns to ORPHAN_PATTERNS so the remaining 29 one-shot
//  REVIEW files get classified as ARCHIVE candidates automatically.
// =============================================================================

const fs = require('fs');

const FILE = 'audit-cjs-cleanup.cjs';
let src = fs.readFileSync(FILE, 'utf8');

const newPatterns = [
  "  /^clean-/,",
  "  /^curate-/,",
  "  /^dedupe-/,",
  "  /^fetch-/,",
  "  /^import-/,",
  "  /^migrate-/,",
  "  /^patch-/,",
  "  /^prepend-/,",
  "  /^regenerate-/,",
  "  /^remove-/,",
  "  /^tune-/,",
  "  /^upgrade-/,",
  "  /^apply-/,",
  "  /^value-/,",
  "  /^enrich-mobo-from-dataforseo/,",  // failed approach
];

const marker = "  /^dump-/,        // dump scripts";
if (!src.includes(marker)) {
  console.error('  ✗ Could not find anchor in ORPHAN_PATTERNS');
  process.exit(1);
}

const additions = newPatterns.filter((p) => !src.includes(p.trim().replace(/,$/, '')));
if (additions.length === 0) {
  console.log('  – All patterns already present');
  process.exit(0);
}

src = src.replace(marker, marker + '\n' + additions.join('\n'));
fs.writeFileSync(FILE, src, 'utf8');
console.log(`  ✓ Added ${additions.length} orphan patterns`);
console.log('  Re-run: node audit-cjs-cleanup.cjs');
