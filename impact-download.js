/**
 * impact-download.js — download Best Buy catalog via Impact API
 *
 * Approach: full pagination (~16k pages at PageSize=100, ~2.5 hours) with
 * inline filtering — items matching our PC hardware categories are saved
 * to per-category JSONL files, everything else is skipped.
 *
 * Output:
 *   catalog-build/bestbuy-raw/motherboard.jsonl
 *   catalog-build/bestbuy-raw/cpu.jsonl
 *   catalog-build/bestbuy-raw/gpu.jsonl
 *   ... etc ...
 *   catalog-build/bestbuy-raw/_progress.json   (last page completed)
 *   catalog-build/bestbuy-raw/_unknowns.log    (unmatched "computer-ish" breadcrumbs)
 *
 * USAGE:
 *   railway run node impact-download.js --limit 10        # test (first 10 pages = 1000 items)
 *   railway run node impact-download.js --resume          # continue from last completed page
 *   railway run node impact-download.js                   # full run (~2.5 hours)
 *   railway run node impact-download.js --page-size 1000  # fewer pages, slower each
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;
if (!SID || !TOKEN) {
  console.error('✗ Missing IMPACT env vars. Run: railway run node impact-download.js');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const BASE = `https://api.impact.com/Mediapartners/${SID}`;

const OUTPUT_DIR = './catalog-build/bestbuy-raw';
const PROGRESS_PATH = join(OUTPUT_DIR, '_progress.json');
const UNKNOWNS_PATH = join(OUTPUT_DIR, '_unknowns.log');

// ─────────────────────────────────────────────────────────────────────────────
// Category matching — breadcrumb patterns → our internal category names
// Best Buy breadcrumbs are comma-separated strings. We match any segment.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_RULES = [
  { cat: 'Motherboard',  match: /\bMotherboards?\b/i },
  { cat: 'CPU',          match: /\b(CPUs|Computer Processors)\b/i },
  { cat: 'GPU',          match: /\b(Graphics Cards|Video Cards|GPUs)\b/i },
  { cat: 'RAM',          match: /\bComputer Memory\b|\bRAM\b|\bDDR[345]\b/i },
  { cat: 'Storage',      match: /\b(SSDs?|Internal Hard Drives|External Hard Drives|Computer Storage|Solid State Drives|NVMe)\b/i },
  { cat: 'PSU',          match: /\bPower Supplies?\b/i },
  { cat: 'Case',         match: /\bComputer Cases\b|\bPC Cases\b|\bTower Cases\b/i },
  { cat: 'CPUCooler',    match: /\bCPU Coolers?\b|\bComputer Cooling\b|\bHeatsinks?\b|\bLiquid Coolers?\b|\bAIO\b/i },
  { cat: 'Monitor',      match: /\bMonitors?\b/i },
  { cat: 'CaseFan',      match: /\b(Case Fans|PC Fans|Computer Fans)\b/i },
];

// "Computer-ish" path that we want to LOG if it doesn't match above (so we can add missing patterns)
const INTEREST_HINT = /\b(Computer|PC|Gaming|Hardware|Electronics.*Components?|Cards?\s*(&|and)\s*Components?)\b/i;

// Always-reject patterns (keep unknowns.log from being flooded with irrelevant hits)
const REJECT_UNKNOWNS = /\b(Laptop|Notebook|Tablet|Ink|Toner|Cartridge|Camera|Printer|Scanner|Phone|Refurbished|Pre-Owned|Accessories|Cables?|Adapters?|Bags?|Backpacks?|Cleaning)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// CLI flags
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const flags = {
  limit:    Number(getFlag('--limit', true)) || null,
  pageSize: Number(getFlag('--page-size', true)) || 100,
  resume:   getFlag('--resume'),
  fresh:    getFlag('--fresh'),  // ignore progress file, start from page 1
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP with retry / backoff
// ─────────────────────────────────────────────────────────────────────────────

async function impactGetPage(page, pageSize) {
  const url = new URL(`${BASE}/Catalogs/28060/Items`);
  url.searchParams.set('Page', page);
  url.searchParams.set('PageSize', pageSize);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: AUTH, Accept: 'application/json' },
        signal: AbortSignal.timeout(45000),
      });

      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const wait = 5000 + attempt * 10000;
        console.log(`   ⚠ HTTP ${res.status} on page ${page} — backing off ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`   ⚠ page ${page} attempt ${attempt+1} failed: ${e.message} — retrying`);
      await new Promise(r => setTimeout(r, 3000 + attempt * 2000));
    }
  }
  throw new Error(`page ${page} failed after 5 attempts`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Item classification
// ─────────────────────────────────────────────────────────────────────────────

function classify(item) {
  const breadcrumb = item.Text3 || '';
  const category = item.Category || '';
  const combined = `${breadcrumb}|${category}`;

  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(combined)) return rule.cat;
  }
  return null;
}

function shouldLogUnknown(item) {
  const combined = `${item.Text3 || ''}|${item.Category || ''}`;
  return INTEREST_HINT.test(combined) && !REJECT_UNKNOWNS.test(combined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output writers
// ─────────────────────────────────────────────────────────────────────────────

const writers = new Map();
function writeItem(category, item) {
  if (!writers.has(category)) writers.set(category, []);
  const path = join(OUTPUT_DIR, `${category.toLowerCase()}.jsonl`);
  appendFileSync(path, JSON.stringify(item) + '\n');
  writers.get(category).push(1);
}

function loadProgress() {
  if (!existsSync(PROGRESS_PATH)) return { lastPage: 0, totalSaved: 0 };
  try { return JSON.parse(readFileSync(PROGRESS_PATH, 'utf-8')); }
  catch { return { lastPage: 0, totalSaved: 0 }; }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── Impact Catalog Downloader ──\n');

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Get total page count from first page
  console.log(`Fetching metadata (page 1, size ${flags.pageSize})...`);
  const first = await impactGetPage(1, flags.pageSize);
  const totalPages = Number(first['@numpages']);
  const totalItems = Number(first['@total']);
  console.log(`  Total items in catalog: ${totalItems.toLocaleString()}`);
  console.log(`  Total pages at PageSize=${flags.pageSize}: ${totalPages.toLocaleString()}`);

  const progress = flags.fresh ? { lastPage: 0, totalSaved: 0 } : loadProgress();
  const startPage = progress.lastPage + 1;
  let endPage = flags.limit ? Math.min(startPage + flags.limit - 1, totalPages) : totalPages;

  console.log(`  Starting at page ${startPage}, ending at page ${endPage}`);
  if (progress.lastPage > 0) console.log(`  Resuming: ${progress.totalSaved} items already saved`);
  console.log();

  const startTime = Date.now();
  let pagesDone = 0;
  let totalSaved = progress.totalSaved;

  for (let page = startPage; page <= endPage; page++) {
    const pageStart = Date.now();

    // Fetch page (use first page data if this is page 1 to avoid duplicate request)
    const data = (page === 1) ? first : await impactGetPage(page, flags.pageSize);
    const items = data.Items || [];

    // Classify and write
    let pageSaved = 0;
    for (const item of items) {
      const category = classify(item);
      if (category) {
        writeItem(category, item);
        pageSaved++;
      } else if (shouldLogUnknown(item)) {
        // Log unmatched but computer-ish items so we can refine patterns
        appendFileSync(UNKNOWNS_PATH, `${item.Text3}|${item.Category}|${item.Name?.slice(0,60)}\n`);
      }
    }

    totalSaved += pageSaved;
    pagesDone++;

    // Progress report every 10 pages
    const pageTime = Date.now() - pageStart;
    if (page % 10 === 0 || page === endPage || page === startPage) {
      const elapsed = (Date.now() - startTime) / 1000;
      const pagesLeft = endPage - page;
      const avgPageTime = elapsed / pagesDone;
      const eta = Math.round(pagesLeft * avgPageTime / 60);
      const pct = ((page / endPage) * 100).toFixed(1);
      console.log(`  [${page}/${endPage}] ${pct}%  saved this page: ${pageSaved}  total saved: ${totalSaved}  last: ${pageTime}ms  eta: ${eta}m`);
    }

    saveProgress({ lastPage: page, totalSaved });

    // Gentle throttle — we don't want to hammer their API
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n── Done ──\n');
  console.log(`  Total items saved: ${totalSaved}`);
  console.log(`  By category:`);
  for (const [cat, arr] of writers) {
    console.log(`    ${cat.padEnd(15)} ${arr.length}`);
  }
  console.log(`\n  Unknowns logged to ${UNKNOWNS_PATH} — review to refine category patterns`);
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
