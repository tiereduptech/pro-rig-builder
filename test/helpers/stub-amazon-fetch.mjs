// =============================================================================
//  test/helpers/stub-amazon-fetch.mjs — preloaded with `node --import` so a test
//  can run amazon-asin-identity-audit.mjs end to end without the network.
//
//  STUB_AMAZON=token-gated   the token endpoint answers 403 AssociateNotEligible
//  STUB_AMAZON=items-gated   a token is issued; getItems answers 400 AssociateNotEligible
//
//  Any other request EXITS the process with 97. Throwing would not do: the
//  audit's call() treats a thrown fetch as a network blip and retries it, so an
//  unexpected request would be swallowed rather than seen.
// =============================================================================

const GATED = '{"__type":"AssociateNotEligible","message":"not eligible"}';
const mode = process.env.STUB_AMAZON;

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.amazon.com/auth')) {
    if (mode === 'token-gated') return new Response(GATED, { status: 403 });
    return new Response(JSON.stringify({ access_token: 'stub-token', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('/getItems') && mode === 'items-gated') return new Response(GATED, { status: 400 });
  console.error(`stub-amazon-fetch: unexpected request in mode ${mode}: ${u}`);
  process.exit(97);
};
