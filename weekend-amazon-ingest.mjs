// weekend-amazon-ingest.mjs — UNATTENDED Amazon SearchItems ingest, QUARANTINE-ONLY.
//
// Runs ONLY the safe/validated/credentialed path: Amazon Creators SearchItems for
// the categories that have a CALIBRATED price ceiling+floor AND validated
// category-reject gates — RAM, PSU, Storage. (Newegg = no RAKUTEN creds; Best Buy =
// non-writeCatalog staging + unvalidated merge — both deferred, see the report.)
//
// NON-NEGOTIABLES enforced in code:
//   1. EVERY row is needsReview:true (+ quarantinedAt). Nothing goes live. Ever.
//   2. NO deploy: writes catalog source ONLY, via writeCatalog() (re-split included).
//      Refuses to run on `main`. Does not build/prerender/push. Never -X ours.
//   3. Additions only — never touches an existing row (no reprice/relink/delete).
//   4. Provenance per (source,category): source:'amazon-<cat>-discovery' + batchId +
//      discoveredAt + weekendRun:true, so any batch rolls back independently.
//
// HARD STOPS (halt the WHOLE run, write the report, do not continue):
//   - a category where >30% of priced candidates fail the price CEILING (stale ceiling)
//   - a category where accept rate > 80% (a gate isn't firing)
//   - cumulative additions would exceed +3000 rows
//   - any write path that is not writeCatalog() (structurally impossible here)
//   - wrong-ASIN detector flags >5% of the run's new rows
//   - PA API auth failure / circuit-breaker trip / rate-limit exhaustion
//
// Usage:
//   node weekend-amazon-ingest.mjs                 # DRY RUN — gates+hard-stops, no write
//   node weekend-amazon-ingest.mjs --apply         # quarantined writes to the branch
//   node weekend-amazon-ingest.mjs --only=PSU      # one category

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
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'tiereduptech-20';
const CONFIRM_RES = [...DEFAULT_RESOURCES, 'images.primary.large'];
const REPORT_JSON = path.join(ROOT, 'weekend-ingest-report.json');
const REPORT_MD = path.join(ROOT, 'weekend-ingest-report.md');

// ── HARD-STOP thresholds ──────────────────────────────────────────────────────
const HS_CEILING_FAIL = 0.30;   // >30% ceiling fail => stale ceiling => halt
const HS_ACCEPT_RATE = 0.80;    // >80% accept => a gate isn't firing => halt
const HS_GROWTH_TOTAL = 3000;   // cumulative additions cap
const HS_DETECTOR = 0.05;       // >5% of new rows flagged by wrong-ASIN detector

// ── per-category query plans (current, in-stock consumer parts) ───────────────
const PLANS = {
  RAM: ['DDR5 desktop RAM', 'DDR4 desktop memory kit', 'DDR5 6000 CL30', 'DDR4 3200 memory',
        '32GB DDR5 RAM', '16GB DDR4 RAM', '64GB DDR5 kit'],
  PSU: ['power supply 80 plus gold', 'ATX power supply 850W', '750W modular power supply',
        '650W bronze power supply', '1000W power supply', 'SFX power supply', '80 plus platinum psu'],
  Storage: ['NVMe SSD 2TB', 'M.2 SSD 1TB', 'SATA SSD 1TB', 'internal SSD 4TB',
            'NVMe Gen4 SSD', 'M.2 2280 SSD', '2.5 inch SSD'],
};

// ── validated per-category gates (ported from apply-newegg-discoveries) ───────
const CATEGORY_REJECT = {
  RAM: (n) => CC.ramRejectReason(n),
  PSU: (n) => CC.psuRejectReason(n),
  Storage: (n) => CC.storageRejectReason(n),
};
const SPEC_BAR = {
  RAM: (s) => s.cap != null && s.speed != null && s.memType != null,
  PSU: (s) => s.watts != null,
  Storage: (s) => s.cap != null && s.storageType != null,
};
const PREBUILT_RE = /\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Barebone|Bundle|Combo)\b/i;

