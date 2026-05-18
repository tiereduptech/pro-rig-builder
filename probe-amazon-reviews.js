#!/usr/bin/env node
/**
 * probe-amazon-reviews.js — THROWAWAY DIAGNOSTIC.
 *
 * Posts ONE merchant/amazon/asin task for a known ASIN, polls task_get/advanced,
 * and dumps the response structure — specifically hunting for review content.
 *
 * Question to answer: does this endpoint return actual review TEXT
 * (rating + title + body + author + date), or only a numeric review count?
 *
 * Run:  railway run node probe-amazon-reviews.js
 */
const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD env vars.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const TEST_ASIN = 'B0DVZSG8D5'; // AMD Ryzen 9 9950X3D — known popular product

async function dfs(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, 3000 + attempt * 5000));
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

// recursively scan an object for keys that look review-related
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
  console.log('Probing merchant/amazon/asin for ASIN ' + TEST_ASIN + '\n');

  // 1. POST the task
  const postResp = await dfs('POST', '/merchant/amazon/asin/task_post', [{
    asin: TEST_ASIN,
    language_code: 'en_US',
    location_code: 2840,
    tag: 'probe',
  }]);
  const task = postResp.tasks?.[0];
  if (!task?.id) {
    console.error('No task id returned. Raw:', JSON.stringify(postResp, null, 2).slice(0, 600));
    process.exit(1);
  }
  console.log('Task posted: ' + task.id + '  (status ' + task.status_code + ' ' + task.status_message + ')');

  // 2. poll task_get/advanced
  console.log('Waiting 12s before first poll...');
  await new Promise(r => setTimeout(r, 12000));

  let item = null;
  for (let poll = 1; poll <= 10; poll++) {
    const resp = await dfs('GET', '/merchant/amazon/asin/task_get/advanced/' + task.id);
    const t = resp.tasks?.[0];
    const pending = !t || t.status_code === 20100 || t.status_code === 40602 || !t.result;
    if (pending) {
      console.log('  poll ' + poll + ': pending (status ' + (t?.status_code) + ')...');
      await new Promise(r => setTimeout(r, 8000));
      continue;
    }
    if (t.status_code !== 20000) {
      console.error('Task failed: ' + t.status_code + ' ' + t.status_message);
      process.exit(1);
    }
    item = t.result?.[0]?.items?.[0] || null;
    console.log('  poll ' + poll + ': DONE.\n');
    break;
  }
  if (!item) { console.error('No item in result after polling.'); process.exit(1); }

  // 3. report
  console.log('━━━ TOP-LEVEL KEYS of result item ━━━');
  console.log(Object.keys(item).join(', '));
  console.log('');

  console.log('━━━ REVIEW / RATING KEYS (recursive scan) ━━━');
  const hits = huntReviewKeys(item);
  if (hits.length) hits.forEach(h => console.log('  ' + h));
  else console.log('  (none found — no review/rating keys anywhere in the response)');
  console.log('');

  // if there's a reviews array, show one entry's shape
  const tryPaths = ['reviews', 'top_reviews', 'product_reviews', 'reviews_data'];
  for (const p of tryPaths) {
    if (Array.isArray(item[p]) && item[p].length) {
      console.log('━━━ SAMPLE from item.' + p + '[0] ━━━');
      console.log(JSON.stringify(item[p][0], null, 2).slice(0, 1200));
      console.log('');
    }
  }

  console.log('━━━ FULL ITEM (first 2500 chars) ━━━');
  console.log(JSON.stringify(item, null, 2).slice(0, 2500));
  console.log('\n━━━ END PROBE ━━━');
})();
