// =============================================================================
//  server.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Production static server for Pro Rig Builder. Replaces `serve -s dist`,
//  which always falls back to root index.html instead of using pre-rendered
//  per-route HTML files.
//
//  Routing logic:
//    1) If the request path maps to a real file in dist/ → serve it.
//       /assets/index.js → dist/assets/index.js
//    2) If the request path is a directory with index.html → serve that.
//       /search → dist/search/index.html  (PRE-RENDERED PAGE)
//    3) Otherwise → SPA fallback to dist/index.html.
//       /search?cat=GPU&id=30345 → matches step 2 (path is /search)
//       /unknown-future-route   → falls through to root index.html
//
//  Why this matters for SEO:
//    Without this, all 16 pre-rendered route files (/search, /builder, etc.)
//    are unreachable — `serve -s` rewrites everything to root index.html, so
//    Bing/Twitter/LinkedIn never see the per-page meta tags.
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DIST)) {
  console.error('  ✗ dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

// Step 1 + 2: real files and directory-with-index.html lookup.
// `index: 'index.html'`     → /search resolves to /search/index.html when it exists
// `extensions: ['html']`    → /privacy resolves to /privacy.html as a fallback
// `fallthrough: true`       → if neither matches, pass to next handler (the SPA fallback)
app.use(
  express.static(DIST, {
    index: 'index.html',
    extensions: ['html'],
    fallthrough: true,
    // Cache hashed assets aggressively, but never cache HTML (so deploys
    // propagate immediately without users seeing stale content).
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      } else if (/\.(js|css|woff2?|png|jpg|svg|webp)$/i.test(filePath)) {
        // Vite emits content-hashed filenames, so 1-year cache is safe.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// Step 3: SPA fallback for routes not pre-rendered (e.g. future dynamic pages).
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`  Pro Rig Builder listening on :${PORT}`);
  console.log(`  Serving from ${DIST}`);
});
