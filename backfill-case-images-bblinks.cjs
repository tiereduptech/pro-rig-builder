#!/usr/bin/env node
/**
 * backfill-case-images-bblinks.cjs — repair two defects the case ingest wrote.
 *
 * (1) BLANK THUMBNAILS — 1,108 of 1,108 batch rows have img:null. The Newegg feed carries
 *     image_url on 100% of rows and case-sweep-newegg.cjs captured it, but the row mappers in
 *     case-gate-audit.cjs dropped it, so accepted[].image was undefined before the ingest ever
 *     saw it. The mappers are fixed for future runs; this repairs the rows already written.
 *     ZERO API CALLS: both sweep dumps are on disk and cover every row.
 *
 * (2) NON-EARNING BEST BUY LINKS — 9 rows store the Developer API's raw click URL
 *     (https://api.bestbuy.com/click/-/<sku>/pdp), which carries no affiliate attribution, so
 *     a click earns nothing. 7 came from the ingest's insert path and 2 from its recovery path
 *     (#70053, #70085). Every other Best Buy row in the catalog uses the 7tiv wrapper. Rebuilt
 *     exactly the way bestbuy-discover-v2.js constructs it.
 *
 * Matching is by EXACT identifier only — Newegg item number, Best Buy SKU — never by name.
 * A row whose identifier is not in the dumps is left untouched and reported, never guessed at.
 *
 * Usage:  node backfill-case-images-bblinks.cjs           (dry run)
 *         node backfill-case-images-bblinks.cjs --write    (apply via writeCatalog)
 */
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const WRITE = process.argv.includes('--write');
const BATCH = 'case-ingest-2026-08-10';

// identical to bestbuy-discover-v2.js
const BB = { host: 'bestbuycreators.7tiv.net', partner: '7109270', offer: '3337161', campaign: '28102' };
const bbProductUrl = (sku) => `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
const bbAffiliateUrl = (sku) => `https://${BB.host}/c/${BB.partner}/${BB.offer}/${BB.campaign}?prodsku=${sku}&u=${encodeURIComponent(bbProductUrl(sku))}`;
const skuFromAnyBBUrl = (u) => {
  const s = String(u || '');
  return (s.match(/[?&]prodsku=(\d+)/i) || s.match(/\/click\/-\/(\d+)\//i) || s.match(/skuId=(\d+)/i) || [])[1] || null;
};

(async () => {
  const ne = require('./catalog-build/case-sweep-newegg.json').rows;
  const bb = require('./catalog-build/case-sweep-bestbuy.json').rows;
  const neByItem = new Map(ne.map((r) => [String(r.itemNumber).toUpperCase(), r]));
  const bbBySku = new Map(bb.map((r) => [String(r.sku), r]));

  const mod = await import('file://' + path.resolve('src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default)];
  const loadedCount = parts.length;

  console.log(`${'='.repeat(90)}\nCASE IMAGE + BEST BUY LINK BACKFILL — ${WRITE ? 'WRITE' : 'DRY RUN'}\n${'='.repeat(90)}`);
  console.log(`catalog ${loadedCount} · newegg dump ${ne.length} rows · bestbuy dump ${bb.length} rows\n`);

  const img = { newegg: 0, bestbuy: 0, alreadyHad: 0, unmatched: [] };
  const link = { fixed: [], unmatched: [] };

  for (const p of parts) {
    const isBatch = p.batchId === BATCH || p.recoveredBy === BATCH;

    // ── (1) images — batch rows only, never overwrite an existing image
    if (isBatch && p.c === 'Case') {
      if (p.img) img.alreadyHad++;
      else {
        const neSku = p.deals?.newegg?.sku;
        const bbSku = p.deals?.bestbuy?.sku || skuFromAnyBBUrl(p.deals?.bestbuy?.url);
        const src = (neSku && neByItem.get(String(neSku).toUpperCase())) || (bbSku && bbBySku.get(String(bbSku)));
        if (src && src.image) { p.img = src.image; if (p.deals?.newegg && !p.deals.newegg.imageurl) p.deals.newegg.imageurl = src.image; (neSku ? img : img) && (neSku ? img.newegg++ : img.bestbuy++); }
        else img.unmatched.push({ id: p.id, neSku: neSku || null, bbSku: bbSku || null, name: String(p.n).slice(0, 46) });
      }
    }

    // ── (2) Best Buy affiliate links — catalog-wide, any row carrying a raw click URL
    const u = p.deals?.bestbuy?.url;
    if (u && /api\.bestbuy\.com\/click/i.test(u)) {
      const sku = skuFromAnyBBUrl(u);
      if (!sku) { link.unmatched.push({ id: p.id, url: String(u).slice(0, 70) }); continue; }
      const before = u;
      p.deals.bestbuy.url = bbAffiliateUrl(sku);
      p.deals.bestbuy.sku = String(sku);
      link.fixed.push({ id: p.id, cat: p.c, sku, before: String(before).slice(0, 52), name: String(p.n).slice(0, 40) });
    }
  }

  console.log('── (1) IMAGES ──────────────────────────────────────────────────────────────');
  console.log(`  filled from the Newegg dump : ${img.newegg}`);
  console.log(`  filled from the Best Buy dump: ${img.bestbuy}`);
  console.log(`  already had an image         : ${img.alreadyHad}`);
  console.log(`  still blank (unmatched)      : ${img.unmatched.length}`);
  for (const u of img.unmatched.slice(0, 10)) console.log(`     #${u.id}  neSku=${u.neSku} bbSku=${u.bbSku}  ${u.name}`);

  console.log('\n── (2) BEST BUY AFFILIATE LINKS ────────────────────────────────────────────');
  console.log(`  rewritten: ${link.fixed.length}   unresolvable: ${link.unmatched.length}`);
  for (const f of link.fixed) console.log(`     #${String(f.id).padEnd(7)} [${f.cat}] sku ${f.sku}  ${f.name}`);
  if (link.fixed.length) {
    console.log(`\n  example after: ${decodeURIComponent(parts.find((p) => p.id === link.fixed[0].id).deals.bestbuy.url)}`);
  }

  const caseRows = parts.filter((p) => p.c === 'Case');
  console.log(`\nCase rows with an image now: ${caseRows.filter((p) => p.img).length}/${caseRows.length}`);
  const rawLeft = parts.filter((p) => /api\.bestbuy\.com\/click/i.test(p.deals?.bestbuy?.url || '')).length;
  console.log(`rows still on a raw Best Buy click URL: ${rawLeft}`);

  if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); return; }
  await writeCatalog(parts, { loadedCount,
    reason: `backfill case images (${img.newegg + img.bestbuy}) + rebuild ${link.fixed.length} Best Buy affiliate links` });
  console.log(`\nWROTE. images +${img.newegg + img.bestbuy} · bestbuy links ${link.fixed.length}.`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
