#!/usr/bin/env node
/**
 * fetch-bestbuy-reviews.js
 *
 * Fetches customer reviews from the Best Buy Reviews API and stores up to
 * 5 per product in catalog-build/reviews.json (keyed by normalized name).
 *
 * Flow per catalog product:
 *   1. Resolve a Best Buy SKU via the discovery data (GTIN → MPN → name).
 *   2. Skip if the product already has 5 stored reviews.
 *   3. Call v1/reviews(sku=...), keep up to 5.
 *
 * The discovery `bestBuySku` works directly against the Reviews API
 * (verified: it returns the correct product's reviews even though that
 * id is not queryable via the Products API).
 *
 * Reviews store shape:
 *   { "<norm name>": { reviews: [ {rating,title,comment,date,author,source} ], updated: "ISO" } }
 *
 * Flags:
 *   --limit N   only process the first N eligible products (test runs)
 *   --dry       resolve SKUs and report, but make no API calls / no writes
 *
 * Usage:  railway run node fetch-bestbuy-reviews.js --limit 20
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeProductName } from './normalize-product-name.js';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('BESTBUY_API_KEY not set'); process.exit(1); }

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const DRY = args.includes('--dry');

const MAX_REVIEWS = 5;
const CALL_GAP_MS = 1100; // ~1 req/s — Best Buy's per-second limit is strict
const RETRY_GAP_MS = 3000; // wait longer before retrying a rate-limited call

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const DISCOVERY_DIR = join(process.cwd(), 'catalog-build', 'bestbuy-discovery');
const OUT_DIR = join(process.cwd(), 'catalog-build');
const OUT_FILE = join(OUT_DIR, 'reviews.json');

function normName(n) {
  return String(n || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}
// ASIN from p.asin or extracted from an Amazon deal URL.
function asinOf(p) {
  if (p && p.asin) return String(p.asin).toUpperCase();
  const u = p && p.deals && p.deals.amazon && p.deals.amazon.url;
  const m = u && String(u).match(/\/dp\/([A-Z0-9]{10})/);
  return m ? m[1].toUpperCase() : null;
}
// Reviews key: ASIN when available (collapses same-ASIN duplicate rows),
// else "name:" + normalized name. MUST match split-reviews.js and the
// frontend reviewKey() exactly.
function reviewKey(p) {
  const a = asinOf(p);
  if (a) return a;
  const n = normName(p && p.n);
  return n ? 'name:' + n : null;
}
function normMpn(m) {
  return String(m || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
}
function normGtin(g) {
  const d = String(g || '').replace(/\D/g, '');
  return d.length >= 8 ? d.replace(/^0+/, '') || d : null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Load parts.js ──
const partsMod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
const parts = partsMod.PARTS || partsMod.default;
if (!Array.isArray(parts)) { console.error('parts.js has no PARTS array'); process.exit(1); }
console.log('Loaded ' + parts.length + ' catalog products');

// ── 2. Load discovery data, build SKU lookup indexes ──
const byGtin = new Map(), byMpn = new Map(), byName = new Map();
let discCount = 0;
for (const f of readdirSync(DISCOVERY_DIR)) {
  if (!f.endsWith('.json')) continue;
  const recs = JSON.parse(readFileSync(join(DISCOVERY_DIR, f), 'utf8'));
  const arr = Array.isArray(recs) ? recs : (recs.products || recs.items || []);
  for (const r of arr) {
    if (!r || !r.bestBuySku) continue;
    discCount++;
    const g = normGtin(r.gtin);
    if (g && !byGtin.has(g)) byGtin.set(g, r);
    const m = normMpn(r.mpn);
    if (m && !byMpn.has(m)) byMpn.set(m, r);
    const cat = r.ourCategory || '';
    let key = null;
    try { key = canonicalizeProductName(r.name, cat); } catch { key = null; }
    if (key) {
      const k = cat + '|' + key.toLowerCase();
      if (!byName.has(k)) byName.set(k, r);
    }
  }
}
console.log('Loaded ' + discCount + ' discovery records (gtin:' + byGtin.size + ' mpn:' + byMpn.size + ' name:' + byName.size + ')');

// resolve a catalog product → discovery record (GTIN → MPN → name)
function resolveSku(p) {
  const g = normGtin(p.gtin || p.upc);
  if (g && byGtin.has(g)) return { rec: byGtin.get(g), tier: 'gtin' };
  const m = normMpn(p.mpn);
  if (m && byMpn.has(m)) return { rec: byMpn.get(m), tier: 'mpn' };
  let key = null;
  try { key = canonicalizeProductName(p.n, p.c); } catch { key = null; }
  if (key) {
    const k = (p.c || '') + '|' + key.toLowerCase();
    if (byName.has(k)) return { rec: byName.get(k), tier: 'name' };
  }
  return null;
}

// ── 3. Load existing reviews store ──
let store = {};
if (existsSync(OUT_FILE)) {
  try { store = JSON.parse(readFileSync(OUT_FILE, 'utf8')); }
  catch (e) { console.error('reviews.json unreadable, aborting: ' + e.message); process.exit(1); }
  console.log('Existing reviews store: ' + Object.keys(store).length + ' products');
}

// ── 4. Fetch loop ──
let processed = 0, skipped5 = 0, noSku = 0, fetched = 0, withReviews = 0, errors = 0;
const tierCount = {};

for (const p of parts) {
  if (processed >= LIMIT) break;
  if (!p || !p.n) continue;
  const key = reviewKey(p);
  if (!key) continue;

  // skip if already at 5
  if (store[key] && store[key].reviews && store[key].reviews.length >= MAX_REVIEWS) {
    skipped5++;
    continue;
  }

  const resolved = resolveSku(p);
  if (!resolved) { noSku++; continue; }
  tierCount[resolved.tier] = (tierCount[resolved.tier] || 0) + 1;

  processed++;
  if (DRY) continue;

  const sku = resolved.rec.bestBuySku;
  const url = 'https://api.bestbuy.com/v1/reviews(sku=' + sku + ')?apiKey=' + KEY +
    '&format=json&pageSize=' + MAX_REVIEWS + '&show=id,sku,rating,title,comment,submissionTime,reviewer';

  let data = null, gotError = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 403) {
        // rate limited — wait longer and retry
        if (attempt < 3) { await sleep(RETRY_GAP_MS); continue; }
        gotError = true;
        process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' — 403 after 3 tries     \n');
        break;
      }
      if (!res.ok) {
        gotError = true;
        process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' — HTTP ' + res.status + '          \n');
        break;
      }
      data = await res.json();
      break;
    } catch (e) {
      if (attempt < 3) { await sleep(RETRY_GAP_MS); continue; }
      gotError = true;
      process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' — ' + e.message + '       \n');
    }
  }

  if (gotError || !data) {
    errors++;
    await sleep(CALL_GAP_MS);
    continue;
  }

  const reviews = (data.reviews || []).slice(0, MAX_REVIEWS).map(r => ({
    rating: r.rating,
    title: r.title || '',
    comment: r.comment || '',
    date: r.submissionTime || '',
    author: (Array.isArray(r.reviewer) && r.reviewer[0] && r.reviewer[0].name) || 'Anonymous',
    source: 'bestbuy',
  }));
  fetched++;
  if (reviews.length) {
    store[key] = { reviews, updated: new Date().toISOString() };
    withReviews++;
  }
  process.stdout.write('\r  processed ' + processed + ' | with reviews ' + withReviews + '          ');
  await sleep(CALL_GAP_MS);
}
console.log('');

// ── 5. Write ──
if (!DRY) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(store), 'utf8');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Processed (had a SKU):   ' + processed);
console.log('  match tiers:           ' + JSON.stringify(tierCount));
console.log('Skipped (already at 5):  ' + skipped5);
console.log('No Best Buy SKU match:   ' + noSku);
if (!DRY) {
  console.log('API calls made:          ' + fetched);
  console.log('Products that got revs:  ' + withReviews);
  console.log('Errors:                  ' + errors);
  console.log('Reviews store now:       ' + Object.keys(store).length + ' products');
  console.log('Written to:              ' + OUT_FILE);
} else {
  console.log('(dry run — no API calls, no writes)');
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
