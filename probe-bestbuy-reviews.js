#!/usr/bin/env node
/**
 * probe-bestbuy-reviews.js — one-off: dump the raw shape of the Best Buy
 * Reviews API response so we can see real field names before building.
 *
 * Usage:  railway run node probe-bestbuy-reviews.js
 */
const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('BESTBUY_API_KEY not set'); process.exit(1); }

// 9950X3D, Best Buy 1P SKU from earlier discovery.
const SKU = '6621941';

// Reviews API: filter reviews by sku. No sort — just see the raw shape.
const url = `https://api.bestbuy.com/v1/reviews(sku=${SKU})?apiKey=${KEY}&format=json&pageSize=5`;

console.log('GET ' + url.replace(KEY, '***'));

const res = await fetch(url);
console.log('HTTP ' + res.status);
const text = await res.text();

if (!res.ok) {
  console.log('Body:', text.slice(0, 500));
  process.exit(1);
}

let data;
try { data = JSON.parse(text); }
catch (e) { console.log('Non-JSON body:', text.slice(0, 500)); process.exit(1); }

console.log('━━━ TOP-LEVEL KEYS ━━━');
console.log(Object.keys(data));
if (data.reviews && data.reviews.length) {
  console.log('━━━ FIRST REVIEW (raw) ━━━');
  console.log(JSON.stringify(data.reviews[0], null, 2));
  console.log('━━━ REVIEW FIELD NAMES ━━━');
  console.log(Object.keys(data.reviews[0]));
  console.log('Total reviews returned:', data.reviews.length);
} else {
  console.log('No reviews array, or empty. Full response:');
  console.log(JSON.stringify(data, null, 2).slice(0, 1000));
}
