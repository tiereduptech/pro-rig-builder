#!/usr/bin/env node
/**
 * fetch-amazon-images.js
 *
 * Pulls Amazon product images for products with ASINs but missing/broken
 * img URLs. Uses DataForSEO Merchant Amazon ASIN endpoint.
 *
 * Flow:
 *   1. Collect products with ASIN but img blank or looks fake
 *   2. POST batch of ASINs to /v3/merchant/amazon/asin/task_post
 *      (up to 100 per batch, ~$0.003 per ASIN)
 *   3. Poll /v3/merchant/amazon/asin/tasks_ready until tasks complete
 *   4. GET each task result and extract image_url
 *   5. Patch parts.js with new image URLs
 *
 * Cost: $0.003 × ~45 products = ~$0.14
 * Time: ~1-3 min (tasks take 10-60 sec each to complete)
 *
 * Usage:
 *   railway run node fetch-amazon-images.js             # all 3 categories
 *   railway run node fetch-amazon-images.js WiFiCard    # single category
 *   railway run node fetch-amazon-images.js --dry       # just report, don't run
 */
import { writeFileSync } from 'node:fs';

const DFS_LOGIN = process.env.DATAFORSEO_LOGIN;
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!DFS_LOGIN || !DFS_PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');
  process.exit(1);
}

const AUTH = Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const targetCat = args.find(a => !a.startsWith('--'));

const TARGET_CATS = targetCat ? [targetCat] : ['OpticalDrive', 'WiFiCard', 'EthernetCard'];

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ─── Identify products that need images ────────────────────────────────────
function needsImage(p) {
  if (!p.asin) return false;
  if (!p.img || p.img === '') return true;
  // Look for suspicious image URLs that might be fake/generic
  // Real Amazon images are /I/[alphanum]._AC_SL300_.jpg style
  if (!p.img.includes('media-amazon.com')) return true;
  return false;
}

const candidates = parts.filter(p => TARGET_CATS.includes(p.c) && needsImage(p));
console.log(`━━━ SCOPE ━━━`);
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c);
  const needs = all.filter(needsImage);
  console.log(`  ${c.padEnd(14)} ${needs.length}/${all.length} need images`);
}
console.log(`\nTotal to fetch: ${candidates.length}`);
console.log(`Estimated cost: $${(candidates.length * 0.003).toFixed(2)}`);

if (DRY) {
  console.log('\n--dry flag set; showing first 10 candidates:');
  candidates.slice(0, 10).forEach(p => console.log(`  [${p.c}] ${p.asin} | ${p.n.slice(0, 60)}`));
  process.exit(0);
}

if (candidates.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// ─── STEP 1: Post tasks ────────────────────────────────────────────────────
async function postTasks(asins) {
  const body = asins.map(asin => ({
    language_code: 'en_US',
    location_code: 2840,
    asin,
    priority: 1, // 1 = normal, 2 = high ($$ more)
  }));
  const res = await fetch(`${BASE}/v3/merchant/amazon/asin/task_post`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.status_code !== 20000) {
    console.error('Task post failed:', json.status_message);
    return [];
  }
  // Returns a task per ASIN, each with an id
  return (json.tasks || []).map(t => ({ id: t.id, asin: t.data?.asin, status: t.status_code }));
}

console.log(`\n━━━ POSTING ${candidates.length} TASKS ━━━`);
const BATCH = 50;
const taskMap = new Map(); // task_id → ASIN
for (let i = 0; i < candidates.length; i += BATCH) {
  const chunk = candidates.slice(i, i + BATCH);
  const asins = chunk.map(p => p.asin);
  process.stdout.write(`  Batch ${i / BATCH + 1}: ${asins.length} ASINs ... `);
  const posted = await postTasks(asins);
  posted.forEach(t => { if (t.id && t.asin) taskMap.set(t.id, t.asin); });
  const ok = posted.filter(t => t.status === 20100).length;
  console.log(`${ok} accepted`);
  await new Promise(r => setTimeout(r, 500));
}
console.log(`\nTotal tasks posted: ${taskMap.size}`);

// ─── STEP 2: Poll for completion ────────────────────────────────────────
async function pollReady() {
  const res = await fetch(`${BASE}/v3/merchant/amazon/asin/tasks_ready`, {
    headers: { 'Authorization': `Basic ${AUTH}` },
  });
  const json = await res.json();
  const ready = [];
  for (const t of (json.tasks || [])) {
    for (const r of (t.result || [])) {
      if (r.id) ready.push(r.id);
    }
  }
  return ready;
}

console.log(`\n━━━ POLLING FOR COMPLETION ━━━`);
const results = new Map(); // asin → image_url
const pending = new Set(taskMap.keys());
const MAX_POLLS = 30; // up to ~5 minutes total
for (let attempt = 1; attempt <= MAX_POLLS && pending.size > 0; attempt++) {
  await new Promise(r => setTimeout(r, 10000)); // 10s between polls
  const ready = await pollReady();
  const newReady = ready.filter(id => pending.has(id));
  process.stdout.write(`  Poll ${attempt}: ${newReady.length} newly ready, ${pending.size - newReady.length} still pending ... `);

  // Fetch each ready task
  for (const taskId of newReady) {
    try {
      const res = await fetch(`${BASE}/v3/merchant/amazon/asin/task_get/advanced/${taskId}`, {
        headers: { 'Authorization': `Basic ${AUTH}` },
      });
      const json = await res.json();
      const item = json?.tasks?.[0]?.result?.[0]?.items?.[0];
      const asin = taskMap.get(taskId);
      if (item?.image_url && asin) {
        results.set(asin, item.image_url);
      }
    } catch (e) {
      console.error(`  Error fetching task ${taskId}:`, e.message);
    }
    pending.delete(taskId);
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`(total fetched: ${results.size})`);
}

if (pending.size > 0) {
  console.log(`\n⚠️  ${pending.size} tasks never completed within poll window (may still be running)`);
}

// ─── STEP 3: Apply images to parts.js ────────────────────────────────────
console.log(`\n━━━ APPLYING ${results.size} IMAGES ━━━`);
let updated = 0;
for (const p of parts) {
  if (p.asin && results.has(p.asin)) {
    const newImg = results.get(p.asin);
    if (newImg && newImg !== p.img) {
      p.img = newImg;
      updated++;
    }
  }
}
console.log(`Updated ${updated} product image URLs`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

// ─── SUMMARY ───────────────────────────────────────────────────────────
console.log(`\n━━━ FINAL COVERAGE ━━━`);
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c);
  const withImg = all.filter(p => p.img && p.img.includes('media-amazon.com'));
  console.log(`  ${c.padEnd(14)} ${withImg.length}/${all.length} with Amazon images  (${Math.round(withImg.length / all.length * 100)}%)`);
}
