<?php
// =============================================================================
//  _env.php — runtime invariant reporter for the pull deploy.
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  DESIGN-pull-deploy.md §3.3 rests on two facts. One (__DIR__ is the resolved
//  release path) was measured on 2026-08-12; the other (opcache keys on that
//  resolved path) could not be tested, because opcache introspection is locked
//  down on this host. This file exists so neither is ever silently assumed
//  again: it reports both on every deploy, epik-pull.sh folds the answer into
//  _deploy-status.json, and epik-watchdog.yml fails if either turns.
//
//  It has a second job. The 3–8s post-swap convergence band is PER WORKER, so a
//  single request reporting the new release proves one worker flipped and
//  nothing more. `release` here is derived from __DIR__, so hitting this
//  endpoint N times is how the healthcheck establishes that the whole pool has
//  converged (epik-pull.sh: unanimous()).
//
//  Deliberately exposes basename() only — never a full filesystem path — and no
//  configuration beyond the opcache/realpath keys the watchdog asserts on.
// =============================================================================

header('Content-Type: application/json');
header('Cache-Control: no-store, max-age=0');
header('X-Robots-Tag: noindex');

$dir  = __DIR__;
$real = realpath($dir);

echo json_encode(array(
    // The release this request actually read from. Derived from __DIR__, so it
    // is the worker's own view, not a static file that flips at 0s.
    'release'                     => ($real === false) ? null : basename($real),

    // The R1 invariant of §3.2: __DIR__ must already BE the resolved path. If
    // this goes false, resolver.php's four reads are no longer pinned to one
    // release and a swap landing mid-request can mix them.
    'dir_resolved'                => ($real !== false && $dir === $real),

    // §3.3. All four read empty on the 2026-08-12 host — that is the baseline.
    // opcache_enable becoming truthy while validate_timestamps is off is the
    // combination the watchdog fails on.
    'opcache_enable'              => (string) ini_get('opcache.enable'),
    'opcache_validate_timestamps' => (string) ini_get('opcache.validate_timestamps'),
    'opcache_revalidate_freq'     => (string) ini_get('opcache.revalidate_freq'),
    'opcache_introspectable'      => function_exists('opcache_get_status'),
    'realpath_cache_ttl'          => (string) ini_get('realpath_cache_ttl'),

    // Worker identity — how you tell "10 requests, one worker" from "10
    // requests, the whole pool" when a convergence number looks wrong.
    'php'                         => PHP_VERSION,
    'sapi'                        => PHP_SAPI,
    'pid'                         => getmypid(),
)), "\n";
