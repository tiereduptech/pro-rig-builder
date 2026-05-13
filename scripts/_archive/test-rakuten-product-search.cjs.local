// =============================================================================
//  test-rakuten-product-search.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Tests Rakuten Advertising's Product Search API end-to-end:
//    1) Gets an OAuth 2.0 access token using client_credentials grant.
//    2) Searches Newegg's catalog for a sample keyword ("RTX 4090").
//    3) Prints the full result structure so we know what fields to map.
//
//  Required env vars (set on Railway):
//    RAKUTEN_CLIENT_ID      — OAuth client ID
//    RAKUTEN_CLIENT_SECRET  — OAuth client secret
//    RAKUTEN_SID            — Numerical publisher SID (token scope)
//    RAKUTEN_NEWEGG_MID     — Newegg's advertiser MID (44583)
//
//  Usage:
//    railway run node test-rakuten-product-search.cjs
//    railway run node test-rakuten-product-search.cjs --keyword "9950X3D"
// =============================================================================

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const KEYWORD = arg('keyword', 'RTX 4090');

const CID = process.env.RAKUTEN_CLIENT_ID;
const SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const MID = process.env.RAKUTEN_NEWEGG_MID;

if (!CID || !SECRET || !SID || !MID) {
  console.error('  ✗ Missing Rakuten env vars. Need:');
  console.error('    RAKUTEN_CLIENT_ID, RAKUTEN_CLIENT_SECRET, RAKUTEN_SID, RAKUTEN_NEWEGG_MID');
  process.exit(1);
}

// ─── Try multiple known token endpoints; Rakuten has migrated over the years
// and which one works depends on app registration vintage.
const TOKEN_ENDPOINTS = [
  'https://api.linksynergy.com/token',
  'https://api.rakutenadvertising.com/token',
  'https://api.rakutenmarketing.com/token',
];

async function getAccessToken() {
  const basic = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    scope: SID,
  }).toString();

  for (const url of TOKEN_ENDPOINTS) {
    console.log(`  Trying token endpoint: ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': basic,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const text = await res.text();
      console.log(`    HTTP ${res.status}  Content-Type: ${res.headers.get('content-type')}`);
      if (res.ok) {
        try {
          const data = JSON.parse(text);
          if (data.access_token) {
            console.log(`  ✓ Got access token (${data.token_type || 'Bearer'}, expires in ${data.expires_in || '?'}s)`);
            return data.access_token;
          }
        } catch {}
      }
      // Log error response (first 300 chars) to help diagnose.
      console.log(`    Response: ${text.slice(0, 300)}`);
    } catch (e) {
      console.log(`    Network error: ${e.message}`);
    }
  }

  // Alternative grant type: some Rakuten apps require client_credentials.
  console.log('\n  Trying grant_type=client_credentials...');
  for (const url of TOKEN_ENDPOINTS) {
    console.log(`  Endpoint: ${url}`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': basic,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: SID }).toString(),
      });
      const text = await res.text();
      console.log(`    HTTP ${res.status}`);
      if (res.ok) {
        try {
          const data = JSON.parse(text);
          if (data.access_token) {
            console.log(`  ✓ Got access token via client_credentials`);
            return data.access_token;
          }
        } catch {}
      }
      console.log(`    Response: ${text.slice(0, 300)}`);
    } catch (e) {}
  }

  return null;
}

async function productSearch(token, keyword) {
  // Try multiple known API hosts.
  const HOSTS = [
    'https://api.rakutenmarketing.com',
    'https://api.linksynergy.com',
    'https://api.rakutenadvertising.com',
  ];
  const params = new URLSearchParams({
    keyword,
    mid: MID,           // restrict to Newegg
    max: '10',
    pagenumber: '1',
  }).toString();

  for (const host of HOSTS) {
    const url = `${host}/productsearch/1.0?${params}`;
    console.log(`\n  GET ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });
      const text = await res.text();
      console.log(`    HTTP ${res.status}  CT: ${res.headers.get('content-type')}`);
      if (res.ok) return { host, body: text };
      console.log(`    ${text.slice(0, 500)}`);
    } catch (e) {
      console.log(`    Network: ${e.message}`);
    }
  }
  return null;
}

(async () => {
  console.log('\n  Rakuten Product Search API test');
  console.log('  ════════════════════════════════');
  console.log(`  Keyword:     "${KEYWORD}"`);
  console.log(`  SID:         ${SID}`);
  console.log(`  Newegg MID:  ${MID}`);
  console.log('');

  const token = await getAccessToken();
  if (!token) {
    console.error('\n  ✗ Could not get access token. Check credentials and SID.');
    process.exit(1);
  }

  const result = await productSearch(token, KEYWORD);
  if (!result) {
    console.error('\n  ✗ Product search failed on all known hosts.');
    process.exit(1);
  }

  console.log(`\n  ✓ Success via ${result.host}`);
  console.log(`  Response length: ${result.body.length} chars`);

  // Response is typically XML — show structure.
  const preview = result.body.slice(0, 2500);
  console.log('\n  ─── First 2500 chars of response ───');
  console.log(preview);
  console.log('\n  ───');
})();
