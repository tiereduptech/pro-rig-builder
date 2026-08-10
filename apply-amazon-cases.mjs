// apply-amazon-cases.mjs — Amazon CASE discovery APPLY (confirmation-gated).
//
// The write-path proof for scaled case discovery. Reuses, verbatim, the READ-ONLY
// pilot's query plan + gate stack (pilot-apevia-cases.mjs), then does what the pilot
// cannot: confirm each accepted ASIN against a live Buy Box and WRITE the survivors
// via the sanctioned writeCatalog() (atomic promote + mandatory re-split + growth
// brake). It does NOT fs.writeFileSync a literal over parts.js — that bypass is the
// 2026-06-27 dual-export corruption, and the old apply-amazon-discoveries.cjs still
// commits it. This script never does.
//
// LIVENESS IS GATED ON CONFIRMATION, not on discovery:
//   classifyBuyBox()==CONFIRMED (New, in-stock Buy Box) -> LIVE (needsReview:false),
//       tagged priceSource 1p|3p + priceSeller so the disclosure badge renders. A 3P
//       Buy Box IS written live — disclosed, per the 2026-08-05 policy.
//   UNCONFIRMED / BAD / no-PA-data                       -> QUARANTINED (needsReview:
//       true + quarantinedAt + priceUnconfirmedReason), held & hidden until a human/
//       nightly clears it. Never published on an unconfirmed price.
//
// Provenance on every row: source:'amazon-case-discovery' + batchId + discoveredAt,
// so one run is reversible exactly. The Amazon affiliate ?tag= is on every deal URL
// (a link without it earns nothing).
//
// Case spec fields (ff/tower/maxGPU/rads/…): a coarse ff+tower is parsed at insert so
// the browse form-factor filter includes these rows; the rich fields are a separate
// enrichment/backfill pass — NOT enrich-case-specs.cjs, whose KNOWN_SPECS table has
// no budget-brand patterns and which itself raw-writes parts.js.
//
// Usage:
//   node apply-amazon-cases.mjs                      # DRY RUN — report only, no write
//   node apply-amazon-cases.mjs --apply              # writes (foreground) + re-split + detector
//   node apply-amazon-cases.mjs --brands=Apevia,Zalman,Vetroo,Cougar   # scope to a brand set
//   node apply-amazon-cases.mjs --budget-only        # drop already-saturated premium brands
//   node apply-amazon-cases.mjs --batch=amazon-case-apevia-2026-08-07  # override batchId

