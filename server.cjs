// =============================================================================
//  server.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Production static server with four pre-render layers:
//
//    1) PRODUCT pre-render:
//         /search?id=NNN → dist/search/id-NNN.html
//
//    2) CATEGORY pre-render (NEW):
//         /search?cat=GPU → dist/search/cat-GPU.html
//         (only when there's NO ?id= — id always wins)
//
//    3) ROUTE pre-render:
//         /search → dist/search/index.html
//
//    4) Static assets + SPA fallback.
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const DIST = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DIST)) {
  console.error(`  ✗ dist/ not found at ${DIST}`);
  process.exit(1);
}

const ASSET_RE = /\.[a-z0-9]{1,5}(?:\?|$)/i;

// ─── Layer 1: Per-product pre-rendered HTML ─────────────────────────────────
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

// ─── Layer 2: Per-category pre-rendered HTML ────────────────────────────────
// Matches /search?cat=X when no id is present. Category names are restricted
// to alphanumeric so no path traversal possible.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path !== '/search') return next();
  if (req.query.id) return next();  // id-based requests handled in layer 1

  const cat = req.query.cat;
  if (!cat || !/^[A-Za-z]+$/.test(String(cat))) return next();

  const candidate = path.join(DIST, 'search', `cat-${cat}.html`);
  if (fs.existsSync(candidate)) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.setHeader('X-PreRender', 'category-hit');
    return res.sendFile(candidate);
  }
  return next();
});

// ─── Layer 3: Route pre-rendered HTML ───────────────────────────────────────
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

// ─── Layer 4: Static assets ─────────────────────────────────────────────────
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

// ─── Layer 5: SPA fallback ──────────────────────────────────────────────────
app.use((req, res) => {
  res.setHeader('X-PreRender', 'spa-fallback');
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`  Pro Rig Builder listening on :${PORT}`);
  console.log(`  Express ${require('express/package.json').version}`);
  console.log(`  Serving from ${DIST}`);

  const routes = ['search', 'builder', 'scanner', 'about', 'compare'];
  for (const r of routes) {
    const exists = fs.existsSync(path.join(DIST, r, 'index.html'));
    console.log(`  ${exists ? '✓' : '✗'} dist/${r}/index.html`);
  }

  const searchDir = path.join(DIST, 'search');
  if (fs.existsSync(searchDir)) {
    const files = fs.readdirSync(searchDir);
    const products = files.filter((f) => /^id-\w+\.html$/.test(f)).length;
    const categories = files.filter((f) => /^cat-\w+\.html$/.test(f)).length;
    console.log(`  ✓ ${products} pre-rendered product pages`);
    console.log(`  ✓ ${categories} pre-rendered category pages`);
  }
});
