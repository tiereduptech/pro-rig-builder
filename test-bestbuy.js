#!/usr/bin/env node
/**
 * test-bestbuy.js — quick test of Best Buy Developer API
 *
 * Hits the /products/{sku}.json endpoint for the RTX 5060 product
 * we already inspected the specs for, so we can see what JSON
 * structure Best Buy returns — specifically the `details` array
 * that has all the spec rows.
 *
 * Usage:
 *   railway run node test-bestbuy.js
 *   railway run node test-bestbuy.js 6630575   # specific SKU
 */

const KEY = process.env.BESTBUY_API_KEY;

if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY env var required.');
  console.error('Run via: railway run node test-bestbuy.js');
  console.error('Or set: $env:BESTBUY_API_KEY="..."');
  process.exit(1);
}

const SKU = process.argv[2] || '6630575';

// `show=all` gives us every field Best Buy has on the product.
// Useful first time so we can see the full structure.
// For production we'd use `show=name,sku,details,upc,manufacturer,...` to minimize payload.
const url = `https://api.bestbuy.com/v1/products/${SKU}.json?apiKey=${KEY}&show=all&format=json`;

console.log(`Fetching SKU ${SKU}...`);
console.log(`URL (key redacted): ${url.replace(KEY, '***KEY***')}`);
console.log('');

(async () => {
  try {
    const resp = await fetch(url);
    console.log(`HTTP ${resp.status} ${resp.statusText}`);
    console.log(`Content-Type: ${resp.headers.get('content-type')}`);
    console.log('');

    if (!resp.ok) {
      const text = await resp.text();
      console.log('ERROR RESPONSE:');
      console.log(text.slice(0, 2000));
      process.exit(2);
    }

    const data = await resp.json();

    // Print top-level keys so we see the shape
    const topKeys = Object.keys(data).sort();
    console.log(`TOP-LEVEL FIELDS (${topKeys.length}):`);
    console.log(topKeys.join(', '));
    console.log('');

    // Print the details array structure specifically — this is the key for spec extraction
    if (Array.isArray(data.details)) {
      console.log(`DETAILS ARRAY (${data.details.length} entries):`);
      for (const d of data.details) {
        console.log(`  ${d.name?.padEnd(50) || '(no name)'.padEnd(50)} = ${d.value}`);
      }
      console.log('');
    } else {
      console.log('details field:', typeof data.details, data.details);
    }

    // Also dump some useful scalar fields
    console.log('SCALAR FIELDS:');
    const interesting = ['sku', 'name', 'manufacturer', 'modelNumber', 'upc', 'salePrice', 'regularPrice',
                         'categoryPath', 'color', 'weight', 'depth', 'height', 'width', 'inStoreAvailability',
                         'onlineAvailability', 'features', 'image', 'url'];
    for (const k of interesting) {
      if (data[k] !== undefined && data[k] !== null && data[k] !== '') {
        const val = Array.isArray(data[k]) ? `[${data[k].length} items]` : String(data[k]).slice(0, 100);
        console.log(`  ${k.padEnd(22)} ${val}`);
      }
    }

    // Save full response for reference
    const fs = await import('node:fs');
    fs.writeFileSync('bestbuy-test-response.json', JSON.stringify(data, null, 2));
    console.log('\nFull response saved to bestbuy-test-response.json');
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
})();
