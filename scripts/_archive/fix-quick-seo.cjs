// =============================================================================
//  fix-quick-seo.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Two quick wins from the audit:
//    1) Adds a default <meta name="description"> to index.html so crawlers see
//       *something* even before react-helmet hydrates (per-page descriptions
//       still win post-hydration via PageMeta.jsx).
//    2) Locates the lone legacy href="#..." link so you can migrate it.
//
//  Idempotent — safe to run twice.
// =============================================================================

const fs = require('fs');
const path = require('path');

const INDEX = path.join('index.html');
const APP = path.join('src', 'App.jsx');

const DEFAULT_DESC = "Build your PC with 3,950+ verified parts. Live Amazon and Best Buy prices, free hardware scanner, and side-by-side comparisons. Free PCPartPicker alternative.";

// ─── 1. Add meta description to index.html ───────────────────────────────────
let html = fs.readFileSync(INDEX, 'utf8');
const orig = html;

if (/<meta\s+name=["']description["']/i.test(html)) {
  console.log('  – Meta description already present in index.html');
} else {
  // Insert right after <title> tag for proper meta order.
  const titleClose = html.indexOf('</title>');
  if (titleClose === -1) {
    console.error('  ✗ <title> tag not found in index.html — add description manually');
  } else {
    const insertAt = titleClose + '</title>'.length;
    const insert = `\n    <meta name="description" content="${DEFAULT_DESC}" />`;
    html = html.slice(0, insertAt) + insert + html.slice(insertAt);
    fs.writeFileSync(INDEX, html, 'utf8');
    console.log('  ✓ Added <meta name="description"> to index.html');
  }
}

// ─── 2. Locate the legacy hash link in App.jsx ───────────────────────────────
const app = fs.readFileSync(APP, 'utf8');
const lines = app.split('\n');
const hashes = [];
for (let i = 0; i < lines.length; i++) {
  const matches = [...lines[i].matchAll(/href=["']#([a-z][^"']*)["']/gi)];
  for (const m of matches) {
    hashes.push({ line: i + 1, href: '#' + m[1], context: lines[i].trim().slice(0, 100) });
  }
}

if (hashes.length === 0) {
  console.log('  – No legacy hash href links found in App.jsx');
} else {
  console.log(`\n  Legacy hash links to migrate (${hashes.length}):`);
  for (const h of hashes) {
    console.log(`    ${APP}:${h.line}  ${h.href}`);
    console.log(`      ${h.context}`);
  }
  console.log('\n  Migrate href="#path" → href="/path" so crawlers can follow the link.');
}

if (orig !== html) {
  console.log('\n  ✓ index.html updated. Re-run audit to verify.');
}
