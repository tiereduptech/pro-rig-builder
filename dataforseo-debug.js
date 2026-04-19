/**
 * dataforseo-debug.js — inspect why filters reject all items
 *
 * Reuses the already-completed task IDs from the last discover run
 * (stored in catalog-build/amazon-discovery/_tasks.json) so we don't
 * spend more money. Fetches those results and dumps the first 3
 * items with ALL relevant fields so we can fix the filters.
 */

import { readFileSync } from 'fs';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: AUTH },
  });
  return res.json();
}

async function main() {
  const tasks = JSON.parse(readFileSync('./catalog-build/amazon-discovery/_tasks.json', 'utf-8'));
  console.log(`Loaded ${tasks.length} task ids from _tasks.json\n`);

  // Fetch first task's results
  const task = tasks[0];
  console.log(`Fetching results for task "${task.keyword}" (${task.id})...\n`);

  const resp = await get(`/merchant/amazon/products/task_get/advanced/${task.id}`);
  const items = resp.tasks?.[0]?.result?.[0]?.items || [];

  console.log(`Got ${items.length} raw items.\n`);
  console.log('═══ FIRST 3 ITEMS — FULL STRUCTURE ═══\n');

  for (let i = 0; i < Math.min(3, items.length); i++) {
    console.log(`───── Item ${i+1} ─────`);
    console.log(JSON.stringify(items[i], null, 2));
    console.log();
  }

  console.log('═══ KEY FIELD SUMMARY (all items) ═══\n');
  console.log('i | title (40ch) | price | reviews | type | asin');
  console.log('--+---------------------------------------+-------+---------+---------+--------');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const title = (it.title || '(no title)').slice(0, 40);
    const price = it.price?.current ?? it.price_from ?? '?';
    const reviews = it.rating?.votes_count ?? '?';
    const type = it.type || '?';
    console.log(`${String(i).padStart(2)} | ${title.padEnd(40)} | ${String(price).padStart(5)} | ${String(reviews).padStart(7)} | ${type.padEnd(7)} | ${it.asin || '?'}`);
  }

  console.log('\n═══ TYPE DISTRIBUTION ═══');
  const types = {};
  for (const it of items) types[it.type || 'none'] = (types[it.type || 'none'] || 0) + 1;
  for (const [t, n] of Object.entries(types)) console.log(`  ${t}: ${n}`);

  console.log('\n═══ PRICE FIELD PRESENCE ═══');
  let hasPriceCurrent = 0, hasPriceFrom = 0, hasNeither = 0;
  for (const it of items) {
    if (it.price?.current != null) hasPriceCurrent++;
    else if (it.price_from != null) hasPriceFrom++;
    else hasNeither++;
  }
  console.log(`  price.current present: ${hasPriceCurrent}`);
  console.log(`  price_from present:    ${hasPriceFrom}`);
  console.log(`  neither present:       ${hasNeither}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
