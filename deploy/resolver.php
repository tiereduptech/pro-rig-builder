<?php
// =============================================================================
//  resolver.php  —  ErrorDocument 404 front controller for prorigbuilder.com
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Replaces server.cjs Layer 4.5 (410/301) + Layer 5 (SPA fallback).
//
//  Invoked ONLY on a genuine miss: .htaccess already served the 5,516 product
//  pages, every prerendered route, and every static asset directly (rules 1–2).
//  If we are here, nothing on disk backed this URL.
//
//  PRODUCT_RE is NOT retyped here. build-epik.cjs extracts the exact literal from
//  server.cjs and writes it to resolver-config.php, so the product/non-product
//  boundary is byte-identical across the two stacks. A mistake here is invisible
//  until traffic drops, so there is a single source of truth by construction.
//
//  Behavior, matching server.cjs:
//    - product-shaped path (PRODUCT_RE), in redirect map  -> 301 Location
//    - product-shaped path, not mapped (deleted OR never existed) -> 410 + noindex
//    - anything else -> the SPA shell (index.html) at 200
// =============================================================================

require __DIR__ . '/resolver-config.php';        // defines RESOLVER_PRODUCT_RE
$redirects = require __DIR__ . '/redirects.php';  // returns array<string,string>

// Express's req.path: the URL path only (no query string), percent-decoded.
$uri  = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
$path = parse_url($uri, PHP_URL_PATH);
if ($path === false || $path === null || $path === '') {
    $path = '/';
}
$path = rawurldecode($path);

// server.cjs Layer 4.5: `if (!PRODUCT_RE.test(req.path)) return next();`
// The regex itself allows an optional trailing slash (…/?$).
if (preg_match(RESOLVER_PRODUCT_RE, $path)) {
    // server.cjs: `key = req.path.replace(/\/$/, '')` — strip exactly one trailing slash.
    $key = preg_replace('#/$#', '', $path);

    if (isset($redirects[$key])) {
        // X-PreRender: gone-301
        header('Location: ' . $redirects[$key], true, 301);
        exit;
    }

    // X-PreRender: gone-410 — 410 status, noindex header, prebuilt noindex shell.
    http_response_code(410);
    header('X-Robots-Tag: noindex');
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/gone.html');
    exit;
}

// server.cjs Layer 5: SPA fallback — index.html at 200, no Cache-Control.
http_response_code(200);
header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/index.html');