import { searchItems, resolveItems, paapiStatus, onPaapiAlert, DEFAULT_RESOURCES } from './amazon-paapi.js';
import { classifyBuyBox, BUYBOX_STATE } from './amazon-price.js';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CC = require('./catalog-classify.cjs');
const { isRenewedTitle } = require('./condition.cjs');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const ROOT = process.cwd();
const PARTS_URL = 'file://' + ROOT.replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now();

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=')[1] : d; };
const APPLY = has('apply');
const BRANDS_FILTER = (arg('brands', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const BUDGET_ONLY = has('budget-only');
// Brands already saturated in the Case catalog (measured 2026-08-07) — --budget-only
// drops discovery into these so the batch fills the actual holes, not the covered ones.
const PREMIUM = new Set(['corsair', 'lian li', 'asus', 'msi', 'nzxt', 'fractal design',
  'thermaltake', 'cooler master', 'be quiet!', 'phanteks', 'hyte', 'antec', 'silverstone',
  'darkflash', 'jonsbo', 'montech']);

const SEARCH_BRAND = 'Apevia';
const SOURCE_CAT = 'Case';
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const BATCH_ID = arg('batch', `amazon-case-${TODAY}`);
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'tiereduptech-20';
const CONFIRM_RES = [...DEFAULT_RESOURCES, 'images.primary.large'];
const REPORT_PATH = path.join(ROOT, 'catalog-build', `apply-amazon-cases-${APPLY ? 'live' : 'dry'}.json`);

// Same 8-query plan as the read-only pilot (brand param is ignored by SearchItems,
// so these are a case-category net; brand is attributed client-side below).
const QUERIES = [
  { keywords: 'Apevia case', brand: null },
  { keywords: 'Apevia computer case', brand: null },
  { keywords: 'Apevia gaming case', brand: null },
  { keywords: 'case', brand: SEARCH_BRAND },
  { keywords: 'gaming case', brand: SEARCH_BRAND },
  { keywords: 'mini itx', brand: SEARCH_BRAND },
  { keywords: 'micro atx', brand: SEARCH_BRAND },
  { keywords: 'mid tower', brand: SEARCH_BRAND },
];

// ── gate stack — copied verbatim from pilot-apevia-cases.mjs (first reason wins) ──
function gateReason(title, manufacturer) {
  if (isRenewedTitle(title)) return 'renewed_condition';
  const pre = CC.prebuiltSystemReason(title); if (pre) return `prebuilt:${pre}`;
  const bun = CC.bundleReason(title); if (bun) return `bundle:${bun}`;
  const signal = CC.detectCategory(CC.stripCompatClauses(title));
  if (signal && signal !== SOURCE_CAT) return `miscategorized:${signal}`;
  if (!signal) {
    const acc = CC.notBuildableReason(title);
    return acc ? `accessory:${acc}` : 'not_a_case';
  }
  const brand = CC.resolveDiscoveryBrand(title, manufacturer, SOURCE_CAT, SEARCH_BRAND);
  if (!brand) return 'no_brand';
  return null; // ACCEPT
}

const titleOf = (it) => it?.itemInfo?.title?.displayValue || it?.itemInfo?.title || '';
const mfrOf = (it) => it?.itemInfo?.byLineInfo?.manufacturer?.displayValue
  || it?.itemInfo?.byLineInfo?.brand?.displayValue || '';
const priceOf = (it) => it?.offersV2?.listings?.[0]?.price?.money?.amount ?? null;
const imgOf = (it) => it?.images?.primary?.large?.url || it?.images?.primary?.medium?.url || null;

// Coarse case form-factor parse so the browse filter includes these rows at insert.
// ff = largest supported board (catalog vocab: E-ATX/ATX/mATX/Mini-ITX); tower = Mid/Mini/Full.
function caseForm(title) {
  const t = String(title).toLowerCase();
  const tower = /full[\s-]?tower/.test(t) ? 'Full'
    : (/(mini[\s-]?tower|mini[\s-]?itx|\bitx\b|\bsff\b|small form)/.test(t) && !/mid[\s-]?tower/.test(t)) ? 'Mini'
      : 'Mid';
  const strip = t.replace(/micro[\s-]?atx/g, ' ').replace(/\bm-?atx\b/g, ' ').replace(/e-?atx/g, ' ');
  const ff = /e-?atx/.test(t) ? 'E-ATX'
    : /\batx\b/.test(strip) ? 'ATX'
      : /(micro[\s-]?atx|matx|m-atx)/.test(t) ? 'mATX'
        : /(mini[\s-]?itx|\bitx\b)/.test(t) ? 'Mini-ITX'
          : 'ATX';
  return { ff, tower };
}

(async () => {
  const bar = '─'.repeat(78);
  console.log('='.repeat(78));
  console.log(`AMAZON CASE DISCOVERY APPLY — ${APPLY ? 'LIVE WRITE (foreground)' : 'DRY RUN (no write)'}  batch=${BATCH_ID}`);
  if (BRANDS_FILTER.length) console.log(`  brand scope: ${BRANDS_FILTER.join(', ')}`);
  if (BUDGET_ONLY) console.log('  --budget-only: dropping already-saturated premium brands');
  console.log('='.repeat(78));
  onPaapiAlert((a) => console.log(`\n  ⚠ PA API degraded: ${a.reason} — ${a.detail}\n`));

  // ── load catalog ──────────────────────────────────────────────────────────
  const mod = await import(PARTS_URL);
  const parts = [...(mod.PARTS || mod.default || [])];
  const loadedCount = parts.length;
  const existingIds = new Set(parts.map((p) => p.id));
  let nextId = Math.max(...parts.map((p) => p.id || 0)) + 1;
  const allocId = () => { while (existingIds.has(nextId)) nextId++; existingIds.add(nextId); return nextId++; };
  const catalogAsins = new Set();
  const reAsin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i;
  for (const p of parts) {
    if (p.asin) catalogAsins.add(String(p.asin).toUpperCase());
    if (p.deals?.amazon?.asin) catalogAsins.add(String(p.deals.amazon.asin).toUpperCase());
    const mm = p.deals?.amazon?.url && String(p.deals.amazon.url).match(reAsin);
    if (mm) catalogAsins.add(mm[1].toUpperCase());
  }
  console.log(`catalog: ${loadedCount} products, ${catalogAsins.size} known Amazon ASINs\n`);

  // ── 1) gather + gate (identical to pilot) ─────────────────────────────────
  const found = new Map();
  console.log('SearchItems queries (deduped by ASIN):');
  for (const q of QUERIES) {
    const { items, totalResultCount, pagesFetched } = await searchItems(q.keywords, {
      brand: q.brand, pages: 10, searchIndex: 'Electronics',
    });
    let fresh = 0;
    for (const it of items) { const a = it?.asin?.toUpperCase(); if (a && !found.has(a)) { found.set(a, it); fresh++; } }
    const label = (q.brand ? `brand=${q.brand} kw="${q.keywords}"` : `kw="${q.keywords}"`).padEnd(34);
    console.log(`  ${label} → ${String(items.length).padStart(3)} items, ${pagesFetched}p, total≈${totalResultCount ?? '?'}, +${fresh} new`);
    if (!paapiStatus().available) { console.log('  (circuit open — stopping queries)'); break; }
  }

  const accepted = [];      // { asin, title, mfr, brand, searchPrice }
  const rejByGate = new Map();
  const scopeSkipped = { premium: 0, brandFilter: 0 };
  let dedupedCount = 0;
  const bump = (r) => rejByGate.set(r, (rejByGate.get(r) || 0) + 1);
  for (const [asin, it] of found) {
    const title = titleOf(it);
    if (catalogAsins.has(asin)) { dedupedCount++; continue; }
    const reason = gateReason(title, mfrOf(it));
    if (reason) { bump(reason); continue; }
    const brand = CC.resolveDiscoveryBrand(title, mfrOf(it), SOURCE_CAT, SEARCH_BRAND);
    const bl = String(brand || '').toLowerCase();
    if (BUDGET_ONLY && PREMIUM.has(bl)) { scopeSkipped.premium++; continue; }
    if (BRANDS_FILTER.length && !BRANDS_FILTER.includes(bl)) { scopeSkipped.brandFilter++; continue; }
    accepted.push({ asin, title, mfr: mfrOf(it), brand, searchPrice: priceOf(it) });
  }

  console.log(`\nAccepted for confirmation: ${accepted.length}  (deduped ${dedupedCount}` +
    `${BUDGET_ONLY ? `, premium-dropped ${scopeSkipped.premium}` : ''}` +
    `${BRANDS_FILTER.length ? `, off-scope ${scopeSkipped.brandFilter}` : ''})`);

  // ── 2) confirmation pass — live Buy Box per ASIN ──────────────────────────
  console.log('\nConfirming Buy Box (New + in-stock) per ASIN via getItems…');
  const confMap = await resolveItems(accepted.map((a) => a.asin), { resources: CONFIRM_RES });
  const st0 = paapiStatus();
  if (!st0.available) console.log(`  ⚠ PA API degraded mid-confirm (${st0.disabledReason}) — unresolved ASINs will quarantine`);

  // ── 3) build rows ─────────────────────────────────────────────────────────
  const rows = [];
  const summary = { live: 0, live1p: 0, live3p: 0, quarantined: 0 };
  const quarantineReasons = new Map();
  const detail = [];
  for (const a of accepted) {
    const item = confMap.get(a.asin);
    const v = item ? classifyBuyBox(item) : { state: 'no_data', reason: 'paapi_no_data' };
    const { ff, tower } = caseForm(a.title);
    const url = `https://www.amazon.com/dp/${a.asin}?tag=${PARTNER_TAG}`;
    const img = imgOf(item);
    const confirmed = v.state === BUYBOX_STATE.CONFIRMED;
    const price = confirmed ? v.offer.price : a.searchPrice;

    const row = {
      id: allocId(), c: 'Case', n: a.title, b: a.brand,
      pr: price ?? null, msrp: price ?? null, r: null, img,
      ff, tower,
      deals: { amazon: { asin: a.asin, url, price: price ?? null, inStock: confirmed } },
      needsReview: !confirmed,
      source: 'amazon-case-discovery', batchId: BATCH_ID, discoveredAt: TODAY, addedAt: NOW,
    };
    if (confirmed) {
      row.deals.amazon.priceSource = v.offer.source;       // '1p' | '3p'
      row.deals.amazon.priceSeller = v.offer.seller || null;
      row.deals.amazon.priceResolvedVia = 'paapi';
      row.deals.amazon.priceConfidence = 'confirmed';
      row.deals.amazon.priceConfirmedAt = TODAY;
      summary.live++; if (v.offer.source === '3p') summary.live3p++; else summary.live1p++;
    } else {
      row.quarantinedAt = TODAY;
      row.deals.amazon.priceUnconfirmedReason = v.reason;
      row.deals.amazon.priceUnconfirmedAt = TODAY;
      summary.quarantined++;
      quarantineReasons.set(v.reason, (quarantineReasons.get(v.reason) || 0) + 1);
    }
    rows.push(row);
    detail.push({ asin: a.asin, brand: a.brand, state: confirmed ? 'LIVE' : 'quarantine',
      source: confirmed ? v.offer.source : null, seller: confirmed ? v.offer.seller : null,
      reason: confirmed ? null : v.reason, price, ff, tower, title: a.title.slice(0, 82) });
  }

  // ── 4) report ─────────────────────────────────────────────────────────────
  console.log('\n' + bar);
  console.log('REJECTED BY GATE');
  console.log(bar);
  for (const [r, n] of [...rejByGate.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}  ${r}`);

  console.log('\n' + bar);
  console.log(`RESULT — ${rows.length} rows to insert`);
  console.log(bar);
  console.log(`  LIVE (confirmed Buy Box) ...... ${summary.live}   (1P ${summary.live1p} · 3P ${summary.live3p})`);
  console.log(`  QUARANTINED (held) ............ ${summary.quarantined}`);
  for (const [r, n] of [...quarantineReasons.entries()].sort((x, y) => y[1] - x[1])) console.log(`       · ${r}: ${n}`);

  // brand breakdown of what would land
  const brandTally = {};
  for (const d of detail) { const k = d.brand || '(none)'; brandTally[k] = brandTally[k] || { live: 0, q: 0 }; if (d.state === 'LIVE') brandTally[k].live++; else brandTally[k].q++; }
  console.log('\n' + bar);
  console.log('BRAND BREAKDOWN (live / quarantined)');
  console.log(bar);
  for (const [b, t] of Object.entries(brandTally).sort((x, y) => (y[1].live + y[1].q) - (x[1].live + x[1].q))) {
    console.log(`  ${String(b).padEnd(24)} ${String(t.live).padStart(3)} live · ${String(t.q).padStart(3)} held`);
  }

  console.log('\n' + bar);
  console.log('PER-ROW (first 80)');
  console.log(bar);
  for (const d of detail.slice(0, 80)) {
    const tag = d.state === 'LIVE' ? `LIVE ${d.source}` : `HELD ${d.reason}`;
    console.log(`  [${String(d.brand || '?').padEnd(10)}] $${String(d.price ?? '—').padStart(7)} ${tag.padEnd(22)} ${d.title}`);
  }

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify({
    generatedAt: NOW, batchId: BATCH_ID, apply: APPLY,
    catalogBefore: loadedCount, wouldInsert: rows.length,
    rejectedByGate: Object.fromEntries(rejByGate), deduped: dedupedCount, scopeSkipped,
    summary, quarantineReasons: Object.fromEntries(quarantineReasons),
    brandTally, detail, rows,
  }, null, 2));
  console.log(`\nReport: ${path.relative(ROOT, REPORT_PATH)}`);

  const st = paapiStatus();
  console.log(`PA API: available=${st.available} calls=${st.stats.calls} items=${st.stats.items} throttled=${st.stats.throttled} batchErrors=${st.stats.batchErrors}`);

  // ── 5) write (foreground) ─────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write (foreground) + re-split + detector.');
    return;
  }
  if (!rows.length) { console.log('\nNo rows to insert — not writing.'); return; }
  parts.push(...rows);
  await writeCatalog(parts, { loadedCount, reason: `amazon case discovery (${rows.length}, batch ${BATCH_ID})` });
  console.log(`\nWROTE ${rows.length} Case rows (${summary.live} live, ${summary.quarantined} held). Catalog ${loadedCount} → ${parts.length}.`);

  // ── 6) detector re-run (READ-ONLY verify, on the freshly re-split chunks) ──
  console.log('\n' + bar);
  console.log('DETECTOR RE-RUN — detect-wrong-asin.cjs (read-only)');
  console.log(bar);
  try {
    execFileSync(process.execPath, ['detect-wrong-asin.cjs'], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.log(`  (detector exited non-zero: ${e.message.slice(0, 160)})`);
  }
  console.log(`\nDONE. batch=${BATCH_ID}. Rollback: remove rows where batchId==='${BATCH_ID}' then re-split.`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
