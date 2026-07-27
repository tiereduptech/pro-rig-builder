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

// Product-detail URL: a SINGLE slug segment ending in "-<id>". Deliberately
// strict ([^/]+, not .*) so it matches ONLY product pages — never /parts/<cat>
// (category index) or /parts/<cat>/browse/page-N (browse), both of which rely
// on the Layer-5 SPA fallback and must keep their 200.
const PRODUCT_RE = /^\/parts\/[^/]+\/[^/]+-\d+\/?$/;

// Deleted-product redirect map. 410 is the default for any missing product URL;
// this file holds 301 exceptions only. Loaded once; missing/bad file → all-410.
let REDIRECTS = {};
try {
  REDIRECTS = require('./product-redirects.json');
} catch (e) {
  console.warn(`  ⚠ product-redirects.json not loaded (${e.code || e.message}) — missing products will 410`);
}

// 410 "Gone" shell. Built once from the SPA shell, but with the indexable
// robots directives stripped and a single noindex forced in — a 410 must never
// advertise itself as indexable. The googlebot/bingbot metas are removed too:
// a leftover `googlebot: index` would override a generic `robots: noindex`.
// The prerendered <link rel="canonical"> (react-helmet, → site root) is also
// stripped: a canonical is an "index this" directive, contradictory on a Gone
// page. Remaining og:* point at the site root, not the dead URL.
let GONE_SHELL;
try {
  GONE_SHELL = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace(/\s*<meta name="(?:robots|googlebot|bingbot)"[^>]*>/gi, '')
    .replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '')
    .replace(/<head>/i, '<head>\n    <meta name="robots" content="noindex">');
} catch (e) {
  GONE_SHELL = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="robots" content="noindex">'
    + '<title>Product Not Found — Pro Rig Builder</title></head>'
    + '<body><h1>Product Not Found</h1></body></html>';
}

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

// ─── Layer 4.5: Deleted-product 301 / 410 (SEO — kills soft-404s) ────────────
// Scoped to PRODUCT_RE only. If a product URL reaches here, Layer 3 found no
// prerendered file, so the product is gone. 301 to its true equivalent if
// mapped, else 410 Gone. Non-product routes (category index, browse, /search,
// top-level pages) never match PRODUCT_RE, so they fall through to the SPA
// fallback below unchanged.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!PRODUCT_RE.test(req.path)) return next();

  const key = req.path.replace(/\/$/, '');   // normalize trailing slash
  const target = REDIRECTS[key];
  if (target) {
    res.setHeader('X-PreRender', 'gone-301');
    return res.redirect(301, target);
  }
  // Gone with no equivalent: 410 status + a noindex shell so the client still
  // renders its "Product Not Found" screen for humans, while crawlers get an
  // unambiguous de-index signal (X-Robots-Tag header + noindex meta, no
  // indexable robots directive, no canonical/og pointing at the dead URL).
  res.status(410);
  res.setHeader('X-PreRender', 'gone-410');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(GONE_SHELL);
});

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
