// =============================================================================
//  server.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Production static server with three pre-render layers:
//
//    1) PRODUCT pre-render (NEW):
//         /search?id=30345 → dist/search/id-30345.html (if exists)
//         Pre-rendered via prerender-products.cjs for top performers.
//
//    2) ROUTE pre-render:
//         /search → dist/search/index.html
//         /builder → dist/builder/index.html
//         Pre-rendered via prerender.cjs for the 16 static pages.
//
//    3) Static assets:
//         /assets/index-XXX.js → dist/assets/index-XXX.js
//         Vite-emitted JS/CSS/images.
//
//    4) SPA fallback:
//         Anything else → dist/index.html (the SPA shell).
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

// Asset paths get sent straight to express.static — no pre-render lookup.
const ASSET_RE = /\.[a-z0-9]{1,5}(?:\?|$)/i;

// ─── Layer 1: Per-product pre-rendered HTML ─────────────────────────────────
// Detects /search?id=NNN and serves dist/search/id-NNN.html when present.
// Falls through if no product file exists.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path !== '/search') return next();

  const id = req.query.id;
  if (!id || !/^\w+$/.test(String(id))) return next();

  const candidate = path.join(DIST, 'search', `id-${id}.html`);
  if (fs.existsSync(candidate)) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-PreRender', 'product-hit');
    return res.sendFile(candidate);
  }
  return next();
});

// ─── Layer 2: Route pre-rendered HTML ───────────────────────────────────────
// /search → dist/search/index.html, /about → dist/about/index.html, etc.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (ASSET_RE.test(req.path)) return next();

  const cleanPath = req.path.replace(/\/$/, '');
  const candidate = cleanPath
    ? path.join(DIST, cleanPath, 'index.html')
    : path.join(DIST, 'index.html');

  if (fs.existsSync(candidate)) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-PreRender', 'route-hit');
    return res.sendFile(candidate);
  }
  return next();
});

// ─── Layer 3: Static assets (JS/CSS/images/fonts/etc.) ──────────────────────
app.use(
  express.static(DIST, {
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (/\.(js|css|woff2?|png|jpg|svg|webp|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// ─── Layer 4: SPA fallback ──────────────────────────────────────────────────
app.use((req, res) => {
  res.setHeader('X-PreRender', 'spa-fallback');
  res.sendFile(path.join(DIST, 'index.html'));
});

// ─── Boot ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`  Pro Rig Builder listening on :${PORT}`);
  console.log(`  Express ${require('express/package.json').version}`);
  console.log(`  Serving from ${DIST}`);

  const routes = ['search', 'builder', 'scanner', 'about', 'compare'];
  for (const r of routes) {
    const exists = fs.existsSync(path.join(DIST, r, 'index.html'));
    console.log(`  ${exists ? '✓' : '✗'} dist/${r}/index.html`);
  }

  // Count product pre-renders.
  const searchDir = path.join(DIST, 'search');
  if (fs.existsSync(searchDir)) {
    const productFiles = fs.readdirSync(searchDir).filter((f) => /^id-\w+\.html$/.test(f));
    console.log(`  ✓ ${productFiles.length} pre-rendered product pages`);
  }
});
