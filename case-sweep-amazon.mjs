// case-sweep-amazon.mjs — CASES ONLY. Phase-1 read-only Amazon SearchItems sweep.
//
// WRITES NOTHING. Dumps every distinct case-category candidate SearchItems will serve,
// so Phase 2 can attribute each miss to a gate offline.
//
// WHY KEYWORD × PRICE-BAND, NOT BRAND: the Creators SearchItems `brand` param is
// inert on this account (the Apevia pilot got identical result sets with and without
// it), so brand scoping cannot widen coverage. What DOES widen it is the fact that
// each query is hard-capped at 10 pages × 10 items = 100 items. Slicing the SAME
// keyword by a disjoint price band returns a DIFFERENT 100 rows per band, so
// N keywords × M bands ≈ N×M×100 reachable rows instead of N×100.
//
// Run: node case-sweep-amazon.mjs
// No --apply flag exists. This script cannot write.

import { searchItems, paapiStatus, onPaapiAlert, SEARCH_RESOURCES } from './amazon-paapi.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'catalog-build', 'case-sweep-amazon.json');

// Broad case-category net. Every phrasing real listings use for a chassis, plus the
// form-factor and finish/feature vocabulary that segments the category (budget SFF
// makers title on form factor; premium makers title on airflow/glass/colour).
const KEYWORDS = [
  'pc case', 'computer case', 'gaming pc case', 'desktop computer case',
  'atx case', 'atx mid tower case', 'full tower case', 'micro atx case',
  'mini itx case', 'itx case', 'sff case', 'e-atx case',
  'mid tower computer case', 'mini tower case', 'cube case pc',
  'pc case airflow', 'mesh pc case', 'tempered glass pc case',
  'white pc case', 'black pc case', 'pc case rgb',
  'pc case with fans', 'pc chassis', 'gaming chassis',
  'small form factor pc case', 'open frame pc case', 'pc case usb-c',
  'quiet pc case', 'water cooling pc case', 'vertical gpu pc case',
];

// Disjoint price bands in DOLLARS (converted per-unit below). Cases run ~$30–$500;
// the open top band catches halo chassis.
const BANDS = [
  [null, 50], [50, 80], [80, 120], [120, 180], [180, 280], [280, null],
];

// Creators SearchItems price unit is unverified for this account. Probe it: run one
// keyword with a band expressed in CENTS and again in DOLLARS, and keep whichever
// unit actually constrains the returned prices. Guessing wrong would silently make
// every band a no-op (all bands return the same 100 rows) — the exact failure this
// sweep exists to avoid.
async function probePriceUnit(kw) {
  const lo = 200, hi = 280;                       // $200–$280 window
  const asDollars = await searchItems(kw, { pages: 1, searchIndex: 'Electronics', minPrice: lo, maxPrice: hi });
  const asCents = await searchItems(kw, { pages: 1, searchIndex: 'Electronics', minPrice: lo * 100, maxPrice: hi * 100 });
  const priceOf = (it) => it?.offersV2?.listings?.[0]?.price?.money?.amount ?? null;
  const inWindow = (r) => {
    const ps = r.items.map(priceOf).filter((p) => p != null);
    if (!ps.length) return { n: 0, frac: 0, med: null };
    const hits = ps.filter((p) => p >= lo && p <= hi).length;
    const sorted = [...ps].sort((a, b) => a - b);
    return { n: ps.length, frac: hits / ps.length, med: sorted[Math.floor(sorted.length / 2)] };
  };
  const d = inWindow(asDollars), c = inWindow(asCents);
  console.log(`  price-unit probe on "${kw}": dollars → ${d.n} priced, ${(d.frac * 100).toFixed(0)}% in $${lo}-${hi} (median $${d.med})`);
  console.log(`                              cents   → ${c.n} priced, ${(c.frac * 100).toFixed(0)}% in $${lo}-${hi} (median $${c.med})`);
  if (d.frac >= 0.6 && d.frac > c.frac) return { unit: 'dollars', mult: 1 };
  if (c.frac >= 0.6 && c.frac > d.frac) return { unit: 'cents', mult: 100 };
  return { unit: 'unconstrained', mult: null };   // param ignored → skip banding
}

const titleOf = (it) => it?.itemInfo?.title?.displayValue || it?.itemInfo?.title || '';
const mfrOf = (it) => it?.itemInfo?.byLineInfo?.manufacturer?.displayValue
  || it?.itemInfo?.byLineInfo?.brand?.displayValue || '';
