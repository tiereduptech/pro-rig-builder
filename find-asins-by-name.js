#!/usr/bin/env node
/**
 * find-asins-by-name.js
 *
 * For products with fake/dead ASINs, search Amazon for the product name
 * and find the real ASIN + image_url. Uses DataForSEO Merchant Amazon
 * Products endpoint (task POST + GET flow).
 *
 * Workflow:
 *   1. Scope: products in OpticalDrive/WiFiCard/EthernetCard/SoundCard
 *      with ASIN set AND dead image URL (confirmed via HEAD)
 *   2. Build a search query from brand + simplified name for each
 *   3. POST search tasks to /v3/merchant/amazon/products/task_post
 *   4. Poll /tasks_ready, fetch results
 *   5. For each result, pick the top organic listing and match by
 *      brand/title similarity — assume match if brand + 2+ title words
 *      overlap
 *   6. Update product with new ASIN + new deals.amazon.url + image_url
 *
 * Cost: $0.003 per search × ~39 = ~$0.12
 *
 * Usage: railway run node find-asins-by-name.js
 */
import { writeFileSync } from 'node:fs';

const DFS_LOGIN = process.env.DATAFORSEO_LOGIN;
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!DFS_LOGIN || !DFS_PASSWORD) { console.error('Missing DATAFORSEO creds'); process.exit(1); }
const AUTH = Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com';
const AMAZON_TAG = 'tiereduptech-20';
const TARGET_CATS = ['OpticalDrive', 'WiFiCard', 'EthernetCard', 'SoundCard'];
const DRY = process.argv.includes('--dry');

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ─── Which products need new ASINs? ────────────────────────────────────────
async function checkUrl(url) {
  if (!url) return false;
  try { const r = await fetch(url, { method: 'HEAD' }); return r.status >= 200 && r.status < 300; }
  catch { return false; }
}

console.log('━━━ FINDING PRODUCTS WITH DEAD IMAGES ━━━');
const candidates = [];
for (const p of parts) {
  if (!TARGET_CATS.includes(p.c)) continue;
  if (!p.asin) continue;
  const imgOk = await checkUrl(p.img);
  if (!imgOk) candidates.push(p);
}
console.log(`  ${candidates.length} products need real ASINs\n`);

if (DRY) {
  candidates.slice(0, 10).forEach(p => console.log(`  [${p.c}] ${p.asin} | ${p.n.slice(0, 60)}`));
  process.exit(0);
}
if (!candidates.length) { console.log('Nothing to do.'); process.exit(0); }

