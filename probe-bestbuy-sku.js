#!/usr/bin/env node
/**
 * probe-bestbuy-sku.js — check whether the SKU values in our discovery
 * data actually work against the Best Buy Reviews API.
 *
 * The reviews API worked earlier with real SKU 6621941. Discovery data
 * stores `bestBuySku` == `catalogItemId` (an Impact id). This tests
 * whether those Impact ids are accepted by the reviews endpoint.
 *
 * Usage:  railway run node probe-bestbuy-sku.js
 */
const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('BESTBUY_API_KEY not set'); process.exit(1); }

// Two ids to compare:
//  - 6621941  : a known-real Best Buy SKU (worked in the reviews probe)
//  - 10871762 : a `bestBuySku` straight from discovery data (Okinos case)
const ids = ['6621941', '10871762'];

for (const id of ids) {
  // (a) does the Products API recognize it as a sku?
  const prodUrl = `https://api.bestbuy.com/v1/products/${id}.json?apiKey=${KEY}&show=sku,name`;
  // (b) does the Reviews API return anything for it?
  const revUrl = `https://api.bestbuy.com/v1/reviews(sku=${id})?apiKey=${KEY}&format=json&pageSize=3`;

  console.log('\n━━━ id ' + id + ' ━━━');

  try {
    const pr = await fetch(prodUrl);
    if (pr.ok) {
      const pd = await pr.json();
      console.log('  products API: HTTP 200 — name: ' + (pd.name || '(none)'));
    } else {
      console.log('  products API: HTTP ' + pr.status + ' — not a valid sku');
    }
  } catch (e) { console.log('  products API error: ' + e.message); }

  await new Promise(r => setTimeout(r, 1500)); // stay under per-second limit

  try {
    const rr = await fetch(revUrl);
    if (rr.ok) {
      const rd = await rr.json();
      console.log('  reviews API:  HTTP 200 — total reviews: ' + (rd.total != null ? rd.total : '(none)'));
    } else {
      const t = await rr.text();
      console.log('  reviews API:  HTTP ' + rr.status + ' — ' + t.slice(0, 120));
    }
  } catch (e) { console.log('  reviews API error: ' + e.message); }

  await new Promise(r => setTimeout(r, 1500)); // pause before next id
}
