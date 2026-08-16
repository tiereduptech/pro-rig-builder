// Cloudflare Access JWT verification — the admin dashboard's only boundary.
//
// Access protects the browser path to a HOSTNAME. The Function is also reachable
// on the project's permanent .pages.dev alias, which Cloudflare offers no way to
// disable (the same fact that forced noindexOnPagesDev in the catalog resolver).
// So the check is enforced in code, and these tests prove it is discriminating:
// a real RSA key signs a real token, and each defect class is then rejected.
//
// A test suite that only ever sees rejection cannot tell "correctly strict" from
// "broken and refusing everything" — hence the positive case first.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, guard } from '../admin/functions-lib/access.js';

const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'aud-tag-for-this-app';
const HOST = 'admin.prorigbuilder.com';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * ONE keypair, published ONCE, for the whole suite.
 *
 * This is not just a speed choice. access.js caches the JWKS per team domain for
 * ten minutes — correct in production, where the signing keys do not rotate per
 * request — so a test that generated a fresh keypair and re-stubbed the JWKS
 * would be verified against the FIRST test's cached key and fail with "bad
 * signature" for reasons that have nothing to do with what it is testing. Tests
 * that need a mismatch create a second key and publish the first, which is the
 * real attack shape anyway.
 */
async function makeKeys(kid = 'kid-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: 'RS256' }, kid };
}

async function sign(privateKey, header, claims) {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/** Serve a JWKS and count fetches, so the cache can be observed. */
function stubJwks(keys) {
  const calls = { n: 0 };
  globalThis.fetch = async () => {
    calls.n++;
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

const KEYS = await makeKeys('kid-1');

const now = () => Math.floor(Date.now() / 1000);
const baseClaims = (over = {}) => ({ aud: [AUD], iss: TEAM, exp: now() + 600, iat: now(), email: 'coby@tiereduptech.com', ...over });

test('a correctly signed, correctly scoped token is ACCEPTED', async () => {
  const calls = stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims());
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.claims.email, 'coby@tiereduptech.com');

  // The JWKS is cached for ten minutes per team domain: a second verification
  // must not re-fetch. Without this every request would add a round trip to
  // Cloudflare before the dashboard could render anything.
  const before = calls.n;
  await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(calls.n, before, 'the JWKS should be served from cache on the second call');
});

test('a token for a DIFFERENT Access application is rejected', async () => {
  // The failure this closes: any valid token from the same Access team would
  // otherwise open the admin panel.
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims({ aud: ['some-other-app'] }));
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /aud does not match/);
});

test('a token signed by a DIFFERENT key is rejected', async () => {
  const attacker = await makeKeys('kid-1'); // same kid, different key
  stubJwks([KEYS.jwk]);
  const token = await sign(attacker.pair.privateKey, { alg: 'RS256', kid: 'kid-1', typ: 'JWT' }, baseClaims());
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bad signature/);
});

test('an expired token is rejected', async () => {
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims({ exp: now() - 1 }));
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('a token from another team is rejected', async () => {
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims({ iss: 'https://someone-else.cloudflareaccess.com' }));
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /is not/);
});

test('alg=none and other unsigned shapes are rejected before any key lookup', async () => {
  const calls = stubJwks([KEYS.jwk]);
  const forged = `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${b64url(JSON.stringify(baseClaims()))}.`;
  const r = await verifyAccessJwt(forged, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected alg/);
  assert.equal(calls.n, 0, 'an alg=none token must not even reach the JWKS');
});

test('missing and malformed tokens are rejected', async () => {
  stubJwks([KEYS.jwk]);
  for (const bad of [null, '', 'not-a-jwt', 'a.b', 'a.b.c.d']) {
    const r = await verifyAccessJwt(bad, { teamDomain: TEAM, aud: AUD });
    assert.equal(r.ok, false, `${bad} should be rejected`);
  }
  const r = await verifyAccessJwt('%%%.%%%.%%%', { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
});

test('an unknown kid is rejected rather than trying every key', async () => {
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: 'kid-rotated', typ: 'JWT' }, baseClaims());
  const r = await verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD });
  assert.equal(r.ok, false);
  assert.match(r.reason, /signing key not in JWKS/);
});

test('an unreachable JWKS is reported as OUR failure, not as a denial', async () => {
  // Otherwise a network problem sends someone hunting through Access policies.
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims());
  const r = await verifyAccessJwt(token, { teamDomain: 'https://unreachable-team.cloudflareaccess.com', aud: AUD });
  assert.equal(r.ok, false);
  assert.equal(r.infrastructure, true);
});

// ── guard(): config, host, then token ──────────────────────────────────────
const req = (url, headers = {}) => new Request(url, { headers });

test('missing configuration serves NOTHING — it never means "no auth needed"', async () => {
  for (const env of [
    {},
    { ACCESS_AUD: AUD, ADMIN_HOST: HOST },
    { ACCESS_TEAM_DOMAIN: TEAM, ADMIN_HOST: HOST },
    { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
  ]) {
    const res = await guard(req(`https://${HOST}/`), env);
    assert.ok(res, 'a misconfigured gate must return a response, not fall through');
    assert.equal(res.status, 500);
    assert.match(await res.text(), /misconfigured/);
  }
});

test('a request on the .pages.dev alias gets 404, not the dashboard', async () => {
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_HOST: HOST };
  const res = await guard(req('https://prb-admin.pages.dev/api/stats'), env);
  assert.ok(res);
  assert.equal(res.status, 404, '403 would advertise that something is there');
});

test('the right host with no token is 403', async () => {
  stubJwks([KEYS.jwk]);
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_HOST: HOST };
  const res = await guard(req(`https://${HOST}/api/dispatch`), env);
  assert.ok(res);
  assert.equal(res.status, 403);
});

test('the right host with a valid token passes through', async () => {
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims());
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_HOST: HOST };
  const res = await guard(req(`https://${HOST}/`, { 'Cf-Access-Jwt-Assertion': token }), env);
  assert.equal(res, null, 'guard returns null to let the request continue');
});

test('the team domain is normalized, so a trailing slash is not an outage', async () => {
  stubJwks([KEYS.jwk]);
  const token = await sign(KEYS.pair.privateKey, { alg: 'RS256', kid: KEYS.kid, typ: 'JWT' }, baseClaims());
  for (const configured of [TEAM, `${TEAM}/`, 'example.cloudflareaccess.com']) {
    const env = { ACCESS_TEAM_DOMAIN: configured, ACCESS_AUD: AUD, ADMIN_HOST: HOST };
    const res = await guard(req(`https://${HOST}/`, { 'Cf-Access-Jwt-Assertion': token }), env);
    assert.equal(res, null, `ACCESS_TEAM_DOMAIN=${configured} should be accepted`);
  }
});
