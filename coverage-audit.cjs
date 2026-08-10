#!/usr/bin/env node
/**
 * coverage-audit.cjs — LAYER 1 of the deliberate coverage audit. READ-ONLY.
 *
 * The Apevia-case hole was invisible until Coby searched Apevia by hand. This
 * finds the NEXT such hole deliberately, with zero API cost, from the catalog alone.
 *
 * Three ranked signals (per the brief):
 *   (A) EMPTY / THIN cells — a brand we carry, in a category where we carry it 0-2×
 *       while the category is deep. "We barely stock them here."
 *   (B) CROSS-CATEGORY ABSENCE — a brand present in category A but absent from
 *       category B that it PLAUSIBLY sells in. Plausibility is DATA-DRIVEN, not a
 *       hand-maintained table: for X absent from B,
 *          plausibility(X,B) = max over A in cats(X) of  |brands(A) ∩ brands(B)| / |brands(A)|
 *       i.e. "of the brands that sell in A (where X sells), what fraction also sell
 *       in B?" If most PSU brands also make cases, a PSU-maker's Case-absence scores
 *       high (the Apevia signal); a pure RAM maker's Case-absence scores low.
 *   (C) per-category brand roster — which brands exist in each category + counts.
 *
 * Coverage is counted on INDEXABLE rows (what a buyer/crawler actually sees), with
 * total shown alongside. needsReview/quarantined rows don't count as coverage.
 *
 *   node coverage-audit.cjs               # top 20 holes across all categories
 *   node coverage-audit.cjs --top=40      # deeper list
 *   node coverage-audit.cjs --category=Case   # focus one category's roster + holes
 *   node coverage-audit.cjs --json        # machine-readable report to coverage-audit.json
 */

const fs = require('fs');
const path = require('path');
const { isIndexable, loadParts } = require('./scripts/url-slugs.cjs');

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=')[1] : d; };
const TOP = parseInt(arg('top', '20'), 10) || 20;
const FOCUS = arg('category', null);
const JSON_OUT = argv.includes('--json');

// A brand needs at least this much of a real footprint before its absence from a
// category is worth flagging — filters one-off/unbranded noise ("(no brand)", a
// single mislabeled row) from the cross-absence signal.
const MIN_BRAND_FOOTPRINT = 3;   // total indexable rows across all categories
// A cell is "thin" if a real category (this deep) holds only this few of a brand.
const THIN_MAX = 2;
const DEEP_CATEGORY = 40;        // a category with >= this many rows is "deep"
const norm = (b) => String(b || '').trim();
const IGNORE_BRANDS = new Set(['', '(no brand)', 'Generic', 'Unknown', 'OEM', 'Budget', 'Misc', 'Various', 'N/A', 'Assorted']);
// Chip giants make ONLY silicon (CPU/GPU) — never cases/fans/peripherals. Their
// statistical co-occurrence with real makers (shared boards/GPU categories) makes
// the plausibility metric flag them as "absent sellers," which is always noise.
// Excluded as SELLERS only (a category can still be flagged as missing them if that
// ever made sense — it won't). Mirrors catalog-classify's implausibleBrandForCategory.
const SELLER_EXCLUDE = new Set(['amd', 'intel', 'nvidia']);

