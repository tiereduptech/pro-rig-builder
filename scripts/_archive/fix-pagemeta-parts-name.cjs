// =============================================================================
//  fix-pagemeta-parts-name.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Fix-up: the previous wire script assumed `parts` was the variable name in
//  App.jsx, but this codebase uses ACTIVE_SEED_PARTS. This script swaps the
//  reference. Idempotent — safe to run twice.
// =============================================================================

const fs = require('fs');
const path = require('path');

const APP = path.join('src', 'App.jsx');
let src = fs.readFileSync(APP, 'utf8');
const before = src;

// Replace parts={parts} with parts={ACTIVE_SEED_PARTS} on the PageMeta line.
src = src.replace(
  /<PageMeta\s+page=\{page\}\s+category=\{bc\}\s+parts=\{parts\}\s*\/>/,
  '<PageMeta page={page} category={bc} parts={ACTIVE_SEED_PARTS} />'
);

if (src !== before) {
  fs.writeFileSync(APP, src, 'utf8');
  console.log('  ✓ Fixed: parts={parts} → parts={ACTIVE_SEED_PARTS}');
} else {
  // Maybe already fixed, check.
  if (/<PageMeta[^/>]*parts=\{ACTIVE_SEED_PARTS\}/.test(src)) {
    console.log('  – Already using ACTIVE_SEED_PARTS — no change needed');
  } else {
    console.log('  ⚠ Could not find <PageMeta page={page} category={bc} parts={parts} /> to replace.');
    console.log('     Inspect manually around the main render.');
  }
}
