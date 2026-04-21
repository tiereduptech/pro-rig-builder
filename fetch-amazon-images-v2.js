#!/usr/bin/env node
/**
 * fetch-amazon-images-v2.js
 *
 * v2 changes vs v1:
 *   - needsImage() uses HTTP HEAD on existing URL (catches 404s from
 *     guessed image paths, not just blank/wrong-domain)
 *   - Walks DataForSEO response tree more thoroughly for image_url
 *     (schema has items[0].image_url OR items[0].details.image[0].url)
 *
 * Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 * Cost: ~$0.0015 per ASIN × ~41 products = ~$0.06
 *
 * Usage:
 *   railway run node fetch-amazon-images-v2.js --dry
 *   railway run node fetch-amazon-images-v2.js
 *   railway run node fetch-amazon-images-v2.js WiFiCard
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
const TARGET_CATS = targetCat ? [targetCat] : ['OpticalDrive', 'WiFiCard', 'EthernetCard', 'SoundCard'];

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ─── Check which products actually have broken images ─────────────────────
async function checkUrl(url) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

console.log('━━━ CHECKING EXISTING IMAGE URLS ━━━');
const candidates = [];
for (const p of parts) {
  if (!TARGET_CATS.includes(p.c)) continue;
  if (!p.asin) continue;
  if (!p.img) {
    candidates.push(p);
    continue;
  }
  const ok = await checkUrl(p.img);
  if (!ok) candidates.push(p);
}

console.log('\n━━━ SCOPE ━━━');
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c && p.asin);
  const needs = candidates.filter(p => p.c === c);
  console.log(`  ${c.padEnd(14)} ${needs.length}/${all.length} need fresh images`);
}
console.log(`\nTotal to fetch: ${candidates.length}`);
console.log(`Estimated cost: $${(candidates.length * 0.0015).toFixed(2)}`);

if (DRY) {
  console.log('\n--dry; first 10:');
  candidates.slice(0, 10).forEach(p => console.log(`  [${p.c}] ${p.asin} | ${p.n.slice(0, 60)}`));
  process.exit(0);
}

if (candidates.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// ─── STEP 1: Post tasks ────────────────────────────────────────────────
async function postTasks(asins) {
  const body = asins.map(asin => ({
    language_code: 'en_US',
    location_code: 2840,
    asin,
    priority: 1,
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
  return (json.tasks || []).map(t => ({ id: t.id, asin: t.data?.asin, status: t.status_code }));
}

console.log(`\n━━━ POSTING ${candidates.length} TASKS ━━━`);
const BATCH = 50;
const taskMap = new Map();
for (let i = 0; i < candidates.length; i += BATCH) {
  const chunk = candidates.slice(i, i + BATCH);
  const asins = chunk.map(p => p.asin);
  process.stdout.write(`  Batch ${i / BATCH + 1}: ${asins.length} ASINs ... `);
  const posted = await postTasks(asins);
  posted.forEach(t => { if (t.id && t.asin) taskMap.set(t.id, t.asin); });
  console.log(`${posted.length} accepted`);
  await new Promise(r => setTimeout(r, 500));
}

// ─── STEP 2: Poll for completion ───────────────────────────────────────
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

// Walk DataForSEO response tree to find image URL
function extractImage(responseJson) {
  const items = responseJson?.tasks?.[0]?.result?.[0]?.items;
  if (!items || !items.length) return null;
  const item = items[0];

  // Top-level image_url
  if (item.image_url) return item.image_url;

  // Sometimes in details.image[0].url
  if (item.details?.image?.[0]?.url) return item.details.image[0].url;
  if (item.details?.images?.[0]?.url) return item.details.images[0].url;

  // Sometimes in product_information.images[0].url
  if (item.product_information?.images?.[0]?.url) return item.product_information.images[0].url;

  // Sometimes in direct images array
  if (item.images?.[0]?.url) return item.images[0].url;
  if (Array.isArray(item.images) && typeof item.images[0] === 'string') return item.images[0];

  // Nested: walk product_images
  if (item.product_images?.[0]?.url) return item.product_images[0].url;

  return null;
}

console.log(`\n━━━ POLLING FOR COMPLETION ━━━`);
const results = new Map();
const pending = new Set(taskMap.keys());
const MAX_POLLS = 30;

for (let attempt = 1; attempt <= MAX_POLLS && pending.size > 0; attempt++) {
  await new Promise(r => setTimeout(r, 10000));
  const ready = await pollReady();
  const newReady = ready.filter(id => pending.has(id));
  process.stdout.write(`  Poll ${attempt}: ${newReady.length} new / ${pending.size} pending ... `);

  for (const taskId of newReady) {
    try {
      const res = await fetch(`${BASE}/v3/merchant/amazon/asin/task_get/advanced/${taskId}`, {
        headers: { 'Authorization': `Basic ${AUTH}` },
      });
      const json = await res.json();
      const imgUrl = extractImage(json);
      const asin = taskMap.get(taskId);
      if (imgUrl && asin) {
        results.set(asin, imgUrl);
      } else if (!imgUrl && attempt === 1) {
        // First-time no-image: dump schema for debugging
        const item = json?.tasks?.[0]?.result?.[0]?.items?.[0];
        if (item) {
          const keys = Object.keys(item);
          console.log(`\n    DEBUG (asin=${asin}): item keys:`, keys.join(', '));
        }
      }
    } catch (e) {
      console.error(`  fetch error taskId=${taskId}:`, e.message);
    }
    pending.delete(taskId);
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`(fetched ${results.size})`);
}

if (pending.size > 0) {
  console.log(`\n⚠️  ${pending.size} tasks never completed`);
}

// ─── STEP 3: Apply ─────────────────────────────────────────────────────
console.log(`\n━━━ APPLYING ${results.size} IMAGES ━━━`);
let updated = 0;
for (const p of parts) {
  if (p.asin && results.has(p.asin)) {
    p.img = results.get(p.asin);
    updated++;
  }
}
console.log(`Updated ${updated} product image URLs`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');

console.log(`\n━━━ SUMMARY ━━━`);
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c);
  const withImg = all.filter(p => p.img);
  console.log(`  ${c.padEnd(14)} ${withImg.length}/${all.length} with some image URL`);
}
