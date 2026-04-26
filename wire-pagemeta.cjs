// =============================================================================
//  wire-pagemeta.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  One-shot wiring script. Adds the PageMeta import and component usage to
//  src/App.jsx automatically. Idempotent — safe to run twice.
//
//  Run from rigfinder root:
//    node wire-pagemeta.cjs
// =============================================================================

const fs = require('fs');
const path = require('path');

const APP = path.join('src', 'App.jsx');

if (!fs.existsSync(APP)) {
  console.error(`✗ ${APP} not found. Run from rigfinder root.`);
  process.exit(1);
}

let src = fs.readFileSync(APP, 'utf8');
const before = src;
let changes = 0;

// 1) Add import (place right after the existing react-helmet-async import).
if (!src.includes('PageMeta')) {
  const importLine = 'import PageMeta from "./PageMeta.jsx";\n';
  const helmetImport = /import\s*\{\s*Helmet\s*\}\s*from\s*["']react-helmet-async["'];?\s*;?\s*\n/;
  if (helmetImport.test(src)) {
    src = src.replace(helmetImport, (m) => m + importLine);
    changes++;
    console.log('  ✓ Added PageMeta import');
  } else {
    console.error('  ✗ Could not find react-helmet-async import. Add manually:');
    console.error('     import PageMeta from "./PageMeta.jsx";');
  }
} else {
  console.log('  – PageMeta import already present');
}

// 2) Inject <PageMeta /> into the main render. Place it right after <style>{css}</style>.
if (!src.includes('<PageMeta')) {
  const styleMarker = '<style>{css}</style>';
  const idx = src.indexOf(styleMarker);
  if (idx !== -1) {
    const insertAt = idx + styleMarker.length;
    src = src.slice(0, insertAt) + '<PageMeta page={page} category={bc} />' + src.slice(insertAt);
    changes++;
    console.log('  ✓ Injected <PageMeta page={page} category={bc} />');
  } else {
    console.error('  ✗ Could not find <style>{css}</style> anchor. Add manually:');
    console.error('     <PageMeta page={page} category={bc} />');
  }
} else {
  console.log('  – <PageMeta> usage already present');
}

if (src !== before) {
  fs.writeFileSync(APP, src, 'utf8');
  console.log(`\n  Saved ${APP} (${changes} change${changes === 1 ? '' : 's'})`);
} else {
  console.log('\n  No changes needed.');
}
