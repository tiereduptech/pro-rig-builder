// =============================================================================
//  fix-home-desc.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Shortens the home-page meta description in PageMeta.jsx from 175 chars to
//  ~135 chars so it doesn't truncate in Google SERPs.
// =============================================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join('src', 'PageMeta.jsx');
const NEW_DESC = "Build your PC with 3,950+ verified parts. Compare prices and specs side-by-side. Free PCPartPicker alternative with hardware scanner.";

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

// Replace ONLY the home page description, identified by the home key right
// before it. This is robust against later edits to other pages.
src = src.replace(
  /(home:\s*\{\s*[\s\S]*?desc:\s*)"[^"]*"/,
  `$1"${NEW_DESC}"`
);

if (src !== before) {
  fs.writeFileSync(FILE, src, 'utf8');
  console.log(`  ✓ Updated home description in ${FILE}`);
  console.log(`      "${NEW_DESC}"`);
  console.log(`      (${NEW_DESC.length} chars)`);
} else {
  console.log('  – Home description not found or already short. Inspect manually.');
}
