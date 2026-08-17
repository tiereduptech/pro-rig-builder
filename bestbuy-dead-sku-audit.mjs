#!/usr/bin/env node
/**
 * bestbuy-dead-sku-audit.mjs — READ-ONLY. Writes a report, never parts.js.
 *
 * THE QUESTION this one CAN answer: how many of our 1,523 Best Buy rows point
 * at a sku Best Buy no longer sells?
 *
 * Unlike the price question (probe-bestbuy-price-truth.mjs), this needs no live
 * PDP and no ground truth. Best Buy's own Developer API either knows a sku or
 * it does not. A sku it does not know is a broken affiliate link and a price
 * attached to nothing — there is no "which field is right" ambiguity to argue
 * about. The 20-sku hand probe hit 6 of these; that rate over the full set
 * would be ~450 rows, which is worth measuring exactly rather than estimating.
 *
 * METHOD — two strikes before a sku is called dead:
 *   strike 1  bulk query. `products(sku in(...))`, 100 skus per request, ~16
 *             requests for the whole catalog. Skus the response omits are
 *             candidates, not verdicts — a bulk query can drop a sku for
 *             reasons other than death (inactive-but-known, indexing lag).
 *   strike 2  individual GET /v1/products/<sku>.json?show=all for every
 *             candidate. HTTP 404 = dead. HTTP 200 = alive, and we record why
 *             the bulk pass missed it (usually active:false). Anything else —
 *             403 quota, 5xx, network — is recorded as UNKNOWN and never
 *             counted as dead. Same rule as recheck-dead-asins.mjs: one API
 *             blip must not condemn a live row.
 *
 * FREE ALONG THE WAY: the bulk pass returns salePrice/orderable for every
 * living sku at no extra request, so the report also carries
 *   - sold-out / unorderable rows (alive sku, unbuyable link), and
 *   - stored-vs-API price drift across all 1,523 rows.
 * The drift number inherits the unresolved caveat from the price probe: the API
 * may be publishing comp value, not the real selling price. It is reported as
 * DISAGREEMENT, not as "the API is right".
 *
 * Usage — normally dispatched, not run by hand:
 *   gh workflow run bestbuy-dead-sku-audit.yml     # BESTBUY_API_KEY is a repo secret
 *
 *   BESTBUY_API_KEY=... node bestbuy-dead-sku-audit.mjs          # full 1,523
 *   ... --n 200        # smoke run over the first 200 skus
 *   ... --resume       # reuse resolved skus from a previous report, refetch
 *                      # only the ones that came back UNKNOWN
 *
 * Under Actions it also appends a markdown report to $GITHUB_STEP_SUMMARY, and
 * exits 1 if more than 5% of skus came back UNKNOWN — a census with that many
 * holes has not measured the catalog.
 *
 * Writes ONLY catalog-build/bestbuy-dead-sku-audit.json, which .gitignore
 * excludes; the working tree is untouched, and the workflow asserts it.
 *
 * Rate limit: Best Buy documents 5 req/sec. This paces at ~3/sec.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY required.');
  console.error('  Railway dashboard → prorigbuilder project → service → Variables tab,');
  console.error('  or:  railway variables            (lists them)');
  console.error('  then: railway run node bestbuy-dead-sku-audit.mjs');
  process.exit(1);
}

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const N = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) || 0 : 0;
const RESUME = argv.includes('--resume');
const OUT = path.join(ROOT, 'catalog-build', 'bestbuy-dead-sku-audit.json');

const CHUNK = 100;      // skus per bulk query; also the API's pageSize ceiling
const PACE_MS = 340;    // ~3 req/sec, under the documented 5/sec
const TRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = '─'.repeat(96);
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');

// ── Catalog ───────────────────────────────────────────────────────────────
// Only a handful of bestbuy deals carry an explicit .sku; the rest keep it in
// the affiliate wrapper's prodsku= param. Derive rather than skip.
const mod = await import('file://' + path.join(ROOT, 'src', 'data', 'parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
const parts = mod.PARTS || mod.default;
if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }

const skuOf = (deal) => {
  if (deal.sku) return String(deal.sku);
  const m = String(deal.url || '').match(/[?&]prodsku=(\d+)/);
  return m ? m[1] : null;
};

const rows = [];
let noSku = 0;
for (const p of parts) {
  const d = p.deals && p.deals.bestbuy;
  if (!d || typeof d !== 'object') continue;
  const sku = skuOf(d);
  if (!sku) { noSku++; continue; }
  rows.push({
    id: p.id,
    name: p.n,
    cat: p.c,
    sku,
    stored: typeof d.price === 'number' && d.price > 0 ? d.price : null,
    url: d.url || null,
    confirmedAt: d.priceConfirmedAt || null,
    quarantined: p.needsReview === true,
  });
}

const targets = N ? rows.slice(0, N) : rows;
const skus = [...new Set(targets.map((r) => r.sku))];
console.log(`Catalog: ${parts.length} products, ${rows.length} Best Buy rows` +
  (noSku ? ` (${noSku} skipped — no recoverable sku)` : '') +
  ` → ${skus.length} distinct skus to check` + (N ? ` (--n ${N})` : ''));

// ── Resume ────────────────────────────────────────────────────────────────
// A previous report's verdicts are reusable for anything it RESOLVED. UNKNOWN
// is exactly what a resume is for, so those are always refetched.
const known = new Map();
if (RESUME && existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const [sku, v] of Object.entries(prev.bySku || {})) {
      if (v && v.status && v.status !== 'unknown') known.set(sku, v);
    }
    console.log(`Resume: ${known.size} skus already resolved in ${path.basename(OUT)}; refetching the rest.`);
  } catch (e) { console.log(`Resume: could not read ${OUT} (${e.message}) — starting clean.`); }
}

// ── HTTP ──────────────────────────────────────────────────────────────────
// Retries only for transient shapes. A 404 is an answer, not a failure, and is
// returned immediately.
async function get(url, label) {
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { ok: true, json: await res.json(), status: res.status };
      if (res.status === 404) return { ok: false, status: 404, err: 'HTTP 404' };
      last = `HTTP ${res.status}${res.status === 403 ? ' (key rejected / quota)' : ''}`;
    } catch (e) { last = e.message; }
    if (attempt < TRIES) {
      const back = 1200 * attempt;
      console.log(`    retry ${attempt}/${TRIES - 1} on ${label}: ${last} — waiting ${back}ms`);
      await sleep(back);
    }
  }
  return { ok: false, status: null, err: last };
}

// ── Strike 1: bulk ────────────────────────────────────────────────────────
const SHOW = ['sku', 'name', 'salePrice', 'regularPrice', 'onSale', 'active',
  'orderable', 'onlineAvailability', 'inStoreAvailability', 'priceUpdateDate'].join(',');

const bySku = new Map(known);          // sku -> verdict record
const pending = skus.filter((s) => !bySku.has(s));
const chunks = [];
for (let i = 0; i < pending.length; i += CHUNK) chunks.push(pending.slice(i, i + CHUNK));

console.log(bar);
console.log(`STRIKE 1 — bulk: ${chunks.length} request(s) covering ${pending.length} skus`);
let bulkErrors = 0;
const missed = [];
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  const url = `https://api.bestbuy.com/v1/products(sku%20in(${c.join(',')})).json` +
    `?apiKey=${KEY}&show=${SHOW}&pageSize=${CHUNK}&format=json`;
  const res = await get(url, `bulk ${i + 1}/${chunks.length}`);
  if (!res.ok) {
    // A failed bulk chunk is not evidence about its skus. Every sku in it falls
    // through to the individual pass, which is authoritative anyway.
    bulkErrors++;
    console.log(`[${String(i + 1).padStart(3)}/${chunks.length}] BULK FAILED (${res.err}) — ${c.length} skus deferred to strike 2`);
    missed.push(...c);
  } else {
    const found = new Map((res.json.products || []).map((p) => [String(p.sku), p]));
    for (const sku of c) {
      const p = found.get(sku);
      if (p) {
        bySku.set(sku, {
          status: 'alive', via: 'bulk',
          name: p.name, salePrice: p.salePrice, regularPrice: p.regularPrice,
          onSale: p.onSale, active: p.active, orderable: p.orderable,
          onlineAvailability: p.onlineAvailability, inStoreAvailability: p.inStoreAvailability,
          priceUpdateDate: p.priceUpdateDate,
        });
      } else missed.push(sku);
    }
    const total = res.json.total;
    console.log(`[${String(i + 1).padStart(3)}/${chunks.length}] ${c.length} asked → ${found.size} returned` +
      (total != null && total !== found.size ? `  (api total ${total})` : '') +
      `  | absent so far ${missed.length}`);
  }
  await sleep(PACE_MS);
}

// ── Strike 2: individual, authoritative ───────────────────────────────────
console.log(bar);
console.log(`STRIKE 2 — individual GET for ${missed.length} sku(s) the bulk pass did not return`);
let dead = 0, revived = 0, unknown = 0;
for (let i = 0; i < missed.length; i++) {
  const sku = missed[i];
  const url = `https://api.bestbuy.com/v1/products/${sku}.json?apiKey=${KEY}&show=all&format=json`;
  const res = await get(url, `sku ${sku}`);
  let rec;
  if (res.status === 404) {
    rec = { status: 'dead', via: 'individual-404' };
    dead++;
  } else if (res.ok) {
    const p = res.json || {};
    rec = {
      status: 'alive', via: 'individual',
      bulkMissReason: p.active === false ? 'active:false' : 'unclear',
      name: p.name, salePrice: p.salePrice, regularPrice: p.regularPrice,
      onSale: p.onSale, active: p.active, orderable: p.orderable,
      onlineAvailability: p.onlineAvailability, inStoreAvailability: p.inStoreAvailability,
      priceUpdateDate: p.priceUpdateDate,
    };
    revived++;
  } else {
    rec = { status: 'unknown', via: 'individual', err: res.err };
    unknown++;
  }
  bySku.set(sku, rec);
  const shown = rec.status === 'dead' ? 'DEAD (404)'
    : rec.status === 'alive' ? `alive — bulk missed it: ${rec.bulkMissReason}, active ${rec.active}, orderable ${rec.orderable}`
    : `UNKNOWN (${rec.err}) — not counted as dead`;
  console.log(`[${String(i + 1).padStart(4)}/${missed.length}] ${sku.padEnd(9)} ${shown}`);
  await sleep(PACE_MS);
}

// ── Join back to catalog rows ─────────────────────────────────────────────
for (const r of targets) {
  const v = bySku.get(r.sku) || { status: 'unknown', err: 'not fetched' };
  r.status = v.status;
  r.api = v.status === 'alive' ? {
    salePrice: v.salePrice ?? null, regularPrice: v.regularPrice ?? null,
    onSale: v.onSale ?? null, active: v.active ?? null, orderable: v.orderable ?? null,
    onlineAvailability: v.onlineAvailability ?? null,
    priceUpdateDate: v.priceUpdateDate ?? null, name: v.name ?? null,
    via: v.via, bulkMissReason: v.bulkMissReason ?? null,
  } : null;
  r.err = v.err || null;
  // Buyable = the API both knows the sku and says it can be ordered online.
  r.buyable = v.status === 'alive'
    ? (v.active !== false && v.onlineAvailability !== false &&
       (v.orderable == null || /^(available|preorder|backorder)$/i.test(String(v.orderable))))
    : false;
  r.drift = (v.status === 'alive' && typeof v.salePrice === 'number' && r.stored != null)
    ? Number((v.salePrice - r.stored).toFixed(2)) : null;
}

const deadRows = targets.filter((r) => r.status === 'dead');
const aliveRows = targets.filter((r) => r.status === 'alive');
const unknownRows = targets.filter((r) => r.status === 'unknown');
const unbuyable = aliveRows.filter((r) => !r.buyable);
const comparable = aliveRows.filter((r) => r.drift != null);
const agree = comparable.filter((r) => Math.abs(r.drift) < 0.005);
const disagree = comparable.filter((r) => Math.abs(r.drift) >= 0.005);
const bigDisagree = disagree.filter((r) => Math.abs(r.drift) / r.stored >= 0.10);

const byCat = {};
for (const r of targets) {
  const k = r.cat || '(none)';
  byCat[k] = byCat[k] || { total: 0, dead: 0, unbuyable: 0, disagree: 0 };
  byCat[k].total++;
  if (r.status === 'dead') byCat[k].dead++;
  if (r.status === 'alive' && !r.buyable) byCat[k].unbuyable++;
  if (r.drift != null && Math.abs(r.drift) >= 0.005) byCat[k].disagree++;
}

const orderableMix = {};
for (const r of aliveRows) {
  const k = String(r.api.orderable ?? '(null)');
  orderableMix[k] = (orderableMix[k] || 0) + 1;
}

// ── Report ────────────────────────────────────────────────────────────────
console.log(bar);
console.log('RESULT');
console.log(bar);
console.log(`  rows checked ............... ${targets.length}`);
console.log(`  DEAD sku (API 404) ......... ${deadRows.length}  (${pct(deadRows.length, targets.length)})   <- broken affiliate link + price attached to nothing`);
console.log(`  alive ...................... ${aliveRows.length}  (${pct(aliveRows.length, targets.length)})`);
console.log(`    of which not buyable ..... ${unbuyable.length}  (sold out / not orderable / inactive)`);
console.log(`  UNKNOWN (API error) ........ ${unknownRows.length}  <- rerun with --resume; never treated as dead`);
if (bulkErrors) console.log(`  bulk chunks that failed .... ${bulkErrors} (their skus were resolved individually)`);
console.log('');
console.log(`  stored vs API salePrice, where both exist (${comparable.length} rows):`);
console.log(`    identical ................ ${agree.length}  (${pct(agree.length, comparable.length)})`);
console.log(`    disagree ................. ${disagree.length}  (${pct(disagree.length, comparable.length)})`);
console.log(`    disagree by >10% ......... ${bigDisagree.length}  (${pct(bigDisagree.length, comparable.length)})`);
console.log(`    (which side is right is still open — see probe-bestbuy-price-truth.mjs)`);
console.log('');
console.log('  orderable values across living skus:');
Object.entries(orderableMix).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`    ${k.padEnd(24)} ${v}`));
console.log('');
console.log('  by category (dead / unbuyable / price-disagree / total):');
Object.entries(byCat).sort((a, b) => b[1].dead - a[1].dead)
  .forEach(([k, v]) => console.log(`    ${k.padEnd(18)} ${String(v.dead).padStart(4)} / ${String(v.unbuyable).padStart(4)} / ${String(v.disagree).padStart(4)} / ${v.total}`));

if (deadRows.length) {
  console.log('');
  console.log(`  first ${Math.min(25, deadRows.length)} dead rows:`);
  deadRows.slice(0, 25).forEach((r) =>
    console.log(`    ${String(r.id).padEnd(8)} sku ${r.sku.padEnd(9)} $${String(r.stored ?? '-').padEnd(8)} ${String(r.name || '').slice(0, 58)}`));
}

// ── Job summary ───────────────────────────────────────────────────────────
// Generated from the same variables the console report uses, so the summary
// cannot drift from the numbers. Only fires under Actions.
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [];
  md.push(`## Best Buy dead-SKU audit — ${targets.length} rows`, '');
  md.push('| verdict | rows | share |', '|---|---:|---:|');
  md.push(`| **DEAD** — Developer API returns 404 | ${deadRows.length} | ${pct(deadRows.length, targets.length)} |`);
  md.push(`| alive | ${aliveRows.length} | ${pct(aliveRows.length, targets.length)} |`);
  md.push(`| &nbsp;&nbsp;↳ alive but not buyable | ${unbuyable.length} | ${pct(unbuyable.length, targets.length)} |`);
  md.push(`| UNKNOWN — API error, never counted as dead | ${unknownRows.length} | ${pct(unknownRows.length, targets.length)} |`);
  md.push('');
  md.push('A dead sku is a broken affiliate link and a price attached to nothing — no ambiguity about which field is right. ' +
    'Two strikes: absent from a bulk `sku in(…)` query, then an individual GET returning 404. ' +
    `${bulkErrors ? `${bulkErrors} bulk chunk(s) failed and were resolved individually. ` : ''}` +
    'Nothing was written to `parts.js`; `deadIds[]` in the artifact is the input a corrective sweep would consume.');
  md.push('');
  md.push(`### Price — stored vs API salePrice (${comparable.length} rows where both exist)`, '');
  md.push('| | rows | share |', '|---|---:|---:|');
  md.push(`| identical | ${agree.length} | ${pct(agree.length, comparable.length)} |`);
  md.push(`| disagree | ${disagree.length} | ${pct(disagree.length, comparable.length)} |`);
  md.push(`| disagree by >10% | ${bigDisagree.length} | ${pct(bigDisagree.length, comparable.length)} |`);
  md.push('');
  md.push('_Which side is right is still open — the API may be publishing comp value rather than the real ' +
    'selling price (see `probe-bestbuy-price-truth.mjs`). This row says the two disagree, not that the API wins._');
  md.push('');
  md.push('### Availability of living skus', '');
  md.push('| orderable | rows |', '|---|---:|');
  Object.entries(orderableMix).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => md.push(`| ${k} | ${v} |`));
  md.push('');
  md.push('### By category', '');
  md.push('| category | dead | unbuyable | price-disagree | rows |', '|---|---:|---:|---:|---:|');
  Object.entries(byCat).sort((a, b) => b[1].dead - a[1].dead)
    .forEach(([k, v]) => md.push(`| ${k} | ${v.dead} | ${v.unbuyable} | ${v.disagree} | ${v.total} |`));
  if (deadRows.length) {
    md.push('', `### Dead rows (first ${Math.min(40, deadRows.length)} of ${deadRows.length})`, '');
    md.push('| id | sku | stored | name |', '|---|---|---:|---|');
    deadRows.slice(0, 40).forEach((r) =>
      md.push(`| ${r.id} | [${r.sku}](https://www.bestbuy.com/site/-/${r.sku}.p?skuId=${r.sku}) | ${r.stored == null ? '—' : '$' + r.stored} | ${String(r.name || '').replace(/\|/g, '\\|').slice(0, 70)} |`));
  }
  md.push('', `Full per-row detail: the \`bestbuy-dead-sku-audit\` artifact on this run.`);
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n', { flag: 'a' });
}

if (!existsSync(path.dirname(OUT))) mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  auditedAt: new Date().toISOString(),
  scope: { products: parts.length, bestbuyRows: rows.length, checked: targets.length, distinctSkus: skus.length, rowsWithoutSku: noSku },
  summary: {
    dead: deadRows.length, alive: aliveRows.length, unknown: unknownRows.length,
    unbuyable: unbuyable.length, bulkChunkErrors: bulkErrors,
    priceComparable: comparable.length, priceIdentical: agree.length,
    priceDisagree: disagree.length, priceDisagreeOver10pct: bigDisagree.length,
    orderableMix, byCat,
  },
  deadIds: deadRows.map((r) => r.id),
  unbuyableIds: unbuyable.map((r) => r.id),
  unknownSkus: unknownRows.map((r) => r.sku),
  rows: targets,
  bySku: Object.fromEntries(bySku),
}, null, 2));
console.log('');
console.log('Report written: ' + OUT);
console.log('');
console.log('NEXT: nothing here writes to parts.js. deadIds[] is the input a corrective');
console.log('sweep would consume — quarantine or drop the bestbuy deal on those rows.');

// ── Completeness gate ─────────────────────────────────────────────────────
// A census with holes in it is not a census. Every UNKNOWN is a sku whose
// verdict we do not have, and they are invisible in a green run unless said
// out loud. Above 5% the dead count is no longer a number worth acting on.
const CI = !!process.env.GITHUB_ACTIONS;
const unknownRate = targets.length ? unknownRows.length / targets.length : 0;
if (unknownRows.length) {
  const msg = `${unknownRows.length} of ${targets.length} skus (${pct(unknownRows.length, targets.length)}) came back UNKNOWN — API error, not dead. Re-run with --resume to resolve just those.`;
  console.log(CI ? `::warning::${msg}` : `WARNING: ${msg}`);
}
if (unknownRate > 0.05) {
  const msg = `Unresolved sku rate ${pct(unknownRows.length, targets.length)} exceeds 5% — this run did not measure the catalog. The dead count below is a floor, not the answer. Re-run with --resume.`;
  console.log(CI ? `::error::${msg}` : `ERROR: ${msg}`);
  process.exit(1);
}
