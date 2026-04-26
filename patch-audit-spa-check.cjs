// =============================================================================
//  patch-audit-spa-check.cjs (v2 — forceful)
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Replaces the entire checkSpaRouting() block in seo-audit.cjs with a
//  version that recognizes server.cjs (custom Express SPA fallback) in
//  addition to `serve -s`. Idempotent.
// =============================================================================

const fs = require('fs');

const FILE = 'seo-audit.cjs';
let src = fs.readFileSync(FILE, 'utf8');

const newFn = `function checkSpaRouting() {
  const nixpacks = read(path.join(ROOT, 'nixpacks.toml')) || '';
  const railwayJson = read(path.join(ROOT, 'railway.json')) || '';
  const serverCjs = read(path.join(ROOT, 'server.cjs')) || '';
  if (serverCjs && /sendFile\\(.*index\\.html/.test(serverCjs)) {
    add('pass', 'SPA_SERVE', 'server.cjs handles SPA fallback (sends index.html for unmatched routes)');
    return;
  }
  if (/serve\\s+-s\\b/.test(nixpacks) || /serve\\s+-s\\b/.test(railwayJson)) {
    add('pass', 'SPA_SERVE', 'serve -s configured (SPA fallback to root index.html)');
    return;
  }
  add('warning', 'SPA_NO_FALLBACK', 'No SPA fallback config detected');
}`;

// Match the function from `function checkSpaRouting()` through its closing `}`
// at column 0 (the function-level brace). Greedy until first such close.
const re = /function\s+checkSpaRouting\s*\(\s*\)\s*\{[\s\S]*?\n\}/;

if (!re.test(src)) {
  console.log('  ✗ Could not locate checkSpaRouting() function in seo-audit.cjs');
  process.exit(1);
}

const before = src;
src = src.replace(re, newFn);

if (src === before) {
  console.log('  – No changes (function already matches new version)');
} else {
  fs.writeFileSync(FILE, src, 'utf8');
  console.log('  ✓ Replaced checkSpaRouting() in seo-audit.cjs');
  console.log('    The audit now recognizes server.cjs as a valid SPA fallback config.');
}
