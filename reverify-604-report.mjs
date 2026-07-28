/**
 * reverify-604-report.mjs — REPORT ONLY. Writes NOTHING to the catalog.
 * Re-verifies the 604 REVIEW_urltrust quarantined rows via the DataForSEO
 * sellers endpoint (New-condition price), using the shared authoritative gate
 * (analyzeResult imported from drift-gate.js — one source of truth). Sellers
 * endpoint ONLY — no ASIN searches. Output -> scratchpad JSON + console table.
 */
import { readFileSync, writeFileSync } from 'fs';
// The gate is imported from the ONE shared module — no local copy (see drift-gate.js).
import { analyzeResult } from './drift-gate.js';

const LOGIN = process.env.DATAFORSEO_LOGIN, PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('ERROR: DataForSEO creds missing'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';
const BATCH_SIZE = 50, POST_DELAY_MS = 500;
const TASK_POLL_DELAY_MS = 20000, TASK_POLL_INTERVAL_MS = 10000, MAX_POLL_WAIT_MS = 480000, GET_CONCURRENCY = 8;
const OUT = 'C:/Users/Admin/AppData/Local/Temp/claude/C--rigfinder/34a42cb1-40a0-496d-b12a-ee9ce9cca1d1/scratchpad/reverify-604-results.json';

let SPENT = 0; // sum of DataForSEO task_post `cost`

async function dfs(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, { method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
      if (res.status === 429 || res.status === 503) { await new Promise(r => setTimeout(r, 3000 + attempt * 5000)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) { if (attempt === 4) throw e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
}
const extractASIN = url => { if (!url) return null; const m = url.match(/\/dp\/([A-Z0-9]{10})/i); return m ? m[1].toUpperCase() : null; };

// ── target set: rebuild the 604 REVIEW_urltrust exactly as in the analysis ──
async function loadCatalog() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
  return [...mod.PARTS];
}
function build604(all) {
  const isQ = r => r.needsReview || r.quarantinedAt;
  const active = all.filter(r => !isQ(r)), q = all.filter(isQ);
  const urls = r => Object.values(r.deals || {}).filter(x => x && x.url).map(x => x.url);
  const aU = new Set(), aA = new Set();
  for (const r of active) for (const u of urls(r)) { aU.add(u.split('?')[0]); const a = extractASIN(u); if (a) aA.add(a); }
  const SCOPE = /server_hedt|enterprise|external_usb|storage_brand|external/i;
  const FIXFLAG = /wrong-asin|stale-pr|ssd-purged|price:(above_ceiling|below_floor)/i;
  const out = [];
  for (const r of q) {
    const fs = (r.reviewFlags || []).join(',');
    const my = urls(r).map(u => u.split('?')[0]), ma = urls(r).map(extractASIN).filter(Boolean);
    const dup = my.some(u => aU.has(u)) || ma.some(a => aA.has(a));
    if (SCOPE.test(fs) || dup || FIXFLAG.test(fs) || urls(r).length === 0) continue;
    out.push(r);
  }
  return out;
}

async function postTasks(products) {
  const tasks = [];
  console.log(`Posting ${products.length} sellers tasks...`);
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const payload = batch.map(p => ({ asin: extractASIN(p.deals.amazon.url), language_code: 'en_US', location_code: 2840, tag: `verify-${p.id}` }));
    const resp = await dfs('POST', '/merchant/amazon/sellers/task_post', payload);
    if (typeof resp.cost === 'number') SPENT += resp.cost;
    for (const t of (resp.tasks || [])) if (t.id) tasks.push({ taskId: t.id, productId: Number(t.data?.tag?.replace('verify-', '')), asin: t.data?.asin });
    process.stdout.write(`  posted ${Math.min(i + BATCH_SIZE, products.length)}/${products.length} (spend so far $${SPENT.toFixed(4)})\r`);
    await new Promise(r => setTimeout(r, POST_DELAY_MS));
  }
  console.log(`\n  ${tasks.length} tasks posted. task_post spend: $${SPENT.toFixed(4)}`);
  return tasks;
}
async function fetchAllResults(tasks) {
  const results = new Map(), pending = new Map(tasks.map(t => [t.taskId, t]));
  const startedAt = Date.now();
  console.log(`Waiting ${TASK_POLL_DELAY_MS / 1000}s before first poll...`);
  await new Promise(r => setTimeout(r, TASK_POLL_DELAY_MS));
  while (pending.size && (Date.now() - startedAt) < MAX_POLL_WAIT_MS) {
    console.log(`  ${results.size} done / ${pending.size} pending (t+${((Date.now()-startedAt)/1000)|0}s)`);
    const taskList = [...pending.keys()];
    for (let i = 0; i < taskList.length; i += GET_CONCURRENCY) {
      const batch = taskList.slice(i, i + GET_CONCURRENCY);
      await Promise.all(batch.map(async taskId => {
        try {
          const resp = await dfs('GET', `/merchant/amazon/sellers/task_get/advanced/${taskId}`);
          const task = resp.tasks?.[0]; if (!task) return;
          if (task.status_code === 20100 || task.status_code === 40602 || !task.result) return;
          const t = pending.get(taskId), result0 = task.result?.[0];
          results.set(taskId, (task.status_code === 20000 && result0) ? { ...t, data: result0 } : { ...t, data: null, error: task.status_message });
          pending.delete(taskId);
        } catch (e) {}
      }));
    }
    if (pending.size) await new Promise(r => setTimeout(r, TASK_POLL_INTERVAL_MS));
  }
  if (pending.size) console.log(`  WARN: ${pending.size} tasks never completed (left as no_data).`);
  return { done: [...results.values()], stuck: [...pending.values()] };
}

// ── main ──
const all = await loadCatalog();
const targets = build604(all);
console.log(`Target set: ${targets.length} rows (expected 604)`);
const byId = new Map(targets.map(p => [p.id, p]));
const tasks = await postTasks(targets);
const { done, stuck } = await fetchAllResults(tasks);

const rows = [];
for (const t of tasks) {
  const p = byId.get(t.productId);
  const res = done.find(d => d.taskId === t.taskId);
  const amazonData = res ? res.data : null;
  const stored = p.deals?.amazon?.price ?? p.pr ?? null;
  const { issues, fixes } = analyzeResult(p, amazonData);
  const primary = issues.find(i => i.severity === 'high') || issues.find(i => i.type === 'price_drift') || issues[0] || { type: 'ok' };
  const live = primary.amazon ?? (fixes.amazonPrice ?? null);
  let cls;
  if (!amazonData || primary.type === 'no_data') cls = 'NOPRICE';         // dead ASIN / never completed
  else if (primary.type === 'no_new_offer') cls = 'NOPRICE';               // only used offers
  else if (primary.type === 'title_mismatch' || primary.type === 'capacity_mismatch') cls = 'MISMATCH';
  else if (fixes.needsReview) cls = 'FAIL';                                 // a price gate fired
  else cls = 'PASS';                                                        // clears needsReview
  rows.push({ id: p.id, c: p.c, b: p.b, n: (p.n || '').slice(0, 46), stored, live, cls, gate: primary.type, msg: primary.msg, at: p.quarantinedAt });
}
writeFileSync(OUT, JSON.stringify({ spent: SPENT, count: rows.length, rows }, null, 1));

// ── report ──
const H = { PASS: 0, FAIL: 0, NOPRICE: 0, MISMATCH: 0 };
for (const r of rows) H[r.cls]++;
console.log('\n══════════ PER-ROW (first 60 shown; full set in results JSON) ══════════');
console.log('id      cat          stored    live     verdict   gate');
for (const r of rows.slice(0, 60))
  console.log(`${String(r.id).padEnd(7)} ${r.c.padEnd(12)} ${('$'+(r.stored??'?')).padEnd(9)} ${('$'+(r.live??'—')).padEnd(8)} ${r.cls.padEnd(9)} ${r.gate}`);

console.log('\n══════════ HEADLINE ══════════');
const evaluated = H.PASS + H.FAIL; // pass-rate denominator excludes noprice+mismatch
console.log(`Total re-verified: ${rows.length}`);
console.log(`  PASS (would clear): ${H.PASS}`);
console.log(`  FAIL (price gate still fires): ${H.FAIL}`);
console.log(`  NO-PRICE (delisted/OOS/used-only → relink queue): ${H.NOPRICE}`);
console.log(`  MISMATCH (title/capacity → relink queue): ${H.MISMATCH}`);
console.log(`Pass rate among price-evaluable (PASS/(PASS+FAIL)): ${evaluated ? (100*H.PASS/evaluated).toFixed(1) : 'n/a'}%  (${H.PASS}/${evaluated})`);

console.log('\n══════════ PASS-RATE BY GATE ══════════');
// gate population = the gate that evaluated the row. PASS rows: 'ok' (drift<=thr) or 'price_drift'(drift>thr but sanity ok).
// FAIL rows: price_drift_flagged / price_attach_flagged / implausible_price.
const gatePop = {};
for (const r of rows) {
  if (r.cls === 'NOPRICE' || r.cls === 'MISMATCH') continue;
  // map to the underlying gate family
  let fam;
  if (r.gate === 'ok' || r.gate === 'price_drift' || r.gate === 'price_drift_flagged') fam = 'price_drift(>5% + sanity)';
  else if (r.gate === 'price_attach_flagged') fam = 'price_attach(no stored price)';
  else if (r.gate === 'implausible_price') fam = 'implausible_price(storage $/TB)';
  else fam = r.gate;
  gatePop[fam] = gatePop[fam] || { pass: 0, fail: 0 };
  if (r.cls === 'PASS') gatePop[fam].pass++; else gatePop[fam].fail++;
}
for (const [g, v] of Object.entries(gatePop).sort((a,b)=>(b[1].pass+b[1].fail)-(a[1].pass+a[1].fail))) {
  const tot = v.pass + v.fail;
  console.log(`  ${g.padEnd(34)} n=${String(tot).padStart(4)}  pass ${String(v.pass).padStart(4)} (${(100*v.pass/tot).toFixed(0)}%)  fail ${String(v.fail).padStart(4)}`);
}
console.log(`\nActual spend: $${SPENT.toFixed(4)}  vs  $0.60 estimate`);
if (stuck.length) console.log(`(${stuck.length} tasks never returned — counted as NO-PRICE, not billed beyond post)`);
console.log(`\nResults JSON: ${OUT}`);
console.log('NO catalog writes performed. Nothing cleared. Awaiting go to apply.');