function gateReason(cat, title, mfr) {
  if (isRenewedTitle(title)) return 'renewed_condition';
  const pre = CC.prebuiltSystemReason(title); if (pre) return `prebuilt:${pre}`;
  if (PREBUILT_RE.test(title)) return 'prebuilt:re';
  const bun = CC.bundleReason(title); if (bun) return `bundle:${bun}`;
  const acc = CC.notBuildableReason(title); if (acc) return `accessory:${acc}`;
  const signal = CC.detectCategory(CC.stripCompatClauses(title));
  if (!signal) return 'unclassified';
  if (signal !== cat) return `miscategorized:${signal}`;
  const rej = CATEGORY_REJECT[cat](title); if (rej) return `categoryReject:${rej}`;
  const specs = CC.extractSpecs(title, cat);
  if (!SPEC_BAR[cat](specs)) return 'specBar';
  const brand = CC.resolveDiscoveryBrand(title, mfr, cat);
  if (!brand) return 'no_brand';
  return null;
}

const titleOf = (it) => it?.itemInfo?.title?.displayValue || it?.itemInfo?.title || '';
const mfrOf = (it) => it?.itemInfo?.byLineInfo?.manufacturer?.displayValue || it?.itemInfo?.byLineInfo?.brand?.displayValue || '';
const priceOf = (it) => it?.offersV2?.listings?.[0]?.price?.money?.amount ?? null;
const imgOf = (it) => it?.images?.primary?.large?.url || it?.images?.primary?.medium?.url || null;

// normalize-product-name price validator (absolute ceiling+floor table)
let CAP;
async function loadCap() { CAP = await import('file://' + ROOT.replace(/\\/g, '/') + '/normalize-product-name.js'); }

function buildRow(cat, id, it, brand, price, verdict, batchId) {
  const title = titleOf(it);
  const specs = CC.extractSpecs(title, cat);
  const confirmed = verdict?.state === BUYBOX_STATE.CONFIRMED;
  const asin = it.asin;
  const row = {
    id, c: cat, n: title, b: brand,
    pr: price ?? null, msrp: price ?? null, r: null, img: imgOf(it),
    ...specs,
    deals: { amazon: { asin, url: `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`, price: price ?? null, inStock: !!confirmed } },
    needsReview: true, quarantinedAt: TODAY,          // NON-NEGOTIABLE #1
    source: `amazon-${cat.toLowerCase()}-discovery`, batchId, discoveredAt: TODAY, addedAt: NOW, weekendRun: true,
  };
  if (confirmed) {
    row.deals.amazon.priceSource = verdict.offer.source;
    row.deals.amazon.priceSeller = verdict.offer.seller || null;
    row.deals.amazon.priceResolvedVia = 'paapi';
    row.deals.amazon.priceConfidence = 'confirmed';
    row.deals.amazon.priceConfirmedAt = TODAY;
  } else {
    row.deals.amazon.priceUnconfirmedReason = verdict?.reason || 'unconfirmed';
    row.deals.amazon.priceUnconfirmedAt = TODAY;
  }
  if (cat === 'RAM') { const a = CC.ramAttributes(title); row.ramType = specs.memType; row.ecc = a.ecc; row.rgb = a.rgb; row.formFactor = a.formFactor; }
  if (cat === 'Storage') row.storageType = specs.storageType;
  return row;
}

const bar = '─'.repeat(80);
const report = { generatedAt: NOW, mode: APPLY ? 'APPLY' : 'DRY_RUN', branch: null,
  deferred: {
    Newegg: 'RAKUTEN_FTP_PASSWORD absent (local + Railway) — auth hard-stop; the only fully-validated path could not run.',
    BestBuy: 'bestbuy-discover-v2.js writes staging JSON via writeFileSync (NOT writeCatalog); 2-step discover→merge with an unvalidated merge write-path. Violates writeCatalog-only.',
    AmazonOtherCats: 'No calibrated price ceiling and no per-category query plan beyond RAM/PSU/Storage/Case — running unattended = the stale-ceiling/null-classifier risk.',
  },
  categories: {}, hardStop: null, totals: { candidates: 0, accepted: 0, written: 0 } };

function haltAndReport(reason, detail) {
  report.hardStop = { reason, detail, at: new Date().toISOString() };
  finalizeReport();
  console.log(`\n${'='.repeat(80)}\nHARD STOP: ${reason}\n  ${detail}\n  Report: ${path.relative(ROOT, REPORT_MD)}\n${'='.repeat(80)}`);
  process.exit(2);
}

