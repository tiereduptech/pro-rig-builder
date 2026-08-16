// =============================================================================
//  admin/functions/_middleware.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Every request to the admin project passes through here — static assets
//  included, because a root middleware in Pages runs ahead of the asset service.
//  That is deliberate: the dashboard HTML is as private as the API, and putting
//  the gate on /api/* alone would serve the page (and its structure) to anyone
//  who reached the host.
//
//  There is no bypass, no dev mode and no header that skips the check. See
//  admin/functions-lib/access.js for why it fails closed on misconfiguration.
// =============================================================================

import { guard } from '../functions-lib/access.js';

export async function onRequest(context) {
  const denied = await guard(context.request, context.env);
  if (denied) return denied;

  const response = await context.next();

  // Stamped at the single exit rather than per route — the same reasoning as
  // noindexOnPagesDev() in the catalog project: a header applied per branch is a
  // header the next branch forgets. Nothing here should ever be indexed, cached
  // by an intermediary, or framed.
  const out = new Response(response.body, response);
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.set('cache-control', 'no-store');
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('x-frame-options', 'DENY');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}
