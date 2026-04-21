#!/usr/bin/env node
/**
 * impact-test.js — diagnostic for Impact /Catalogs/ItemSearch endpoint
 *
 * v2: Fixed Query syntax — Impact needs string values in single quotes.
 *
 * Usage:
 *   railway run node impact-test.js
 *   railway run node impact-test.js --keyword="GPU"
 *   railway run node impact-test.js --keyword="CPU" --maxprice=500
 *   railway run node impact-test.js --noquery       # no Query filter, just keyword
 */

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;

if (!SID || !TOKEN) {
  console.error('ERROR: IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN env vars required.');
  process.exit(1);
}

const args = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.replace(/^--/, '').split('=');
  args[k] = v ?? true;
}

const KEYWORD = args.keyword || 'graphics card';
const PAGE_SIZE = parseInt(args.pagesize || '10');
const MAX_PRICE = args.maxprice ? parseInt(args.maxprice) : null;
const NO_QUERY = !!args.noquery;

// Impact Query syntax: string values MUST be in single quotes.
// Operators: = != > >= < <= AND
// Per docs: "string values need to be in single quotes. e.g., (Color = 'Navy')"
let queryExpr = null;
if (!NO_QUERY) {
  queryExpr = "StockAvailability = 'InStock'";
  if (MAX_PRICE) queryExpr += ` AND CurrentPrice <= ${MAX_PRICE}`;
}

const basicAuth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const params = new URLSearchParams({
  Keyword: KEYWORD,
  PageSize: String(PAGE_SIZE),
});
if (queryExpr) params.append('Query', queryExpr);

const url = `https://api.impact.com/Mediapartners/${SID}/Catalogs/ItemSearch?${params}`;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Impact /Catalogs/ItemSearch diagnostic (v2)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Keyword:    ', KEYWORD);
console.log('Max price:  ', MAX_PRICE || 'no limit');
console.log('Page size:  ', PAGE_SIZE);
console.log('Query expr: ', queryExpr || '(none)');
console.log('URL:        ', url);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

(async () => {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
    });

    console.log(`HTTP ${resp.status} ${resp.statusText}`);
    console.log(`Content-Type: ${resp.headers.get('content-type')}\n`);

    const text = await resp.text();

    if (!resp.ok) {
      console.log('ERROR RESPONSE BODY:');
      console.log(text.slice(0, 2000));
      process.exit(2);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log('Response was not JSON. Raw body:');
      console.log(text.slice(0, 2000));
      process.exit(3);
    }

    const topKeys = Object.keys(data);
    console.log('TOP-LEVEL RESPONSE KEYS:', topKeys.join(', '));
    if (data['@total']) console.log('Total matching (across all pages):', data['@total']);
    if (data['@numpages']) console.log('Pages total:', data['@numpages']);

    const items = data.Items || data.CatalogItems || data.items || [];
    console.log(`\nITEMS RETURNED: ${items.length}\n`);

    if (items.length === 0) {
      console.log('⚠️  No items returned.');
      console.log('\nFull response:');
      console.log(JSON.stringify(data, null, 2).slice(0, 3000));
      process.exit(0);
    }

    const campaigns = new Map();
    for (const item of items) {
      const name = item.CampaignName || 'Unknown';
      const id = item.CampaignId || 'unknown';
      const key = `${name} (${id})`;
      campaigns.set(key, (campaigns.get(key) || 0) + 1);
    }

    console.log('CAMPAIGNS IN RESULTS:');
    for (const [k, v] of campaigns) {
      console.log(`   ${v.toString().padStart(3)} × ${k}`);
    }

    console.log('\nSAMPLE ITEM:');
    const first = items[0];
    console.log(JSON.stringify({
      CampaignName: first.CampaignName,
      Name: first.Name,
      CatalogItemId: first.CatalogItemId,
      Manufacturer: first.Manufacturer,
      CurrentPrice: first.CurrentPrice,
      OriginalPrice: first.OriginalPrice,
      Currency: first.Currency,
      StockAvailability: first.StockAvailability,
      Url: first.Url,
      ImageUrl: first.ImageUrl,
      Gtin: first.Gtin,
      Mpn: first.Mpn,
      Asin: first.Asin,
      Category: first.Category,
      SubCategory: first.SubCategory,
    }, null, 2));

    const fieldStats = {
      Url: 0, ImageUrl: 0, Gtin: 0, Mpn: 0, Asin: 0,
      CurrentPrice: 0, StockAvailability: 0, Manufacturer: 0, Category: 0,
    };
    for (const item of items) {
      for (const key of Object.keys(fieldStats)) {
        if (item[key] && String(item[key]).trim() !== '') fieldStats[key]++;
      }
    }
    console.log(`\nFIELD DENSITY (out of ${items.length} items):`);
    for (const [k, v] of Object.entries(fieldStats)) {
      console.log(`   ${k.padEnd(20)} ${v}/${items.length}`);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const hasBestBuy = [...campaigns.keys()].some(k => /best\s*buy/i.test(k));
    if (hasBestBuy) {
      console.log('✅ Best Buy found — ItemSearch works for you.');
    } else {
      console.log('⚠️  Best Buy not in results.');
      console.log('   Campaigns found above. Check Impact dashboard for active brands.');
    }
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
})();
