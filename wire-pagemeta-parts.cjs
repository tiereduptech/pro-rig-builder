// =============================================================================
//  wire-pagemeta-parts.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Adds parts={parts} to the <PageMeta /> call in App.jsx so PageMeta can
//  do URL-based product lookups for /search?id=X. Idempotent.
//
//  Also verifies parts.js is imported in App.jsx, since PageMeta needs the
//  parts array. Most repos import it as `import { parts } from "./data/parts.js"`.
// =============================================================================

const fs = require('fs');
const path = require('path');

const APP = path.join('src', 'App.jsx');
let src = fs.readFileSync(APP, 'utf8');
const before = src;

// 1) Verify parts is imported. Look for several common variable names.
const importRe = /import\s*\{[^}]*\bparts\b[^}]*\}\s*from\s*["']\.\/data\/parts(?:\.js)?["']/;
if (!importRe.test(src)) {
  console.log('  ⚠ Could not detect `import { parts }` from data/parts.js in App.jsx.');
  console.log('    Verify manually that App.jsx has: import { parts } from "./data/parts.js"');
  console.log('    Continuing anyway — assuming the import exists under a different alias.');
} else {
  console.log('  ✓ parts.js import detected in App.jsx');
}

// 2) Add parts={parts} to PageMeta call. Match the existing call exactly so
//    we don't accidentally duplicate the prop.
if (/<PageMeta\b[^/>]*\bparts=\{parts\}/.test(src)) {
  console.log('  – <PageMeta> already passes parts');
} else {
  const replaced = src.replace(
    /<PageMeta\s+page=\{page\}\s+category=\{bc\}\s*\/>/,
    '<PageMeta page={page} category={bc} parts={parts} />'
  );
  if (replaced !== src) {
    src = replaced;
    fs.writeFileSync(APP, src, 'utf8');
    console.log('  ✓ Added parts={parts} to <PageMeta> in App.jsx');
  } else {
    console.log('  ⚠ Could not find existing `<PageMeta page={page} category={bc} />` call.');
    console.log('    Edit App.jsx manually:');
    console.log('       <PageMeta page={page} category={bc} parts={parts} />');
  }
}

if (src !== before) {
  console.log('\n  Next:');
  console.log('    npm run build           # rebuild + prerender');
  console.log('    node seo-audit.cjs      # verify clean');
  console.log('    git add -A && git commit -m "SEO: per-product schema + URL-based product detection"');
  console.log('    git push');
}
