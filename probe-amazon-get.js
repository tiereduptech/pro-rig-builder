#!/usr/bin/env node
/**
 * probe-amazon-get.js â€” fetch the result of an ALREADY-POSTED task.
 * No new task is created (no extra cost). Edit TASK_ID if needed.
 * Run:  railway run node probe-amazon-get.js
 */
const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing DATAFORSEO creds.'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const TASK_ID = '05180602-1670-0192-0000-5385045ad2d2';

function huntReviewKeys(obj, pathStr = '', found = []) {
  if (obj == null || typeof obj !== 'object') return found;
  for (const [k, v] of Object.entries(obj)) {
    const here = pathStr ? pathStr + '.' + k : k;
    if (/review|rating/i.test(k)) {
      let desc;
      if (Array.isArray(v)) desc = 'ARRAY[' + v.length + ']';
      else if (v && typeof v === 'object') desc = 'OBJECT{' + Object.keys(v).join(',') + '}';
      else desc = JSON.stringify(v);
      found.push(here + ' = ' + desc);
    }
    if (v && typeof v === 'object') huntReviewKeys(v, here, found);
  }
  return found;
}

(async () => {
  const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + TASK_ID, {
    headers: { 'Authorization': AUTH },
  });
  const d = await res.json();
  const t = d.tasks && d.tasks[0];
  console.log('Task status: ' + (t && t.status_code) + ' ' + (t && t.status_message));

  const item = t && t.result && t.result[0] && t.result[0].items && t.result[0].items[0];
  if (!item) {
    console.log('Still no item â€” task not finished yet. Re-run this in a few minutes.');
    return;
  }

  console.log('\nâ”â”â” TOP-LEVEL KEYS â”â”â”');
  console.log(Object.keys(item).join(', '));

  console.log('\nâ”â”â” REVIEW / RATING KEYS (recursive) â”â”â”');
  const hits = huntReviewKeys(item);
  if (hits.length) hits.forEach(h => console.log('  ' + h));
  else console.log('  (none)');

  for (const p of ['top_local_reviews', 'top_global_reviews']) {
    if (Array.isArray(item[p]) && item[p].length) {
      console.log('\nâ”â”â” SAMPLE item.' + p + '[0] â”â”â”');
      console.log(JSON.stringify(item[p][0], null, 2).slice(0, 1200));
    }
  }

  console.log('\nâ”â”â” FULL ITEM (first 2500 chars) â”â”â”');
  console.log(JSON.stringify(item, null, 2).slice(0, 2500));
  console.log('\nâ”â”â” END â”â”â”');
})();