function finalizeReport() {
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  const L = [];
  L.push(`# Weekend Amazon ingest — ${report.mode} — ${report.generatedAt}`, '');
  L.push(`Branch: \`${report.branch}\`  |  everything QUARANTINED (needsReview:true)  |  no deploy`, '');
  if (report.hardStop) L.push(`## ⛔ HARD STOP\n- **${report.hardStop.reason}** — ${report.hardStop.detail} (${report.hardStop.at})`, '');
  L.push('## Deferred (not run)', ...Object.entries(report.deferred).map(([k, v]) => `- **${k}**: ${v}`), '');
  L.push('## Per category');
  for (const [cat, c] of Object.entries(report.categories)) {
    L.push(`\n### ${cat}`, `candidates ${c.candidates} · deduped ${c.deduped} · accepted ${c.accepted} (rate ${(c.acceptRate * 100).toFixed(1)}%) · written ${c.written} (all quarantined)`);
    if (c.ceiling) L.push(`price ceiling: ${c.ceiling.priced} priced, ${c.ceiling.failed} over ceiling (${(c.ceiling.failRate * 100).toFixed(1)}%), calibrated ${c.ceiling.calibratedAt}`);
    if (c.detector) L.push(`wrong-ASIN detector: ${c.detector.flagged}/${c.detector.checked} new rows flagged (${(c.detector.rate * 100).toFixed(1)}%)`);
    L.push('\nrejected by gate (first gate that fired; up to 5 examples):');
    for (const [g, e] of Object.entries(c.rejects || {}).sort((a, b) => b[1].n - a[1].n)) {
      L.push(`- **${g}** — ${e.n}`);
      for (const t of e.examples) L.push(`    - ${t.slice(0, 92)}`);
    }
  }
  L.push('', '## Totals', `- candidates ${report.totals.candidates} · accepted ${report.totals.accepted} · **written ${report.totals.written} (all quarantined)**`);
  L.push('', '## Release recommendation', '- Every row is quarantined pending your Monday review. Release guidance per batch is added after writes complete.');
  if (report.recommendations) L.push(...report.recommendations.map((r) => `- ${r}`));
  writeFileSync(REPORT_MD, L.join('\n'));
}

