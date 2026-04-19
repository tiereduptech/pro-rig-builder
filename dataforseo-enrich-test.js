/**
 * dataforseo-enrich-test.js — test ASIN enrichment on 5 products
 *
 * Before spending $3.11 enriching all 2,073 new products, we test the
 * endpoint on 5 ASINs (one per major category) to see what fields come
 * back. Based on the response shape, we'll map fields to your schema
 * correctly in the full enrichment script.
 *
 * Cost: ~$0.008 (5 ASIN calls at $0.0015 each + $0 for result retrieval)
 * Runtime: ~1-2 minutes (task-based with polling)
 *
 * Endpoint used:
 *   POST /v3/merchant/amazon/asin/task_post
 *   GET  /v3/merchant/amazon/asin/tasks_ready
 *   GET  /v3/merchant/amazon/asin/task_get/advanced/{id}
 */

import { writeFileSync, mkdirSync } from 'fs';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('✗ Missing DATAFORSEO env vars.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

// One ASIN per major category — cover the spec-structure variation
const TEST_ASINS = [
  { asin: 'B0DDZNZF76', category: 'Motherboard', hint: 'ASUS ROG Strix X870E-E' },
  { asin: 'B0DHLBDSRL', category: 'CPU',         hint: 'Ryzen 9 9950X' },
  { asin: 'B0CZ7PL123', category: 'GPU',         hint: 'RTX 5090 (guess)' },
  { asin: 'B0B5W2Q5C8', category: 'RAM',         hint: 'Corsair Vengeance DDR5' },
  { asin: 'B0B4M4CM7P', category: 'Storage',     hint: 'WD SN850X or similar' },
];

async function dfsRequest(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = 3000 + attempt * 5000;
        console.log(`   ⚠ HTTP ${res.status} — backing off ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('retries exhausted');
}

async function main() {
  console.log('\n── DataForSEO ASIN Enrichment Test (5 products) ──\n');
  mkdirSync('./catalog-build/asin-test', { recursive: true });

  // Phase 1: submit all 5 tasks
  console.log('Submitting tasks...');
  const body = TEST_ASINS.map(t => ({
    asin: t.asin,
    location_code: 2840,
    language_code: 'en_US',
    load_more_local_reviews: false,
    tag: t.category,
  }));

  const resp = await dfsRequest('POST', '/merchant/amazon/asin/task_post', body);
  if (resp.status_code !== 20000) {
    console.error(`✗ Submit failed: ${resp.status_code} ${resp.status_message}`);
    process.exit(1);
  }

  const tasks = [];
  for (let i = 0; i < resp.tasks.length; i++) {
    const t = resp.tasks[i];
    if (t.status_code !== 20100) {
      console.log(`  ⚠ task for ${TEST_ASINS[i].asin}: ${t.status_code} ${t.status_message}`);
      continue;
    }
    tasks.push({ id: t.id, ...TEST_ASINS[i] });
  }
  console.log(`✓ ${tasks.length}/${TEST_ASINS.length} tasks submitted`);

  // Phase 2: poll for completion
  console.log('\nPolling for completion...');
  const pending = new Set(tasks.map(t => t.id));
  const startWait = Date.now();

  while (pending.size > 0) {
    if (Date.now() - startWait > 300000) { // 5 min cap
      console.log(`   timeout — ${pending.size} still pending`);
      break;
    }
    await new Promise(r => setTimeout(r, 8000));

    const ready = await dfsRequest('GET', '/merchant/amazon/asin/tasks_ready');
    let newlyReady = 0;
    for (const task of ready.tasks || []) {
      for (const result of task.result || []) {
        if (pending.has(result.id)) {
          pending.delete(result.id);
          newlyReady++;
        }
      }
    }
    const elapsed = Math.round((Date.now() - startWait) / 1000);
    console.log(`   [${elapsed}s] +${newlyReady} ready, ${pending.size} still pending`);
  }

  // Phase 3: fetch results
  console.log('\nFetching results...');
  for (const task of tasks) {
    if (pending.has(task.id)) continue;

    const data = await dfsRequest('GET', `/merchant/amazon/asin/task_get/advanced/${task.id}`);
    const items = data.tasks?.[0]?.result?.[0]?.items || [];
    const item = items[0];

    const outPath = `./catalog-build/asin-test/${task.category}-${task.asin}.json`;
    writeFileSync(outPath, JSON.stringify(item || { error: 'no items' }, null, 2));

    console.log(`\n───── ${task.category} (${task.asin}) — ${task.hint} ─────`);
    if (!item) {
      console.log('  ✗ No items returned');
      continue;
    }

    // Print the top-level structure
    console.log(`  Top-level keys: ${Object.keys(item).join(', ')}`);

    // Print key fields we care about
    console.log(`  title: ${(item.title || '').slice(0, 80)}`);
    console.log(`  price: ${JSON.stringify(item.price)}`);
    console.log(`  brand: ${item.brand || '?'}`);
    console.log(`  manufacturer: ${item.manufacturer || '?'}`);
    console.log(`  model: ${item.model || '?'}`);
    console.log(`  product_id: ${item.product_id || '?'}`);

    // Product specs table — the money field
    const specs = item.product_information || item.product_details || item.specifications;
    if (specs) {
      console.log(`  product_information: ${Array.isArray(specs) ? specs.length : Object.keys(specs).length} entries`);
      if (Array.isArray(specs)) {
        for (const s of specs.slice(0, 8)) console.log(`    - ${s.name || s.title}: ${s.value || s.text}`);
      } else {
        for (const [k, v] of Object.entries(specs).slice(0, 8)) console.log(`    - ${k}: ${JSON.stringify(v).slice(0, 60)}`);
      }
    } else {
      console.log(`  product_information: NOT FOUND`);
    }

    // Bullets
    if (item.bullets) console.log(`  bullets: ${item.bullets.length} items`);

    // Categories
    if (item.categories) console.log(`  categories: ${item.categories.length} entries`);

    // Full result sample written to file
    console.log(`  → Full JSON saved to ${outPath}`);
  }

  console.log('\n── Test Complete ──');
  console.log('Inspect the JSON files in ./catalog-build/asin-test/ to see the full field structure.');
  console.log('Based on what you see, we\'ll build the full enrichment script to map fields correctly.');
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
