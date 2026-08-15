// =============================================================================
//  functions/parts/[[path]].js
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  The Cloudflare Pages resolver. Port of server.cjs Layer 4.5 (301/410) and
//  Layer 5 (SPA fallback), and the direct counterpart of deploy/resolver.php on
//  the Epik stack.
//
//  Behavior, matching both of those exactly:
//    - the asset exists (prerendered page, any static file)  -> serve it
//    - product-shaped path (PRODUCT_RE), in the redirect map -> 301 Location
//    - product-shaped path, not mapped (deleted OR never existed) -> 410 + noindex
//    - anything else -> the SPA shell at 200
//
//  ── Scope: why [[path]] under /parts/ and not a root _middleware ────────────
//  A catch-all here makes wrangler emit _routes.json with include ["/parts/*"],
//  so ONLY /parts/ requests invoke the Worker. Every other route, and every
//  asset, is served by the static edge with no Worker in the path at all.
//
//  The cost is that all ~5.5k prerendered product pages do invoke it, since
//  "does this URL exist" is not answerable from a route pattern — the miss case
//  is defined by absence. The work on that path is one next() and a status
//  check, and _routes.json cannot exclude 5,484 individual pages (the exclude
//  list caps at 100 rules). A root _middleware.js would answer the same question
//  while putting a Worker in front of every asset on the site, which is strictly
//  worse. See deploy/DESIGN-cloudflare-pages.md §5.
//
//  ── PRODUCT_RE, REDIRECTS, SPA_HTML, GONE_HTML are GENERATED ────────────────
//  build-pages.cjs writes functions-lib/resolver-data.generated.js on every
//  deploy: PRODUCT_RE is copied verbatim out of server.cjs (never retyped, so
//  the product boundary cannot drift between the three stacks), REDIRECTS comes
//  from product-redirects.json, and the two shells are derived from the
//  dist/index.html being deployed in that same run.
//
//  If that file is missing the wrangler bundle fails at deploy time. That is
//  deliberate: the alternative failure — a resolver running against a stale
//  committed copy — is silent and costs organic traffic.
// =============================================================================

import {
  PRODUCT_RE,
  REDIRECTS,
  SPA_HTML,
  GONE_HTML,
} from '../../functions-lib/resolver-data.generated.js';

const HTML = 'text/html; charset=utf-8';

export async function onRequest(context) {
  const { request, next } = context;

  // server.cjs guards every resolver layer on the method; a POST to a product
  // URL is not a soft-404 question and must not be answered with a shell.
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();

  const url = new URL(request.url);

  // Ask the asset service first. This is the hot path: for the ~5.5k
  // prerendered product pages and the 9 prerendered category indexes it
  // returns the file and we hand it straight back untouched.
  //
  // THIS CALL ONLY RETURNS 404 BECAUSE dist/404.html EXISTS. Cloudflare's asset
  // service falls back to serving the root index.html at 200 for any unmatched
  // path when the tree has no 404.html, which would make the test below always
  // false and every branch past it dead code — a silent soft-404 on the whole
  // retired catalog. build-pages.cjs §4b writes that file and explains the
  // measurement. Do not remove it, and do not add a `/* /index.html 200` rule
  // to _redirects, which reintroduces the same thing by another route.
  const assetResponse = await next();

  // ── Trailing slash: serve the canonical form at 200 instead of redirecting ──
  // MEASURED with `wrangler pages dev`, 2026-08-15. Prerendered pages live at
  // <path>/index.html, and Cloudflare's asset service answers a request for
  // <path> with a 308 to <path>/. Express serves it at 200 and never redirects.
  //
  // That difference lands on every URL the site publishes. public/sitemap.xml
  // lists 5,519 URLs and exactly one — the root — ends in a slash; every
  // prerendered <link rel="canonical"> is likewise the unslashed form. So on a
  // stock Pages deploy every canonical URL 308s to a variant whose own canonical
  // tag points back at the URL just redirected away from. Search Console reads
  // that as "Page with redirect" across the whole sitemap.
  //
  // Cloudflare exposes no control for it: html_handling / drop-trailing-slash is
  // Workers-static-assets configuration and wrangler rejects an [assets] block in
  // a Pages project. So the redirect is intercepted here and the slashed asset is
  // returned under the requested URL. Scoped to exactly the "add a trailing
  // slash" case — any other redirect the asset service produces is passed
  // through untouched.
  if (assetResponse.status === 301 || assetResponse.status === 308) {
    const location = assetResponse.headers.get('Location');
    if (location === url.pathname + '/') {
      const slashed = new URL(url);
      slashed.pathname = location;
      const direct = await next(new Request(slashed.toString(), request));
      if (direct.status === 200) {
        const headers = new Headers(direct.headers);
        headers.set('X-PreRender', 'route-hit-noslash');
        return new Response(direct.body, { status: 200, headers });
      }
    }
    return assetResponse;
  }

  if (assetResponse.status !== 404) return assetResponse;

  // Express's req.path and resolver.php's rawurldecode() both hand the matcher
  // a DECODED path; URL.pathname is still percent-encoded, so decode to keep the
  // three stacks matching on the same string. A malformed escape sequence throws
  // here where PHP would have returned the raw bytes, so fall back rather than
  // 500 on a crawler's mangled URL.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }

  if (!PRODUCT_RE.test(pathname)) {
    // server.cjs Layer 5. Not a product URL, so its absence is not evidence of
    // a deletion — /parts/<cat> for the 21 categories with no prerendered index,
    // and every /parts/<cat>/browse/page-N, live here and are legitimately 200.
    return new Response(request.method === 'HEAD' ? null : SPA_HTML, {
      status: 200,
      headers: { 'Content-Type': HTML, 'X-PreRender': 'spa-fallback' },
    });
  }

  // server.cjs: `key = req.path.replace(/\/$/, '')` — strip exactly one
  // trailing slash, because PRODUCT_RE admits both forms but the map is keyed
  // without it.
  const key = pathname.replace(/\/$/, '');

  const target = REDIRECTS[key];
  if (target) {
    // Built with a literal Location rather than Response.redirect(), which
    // requires an absolute URL and would throw on these: every target in
    // product-redirects.json is a site-relative path, and both server.cjs
    // (res.redirect) and resolver.php (header Location:) emit it relative.
    return new Response(null, {
      status: 301,
      headers: { Location: target, 'X-PreRender': 'gone-301' },
    });
  }

  // Gone with no equivalent. 410 + noindex header + a shell carrying its own
  // noindex and no canonical, so a human still gets the app's "Product Not
  // Found" screen while a crawler gets an unambiguous de-index signal.
  return new Response(request.method === 'HEAD' ? null : GONE_HTML, {
    status: 410,
    headers: {
      'Content-Type': HTML,
      'X-Robots-Tag': 'noindex',
      'X-PreRender': 'gone-410',
    },
  });
}