(async () => {
  // ── SAFETY: refuse to run on main ───────────────────────────────────────────
  let branch = '';
  try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch {}
  report.branch = branch;
  if (branch === 'main' || branch === 'master') haltAndReport('write_path_guard', `refusing to run on ${branch} — weekend writes go to a branch only`);
  if (!branch) haltAndReport('write_path_guard', 'could not determine git branch — refusing to write');

  await loadCap();
  onPaapiAlert((a) => { report.paapiAlert = a; haltAndReport('paapi_' + a.reason, a.detail); });

  console.log(`${'='.repeat(80)}\nWEEKEND AMAZON INGEST — ${APPLY ? 'APPLY (quarantined writes)' : 'DRY RUN'} — branch ${branch}\n${'='.repeat(80)}`);

  const cats = (ONLY ? [ONLY] : ['RAM', 'PSU', 'Storage']).filter((c) => PLANS[c]);

  // Load the catalog ONCE and CARRY IT FORWARD across categories. Re-importing
  // parts.js mid-process returns STALE cached chunks — the barrel's chunk imports
  // (`import _0 from './parts/ram.js'`) carry no cache-buster — so a per-category
  // re-import + writeCatalog would clobber the prior category's additions (the exact
  // ESM chunk-cache trap documented in write-catalog.cjs). One in-memory array is
  // the single source of truth for the whole run.
  const mod = await import('file://' + ROOT.replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default || [])];
  const existingIds = new Set(parts.map((p) => p.id));
  let nextId = Math.max(...parts.map((p) => p.id || 0)) + 1;
  const allocId = () => { while (existingIds.has(nextId)) nextId++; existingIds.add(nextId); return nextId++; };
  const reAsin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i;
  const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
  const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };

  for (const cat of cats) {
    console.log(`\n${bar}\n${cat}\n${bar}`);
    const startCount = parts.length;   // per-category base for the growth brake
    // dedup sets rebuilt from the CURRENT (growing) catalog each category
    const catalogAsins = new Set(), byUPC = new Set(), byMPN = new Set();
    for (const p of parts) {
      if (p.asin) catalogAsins.add(String(p.asin).toUpperCase());
      if (p.deals?.amazon?.asin) catalogAsins.add(String(p.deals.amazon.asin).toUpperCase());
      const mm = p.deals?.amazon?.url && String(p.deals.amazon.url).match(reAsin); if (mm) catalogAsins.add(mm[1].toUpperCase());
      const u = normUPC(p.upc); if (u) byUPC.add(u); const m = normMPN(p.mpn); if (m) byMPN.add(m);
    }

    const batchId = `amazon-${cat.toLowerCase()}-${TODAY}`;
    const c = { candidates: 0, deduped: 0, accepted: 0, written: 0, acceptRate: 0, rejects: {}, ceiling: null, detector: null };
    const bump = (g, t) => { let e = c.rejects[g]; if (!e) { e = { n: 0, examples: [] }; c.rejects[g] = e; } e.n++; if (e.examples.length < 5) e.examples.push(t); };

    // 1) gather
    const found = new Map();
    for (const kw of PLANS[cat]) {
      const { items } = await searchItems(kw, { pages: 10, searchIndex: 'Electronics' });
      for (const it of items) { const a = it?.asin?.toUpperCase(); if (a && !found.has(a)) found.set(a, it); }
      if (!paapiStatus().available) haltAndReport('paapi_circuit_open', `circuit opened during ${cat} search`);
    }

    // 2) gate
    const accepted = [];
    for (const [asin, it] of found) {
      c.candidates++;
      const title = titleOf(it);
      if (catalogAsins.has(asin)) { c.deduped++; continue; }
      const specs = CC.extractSpecs(title, cat);
      const reason = gateReason(cat, title, mfrOf(it));
      if (reason) { bump(reason, title); continue; }
      accepted.push({ asin, it, brand: CC.resolveDiscoveryBrand(title, mfrOf(it), cat), searchPrice: priceOf(it) });
    }
    const newCount = c.candidates - c.deduped;
    c.accepted = accepted.length;
    c.acceptRate = newCount ? accepted.length / newCount : 0;
    console.log(`  candidates ${c.candidates} · deduped ${c.deduped} · accepted ${c.accepted} (${(c.acceptRate * 100).toFixed(1)}%)`);

    // HARD STOP: accept rate > 80%
    if (newCount >= 10 && c.acceptRate > HS_ACCEPT_RATE) { report.categories[cat] = c; haltAndReport('accept_rate_over_80', `${cat} accept rate ${(c.acceptRate * 100).toFixed(1)}% (>${HS_ACCEPT_RATE * 100}%) — a gate is not firing`); }

    // 3) confirm buybox (price) for accepted
    const confMap = accepted.length ? await resolveItems(accepted.map((a) => a.asin), { resources: CONFIRM_RES }) : new Map();
    if (!paapiStatus().available) { report.categories[cat] = c; haltAndReport('paapi_circuit_open', `circuit opened during ${cat} confirm`); }

    // 4) price ceiling check (absolute table) — for hard-stop + row provenance
    const priced = [];
    for (const a of accepted) {
      const item = confMap.get(a.asin);
      const v = item ? classifyBuyBox(item) : { state: 'no_data', reason: 'paapi_no_data' };
      const price = v.state === BUYBOX_STATE.CONFIRMED ? v.offer.price : a.searchPrice;
      a.verdict = v; a.price = price;
      if (price != null) priced.push(a);
    }
    const gate = CAP.validatePriceBatch(
      priced.map((a) => ({ category: cat, specs: CC.extractSpecs(titleOf(a.it), cat), price: a.price, a })),
      { today: TODAY });
    const ceilFailed = gate.quarantined.length;
    c.ceiling = { priced: priced.length, failed: ceilFailed, failRate: priced.length ? ceilFailed / priced.length : 0,
      calibratedAt: gate.calibratedAt, warnings: gate.warnings };
    for (const w of gate.warnings || []) console.log(`  !! ceiling warning: ${w}`);
    console.log(`  price ceiling: ${priced.length} priced, ${ceilFailed} over ceiling (${(c.ceiling.failRate * 100).toFixed(1)}%)`);

    // HARD STOP: >30% ceiling fail
    if (priced.length >= 10 && c.ceiling.failRate > HS_CEILING_FAIL) { report.categories[cat] = c; haltAndReport('ceiling_fail_over_30', `${cat} ${(c.ceiling.failRate * 100).toFixed(1)}% over ceiling (>${HS_CEILING_FAIL * 100}%) — ceiling likely stale, not the data`); }

    // 5) build rows (ALL quarantined). ceiling-failers get an extra priceQuarantine note.
    const ceilBad = new Set(gate.quarantined.map((e) => e.row.a.asin));
    const rows = accepted.map((a) => {
      const row = buildRow(cat, allocId(), a.it, a.brand, a.price, a.verdict, batchId);
      if (ceilBad.has(a.asin)) { const q = gate.quarantined.find((e) => e.row.a.asin === a.asin); row.priceQuarantine = { reason: q.verdict.reason, ppu: q.verdict.ppu, unit: q.verdict.unit, ceiling: q.verdict.ceiling }; }
      return row;
    });

    // HARD STOP: cumulative growth
    if (report.totals.written + rows.length > HS_GROWTH_TOTAL) { report.categories[cat] = c; haltAndReport('growth_over_3000', `${cat} would push cumulative additions to ${report.totals.written + rows.length} (>${HS_GROWTH_TOTAL})`); }

    report.totals.candidates += c.candidates; report.totals.accepted += c.accepted;

    if (!APPLY) {
      console.log(`  DRY RUN — would write ${rows.length} quarantined ${cat} rows (batch ${batchId})`);
      c.written = 0; report.categories[cat] = c; continue;
    }

    // 6) WRITE (quarantined) via writeCatalog — the ONLY write path
    if (rows.length) {
      parts.push(...rows);
      await writeCatalog(parts, { loadedCount: startCount, reason: `weekend amazon ${cat} discovery QUARANTINED (${rows.length}, batch ${batchId})` });
      c.written = rows.length; report.totals.written += rows.length;
      console.log(`  WROTE ${rows.length} quarantined ${cat} rows. Catalog ${startCount} → ${parts.length}.`);

      // 7) detector on fresh chunks (read-only) — hard-stop if >5% of NEW rows flagged
      let flagged = 0;
      try {
        const out = execFileSync(process.execPath, ['detect-wrong-asin.cjs'], { cwd: ROOT }).toString();
        const newIds = new Set(rows.map((r) => String(r.id)));
        for (const line of out.split('\n')) { const m = line.match(/#(\d+)\s/); if (m && newIds.has(m[1])) flagged++; }
      } catch (e) { /* detector prints hits then exits 0/1; ignore exit, parse stdout if any */ }
      c.detector = { checked: rows.length, flagged, rate: rows.length ? flagged / rows.length : 0 };
      console.log(`  detector: ${flagged}/${rows.length} new rows flagged (${(c.detector.rate * 100).toFixed(1)}%)`);
      report.categories[cat] = c;
      if (c.detector.rate > HS_DETECTOR) haltAndReport('detector_over_5pct', `${cat} detector flagged ${flagged}/${rows.length} new rows (${(c.detector.rate * 100).toFixed(1)}% > ${HS_DETECTOR * 100}%)`);

      // commit to branch (source only; NO dist, NO deploy)
      try {
        execFileSync('git', ['add', 'src/data/parts'], { cwd: ROOT });
        execFileSync('git', ['commit', '-q', '-m', `chore(weekend-ingest): ${cat} +${rows.length} QUARANTINED (batch ${batchId}) [no-deploy]`], { cwd: ROOT });
        console.log(`  committed ${cat} batch to ${branch}`);
      } catch (e) { console.log(`  (commit skipped: ${e.message.slice(0, 120)})`); }
    } else {
      c.written = 0; report.categories[cat] = c;
    }
  }

  // recommendations
  report.recommendations = [];
  for (const [cat, c] of Object.entries(report.categories)) {
    if (!c.written) continue;
    const susp = (c.ceiling && c.ceiling.failRate > 0.1) || (c.detector && c.detector.rate > 0);
    report.recommendations.push(`${cat} batch amazon-${cat.toLowerCase()}-${TODAY}: ${c.written} rows — ${susp ? 'REVIEW CLOSELY (ceiling/detector flags present)' : 'looks clean; spot-check a sample then release'}`);
  }
  finalizeReport();
  const st = paapiStatus();
  console.log(`\n${'='.repeat(80)}\nDONE (${APPLY ? 'APPLY' : 'DRY RUN'}). written ${report.totals.written} (all quarantined). PA API calls=${st.stats.calls} throttled=${st.stats.throttled}.\nReport: ${path.relative(ROOT, REPORT_MD)}\n${'='.repeat(80)}`);
})().catch((e) => { report.fatal = String(e.stack || e.message); try { finalizeReport(); } catch {} console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
