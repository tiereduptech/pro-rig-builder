#!/usr/bin/env node
/**
 * probe-bestbuy-sku2.js — the reviews API returned total:2 for discovery
 * id 10871762 even though that id is NOT a valid product SKU. Pull the
 * actual review content + the sku each review is attached to, to see
 * whether it's the right product (Okinos case) or unrelated garbage.
 *
 * Usage:  railway run node probe-bestbuy-sku2.js
 */
const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('BESTBUY_API_KEY not set'); process.exit(1); }

const id = '10871762'; // discovery bestBuySku for the Okinos Aqua 9 case

const url = `https://api.bestbuy.com/v1/reviews(sku=${id})?apiKey=${KEY}&format=json&pageSize=5&show=id,sku,rating,title,comment`;
console.log('Discovery id: ' + id + ' (expected product: Okinos Aqua 9 ATX PC Case)');
console.log('GET reviews(sku=' + id + ')\n');

const res = await fetch(url);
console.log('HTTP ' + res.status);
if (!res.ok) { console.log(await res.text()); process.exit(1); }

const data = await res.json();
console.log('total: ' + data.total);
console.log('reviews returned: ' + (data.reviews ? data.reviews.length : 0));
if (data.reviews) {
  for (const r of data.reviews) {
    console.log('\n  --- review ' + r.id + ' ---');
    console.log('  attached to sku: ' + r.sku);
    console.log('  rating: ' + r.rating);
    console.log('  title:  ' + r.title);
    console.log('  text:   ' + String(r.comment || '').slice(0, 160));
  }
}
console.log('\n→ If "attached to sku" matches ' + id + ' and the text is about a PC case,');
console.log('  the discovery id works for reviews. If the sku differs or text is unrelated,');
console.log('  the reviews API ignored our filter and the discovery id is unusable.');
