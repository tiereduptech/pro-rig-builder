// =============================================================================
//  server.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Production static server for Pro Rig Builder. Handles three cases in order:
//    1) Explicit pre-render lookup — for any non-asset path, check if a
//       pre-rendered HTML exists at dist/{path}/index.html and serve it.
//       This is the SEO-critical step.
//    2) express.static for assets (JS/CSS/images/etc.) under dist/.
//    3) SPA fallback to dist/index.html for unknown routes.
//
//  Why explicit middleware (step 1):
//    Express 5 + Express's static middleware can be inconsistent about
//    auto-resolving directory index.html files (especially with the
//    `extensions` option). Doing it explicitly removes that uncertainty.
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DIST)) {
  console.error(`  ✗ dist/ not found at ${DIST}`);
  console.error('    Build locally and commit dist/ before deploying.');
  process.exit(1);
}

// Identify request paths that look like assets (have extensions like .js, .css).
// These should skip the pre-render lookup and go straight to express.static.
const ASSET_RE = /\.[a-z0-9]{1,5}(?:\?|$)/i;

// ─── Step 1: Pre-rendered HTML lookup ───────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  // Asset requests (any path with a file extension) skip this step.
  if (ASSET_RE.test(req.path)) return next();

  const cleanPath = req.path.replace(/\/$/, '');  // strip trailing slash
  const candidate = cleanPath
    ? path.join(DIST, cleanPath, 'index.html')
    : path.join(DIST, 'index.html');

  if (fs.existsSync(candidate)) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-PreRender', 'hit');
    return res.sendFile(candidate);
  }

  return next();
});

// ─── Step 2: Static asset serving ───────────────────────────────────────────
app.use(
  express.static(DIST, {
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (/\.(js|css|woff2?|png|jpg|svg|webp|ico)$/i.test(filePath)) {
        // Vite content-hashes filenames, so 1-year immutable cache is safe.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// ─── Step 3: SPA fallback ───────────────────────────────────────────────────
app.use((req, res) => {
  res.setHeader('X-PreRender', 'fallback');
  res.sendFile(path.join(DIST, 'index.html'));
});

// ─── Boot ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`  Pro Rig Builder listening on :${PORT}`);
  console.log(`  Express ${require('express/package.json').version}`);
  console.log(`  Serving from ${DIST}`);

  const routes = ['search', 'builder', 'scanner', 'about', 'compare', 'tools', 'upgrade'];
  for (const r of routes) {
    const exists = fs.existsSync(path.join(DIST, r, 'index.html'));
    console.log(`  ${exists ? '✓' : '✗'} dist/${r}/index.html`);
  }
});
