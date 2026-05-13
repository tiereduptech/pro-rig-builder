// =============================================================================
//  test-rakuten-upc-search.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Tests Rakuten Product Search using UPC (not keyword). If this works, we
//  can match our catalog to Newegg with near-perfect accuracy for the 54%
//  of products that have a UPC.
//
//  Usage:
//    railway run node test-rakuten-upc-search.cjs --upc 197105470644
//    railway run node test-rakuten-upc-search.cjs   # uses sample default
// =============================================================================

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const UPC = arg('upc', '197105470644');

const CID = process.env.RAKUTEN_CLIENT_ID;
const SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const MID = process.env.RAKUTEN_NEWEGG_MID;

if (!CID || !SECRET || !SID || !MID) {
  console.error('  ✗ Missing Rakuten env vars');
  process.exit(1);
}

async function getToken() {
  const basic = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', scope: SID }).toString(),
  });
  const data = await res.json();
  return data.access_token;
}

// Strip XML tags from a value for clean display.
function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'));
  return m ? m[1].trim() : null;
}

// Parse all <item> blocks from XML.
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

(async () => {
  console.log('\n  Rakuten UPC Search test');
  console.log('  ═══════════════════════');
  console.log(`  UPC: ${UPC}`);
  console.log(`  Newegg MID: ${MID}\n`);

  const token = await getToken();
  if (!token) { console.error('  ✗ Token failed'); process.exit(1); }
  console.log('  ✓ Got access token');

  // Rakuten Product Search supports a `upccode` query parameter.
  // Test both `upccode` and the `keyword` fallback (some implementations
  // accept the UPC as a keyword too).
  const tests = [
    { label: 'upccode param', params: { upccode: UPC, mid: MID, max: '5' } },
    { label: 'keyword=UPC',   params: { keyword: UPC, mid: MID, max: '5' } },
  ];

  for (const test of tests) {
    const url = `https://api.linksynergy.com/productsearch/1.0?${new URLSearchParams(test.params)}`;
    console.log(`\n  Test: ${test.label}`);
    console.log(`  GET ${url}`);
    try {
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const text = await res.text();
      console.log(`    HTTP ${res.status}, ${text.length} chars`);
      if (!res.ok) { console.log(`    ${text.slice(0, 300)}`); continue; }

      const totalMatches = parseInt(xmlField(text, 'TotalMatches') || '0', 10);
      console.log(`    Total matches: ${totalMatches}`);

      const items = parseItems(text);
      if (items.length === 0) { console.log('    No items returned'); continue; }

      console.log(`    Showing first ${Math.min(3, items.length)}:`);
      for (const item of items.slice(0, 3)) {
        const name = xmlField(item, 'productname');
        const sku = xmlField(item, 'sku');
        const upc = xmlField(item, 'upccode');
        const price = xmlField(item, 'price');
        const sale = xmlField(item, 'saleprice');
        const link = xmlField(item, 'linkurl');
        console.log(`      • ${name?.slice(0, 70)}`);
        console.log(`        SKU: ${sku}  UPC: ${upc}  Price: $${price}  Sale: $${sale}`);
        console.log(`        Link: ${link?.slice(0, 90)}...`);
      }
    } catch (e) {
      console.log(`    Error: ${e.message}`);
    }
  }
  console.log('');
})();