(async () => {
  const all = (await loadParts()).filter((p) => !p.bundle);
  const idx = all.filter(isIndexable);

  // ── rosters ────────────────────────────────────────────────────────────────
  const cats = [...new Set(idx.map((p) => p.c).filter(Boolean))].sort();
  const catBrands = new Map();          // category -> Map(brand -> {live, total})
  const brandCats = new Map();          // brand -> Map(category -> {live, total})
  const catSize = new Map();            // category -> live row count
  const brandFootprint = new Map();     // brand -> total live rows

  const tally = (p, live) => {
    const c = p.c, b = norm(p.b);
    if (!c || IGNORE_BRANDS.has(b)) return;
    if (!catBrands.has(c)) catBrands.set(c, new Map());
    if (!brandCats.has(b)) brandCats.set(b, new Map());
    const cb = catBrands.get(c); if (!cb.has(b)) cb.set(b, { live: 0, total: 0 });
    const bc = brandCats.get(b); if (!bc.has(c)) bc.set(c, { live: 0, total: 0 });
    cb.get(b).total++; bc.get(c).total++;
    if (live) { cb.get(b).live++; bc.get(c).live++; }
  };
  for (const p of all) tally(p, false);
  for (const p of idx) { const c = p.c; catSize.set(c, (catSize.get(c) || 0) + 1); const b = norm(p.b); if (!IGNORE_BRANDS.has(b)) brandFootprint.set(b, (brandFootprint.get(b) || 0) + 1); }
  // re-tally live correctly (the loop above set live=false for all; fix by counting idx)
  for (const c of catBrands.values()) for (const v of c.values()) v.live = 0;
  for (const b of brandCats.values()) for (const v of b.values()) v.live = 0;
  for (const p of idx) {
    const c = p.c, b = norm(p.b);
    if (!c || IGNORE_BRANDS.has(b)) continue;
    if (catBrands.get(c)?.has(b)) catBrands.get(c).get(b).live++;
    if (brandCats.get(b)?.has(c)) brandCats.get(b).get(c).live++;
  }

  const brandsIn = (c) => new Set([...(catBrands.get(c)?.keys() || [])]);
  const brandSetByCat = new Map(cats.map((c) => [c, brandsIn(c)]));

  // ── signal B: cross-category absence, data-driven plausibility ──────────────
  const holes = [];
  for (const B of cats) {
    const sizeB = catSize.get(B) || 0;
    if (sizeB < 8) continue;            // don't flag holes in a category we barely have ourselves
    const brandsB = brandSetByCat.get(B);
    for (const [X, cmap] of brandCats) {
      if (brandsB.has(X)) continue;                       // present — not a hole
      if (SELLER_EXCLUDE.has(X.toLowerCase())) continue;  // chip giants make only silicon
      if ((brandFootprint.get(X) || 0) < MIN_BRAND_FOOTPRINT) continue;
      // plausibility = strongest overlap between a category X sells in and B
      let plaus = 0, viaA = null;
      for (const A of cmap.keys()) {
        const brandsA = brandSetByCat.get(A); if (!brandsA || brandsA.size === 0) continue;
        let inter = 0; for (const b of brandsA) if (brandsB.has(b)) inter++;
        const aff = inter / brandsA.size;
        if (aff > plaus) { plaus = aff; viaA = A; }
      }
      if (plaus < 0.15) continue;                         // too weak to be a plausible seller
      const footprint = brandFootprint.get(X) || 0;
      // score rewards a strong ecosystem signal (plaus) AND an established maker (footprint)
      const score = plaus * Math.log2(1 + footprint);
      const sells = [...cmap.entries()].filter(([, v]) => v.live > 0)
        .sort((a, b) => b[1].live - a[1].live)
        .map(([c, v]) => `${c}:${v.live}`);
      holes.push({ brand: X, missingFrom: B, plausibility: +plaus.toFixed(2), viaCategory: viaA,
        footprint, score: +score.toFixed(2), sellsIn: sells });
    }
  }
  holes.sort((a, b) => b.score - a.score);

  // ── signal A: thin cells in deep categories ─────────────────────────────────
  const thin = [];
  for (const [c, bm] of catBrands) {
    if ((catSize.get(c) || 0) < DEEP_CATEGORY) continue;
    for (const [b, v] of bm) if (v.live > 0 && v.live <= THIN_MAX) thin.push({ brand: b, category: c, live: v.live, catSize: catSize.get(c) });
  }
  thin.sort((a, b) => (a.live - b.live) || (b.catSize - a.catSize));

  // ── output ──────────────────────────────────────────────────────────────────
  const bar = '─'.repeat(80);
  console.log('='.repeat(80));
  console.log(`COVERAGE AUDIT (layer 1, read-only) — ${cats.length} categories, ${idx.length} indexable rows`);
  console.log('='.repeat(80));

  if (FOCUS) {
    const bm = catBrands.get(FOCUS);
    console.log(`\nROSTER — ${FOCUS} (${catSize.get(FOCUS) || 0} indexable rows):`);
    if (!bm) console.log('  (no such category)');
    else for (const [b, v] of [...bm.entries()].sort((a, c) => c[1].live - a[1].live)) console.log(`  ${String(v.live).padStart(4)}  ${b}${v.total !== v.live ? `  (+${v.total - v.live} held)` : ''}`);
    console.log(`\nHOLES missing FROM ${FOCUS} (plausible sellers we don't carry here):`);
    const f = holes.filter((h) => h.missingFrom === FOCUS).slice(0, TOP);
    for (const h of f) console.log(`  ${h.brand.padEnd(22)} plaus ${h.plausibility}  (sells: ${h.sellsIn.join(', ')})`);
  } else {
    console.log(`\nTOP ${TOP} SUSPECTED HOLES — brand absent from a category it plausibly sells in`);
    console.log(bar);
    console.log(`  ${'brand'.padEnd(22)} ${'missing from'.padEnd(14)} plaus  foot  where we carry them`);
    console.log(bar);
    for (const h of holes.slice(0, TOP)) {
      console.log(`  ${h.brand.padEnd(22)} ${h.missingFrom.padEnd(14)} ${String(h.plausibility).padEnd(5)} ${String(h.footprint).padStart(4)}  ${h.sellsIn.slice(0, 6).join(', ')}`);
    }
    console.log(`\nTHIN CELLS — brand barely stocked (≤${THIN_MAX}) in a deep category (top 15):`);
    console.log(bar);
    for (const t of thin.slice(0, 15)) console.log(`  ${t.brand.padEnd(22)} ${t.category.padEnd(14)} ${t.live} row(s)  (category has ${t.catSize})`);
  }

  if (JSON_OUT) {
    const out = { generatedAt: new Date().toISOString(), categories: cats.length, indexableRows: idx.length,
      holes: holes.slice(0, 200), thin: thin.slice(0, 100),
      roster: Object.fromEntries([...catBrands].map(([c, bm]) => [c, Object.fromEntries([...bm].map(([b, v]) => [b, v.live]))])) };
    fs.writeFileSync(path.join(__dirname, 'coverage-audit.json'), JSON.stringify(out, null, 2));
    console.log('\nWrote coverage-audit.json');
  }
  console.log('\nREAD-ONLY. No catalog change. Signals are candidates — confirm before discovery runs.');
})();
