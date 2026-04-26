// =============================================================================
//  fix-duplicate-meta.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Removes static <meta name="description"> and <link rel="canonical"> from
//  index.html so they don't duplicate with the per-page versions injected by
//  react-helmet during pre-rendering.
//
//  Why duplicates happened:
//    Pre-rendering captures both the static template tags AND the helmet-
//    injected tags. Result: 2 description tags + 2 canonical tags in every
//    pre-rendered HTML. Bing flags this as an error.
//
//  Why this fix is safe:
//    Every page (pre-rendered or SPA-fallback) has helmet running and
//    injecting its own description + canonical. The static ones in
//    index.html were only there as a fallback for the original SPA shell —
//    no longer needed now that helmet is always present.
// =============================================================================

const fs = require('fs');

const FILE = 'index.html';
let html = fs.readFileSync(FILE, 'utf8');
const before = html;

let removedDesc = 0;
let removedCanonical = 0;

// Strip <meta name="description" content="..."> (any whitespace, attribute order).
html = html.replace(/\s*<meta\s+name=["']description["'][^>]*>/gi, () => {
  removedDesc++;
  return '';
});

// Strip <link rel="canonical" href="...">.
html = html.replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, () => {
  removedCanonical++;
  return '';
});

if (html === before) {
  console.log('  – No static meta description or canonical found in index.html');
} else {
  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`  ✓ Removed ${removedDesc} <meta name="description"> tag(s)`);
  console.log(`  ✓ Removed ${removedCanonical} <link rel="canonical"> tag(s)`);
  console.log('\n  react-helmet will inject the per-page versions during pre-render.');
  console.log('  Next: npm run build  →  node prerender-products.cjs --force  →  commit + push');
}
