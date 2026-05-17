#!/usr/bin/env node
/**
 * probe-dataforseo-reviews.js — one-off: post an Amazon reviews task to
 * DataForSEO, poll for the result, and dump the raw response shape.
 *
 * Cost: ~one task + 10 reviews ≈ a fraction of a cent.
 *
 * Usage:  railway run node probe-dataforseo-reviews.js
 */
const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASS = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASS) { console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set'); process.exit(1); }

const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASS).toString('base64');
const ASIN = 'B0D6NN87T8'; // a real Ryzen ASIN from the catalog
const BASE = 'https://api.dataforseo.com/v3/merchant/amazon/reviews';

const headers = { 'Authorization': AUTH, 'Content-Type': 'application/json' };

// ── 1. POST the task ──
console.log('Posting reviews task for ASIN ' + ASIN + ' ...');
const postRes = await fetch(BASE + '/task_post', {
  method: 'POST', headers,
  body: JSON.stringify([{
    asin: ASIN,
    location_name: 'United States',
    language_name: 'English',
    depth: 10, // 10 reviews — one billing bucket
  }]),
});
const postData = await postRes.json();
console.log('task_post HTTP ' + postRes.status + ', status_code ' + postData.status_code + ' — ' + postData.status_message);

const task = postData.tasks && postData.tasks[0];
if (!task || !task.id) {
  console.log('No task id. Full response:');
  console.log(JSON.stringify(postData, null, 2).slice(0, 1500));
  process.exit(1);
}
const taskId = task.id;
console.log('Task id: ' + taskId);
console.log('task-level status_code ' + task.status_code + ' — ' + task.status_message);

// ── 2. Poll task_get until ready ──
const GET = BASE + '/task_get/' + taskId;
let result = null;
for (let attempt = 1; attempt <= 30; attempt++) {
  await new Promise(r => setTimeout(r, 10000)); // 10s between polls
  const getRes = await fetch(GET, { headers });
  const getData = await getRes.json();
  const t = getData.tasks && getData.tasks[0];
  const sc = t && t.status_code;
  process.stdout.write('\r  poll ' + attempt + '/30 — status_code ' + sc + '          ');
  // 20000 = "Task In Queue", 20100 = "Task Created"; 20000-range = not ready
  if (sc === 20000 && t.result) { result = t; break; }
  if (sc && sc !== 40602 && sc !== 40601 && sc < 20000) { /* keep polling */ }
  if (t && t.result) { result = t; break; }
}
console.log('');

if (!result) {
  console.log('Task did not complete within polling window. Try task_get again later:');
  console.log('  ' + GET);
  process.exit(1);
}

// ── 3. Dump the shape ──
const res0 = result.result && result.result[0];
console.log('━━━ RESULT-LEVEL KEYS ━━━');
console.log(res0 ? Object.keys(res0) : '(no result[0])');
const items = res0 && res0.items;
if (Array.isArray(items) && items.length) {
  console.log('━━━ FIRST REVIEW ITEM (raw) ━━━');
  console.log(JSON.stringify(items[0], null, 2));
  console.log('━━━ ITEM FIELD NAMES ━━━');
  console.log(Object.keys(items[0]));
  console.log('Items returned: ' + items.length);
} else {
  console.log('No items array. result[0]:');
  console.log(JSON.stringify(res0, null, 2).slice(0, 1500));
}
