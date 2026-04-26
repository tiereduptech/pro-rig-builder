// =============================================================================
//  enrich-mobo-from-dataforseo.cjs (v2 — direct task fetch)
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Pulls motherboard m2Slots and sata from Amazon spec tables via DataForSEO.
//
//  STRICT data policy:
//    - Only writes a field if DataForSEO returns a parseable integer.
//    - No defaults, no inference.
//
//  Architecture difference from v1:
//    v1 used /tasks_ready to discover completed tasks. That endpoint is
//    capped at 1000 and was returning stale results from previous runs,
//    starving our new tasks. v2 instead polls each submitted task by ID
//    directly via /task_get. More HTTP calls but reliable.
//
//  Usage:
//    railway run node enrich-mobo-from-dataforseo.cjs --dry-run
//    railway run node enrich-mobo-from-dataforseo.cjs
// =============================================================================

const fs = require('fs');
const path = require('path');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('  ✗ Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');
  console.error('    Run via: railway run node enrich-mobo-from-dataforseo.cjs');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';
const ENRICHMENTS_PATH = './catalog-build/_enrichments.json';

const TARGET_CATEGORY = 'Motherboard';
const TARGET_FIELDS = ['m2Slots', 'sata'];

const AMAZON_FIELD_MAP = {
  m2Slots: ['M.2 Slots', 'M.2 Slot', 'Number of M.2 Slots', 'M.2 Connectors', 'M.2 Sockets', 'M.2 Connector', 'PCIe M.2 Slots'],
  sata: ['SATA Ports', 'Number of SATA Ports', 'SATA Connectors', 'SATA III Ports', 'SATA 6Gb/s Ports', 'SATA Slots', 'SATA Interfaces'],
};

function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    if (section.type === 'product_information_details_item' && section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) flat[k] = v;
    }
    if (Array.isArray(section.contents)) {
      for (const c of section.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k] = v;
        }
      }
    }
  }
  return flat;
}

function parseSlotCount(field, raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'not specified' || s === '-' || s === 'N/A' || s === 'None') return null;
  let m = s.match(/^\s*(\d+)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 12) return n;
  }
  m = s.match(/(\d+)\s*x\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 12) return n;
  }
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  for (const [w, n] of Object.entries(words)) {
    if (new RegExp(`\\b${w}\\b`, 'i').test(s)) return n;
  }
  return null;
}

