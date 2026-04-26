// =============================================================================
//  wire-build-and-fix-hash.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Two automated fixes:
//    1) Updates package.json so `npm run build` also runs prerender.cjs.
//       This means Railway will pre-render on every deploy.
//    2) Fixes the legacy href="#affiliate" link in App.jsx → href="/affiliate".
//
//  Idempotent — safe to run twice.
// =============================================================================

const fs = require('fs');
const path = require('path');

// ─── 1. package.json build script ────────────────────────────────────────────
const PKG = 'package.json';
const pj = JSON.parse(fs.readFileSync(PKG, 'utf8'));
pj.scripts = pj.scripts || {};

const buildCmd = pj.scripts.build || '';
if (/prerender/.test(buildCmd)) {
  console.log('  – build script already runs prerender');
} else {
  pj.scripts['build:fast'] = pj.scripts.build || 'vite build';
  pj.scripts.build = `${pj.scripts.build || 'vite build'} && node prerender.cjs`;
  fs.writeFileSync(PKG, JSON.stringify(pj, null, 2) + '\n', 'utf8');
  console.log(`  ✓ package.json updated:`);
  console.log(`      "build":      "${pj.scripts.build}"`);
  console.log(`      "build:fast": "${pj.scripts['build:fast']}"  (skip prerender)`);
}

// ─── 2. Fix the legacy href="#affiliate" link ────────────────────────────────
const APP = path.join('src', 'App.jsx');
let app = fs.readFileSync(APP, 'utf8');
const before = app;

// Match href="#affiliate" or href='#affiliate' — convert to "/affiliate".
// Use word boundary to avoid hitting things like "#affiliateProgram".
app = app.replace(/href=(["'])#affiliate\1/g, 'href=$1/affiliate$1');

if (app !== before) {
  fs.writeFileSync(APP, app, 'utf8');
  console.log('  ✓ Replaced href="#affiliate" → href="/affiliate" in App.jsx');
} else {
  console.log('  – No href="#affiliate" links found (already fixed)');
}

console.log('\n  Next:');
console.log('    npm run build           # builds + runs prerender');
console.log('    node seo-audit.cjs      # verify audit passes');
console.log('    git add -A && git commit -m "SEO: pre-render static pages, fix affiliate link"');
console.log('    git push                # Railway redeploys with pre-rendered HTML');
