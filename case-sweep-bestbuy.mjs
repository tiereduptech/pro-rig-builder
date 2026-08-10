// case-sweep-bestbuy.mjs — CASES ONLY. Phase-1 read-only Best Buy sweep.
//
// WRITES NOTHING (no catalog, no staging merge — just a report JSON). Pages the Best
// Buy Developer API for EVERY product in the case category and records it, so Phase 2
// can attribute each miss to a gate offline.
//
// FIRST-PARTY ONLY: the Developer API serves Best Buy direct inventory, but a
// marketplace/3P row is still distinguishable and is EXCLUDED per the standing
// Best-Buy-first-party-only policy (a 3P Best Buy link is not a link we publish).
//
// Needs BESTBUY_API_KEY — present in Railway, absent locally:
//   railway run node case-sweep-bestbuy.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('ERROR: BESTBUY_API_KEY required (use: railway run node case-sweep-bestbuy.mjs)'); process.exit(1); }

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'catalog-build', 'case-sweep-bestbuy.json');

// abcat0507006 = Computer Cases (the ID bestbuy-discover-v2.js already uses for Case).
// pcmcat... additions are the adjacent leaves a chassis can be filed under; unknown
// IDs simply return 0 rather than erroring, so probing them is free coverage.
const CATEGORY_IDS = ['abcat0507006'];

const SHOW = [
  'sku', 'name', 'manufacturer', 'modelNumber', 'upc',
  'salePrice', 'regularPrice', 'onSale',
  'onlineAvailability', 'inStoreAvailability', 'orderable',
  'image', 'url', 'color', 'depth', 'height', 'width',
  'categoryPath', 'customerReviewAverage', 'customerReviewCount',
  'marketplace', 'condition', 'details',
].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page, attempt = 1) {
  const filter = CATEGORY_IDS.map((id) => `categoryPath.id=${id}`).join('|');
  const url = `https://api.bestbuy.com/v1/products((${filter}))?apiKey=${KEY}&page=${page}&pageSize=100&show=${SHOW}&format=json`;
  const resp = await fetch(url);
  if (resp.status === 403 && attempt < 6) { await sleep(attempt * 2500); return fetchPage(page, attempt + 1); }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on page ${page}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

(async () => {
  console.log('='.repeat(80));
  console.log('BEST BUY CASE SWEEP — READ-ONLY. Nothing is written to the catalog.');
  console.log('='.repeat(80));

  const rows = [];
  let page = 1, totalPages = 1, total = null;
  do {
    const j = await fetchPage(page);
    total = j.total; totalPages = j.totalPages || 1;
    for (const p of j.products || []) rows.push(p);
    console.log(`  page ${page}/${totalPages} → ${(j.products || []).length} products (running ${rows.length}/${total})`);
    page++;
    if (page <= totalPages) await sleep(600);
  } while (page <= totalPages);

  // first-party / condition / orderable split — reported, not silently dropped
  const tally = { total: rows.length, marketplace: 0, notNew: 0, notOrderable: 0, firstPartyNew: 0 };
  const kept = [];
  for (const p of rows) {
    if (p.marketplace === true) { tally.marketplace++; continue; }
    if (p.condition && !/^new$/i.test(p.condition)) { tally.notNew++; continue; }
    const orderable = p.orderable == null ? null : String(p.orderable);
    if (p.onlineAvailability === false && p.inStoreAvailability === false) { tally.notOrderable++; continue; }
    tally.firstPartyNew++;
    kept.push({
      sku: String(p.sku), name: p.name || '', mfr: p.manufacturer || '', mpn: p.modelNumber || '',
      upc: p.upc || '', price: p.salePrice ?? p.regularPrice ?? null, regularPrice: p.regularPrice ?? null,
      onlineAvailability: p.onlineAvailability, inStoreAvailability: p.inStoreAvailability, orderable,
      condition: p.condition || 'New', image: p.image || null, url: p.url || null,
      color: p.color || null, depth: p.depth || null, height: p.height || null, width: p.width || null,
      categoryPath: (p.categoryPath || []).map((c) => c.name).join(' > '),
      reviewAvg: p.customerReviewAverage ?? null, reviewCount: p.customerReviewCount ?? null,
    });
  }

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'bestbuy-api', dryRun: true, wrote: false,
    categoryIds: CATEGORY_IDS, apiTotal: total, tally, rows: kept,
  }, null, 2));

  console.log('\n' + '─'.repeat(80));
  console.log(`API total in category .......... ${total}`);
  console.log(`  ✗ marketplace (3P) .......... ${tally.marketplace}`);
  console.log(`  ✗ not New condition ......... ${tally.notNew}`);
  console.log(`  ✗ not orderable anywhere .... ${tally.notOrderable}`);
  console.log(`  ✓ first-party New ........... ${tally.firstPartyNew}`);
  console.log(`Report: ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