// Fetch a single task by ID. Returns null if not ready yet, or the result if done.
async function fetchTask(taskId) {
  try {
    const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
      headers: { 'Authorization': AUTH },
    });
    const data = await res.json();
    const task = data?.tasks?.[0];
    if (!task) return null;
    // Status code 40601 = "Task in queue" (still processing)
    // Status code 20000 = "Ok" (results available)
    if (task.status_code === 40601 || task.status_code === 40602) return null;
    return task.result?.[0] || null;
  } catch (e) {
    return null;
  }
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  fs.mkdirSync(path.dirname(ENRICHMENTS_PATH), { recursive: true });
  const enrichments = fs.existsSync(ENRICHMENTS_PATH)
    ? JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8'))
    : {};

  const candidates = [];
  const asinToCandidate = new Map();
  for (const p of parts) {
    if (p.c !== TARGET_CATEGORY) continue;
    if (p.needsReview || p.bundle) continue;
    if (!p.deals?.amazon?.url) continue;
    const asinM = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinM) continue;
    const enrichmentForId = enrichments[p.id] || {};
    const missing = TARGET_FIELDS.filter((f) => p[f] == null && enrichmentForId[f] == null);
    if (missing.length === 0) continue;
    const c = { id: p.id, asin: asinM[1], name: p.n, missing };
    candidates.push(c);
    asinToCandidate.set(c.asin, c);
  }

  console.log(`\n  Motherboard enrichment via DataForSEO`);
  console.log(`  Candidates: ${candidates.length}`);
  console.log(`    Missing m2Slots: ${candidates.filter((c) => c.missing.includes('m2Slots')).length}`);
  console.log(`    Missing sata:    ${candidates.filter((c) => c.missing.includes('sata')).length}`);

  if (candidates.length === 0) {
    console.log('\n  Nothing to enrich.\n');
    return;
  }

  if (process.argv.includes('--dry-run')) {
    console.log('\n  Sample candidates (first 10):');
    candidates.slice(0, 10).forEach((c) => {
      console.log(`    id ${c.id}  ASIN ${c.asin}  ${c.name.slice(0, 50)}`);
    });
    console.log(`\n  Estimated cost: ~$${(candidates.length * 0.0015).toFixed(2)}`);
    console.log('  --dry-run: not submitting tasks\n');
    return;
  }

  // Submit ALL tasks in batches of 100.
  console.log(`\n  Submitting tasks (${candidates.length} total)...`);
  const taskIdToAsin = new Map();
  const BATCH = 100;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH).map((c) => ({
      asin: c.asin, location_code: 2840, language_code: 'en_US',
      tag: `mobo-${c.id}`,
    }));
    try {
      const res = await fetch(BASE + '/merchant/amazon/asin/task_post', {
        method: 'POST',
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const data = await res.json();
      if (data.tasks) {
        for (const t of data.tasks) {
          if (t.id && t.data?.asin) taskIdToAsin.set(t.id, t.data.asin);
        }
      }
      console.log(`    batch ${Math.floor(i / BATCH) + 1}: ${data.tasks?.length || 0} submitted`);
    } catch (e) {
      console.log(`    batch fail: ${e.message}`);
    }
  }
  console.log(`  Submitted ${taskIdToAsin.size} tasks`);

  if (taskIdToAsin.size === 0) {
    console.log('  No tasks submitted, exiting.');
    return;
  }

  // Direct fetch loop. Poll each unfinished task ID until all are done or timeout.
  console.log('\n  Fetching results (direct task_get, no tasks_ready)...');
  const stats = { fetched: 0, m2Found: 0, sataFound: 0, missingFields: 0 };
  const remaining = new Set(taskIdToAsin.keys());
  const startTime = Date.now();
  const TIMEOUT = 15 * 60 * 1000;
  const CONCURRENCY = 5;
  let lastReport = 0;

  while (remaining.size > 0 && Date.now() - startTime < TIMEOUT) {
    const batch = [...remaining].slice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(async (taskId) => {
      const r = await fetchTask(taskId);
      return { taskId, result: r };
    }));

    for (const { taskId, result } of results) {
      if (result === null) continue;  // not ready yet
      remaining.delete(taskId);
      const asin = taskIdToAsin.get(taskId);
      const candidate = asinToCandidate.get(asin);
      if (!candidate) continue;
      stats.fetched++;
      const item = result.items?.[0];
      if (!item) continue;
      const flat = flattenProductInfo(item.product_information);
      const enrichmentForId = enrichments[candidate.id] || {};

      for (const field of candidate.missing) {
        const fieldList = AMAZON_FIELD_MAP[field] || [];
        let found = null;
        for (const amazonKey of fieldList) {
          const rawVal = flat[amazonKey];
          if (rawVal == null) continue;
          const parsed = parseSlotCount(field, rawVal);
          if (parsed != null) { found = parsed; break; }
        }
        if (found != null) {
          enrichmentForId[field] = found;
          if (field === 'm2Slots') stats.m2Found++;
          else if (field === 'sata') stats.sataFound++;
        } else {
          stats.missingFields++;
        }
      }

      if (Object.keys(enrichmentForId).length > 0) {
        enrichments[candidate.id] = enrichmentForId;
      }
    }

    // Report progress every 10 seconds.
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed - lastReport >= 10) {
      lastReport = elapsed;
      console.log(`    fetched ${stats.fetched}/${taskIdToAsin.size}  remaining ${remaining.size}  (${elapsed}s)`);
      // Save progress periodically so a crash doesn't lose work.
      fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(enrichments, null, 2));
    }

    // Tasks need ~30 seconds to process. Sleep between rounds.
    if (remaining.size > 0) await new Promise((r) => setTimeout(r, 3000));
  }

  console.log('\n  ═══ RESULTS ═══');
  console.log(`  Submitted:              ${taskIdToAsin.size}`);
  console.log(`  Fetched:                ${stats.fetched}`);
  console.log(`  Still pending:          ${remaining.size}`);
  console.log(`  m2Slots filled:         ${stats.m2Found}`);
  console.log(`  sata filled:            ${stats.sataFound}`);
  console.log(`  Field misses (no data): ${stats.missingFields}`);

  fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(enrichments, null, 2));
  console.log(`\n  ✓ Saved enrichments to ${ENRICHMENTS_PATH}`);
  console.log('  Next: run apply-enrichments.cjs to merge into parts.js\n');
})();
