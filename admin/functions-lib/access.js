// =============================================================================
//  admin/functions-lib/access.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Cloudflare Access JWT verification. See deploy/DESIGN-admin-dashboard.md §8.
//
//  ── WHY VERIFY THE JWT WHEN ACCESS IS ALREADY IN FRONT ──────────────────────
//  Access protects the browser path to a HOSTNAME. This Function is also
//  reachable on the Pages project's permanent <project>.pages.dev alias, which
//  Cloudflare offers no way to disable — the same fact that forced the noindex
//  branch in functions/parts/[[path]].js. An Access policy on
//  admin.prorigbuilder.com does not cover a request that never goes near
//  admin.prorigbuilder.com.
//
//  So the boundary is enforced twice, in code:
//    1. the request's hostname must equal ADMIN_HOST
//    2. Cf-Access-Jwt-Assertion must verify against the team's JWKS, with `aud`
//       matching this application
//
//  This is the same argument the resolver already makes for checking the host in
//  code rather than trusting a Transform Rule someone has to remember exists.
//
//  ── FAIL CLOSED, INCLUDING ON MISCONFIGURATION ──────────────────────────────
//  A missing ACCESS_AUD / ACCESS_TEAM_DOMAIN / ADMIN_HOST returns 500 and serves
//  nothing. The tempting alternative — "no config, so skip the check" — turns a
//  typo in the Pages dashboard into a public admin panel holding a GitHub write
//  token. There is no unauthenticated path through this module.
// =============================================================================

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache = { at: 0, url: null, keys: null };

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/** Normalize `https://team.cloudflareaccess.com/` -> `https://team.cloudflareaccess.com`. */
function normalizeTeamDomain(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return null;
  return /^https?:\/\//.test(v) ? v : `https://${v}`;
}

async function fetchJwks(teamDomain) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const fresh = jwksCache.keys && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh) return jwksCache.keys;

  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) throw new Error('JWKS contained no keys');
  jwksCache = { at: Date.now(), url, keys };
  return keys;
}

/**
 * Verify an Access JWT. Returns { ok: true, claims } or { ok: false, reason }.
 * Never throws for an untrusted-input reason — a malformed token is a 403, not a
 * 500, and the two must stay distinguishable in the logs.
 */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  if (!token) return { ok: false, reason: 'no Cf-Access-Jwt-Assertion header' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header, claims;
  try {
    header = b64urlToJson(parts[0]);
    claims = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, reason: 'undecodable token' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${header.alg}` };

  let keys;
  try {
    keys = await fetchJwks(teamDomain);
  } catch (e) {
    // An unreachable JWKS is OUR failure, not the caller's. Surface it as such
    // rather than as "you are not authorized", which would send someone hunting
    // through Access policies for a network problem.
    return { ok: false, reason: `jwks unavailable: ${e.message}`, infrastructure: true };
  }

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'signing key not in JWKS (token from another team, or a rotated key)' };

  let verified = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${e.message}` };
  }
  if (!verified) return { ok: false, reason: 'bad signature' };

  // `aud` is an array in Access tokens. Checking it is what stops a valid token
  // for a DIFFERENT application in the same Access team from opening this one.
  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audList.includes(aud)) return { ok: false, reason: 'aud does not match this application' };
  if (claims.iss !== teamDomain) return { ok: false, reason: `iss ${claims.iss} is not ${teamDomain}` };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'token expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return { ok: false, reason: 'token not yet valid' };

  return { ok: true, claims };
}

/**
 * The whole gate: config presence, host, then token. Returns null when the
 * request may proceed, or the Response to send back when it may not.
 */
export async function guard(request, env) {
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const aud = String(env.ACCESS_AUD || '').trim();
  const adminHost = String(env.ADMIN_HOST || '').trim();

  const missing = [];
  if (!teamDomain) missing.push('ACCESS_TEAM_DOMAIN');
  if (!aud) missing.push('ACCESS_AUD');
  if (!adminHost) missing.push('ADMIN_HOST');
  if (missing.length) {
    return new Response(
      `Admin dashboard is misconfigured: missing ${missing.join(', ')}. ` +
        `Refusing to serve — an unconfigured auth check must never mean an open one.`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' } },
    );
  }

  const host = new URL(request.url).hostname;
  if (host !== adminHost) {
    // The .pages.dev alias lands here. 404 rather than 403: there is nothing to
    // find on this hostname, and saying "forbidden" advertises that there is.
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }

  const result = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), { teamDomain, aud });
  if (!result.ok) {
    return new Response(`Access denied: ${result.reason}`, {
      status: result.infrastructure ? 503 : 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' },
    });
  }

  return null;
}