const brandFieldOf = (it) => it?.itemInfo?.byLineInfo?.brand?.displayValue || '';
const priceOf = (it) => it?.offersV2?.listings?.[0]?.price?.money?.amount ?? null;
const availOf = (it) => it?.offersV2?.listings?.[0]?.availability?.message
  || it?.offersV2?.listings?.[0]?.availability?.type || null;

(async () => {
  console.log('='.repeat(80));
  console.log('AMAZON CASE SWEEP — READ-ONLY. Nothing is written to the catalog.');
  console.log('='.repeat(80));
  onPaapiAlert((a) => console.log(`\n  ⚠ PA API degraded: ${a.reason} — ${a.detail}\n`));

  const found = new Map();                 // asin -> { item, queries[] }
  const perQuery = [];
  const record = (label, items) => {
    let fresh = 0;
    for (const it of items) {
      const a = it?.asin?.toUpperCase();
      if (!a) continue;
      if (!found.has(a)) { found.set(a, { it, queries: [label] }); fresh++; }
      else found.get(a).queries.push(label);
    }
    return fresh;
  };

  const unit = await probePriceUnit('pc case');
  console.log(`  → price param unit: ${unit.unit}${unit.mult ? '' : ' (bands SKIPPED — param inert)'}\n`);

  // Pass 1 — unbanded, 10 pages per keyword (the cap).
  console.log(`Pass 1: ${KEYWORDS.length} keywords × up to 10 pages, deduped by ASIN`);
  for (const kw of KEYWORDS) {
    const r = await searchItems(kw, { pages: 10, searchIndex: 'Electronics' });
    const fresh = record(`kw:${kw}`, r.items);
    perQuery.push({ q: kw, band: null, items: r.items.length, pages: r.pagesFetched, total: r.totalResultCount, fresh });
    console.log(`  ${kw.padEnd(30)} → ${String(r.items.length).padStart(3)} items, ${r.pagesFetched}p, total≈${r.totalResultCount ?? '?'}, +${fresh} new  (running ${found.size})`);
    if (!paapiStatus().available) { console.log('  (circuit open — stopping pass 1)'); break; }
  }

  // Pass 2 — the same keywords sliced by disjoint price band, which returns a
  // different 100 rows per band and is the only way past the per-query cap.
  if (unit.mult && paapiStatus().available) {
    const BANDED = KEYWORDS.slice(0, 12);   // the broadest phrasings carry the deepest tails
    console.log(`\nPass 2: ${BANDED.length} keywords × ${BANDS.length} price bands (${unit.unit})`);
    for (const kw of BANDED) {
      for (const [lo, hi] of BANDS) {
        const opts = { pages: 10, searchIndex: 'Electronics' };
        if (lo != null) opts.minPrice = lo * unit.mult;
        if (hi != null) opts.maxPrice = hi * unit.mult;
        const r = await searchItems(kw, opts);
        const label = `kw:${kw}|$${lo ?? 0}-${hi ?? '∞'}`;
        const fresh = record(label, r.items);
        perQuery.push({ q: kw, band: [lo, hi], items: r.items.length, pages: r.pagesFetched, total: r.totalResultCount, fresh });
        console.log(`  ${kw.padEnd(24)} $${String(lo ?? 0).padStart(3)}-${String(hi ?? '∞').padEnd(4)} → ${String(r.items.length).padStart(3)} items, ${r.pagesFetched}p, +${fresh} new  (running ${found.size})`);
        if (!paapiStatus().available) break;
      }
      if (!paapiStatus().available) { console.log('  (circuit open — stopping pass 2)'); break; }
    }
  }

  const rows = [...found.entries()].map(([asin, e]) => ({
    asin, title: titleOf(e.it), mfr: mfrOf(e.it), brandField: brandFieldOf(e.it),
    price: priceOf(e.it), availability: availOf(e.it), queries: e.queries.slice(0, 6),
  }));

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'amazon-searchitems', dryRun: true, wrote: false,
    priceUnit: unit, keywords: KEYWORDS, bands: BANDS, perQuery,
    distinctFound: rows.length, rows,
  }, null, 2));

  const st = paapiStatus();
  console.log('\n' + '─'.repeat(80));
  console.log(`DISTINCT ASINs FOUND: ${rows.length}`);
  console.log(`queries run: ${perQuery.length}   PA API calls=${st.stats.calls} items=${st.stats.items} throttled=${st.stats.throttled} batchErrors=${st.stats.batchErrors}`);
  if (st.disabledReason) console.log(`  ⚠ degraded: ${st.disabledReason}`);
  console.log(`Report: ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
