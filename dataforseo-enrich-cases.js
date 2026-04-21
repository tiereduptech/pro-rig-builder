#!/usr/bin/env node
/**
 * dataforseo-enrich-cases.js — re-enrich Amazon Case products with full spec
 * data (maxGPU, maxCooler, fans_inc, rads, drive25, drive35) via DataForSEO.
 *
 * Endpoint: /v3/merchant/amazon/asin/task_post  →  tasks_ready  →  task_get
 * Cost:     ~$0.0015 per ASIN × ~224 cases = ~$0.34
 * Runtime:  ~10-20 minutes (task-based API with polling)
 *
 * USAGE:
 *   railway run node dataforseo-enrich-cases.js --dry-run      # plan only, no $ spend
 *   railway run node dataforseo-enrich-cases.js --limit 5      # test 5 ASINs (~$0.008)
 *   railway run node dataforseo-enrich-cases.js                # full run (~$0.34)
 *   railway run node dataforseo-enrich-cases.js --resume       # continue interrupted
 *   railway run node dataforseo-enrich-cases.js --apply-only   # skip fetch, apply cached results
 *
 * Output:
 *   catalog-build/case-enrich/{ASIN}.json     — raw responses
 *   catalog-build/case-enrich/_progress.json  — which ASINs done/failed
 *   catalog-build/case-enrich/_tasks.json     — in-flight task IDs
 *   src/data/parts.js                         — updated in place at end
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('✗ Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD env vars.');
  console.error('  Run with: railway run node dataforseo-enrich-cases.js');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const OUTPUT_DIR = './catalog-build/case-enrich';
const PROGRESS_PATH = join(OUTPUT_DIR, '_progress.json');
const TASKS_PATH = join(OUTPUT_DIR, '_tasks.json');

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_WAIT_MS = 1_800_000;
const GET_CONCURRENCY = 5;

// ─── CLI flags ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getFlag = (n, hasVal = false) => {
  const i = args.indexOf(n);
  if (i === -1) return hasVal ? null : false;
  return hasVal ? args[i + 1] : true;
};
const flags = {
  dryRun:    getFlag('--dry-run'),
  limit:     Number(getFlag('--limit', true)) || null,
  resume:    getFlag('--resume'),
  applyOnly: getFlag('--apply-only'),
};

// ─── Setup ──────────────────────────────────────────────────────────────────
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
const progress = existsSync(PROGRESS_PATH)
  ? JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'))
  : { done: {}, failed: {} };
const saveProgress = () => writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

// ─── Load catalog ───────────────────────────────────────────────────────────
const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// Candidates: Case products with ASIN and missing key specs
const candidates = parts.filter(p =>
  p.c === 'Case'
  && p.asin
  && (!p.maxGPU || !p.fans_inc || !p.rads)
);

const target = flags.limit ? candidates.slice(0, flags.limit) : candidates;
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DataForSEO Amazon re-enrichment for Case products');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Candidates missing specs:', candidates.length);
console.log('Processing:', target.length);
console.log('Estimated cost: $' + (target.length * 0.0015).toFixed(3));
console.log('Already done:', Object.keys(progress.done).length);
console.log('Previously failed:', Object.keys(progress.failed).length);
console.log('Dry run:', flags.dryRun);
console.log('Apply-only:', flags.applyOnly);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (flags.dryRun) {
  console.log('DRY RUN — would enrich:');
  target.slice(0, 10).forEach(p => console.log('  ' + p.asin + '  ' + p.n.slice(0, 70)));
  if (target.length > 10) console.log('  ... and ' + (target.length - 10) + ' more');
  process.exit(0);
}

// ─── Spec parser ────────────────────────────────────────────────────────────
function parseSpecs(item) {
  const specs = {};
  if (!item) return specs;

  // Collect all searchable text:
  //   - title
  //   - description
  //   - product_information[].body (structured key-value dict per section)
  //   - product_information[].contents[].rows[].text (nested bullet sections)
  const parts = [];
  if (item.title) parts.push(item.title);
  if (item.description) parts.push(item.description);

  const pi = item.product_information || [];
  const bodyKV = {};       // flat key-value from all "Features & Specs" style sections
  for (const section of pi) {
    if (section?.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) {
        bodyKV[k.toLowerCase()] = String(v);
        parts.push(`${k}: ${v}`);
      }
    }
    // nested rows
    for (const c of (section?.contents || [])) {
      for (const row of (c?.rows || [])) {
        if (row?.text) parts.push(row.text);
      }
    }
  }
  const text = parts.join(' \n ');

  // ─── Max GPU Length ──
  //   "Supports up to 340 mm GPU", "GPU Clearance: 365mm", "GPU Length 400mm"
  let m = text.match(/(?:up to\s*)?(\d{3})\s*mm\s*GPU(?:\s*(?:in\s*)?length)?/i);
  if (m) specs.maxGPU = parseInt(m[1]);
  else {
    m = text.match(/GPU\s*(?:Clearance|Length|Support|Max)\s*[:\-–]?\s*(\d{3})\s*mm/i);
    if (m) specs.maxGPU = parseInt(m[1]);
  }

  // ─── Max Cooler Height ──
  m = text.match(/(?:Max(?:imum)?\s*(?:CPU\s*)?(?:Air\s*)?Cooler|CPU\s*Cooler\s*(?:Height|Clearance))[^:\n]*?[:\-–]?\s*(\d{2,3})\s*mm/i);
  if (m) specs.maxCooler = parseInt(m[1]);

  // ─── Fans Included ──
  //   "1 x Pre-Installed Fan", "Pre-installed 3 fans", "Includes 6 ARGB fans"
  m = text.match(/(\d{1,2})\s*x\s*Pre[-\s]?Installed\s*Fans?/i);
  if (m) specs.fans_inc = parseInt(m[1]);
  else {
    m = text.match(/Pre[-\s]?Install(?:ed)?\s*(\d{1,2})\s*(?:x\s*\d+mm)?\s*(?:ARGB\s*|RGB\s*|PWM\s*)*fans?/i);
    if (m) specs.fans_inc = parseInt(m[1]);
  }
  if (specs.fans_inc == null) {
    m = text.match(/Includes?\s*(\d{1,2})\s*(?:x\s*\d+mm\s*)?(?:ARGB\s*|RGB\s*|PWM\s*)*fans?/i);
    if (m) specs.fans_inc = parseInt(m[1]);
  }

  // ─── Radiator Support ──
  //   Collect all mentioned radiator sizes in the text (360mm, 280mm, 240mm, 120mm)
  const rads = new Set();
  const radPat = /(\d{3})\s*mm\s*(?:AIO\s*)?(?:Radiator|rad\b)/gi;
  let r;
  while ((r = radPat.exec(text)) !== null) {
    const n = parseInt(r[1]);
    if ([120, 140, 240, 280, 360, 420].includes(n)) rads.add(n + 'mm');
  }
  if (rads.size) specs.rads = [...rads].sort().join(',');

  // ─── Drive Bays from structured body ──
  if (bodyKV['internal bays quantity']) {
    const n = parseInt(bodyKV['internal bays quantity']);
    if (n) {
      // We don't know 2.5 vs 3.5 from this field alone, but Hard Disk Form Factor tells us
      const form = bodyKV['hard disk form factor'] || '';
      if (/3\.5/.test(form)) specs.drive35 = n;
      else if (/2\.5/.test(form)) specs.drive25 = n;
    }
  }

  return specs;
}

// ─── DataForSEO task POST/GET helpers ───────────────────────────────────────
async function postTasks(asins) {
  const resp = await fetch(`${BASE}/merchant/amazon/asin/task_post`, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(asins.map(asin => ({
      asin,
      language_code: 'en_US',
      location_code: 2840, // US
    }))),
  });
  if (!resp.ok) throw new Error(`task_post ${resp.status}`);
  const json = await resp.json();
  const tasks = {};
  (json.tasks || []).forEach((t, i) => {
    if (t.id && t.status_code === 20100) {
      tasks[asins[i]] = t.id;
    } else {
      progress.failed[asins[i]] = { stage: 'post', code: t.status_code, msg: t.status_message };
    }
  });
  return tasks;
}

async function fetchReady() {
  const resp = await fetch(`${BASE}/merchant/amazon/asin/tasks_ready`, {
    headers: { 'Authorization': AUTH },
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  const ids = new Set();
  (json.tasks || []).forEach(t => (t.result || []).forEach(r => ids.add(r.id)));
  return [...ids];
}

async function getTask(id, asin) {
  const resp = await fetch(`${BASE}/merchant/amazon/asin/task_get/advanced/${id}`, {
    headers: { 'Authorization': AUTH },
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const task = (json.tasks || [])[0];
  if (!task || !task.result) return null;
  writeFileSync(join(OUTPUT_DIR, `${asin}.json`), JSON.stringify(task.result, null, 2));
  return task.result?.[0]?.items?.[0] || null;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function run() {
  // Step 1: POST tasks for ASINs not yet done
  const toPost = target
    .map(p => p.asin)
    .filter(asin => !progress.done[asin] && !progress.failed[asin]);

  let tasks = existsSync(TASKS_PATH) && flags.resume
    ? JSON.parse(readFileSync(TASKS_PATH, 'utf8'))
    : {};

  if (!flags.applyOnly && !flags.resume && toPost.length) {
    console.log('POSTing', toPost.length, 'tasks in batches of', BATCH_SIZE, '...');
    for (let i = 0; i < toPost.length; i += BATCH_SIZE) {
      const batch = toPost.slice(i, i + BATCH_SIZE);
      const batchTasks = await postTasks(batch);
      Object.assign(tasks, batchTasks);
      writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2));
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${Object.keys(batchTasks).length}/${batch.length} posted`);
    }
    saveProgress();
  }

  // Step 2: Poll for ready and fetch
  if (!flags.applyOnly) {
    const pending = { ...tasks };
    const start = Date.now();
    while (Object.keys(pending).length > 0 && Date.now() - start < MAX_POLL_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const readyIds = new Set(await fetchReady());
      const readyEntries = Object.entries(pending).filter(([, id]) => readyIds.has(id));
      console.log(`  Ready: ${readyEntries.length} / ${Object.keys(pending).length} pending`);

      // Fetch in parallel (bounded)
      for (let i = 0; i < readyEntries.length; i += GET_CONCURRENCY) {
        const slice = readyEntries.slice(i, i + GET_CONCURRENCY);
        await Promise.all(slice.map(async ([asin, id]) => {
          const item = await getTask(id, asin);
          if (item) progress.done[asin] = true;
          else progress.failed[asin] = { stage: 'get', msg: 'empty result' };
          delete pending[asin];
        }));
        saveProgress();
      }
      writeFileSync(TASKS_PATH, JSON.stringify(pending, null, 2));
    }
  }

  // Step 3: Apply saved responses to parts.js
  console.log('\nApplying specs to catalog...');
  let applied = 0;
  const stats = { maxGPU: 0, maxCooler: 0, fans_inc: 0, rads: 0, drive25: 0, drive35: 0 };
  for (const p of target) {
    const path = join(OUTPUT_DIR, `${p.asin}.json`);
    if (!existsSync(path)) continue;
    try {
      const result = JSON.parse(readFileSync(path, 'utf8'));
      const item = result?.[0]?.items?.[0];
      const specs = parseSpecs(item);
      let any = false;
      for (const [k, v] of Object.entries(specs)) {
        if (p[k] == null && v != null) { p[k] = v; stats[k]++; any = true; }
      }
      if (any) applied++;
    } catch (e) {
      // skip bad json
    }
  }

  console.log('Products updated:', applied);
  console.log('Fields filled:', JSON.stringify(stats));

  writeFileSync(
    './src/data/parts.js',
    `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`
  );

  const cases = parts.filter(p => p.c === 'Case');
  console.log('\nCase coverage after:');
  console.log('  maxGPU:  ', cases.filter(x => x.maxGPU).length + '/' + cases.length);
  console.log('  maxCooler:', cases.filter(x => x.maxCooler).length + '/' + cases.length);
  console.log('  fans_inc:', cases.filter(x => x.fans_inc != null).length + '/' + cases.length);
  console.log('  rads:    ', cases.filter(x => x.rads).length + '/' + cases.length);
}

run().catch(err => {
  console.error('FATAL:', err);
  saveProgress();
  process.exit(1);
});
