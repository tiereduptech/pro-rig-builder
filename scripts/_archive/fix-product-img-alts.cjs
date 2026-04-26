// =============================================================================
//  fix-product-img-alts.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Walks every <img> tag in App.jsx and:
//    1) If src={p.img} (or similar product-image pattern) AND alt is empty
//       → replaces with alt={`${p.n}${p.c ? ' ' + p.c : ''}`}
//    2) If alt={p.n} (basic product name alt) → upgrades to include category
//
//  Why this matters:
//    Google Images uses alt text as a primary ranking signal. Empty alts on
//    3,950 product images = 3,950 missed image-search ranking opportunities.
//    Descriptive alts (e.g., "Samsung 990 Pro 2TB Storage") rank well for
//    both product searches and image searches.
//
//  Idempotent — safe to re-run.
// =============================================================================

const fs = require('fs');
const path = require('path');

const APP = path.join('src', 'App.jsx');
let src = fs.readFileSync(APP, 'utf8');
const before = src;

// The dynamic alt expression we want everywhere a product image is rendered.
// Uses template literal with safe fallbacks: name first (most SEO weight),
// then category. Skips appending category if it's missing.
const NEW_ALT = "alt={`${p.n}${p.c ? ' ' + p.c : ''}`}";

let emptyFixed = 0;
let upgraded = 0;

// Process each <img ... /> tag individually. Multiline-safe via /s flag.
src = src.replace(/<img\b[^>]*?\/?>/gs, (tag) => {
  // Only target tags whose src looks like a product image. Catches both
  // src={p.img} and src={p.img.replace(...)}.
  const isProductImg = /\bsrc=\{[^}]*\bp\.img\b/.test(tag);
  if (!isProductImg) return tag;

  // Case 1: empty alt → upgrade.
  if (/\balt=""/.test(tag)) {
    emptyFixed++;
    return tag.replace(/\balt=""/, NEW_ALT);
  }

  // Case 2: alt={p.n} (basic name only) → upgrade to include category.
  if (/\balt=\{p\.n\}/.test(tag)) {
    upgraded++;
    return tag.replace(/\balt=\{p\.n\}/, NEW_ALT);
  }

  return tag;
});

if (src === before) {
  console.log('  – No product-image alt changes needed (already good or already patched)');
} else {
  fs.writeFileSync(APP, src, 'utf8');
  console.log(`  ✓ Updated product image alts in ${APP}`);
  if (emptyFixed > 0) console.log(`      Filled ${emptyFixed} empty alts`);
  if (upgraded > 0) console.log(`      Upgraded ${upgraded} alts (added category)`);
  console.log('\n  Re-run audit to verify:');
  console.log('    node audit-image-alts.cjs');
}