// ─── Build a good search query for each ────────────────────────────────────
// We want to find the specific model on Amazon. Strategy:
// - Start with brand + key product identifier (model number)
// - Strip marketing words like "PCIe", "Gaming", "Card", "Adapter", "Writer"
function buildQuery(p) {
  const name = p.n
    .replace(/\bPCIe?\s*3?\.?\d?\b/gi, '')
    .replace(/\bSATA\b/gi, '')
    .replace(/\b\d+x\s*(?:x\d+)?\b/gi, '')  // "PCIe 3.0 x4"
    .replace(/\bInternal\b|\bGaming\b|\bNetwork\b|\bCard\b|\bAdapter\b|\bWriter\b|\bBoard\b|\bExpansion\b|\bTri-?Band\b|\bDual-?Band\b|\bUltra\b|\bSilent\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${p.b} ${name}`.trim().replace(/\s+/g, ' ').slice(0, 80);
}

// ─── POST search tasks ─────────────────────────────────────────────────────
async function postSearchTasks(queries) {
  const body = queries.map(q => ({
    language_code: 'en_US',
    location_code: 2840,
    keyword: q,
    depth: 10, // first 10 results is plenty
    priority: 1,
  }));
  const res = await fetch(`${BASE}/v3/merchant/amazon/products/task_post`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.status_code !== 20000) {
    console.error('Post failed:', json.status_message);
    return [];
  }
  return (json.tasks || []).map(t => ({ id: t.id, keyword: t.data?.keyword }));
}

// Map: product → query
const queryFor = new Map();
for (const p of candidates) queryFor.set(p, buildQuery(p));

console.log('━━━ POSTING SEARCH TASKS ━━━');
const BATCH = 50;
// task_id → keyword
const taskKeyword = new Map();
// keyword → product
const productByKeyword = new Map();
for (const [p, q] of queryFor.entries()) productByKeyword.set(q, p);

for (let i = 0; i < candidates.length; i += BATCH) {
  const chunk = candidates.slice(i, i + BATCH);
  const queries = chunk.map(p => queryFor.get(p));
  process.stdout.write(`  Batch ${i / BATCH + 1} (${queries.length} queries)... `);
  const posted = await postSearchTasks(queries);
  posted.forEach(t => { if (t.id && t.keyword) taskKeyword.set(t.id, t.keyword); });
  console.log(`${posted.length} accepted`);
  await new Promise(r => setTimeout(r, 500));
}

// ─── Poll for completion ───────────────────────────────────────────────────
async function listReady() {
  const r = await fetch(`${BASE}/v3/merchant/amazon/products/tasks_ready`, {
    headers: { 'Authorization': `Basic ${AUTH}` },
  });
  const j = await r.json();
  return (j.tasks?.[0]?.result || []).map(x => x.id);
}

async function getTask(taskId) {
  const r = await fetch(`${BASE}/v3/merchant/amazon/products/task_get/advanced/${taskId}`, {
    headers: { 'Authorization': `Basic ${AUTH}` },
  });
  return r.json();
}

// Score a candidate Amazon result against our product name
// Returns { asin, image_url, title, score }
function pickBestMatch(searchItems, product) {
  const productWords = product.n
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
  const productBrand = product.b.toLowerCase();

  let best = null;
  for (const item of searchItems) {
    if (item.type !== 'amazon_serp' || !item.asin || !item.title) continue;
    // Skip sponsored & ads
    if (/\bsponsored\b|\bads?\b/i.test(item.title)) continue;

    const title = item.title.toLowerCase();
    const brandMatch = title.includes(productBrand);
    const wordsMatched = productWords.filter(w => title.includes(w)).length;
    const score = (brandMatch ? 100 : 0) + wordsMatched * 10;

    if (!best || score > best.score) {
      best = {
        asin: item.asin,
        image_url: item.image_url,
        title: item.title,
        price: item.price?.current ?? item.price?.price ?? null,
        score,
      };
    }
  }
  return best;
}

console.log(`\n━━━ POLLING (${taskKeyword.size} tasks) ━━━`);
const matched = new Map(); // product id → { asin, img, price }
const noMatch = [];
const pending = new Set(taskKeyword.keys());
const MAX_POLLS = 60;

for (let attempt = 1; attempt <= MAX_POLLS && pending.size > 0; attempt++) {
  await new Promise(r => setTimeout(r, 10000));
  const ready = await listReady();
  const newReady = ready.filter(id => pending.has(id));
  process.stdout.write(`  Poll ${attempt}: ${newReady.length} new / ${pending.size} pending ... `);

  for (const taskId of newReady) {
    try {
      const gj = await getTask(taskId);
      const status = gj?.tasks?.[0]?.status_code;
      if (status !== 20000) { pending.delete(taskId); continue; }
      const keyword = taskKeyword.get(taskId);
      const product = productByKeyword.get(keyword);
      if (!product) { pending.delete(taskId); continue; }

      const items = gj?.tasks?.[0]?.result?.[0]?.items || [];
      const best = pickBestMatch(items, product);
      if (best && best.score >= 30) {
        matched.set(product.id, {
          asin: best.asin,
          img: best.image_url,
          price: best.price,
          title: best.title,
        });
      } else {
        noMatch.push({ product, bestScore: best?.score || 0, bestTitle: best?.title });
      }
    } catch (e) {
      // ignore
    }
    pending.delete(taskId);
    await new Promise(r => setTimeout(r, 150));
  }

  // Save progress to parts.js every poll
  for (const p of parts) {
    if (matched.has(p.id)) {
      const m = matched.get(p.id);
      p.asin = m.asin;
      if (m.img) p.img = m.img;
      if (m.price) p.pr = Math.round(m.price);
      p.deals = {
        ...(p.deals || {}),
        amazon: { price: Math.round(m.price || p.pr), url: `https://www.amazon.com/dp/${m.asin}?tag=${AMAZON_TAG}`, inStock: true },
      };
    }
  }
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);

  console.log(`matched ${matched.size}, no-match ${noMatch.length}`);
}

// ─── Report ────────────────────────────────────────────────────────────────
console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  Matched:   ${matched.size}`);
console.log(`  No match:  ${noMatch.length}`);
console.log(`  Stuck:     ${pending.size}`);

if (noMatch.length) {
  console.log(`\n  Low-confidence / no match (you may want to manually verify):`);
  noMatch.slice(0, 20).forEach(nm => {
    console.log(`    [${nm.product.c}] ${nm.product.n.slice(0, 60)}`);
    console.log(`      → best was: "${(nm.bestTitle || '').slice(0, 70)}" (score ${nm.bestScore})`);
  });
}

// Verify final live images
console.log(`\n━━━ VERIFYING ${matched.size} NEW IMAGES ━━━`);
let live = 0;
for (const [pid, m] of matched.entries()) {
  if (await checkUrl(m.img)) live++;
}
console.log(`  ${live}/${matched.size} images verified live on Amazon CDN`);

console.log('\nDone.');
