#!/usr/bin/env node
/**
 * fetch-amazon-images-v3.js
 *
 * v3 changes vs v2:
 *   - Drains the ready queue BEFORE posting new tasks (cleans old tasks)
 *   - Longer poll window (60 attempts × 10s = 10 minutes)
 *   - Saves partial progress after every poll (survives Ctrl-C)
 *   - Skips products where DataForSEO returns empty items (dead ASIN)
 *
 * Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 * Usage:
 *   railway run node fetch-amazon-images-v3.js --dry
 *   railway run node fetch-amazon-images-v3.js
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
const TARGET_CATS = ['OpticalDrive', 'WiFiCard', 'EthernetCard', 'SoundCard'];
const DRY = process.argv.includes('--dry');

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ─── Check which products have broken/missing images ───────────────────────
async function checkUrl(url) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

console.log('━━━ CHECKING IMAGE URLS ━━━');
const candidates = [];
for (const p of parts) {
  if (!TARGET_CATS.includes(p.c)) continue;
  if (!p.asin) continue;
  const ok = await checkUrl(p.img);
  if (!ok) candidates.push(p);
}
console.log(`  ${candidates.length} products need fresh images`);
console.log(`  Estimated cost: $${(candidates.length * 0.0015).toFixed(2)}`);

if (DRY) {
  console.log('\n--dry; exiting');
  process.exit(0);
}
if (candidates.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// ─── STEP 0: Drain any stale tasks from earlier runs ───────────────────
async function drainStale() {
  let drained = 0;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/v3/merchant/amazon/asin/tasks_ready`, {
      headers: { 'Authorization': `Basic ${AUTH}` },
    });
    const j = await r.json();
    const ids = (j.tasks?.[0]?.result || []).map(x => x.id);
    if (!ids.length) break;
    for (const id of ids) {
      // Just GET to clear it from ready queue
      await fetch(`${BASE}/v3/merchant/amazon/asin/task_get/advanced/${id}`, {
        headers: { 'Authorization': `Basic ${AUTH}` },
      });
      drained++;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (drained) console.log(`  Drained ${drained} stale tasks from earlier runs`);
}
console.log('\n━━━ STEP 0: DRAINING STALE QUEUE ━━━');
await drainStale();

// ─── STEP 1: Post fresh tasks ──────────────────────────────────────────
async function postTasks(asins) {
  const body = asins.map(asin => ({ language_code: 'en_US', location_code: 2840, asin, priority: 1 }));
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
  return (json.tasks || []).map(t => ({ id: t.id, asin: t.data?.asin }));
}

console.log(`\n━━━ STEP 1: POSTING ${candidates.length} TASKS ━━━`);
const taskMap = new Map();
const BATCH = 50;
for (let i = 0; i < candidates.length; i += BATCH) {
  const chunk = candidates.slice(i, i + BATCH);
  process.stdout.write(`  Batch ${i / BATCH + 1} (${chunk.length} ASINs)... `);
  const posted = await postTasks(chunk.map(p => p.asin));
  posted.forEach(t => { if (t.id && t.asin) taskMap.set(t.id, t.asin); });
  console.log(`${posted.length} accepted`);
  await new Promise(r => setTimeout(r, 500));
}

// ─── STEP 2: Poll + fetch until all tasks complete ─────────────────────
const results = new Map();
const emptyAsins = new Set();  // ASINs DataForSEO can't find
const pending = new Set(taskMap.keys());
const MAX_POLLS = 60; // 10 min max

function writeProgress() {
  // Patch parts + save after every poll so we don't lose progress
  let updated = 0;
  for (const p of parts) {
    if (p.asin && results.has(p.asin)) {
      const img = results.get(p.asin);
      if (img && img !== p.img) { p.img = img; updated++; }
    }
  }
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);
  return updated;
}

console.log(`\n━━━ STEP 2: POLLING (up to ${MAX_POLLS * 10}s) ━━━`);
for (let attempt = 1; attempt <= MAX_POLLS && pending.size > 0; attempt++) {
  await new Promise(r => setTimeout(r, 10000));

  // Get list of ready tasks
  const r = await fetch(`${BASE}/v3/merchant/amazon/asin/tasks_ready`, {
    headers: { 'Authorization': `Basic ${AUTH}` },
  });
  const j = await r.json();
  const ready = (j.tasks?.[0]?.result || []).map(x => x.id).filter(id => pending.has(id));

  process.stdout.write(`  Poll ${attempt}: ${ready.length} new / ${pending.size} pending ... `);

  // Fetch each ready task
  for (const taskId of ready) {
    try {
      const gr = await fetch(`${BASE}/v3/merchant/amazon/asin/task_get/advanced/${taskId}`, {
        headers: { 'Authorization': `Basic ${AUTH}` },
      });
      const gj = await gr.json();
      const item = gj?.tasks?.[0]?.result?.[0]?.items?.[0];
      const asin = taskMap.get(taskId);
      if (item?.image_url && asin) {
        results.set(asin, item.image_url);
      } else if (asin) {
        emptyAsins.add(asin);
      }
    } catch (e) {
      // swallow & move on
    }
    pending.delete(taskId);
    await new Promise(r => setTimeout(r, 150));
  }

  const updated = writeProgress();
  console.log(`fetched ${results.size}, empty ${emptyAsins.size}, saved ${updated}`);
}

if (pending.size > 0) {
  console.log(`\n⚠️  ${pending.size} tasks never completed within poll window`);
  console.log('   (may still complete later; run the drain script to catch them)');
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────
console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  Images fetched:      ${results.size}`);
console.log(`  Empty (dead ASIN):   ${emptyAsins.size}`);
console.log(`  Stuck/timed out:     ${pending.size}`);

if (emptyAsins.size > 0) {
  console.log(`\n  Products with dead ASINs (remove or re-find):`);
  for (const a of emptyAsins) {
    const p = parts.find(x => x.asin === a);
    if (p) console.log(`    [${p.c}] ${a} | ${p.n.slice(0, 60)}`);
  }
}

// Final live-image check
console.log(`\n━━━ FINAL LIVE-IMAGE COVERAGE ━━━`);
for (const c of TARGET_CATS) {
  const f = parts.filter(p => p.c === c);
  let live = 0;
  for (const p of f) {
    if (!p.img) continue;
    const ok = await checkUrl(p.img);
    if (ok) live++;
  }
  console.log(`  ${c.padEnd(14)} ${live}/${f.length} live`);
}
