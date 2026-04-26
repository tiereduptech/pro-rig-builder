// =============================================================================
//  fix-commit-dist.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Removes any dist/ entry from .gitignore so we can commit pre-rendered
//  build artifacts to git. Idempotent.
//
//  Why we commit dist/:
//    Puppeteer-based pre-rendering needs headless Chrome, which doesn't run
//    cleanly in Railway's nixpacks container. Cheapest reliable solution is to
//    pre-render locally and commit the artifacts. Vite's content-hashed
//    filenames keep diffs small.
// =============================================================================

const fs = require('fs');

const FILE = '.gitignore';
if (!fs.existsSync(FILE)) {
  console.log(`  – No ${FILE} to update`);
  process.exit(0);
}

const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const before = lines.length;

// Drop any line that matches `dist`, `dist/`, `/dist`, `/dist/`, etc.
// (with optional comments preserved).
const cleaned = lines.filter((line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return true;
  return !/^\/?dist\/?$/.test(trimmed);
});

if (cleaned.length === before) {
  console.log('  – dist/ not found in .gitignore — already committable');
} else {
  fs.writeFileSync(FILE, cleaned.join('\n'), 'utf8');
  console.log(`  ✓ Removed ${before - cleaned.length} dist/ entry from .gitignore`);
}
