// =============================================================================
//  server.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Production static server for Pro Rig Builder. Compatible with Express 4
//  and 5 (Express 5 removed the `*` wildcard, so we use middleware fallback
//  via app.use instead of app.get('*', handler)).
//
//  Routing logic:
//    1) If the request path maps to a real file in dist/ → serve it.
//       /assets/index.js → dist/assets/index.js
//    2) If the request path is a directory with index.html → serve that.
//       /search → dist/search/index.html  (PRE-RENDERED PAGE)
//    3) Otherwise → SPA fallback to dist/index.html.
//       /search?cat=GPU&id=30345 → matches step 2 (path is /search)
//       /unknown-future-route   → falls through to root index.html
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DIST)) {
  console.error('  ✗ dist/ not found at', DIST);
  console.error('    Run `npm run build` and commit dist/ before deploying.');
  process.exit(1);
}

// Step 1 + 2: serve real files and directory-index lookups.
//   index: 'index.html'  → /search resolves to /search/index.html when present
//   extensions: ['html'] → /privacy resolves to /privacy.html as fallback
//   fallthrough: true    → if neither matches, hand off to the next middleware
app.use(
  express.static(DIST, {
    index: 'index.html',
    extensions: ['html'],
    fallthrough: true,
    setHeaders: (res, filePath) => {
      // HTML is uncached so deploys propagate immediately. Hashed assets
      // (Vite content-hashes them) get a 1-year immutable cache.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      } else if (/\.(js|css|woff2?|png|jpg|svg|webp)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// Step 3: SPA fallback. Using `app.use` (middleware) instead of `app.get('*')`
// because Express 5 removed the `*` wildcard pattern.
app.use((req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`  Pro Rig Builder listening on :${PORT}`);
  console.log(`  Serving from ${DIST}`);

  // Boot-time sanity log — confirms pre-rendered routes are present.
  const routes = ['search', 'builder', 'scanner', 'about', 'compare'];
  for (const r of routes) {
    const exists = fs.existsSync(path.join(DIST, r, 'index.html'));
    console.log(`  ${exists ? '✓' : '✗'} dist/${r}/index.html`);
  }
});
