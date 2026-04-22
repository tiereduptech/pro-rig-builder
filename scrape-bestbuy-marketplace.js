#!/usr/bin/env node
/**
 * scrape-bestbuy-marketplace.js
 *
 * Uses Best Buy's website (which includes marketplace/3P products — 426 total
 * cases) instead of their developer API (which only shows 113 first-party
 * cases). Extracts all SKUs from the embedded GraphQL response data in each
 * paginated category page, then queries the API for each SKU's details.
 *
 * Pipeline:
 *   1. Scrape /site/.../abcat0507006.c pages 1-14 (pagination via cp=N)
 *   2. For each page, extract unique skuIds from "__typename":"Product" blocks
 *   3. For each unique SKU: call API for name, manufacturer, spec details
 *   4. Group results: (a) already in DB, (b) new, (c) API confirmed case, (d) not a case
 *   5. Generate a JSON report + console summary
 *
 * Read-only. Does NOT modify parts.js.
 *
 * Usage: railway run node scrape-bestbuy-marketplace.js [--dry-sku-only]
 *   --dry-sku-only: skip API lookups, just show the scraped SKU list
 */
import { writeFileSync } from 'node:fs';

const KEY = process.env.BESTBUY_API_KEY;
const DRY = process.argv.includes('--dry-sku-only');
if (!KEY && !DRY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_DELAY = 2500; // between web fetches
const API_DELAY = 300;    // between API calls

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;
const cases = parts.filter(p => p.c === 'Case');

function extractSku(p) {
  if (!p.deals?.bestbuy?.url) return null;
  const m = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
  return m ? m[1] : null;
}

const dbBySku = new Map();
for (const p of cases) {
  const sku = extractSku(p);
  if (sku) dbBySku.set(sku, p);
}
console.log(`DB: ${cases.length} cases, ${dbBySku.size} with Best Buy SKUs\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: SCRAPE PAGES
// ═══════════════════════════════════════════════════════════════════════════
console.log('━━━ SCRAPING bestbuy.com pages ━━━');
const allSkus = new Set();
for (let page = 1; page <= 14; page++) {
  const url = page === 1
    ? 'https://www.bestbuy.com/site/computer-cards-components/computer-cases-drive-enclosures/abcat0507006.c?id=abcat0507006'
    : `https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=abcat0507006&cp=${page}&id=pcat17071&st=categoryid%24abcat0507006`;
  process.stdout.write(`  page ${page}: `);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) { console.log(`status ${r.status}, stopping`); break; }
    const html = await r.text();
    const pageSkus = new Set();
    const re = /"__typename":"Product","openBoxCondition":[^,]+,"skuId":"(\d+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) pageSkus.add(m[1]);
    const newOnes = [...pageSkus].filter(s => !allSkus.has(s));
    for (const s of pageSkus) allSkus.add(s);
    console.log(`${pageSkus.size} skus (${newOnes.length} new, total ${allSkus.size})`);
    if (newOnes.length === 0 && page > 2) {
      console.log('  no new SKUs — reached end');
      break;
    }
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, PAGE_DELAY));
}
console.log(`\n  Total unique scraped SKUs: ${allSkus.size}\n`);

if (DRY) {
  writeFileSync('./scraped-case-skus.txt', [...allSkus].sort().join('\n'));
  console.log('Saved SKU list to scraped-case-skus.txt');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: FETCH API DETAILS FOR EACH SKU
// ═══════════════════════════════════════════════════════════════════════════
console.log('━━━ FETCHING API DETAILS ━━━');
const results = [];
let i = 0;
for (const sku of allSkus) {
  i++;
  if (i % 25 === 0) process.stdout.write(`  ${i}/${allSkus.size}...\n`);
  try {
    const r = await fetch(`https://api.bestbuy.com/v1/products/${sku}.json?show=sku,name,manufacturer,modelNumber,details,categoryPath&apiKey=${KEY}`);
    if (r.status === 404) {
      results.push({ sku, status: '404-not-in-api', inDb: dbBySku.has(sku) });
    } else if (r.status === 403) {
      console.log(`  rate limited at ${i}, waiting 10s`);
      await new Promise(r => setTimeout(r, 10000));
      i--; // retry this sku
      continue;
    } else if (!r.ok) {
      results.push({ sku, status: `http-${r.status}`, inDb: dbBySku.has(sku) });
    } else {
      const j = await r.json();
      const isCase = (j.categoryPath || []).some(c => c.id === 'abcat0507006');
      results.push({
        sku,
        status: 'ok',
        name: j.name,
        manufacturer: j.manufacturer,
        modelNumber: j.modelNumber,
        isCase,
        detailsCount: j.details?.length || 0,
        details: j.details || [],
        inDb: dbBySku.has(sku),
        dbProductName: dbBySku.get(sku)?.n || null,
      });
    }
  } catch (e) {
    results.push({ sku, status: 'fetch-error', error: e.message });
  }
  await new Promise(r => setTimeout(r, API_DELAY));
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: REPORT
// ═══════════════════════════════════════════════════════════════════════════
const ok = results.filter(r => r.status === 'ok');
const notFound = results.filter(r => r.status === '404-not-in-api');
const errors = results.filter(r => !['ok', '404-not-in-api'].includes(r.status));
const actualCases = ok.filter(r => r.isCase);
const miscategorized = ok.filter(r => !r.isCase);

console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  Scraped SKUs:            ${allSkus.size}`);
console.log(`  API returned OK:         ${ok.length}`);
console.log(`    of which cases:        ${actualCases.length}`);
console.log(`    not actually cases:    ${miscategorized.length}`);
console.log(`  404 (not in API):        ${notFound.length}  ← marketplace/3P products`);
console.log(`  Other errors:            ${errors.length}`);

console.log(`\n━━━ BY MANUFACTURER (cases only) ━━━`);
const byMfr = {};
for (const r of actualCases) {
  const m = r.manufacturer || '(none)';
  if (!byMfr[m]) byMfr[m] = { total: 0, withSpecs: 0, inDb: 0 };
  byMfr[m].total++;
  if (r.detailsCount > 0) byMfr[m].withSpecs++;
  if (r.inDb) byMfr[m].inDb++;
}
const sorted = Object.entries(byMfr).sort((a, c) => c[1].total - a[1].total);
console.log(`  ${'Mfr'.padEnd(22)} ${'total'.padStart(5)} ${'inDB'.padStart(5)} ${'specs'.padStart(5)}`);
for (const [m, s] of sorted) {
  console.log(`  ${m.padEnd(22)} ${s.total.toString().padStart(5)} ${s.inDb.toString().padStart(5)} ${s.withSpecs.toString().padStart(5)}`);
}

console.log(`\n━━━ 404 SKUs (likely 3P marketplace) ━━━`);
console.log(`  ${notFound.length} SKUs from bestbuy.com NOT accessible via API`);
console.log(`  (These are marketplace/3P products — API exposes only 1P inventory)`);
const notFoundInDb = notFound.filter(r => r.inDb).length;
console.log(`  Of those, ${notFoundInDb} are already in your DB (legacy SKUs)`);

console.log(`\n━━━ NEW CASES NOT IN DB ━━━`);
const newCases = actualCases.filter(r => !r.inDb);
console.log(`  Total new: ${newCases.length}`);
const newByMfr = {};
for (const r of newCases) {
  const m = r.manufacturer || '(none)';
  if (!newByMfr[m]) newByMfr[m] = [];
  newByMfr[m].push(r);
}
for (const [m, items] of Object.entries(newByMfr).sort((a, c) => c[1].length - a[1].length)) {
  console.log(`\n  ${m} (+${items.length})`);
  items.slice(0, 3).forEach(r => console.log(`    sku=${r.sku} specs=${r.detailsCount} ${r.name?.slice(0, 65)}`));
  if (items.length > 3) console.log(`    +${items.length - 3} more`);
}

// Save JSON for later use
writeFileSync('./bestbuy-full-scrape.json', JSON.stringify(results, null, 2));
console.log(`\n  Full results saved to bestbuy-full-scrape.json`);
