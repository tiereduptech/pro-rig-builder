// =============================================================================
//  fix-static-desc.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Updates the static <meta name="description"> in index.html (the SPA shell
//  template) to a 133-char version. This becomes the fallback description
//  for any route not pre-rendered or not handled by PageMeta. Pre-rendered
//  routes still get their per-page description from react-helmet.
// =============================================================================

const fs = require('fs');

const FILE = 'index.html';
const NEW_DESC = "Build your PC with 3,950+ verified parts. Compare prices and specs side-by-side. Free PCPartPicker alternative with hardware scanner.";

let html = fs.readFileSync(FILE, 'utf8');
const before = html;

html = html.replace(
  /(<meta\s+name=["']description["']\s+content=)["'][^"']*["']/i,
  `$1"${NEW_DESC}"`
);

if (html !== before) {
  fs.writeFileSync(FILE, html, 'utf8');
  console.log(`  ✓ Updated <meta name="description"> in ${FILE}`);
  console.log(`      "${NEW_DESC}"`);
  console.log(`      (${NEW_DESC.length} chars)`);
} else {
  console.log('  – No <meta name="description"> found or already short.');
}
