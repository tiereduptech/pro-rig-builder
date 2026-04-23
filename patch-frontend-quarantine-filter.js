#!/usr/bin/env node
/**
 * patch-frontend-quarantine-filter.js
 *
 * Adds `.filter(p => !p.needsReview)` to the main PARTS access points in
 * App.jsx and UpgradePage.jsx so quarantined products are hidden from users.
 *
 * Safe to re-run.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function patchFile(path, changes) {
  let src = readFileSync(path, 'utf8');
  const original = src;
  let applied = 0;
  for (const { name, find, replace, check } of changes) {
    if (check && src.includes(check)) {
      console.log(`  - ${name}: already patched, skipping`);
      continue;
    }
    if (!src.includes(find)) {
      console.log(`  ! ${name}: anchor not found`);
      continue;
    }
    src = src.replace(find, replace);
    console.log(`  + ${name}`);
    applied++;
  }
  if (src !== original) writeFileSync(path, src);
  return applied;
}

// ─── UpgradePage.jsx: filter PARTS at the import point ───
console.log('Patching UpgradePage.jsx...');
patchFile('./src/UpgradePage.jsx', [
  {
    name: 'Filter PARTS array on import',
    check: 'ACTIVE_PARTS',
    find: 'import { PARTS } from "./data/parts.js";',
    replace: `import { PARTS as RAW_PARTS } from "./data/parts.js";
// Hide quarantined products (failed ASIN verification) from all recommendations
const PARTS = RAW_PARTS.filter(p => !p.needsReview);
const ACTIVE_PARTS = PARTS;`
  }
]);

// ─── App.jsx: filter SEED_PARTS at the import point ───
console.log('\nPatching App.jsx...');
patchFile('./src/App.jsx', [
  {
    name: 'Filter SEED_PARTS array on import',
    check: 'ACTIVE_SEED_PARTS',
    find: 'import { PARTS as SEED_PARTS } from "./data/parts.js";',
    replace: `import { PARTS as RAW_SEED_PARTS } from "./data/parts.js";
// Hide quarantined products from browse/builder/search
const SEED_PARTS = RAW_SEED_PARTS.filter(p => !p.needsReview);
const ACTIVE_SEED_PARTS = SEED_PARTS;`
  }
]);

console.log('\n✓ Frontend quarantine filter installed.');
console.log('Products with needsReview=true will now be hidden from users.');
