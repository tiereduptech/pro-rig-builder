#!/usr/bin/env node
/**
 * scrape-bestbuy-cases.js
 *
 * Best Buy's developer API only exposes 113 of the ~426 cases visible on
 * bestbuy.com (they filter marketplace/3P listings out of the API).
 *
 * This script scrapes the website (not the API) to get the full SKU list,
 * then uses the API to pull spec details for each SKU. Some SKUs will still
 * have empty details (API gap) but we capture whatever's available.
 *
 * Pipeline:
 *   1. Scrape pages 1-12 of bestbuy.com/site/.../abcat0507006.c
 *   2. Extract all unique SKUs from "/sku/NNNNNNN" patterns
 *   3. For each SKU: call API to get name, manufacturer, details
 *   4. Report:
 *      - How many SKUs total
 *      - How many match existing DB products (by SKU)
 *      - How many are new (not in DB)
 *      - Breakdown by brand
 *      - Spec data availability
 *
 * Read-only. Does NOT modify parts.js. Writes a JSON report for review.
 *
 * Env: BESTBUY_API_KEY
 */
import { writeFileSync } from 'node:fs';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const RATE_DELAY = 300; // 3 req/sec safe for API

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;
const cases = parts.filter(p => p.c === 'Case');

function extractSku(p) {
  if (!p.deals?.bestbuy?.url) return null;
  const m = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
  return m ? m[1] : null;
}

const dbBySku = new Map();
const dbByName = new Map();
for (const p of cases) {
  const sku = extractSku(p);
  if (sku) dbBySku.set(sku, p);
  dbByName.set(p.n.toLowerCase(), p);
}
console.log(`DB has ${cases.length} cases, ${dbBySku.size} with Best Buy SKUs\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: SCRAPE BESTBUY.COM CATEGORY PAGES
// ═══════════════════════════════════════════════════════════════════════════
console.log('━━━ SCRAPING bestbuy.com ━━━');
const allSkus = new Set();
for (let page = 1; page <= 14; page++) {
  const url = `https://www.bestbuy.com/site/searchpage.jsp?browsedCategory=abcat0507006&cp=${page}&id=pcat17071&st=categoryid%24abcat0507006`;
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
    // Extract SKUs from URLs like /sku/6469130 or /site/.../6469130.p
    const pageSkus = new Set();
    const re1 = /\/sku\/(\d{7,8})/g;
    const re2 = /\/(\d{7,8})\.p\?/g;
    let m;
    while ((m = re1.exec(html)) !== null) pageSkus.add(m[1]);
    while ((m = re2.exec(html)) !== null) pageSkus.add(m[1]);

    const newOnes = [...pageSkus].filter(s => !allSkus.has(s));
    for (const s of pageSkus) allSkus.add(s);
    console.log(`${pageSkus.size} skus (${newOnes.length} new, ${allSkus.size} total)`);
    if (newOnes.length === 0 && page > 2) {
      console.log('  no new SKUs, reached end');
      break;
    }
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 2000)); // 2s between page fetches
}

console.log(`\n  Total unique SKUs scraped: ${allSkus.size}\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: FETCH DETAILS VIA API FOR EACH SKU
// ═══════════════════════════════════════════════════════════════════════════
console.log('━━━ FETCHING API DETAILS FOR EACH SKU ━━━');
const results = []; // {sku, name, manufacturer, hasDetails, detailsCount, inDb, productName}
let i = 0;
for (const sku of allSkus) {
  i++;
  if (i % 25 === 0) process.stdout.write(`  ${i}/${allSkus.size}...\n`);
  try {
    const r = await fetch(`https://api.bestbuy.com/v1/products/${sku}.json?show=sku,name,manufacturer,modelNumber,details,categoryPath&apiKey=${KEY}`);
    if (r.status === 404) {
      results.push({ sku, status: 404 });
      continue;
    }
    if (!r.ok) {
      results.push({ sku, status: r.status });
      continue;
    }
    const j = await r.json();
    // Filter: must actually be a case (category includes abcat0507006)
    const isCase = (j.categoryPath || []).some(c => c.id === 'abcat0507006');
    if (!isCase) {
      results.push({ sku, status: 'not-a-case', manufacturer: j.manufacturer, name: j.name });
      continue;
    }
    const inDb = dbBySku.has(sku);
    results.push({
      sku,
      name: j.name,
      manufacturer: j.manufacturer,
      modelNumber: j.modelNumber,
      detailsCount: j.details?.length || 0,
      inDb,
      dbProductName: inDb ? dbBySku.get(sku).n : null,
    });
  } catch (e) {
    results.push({ sku, error: e.message });
  }
  await new Promise(r => setTimeout(r, RATE_DELAY));
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: REPORT
// ═══════════════════════════════════════════════════════════════════════════
const cases_results = results.filter(r => r.manufacturer && r.detailsCount != null);
const notCases = results.filter(r => r.status === 'not-a-case');
const errors = results.filter(r => r.status === 404 || r.status === 403 || r.error);

console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  Scraped SKUs:         ${allSkus.size}`);
console.log(`  Confirmed cases:      ${cases_results.length}`);
console.log(`  Not actually cases:   ${notCases.length}`);
console.log(`  Errors/404s:          ${errors.length}`);

console.log(`\n━━━ BY MANUFACTURER ━━━`);
const byMfr = {};
for (const r of cases_results) {
  const m = r.manufacturer || '(none)';
  if (!byMfr[m]) byMfr[m] = { total: 0, withDetails: 0, inDb: 0 };
  byMfr[m].total++;
  if (r.detailsCount > 0) byMfr[m].withDetails++;
  if (r.inDb) byMfr[m].inDb++;
}
const sorted = Object.entries(byMfr).sort((a, c) => c[1].total - a[1].total);
console.log(`  ${'Manufacturer'.padEnd(22)} ${'total'.padStart(5)} ${'inDB'.padStart(5)} ${'specs'.padStart(5)}`);
for (const [m, s] of sorted) {
  console.log(`  ${m.padEnd(22)} ${s.total.toString().padStart(5)} ${s.inDb.toString().padStart(5)} ${s.withDetails.toString().padStart(5)}`);
}

console.log(`\n━━━ NEW CASES NOT IN DB ━━━`);
const newCases = cases_results.filter(r => !r.inDb);
const newByMfr = {};
for (const r of newCases) {
  const m = r.manufacturer || '(none)';
  if (!newByMfr[m]) newByMfr[m] = [];
  newByMfr[m].push(r);
}
for (const [m, items] of Object.entries(newByMfr).sort((a, c) => c[1].length - a[1].length)) {
  console.log(`\n  ${m} (${items.length} new)`);
  items.slice(0, 3).forEach(r => console.log(`    sku=${r.sku} | specs=${r.detailsCount} | ${r.name?.slice(0, 70)}`));
  if (items.length > 3) console.log(`    ... +${items.length - 3} more`);
}

// Save full report
writeFileSync('./bestbuy-scrape-report.json', JSON.stringify(results, null, 2));
console.log(`\n  Full report saved to bestbuy-scrape-report.json`);
