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
// Reviews key — token-first so duplicate catalog rows for the same product
// resolve to ONE key. Priority:
//   1. tok:<brand>|<category>|<model token>   (collapses twin rows)
//   2. asin:<ASIN>                            (collapses same-ASIN rows)
//   3. name:<normalized name>                 (last resort)
// MUST be identical in split-reviews.js and the frontend reviewKey().
function reviewKey(p) {
  if (!p) return null;
  const tok = modelToken(p.n);
  if (tok) {
    const brand = String(p.b || '').toUpperCase().trim();
    return 'tok:' + brand + '|' + (p.c || '') + '|' + tok;
  }
  const a = asinOf(p);
  if (a) return 'asin:' + a;
  const n = normName(p.n);
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
const byGtin = new Map(), byMpn = new Map(), byName = new Map(), byToken = new Map();

// Extract a distinctive model token from a product name (brand-agnostic).
// Works on messy long names where canonicalizeProductName returns null.
function modelToken(name) {
  const n = String(name || '').toUpperCase();
  const patterns = [
    /\bRTX\s?\d{4}\s?(?:TI|SUPER)?\b/,
    /\bGTX\s?\d{3,4}\s?(?:TI|SUPER)?\b/,
    /\bRX\s?\d{3,4}\s?(?:XT|GRE)?\b/,
    /\bRYZEN\s?\d\s?\d{3,4}[A-Z0-9]*\b/,
    /\bCORE\s?(?:ULTRA\s?\d\s?)?I?\d?-?\d{3,5}[A-Z]*\b/,
    /\bI[3579]-\d{4,5}[A-Z]*\b/,
    /\b\d{4,5}X3D\b/,
  ];
  for (const p of patterns) {
    const m = n.match(p);
    if (m) return m[0].replace(/\s+/g, '');
  }
  return null;
}

let discCount = 0;
function pushIdx(map, key, rec) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  // dedupe by SKU within a key
  if (!arr.some(r => r.bestBuySku === rec.bestBuySku)) arr.push(rec);
}
for (const f of readdirSync(DISCOVERY_DIR)) {
  if (!f.endsWith('.json')) continue;
  const recs = JSON.parse(readFileSync(join(DISCOVERY_DIR, f), 'utf8'));
  const arr = Array.isArray(recs) ? recs : (recs.products || recs.items || []);
  for (const r of arr) {
    if (!r || !r.bestBuySku) continue;
    discCount++;
    const g = normGtin(r.gtin);
    if (g) pushIdx(byGtin, g, r);
    const m = normMpn(r.mpn);
    if (m) pushIdx(byMpn, m, r);
    const cat = r.ourCategory || '';
    let key = null;
    try { key = canonicalizeProductName(r.name, cat); } catch { key = null; }
    if (key) pushIdx(byName, cat + '|' + key.toLowerCase(), r);
    // model-token index: brand|category|token
    const tok = modelToken(r.name);
    if (tok) {
      const brand = (r.manufacturer || '').toUpperCase().trim();
      pushIdx(byToken, brand + '|' + cat + '|' + tok, r);
    }
  }
}
console.log('Loaded ' + discCount + ' discovery records (gtin:' + byGtin.size +
  ' mpn:' + byMpn.size + ' name:' + byName.size + ' token:' + byToken.size + ' index keys)');

// resolve a catalog product → ALL candidate discovery records (GTIN → MPN → name → token)
function resolveSku(p) {
  const g = normGtin(p.gtin || p.upc);
  if (g && byGtin.has(g)) return { recs: byGtin.get(g), tier: 'gtin' };
  const m = normMpn(p.mpn);
  if (m && byMpn.has(m)) return { recs: byMpn.get(m), tier: 'mpn' };
  let key = null;
  try { key = canonicalizeProductName(p.n, p.c); } catch { key = null; }
  if (key) {
    const k = (p.c || '') + '|' + key.toLowerCase();
    if (byName.has(k)) return { recs: byName.get(k), tier: 'name' };
  }
  // 4th tier: model token (catches flagship CPUs/GPUs whose catalog rows
  // lack identifiers and whose names canonicalize to null).
  const tok = modelToken(p.n);
  if (tok) {
    const brand = (p.b || '').toUpperCase().trim();
    const tk = brand + '|' + (p.c || '') + '|' + tok;
    if (byToken.has(tk)) return { recs: byToken.get(tk), tier: 'token' };
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
// Abort the whole run if Best Buy rate-limits us hard — once sustained 403s
// start, retrying only prolongs the block. Bail instead of grinding.
let consecutive403 = 0;
const ABORT_AFTER_403 = 25;
let aborted = false;
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

  // Try EVERY candidate SKU for this product. Discovery data has many
  // listings per product (1P + marketplace); only some carry reviews.
  // Keep the listing that returns the most reviews. Stop early at 5.
  // Cap candidates: discovery has up to 20-40 listings per product (esp.
  // Storage/PSU). Trying all of them blows Best Buy's rate limit. The 1P
  // listing with the most reviews is almost always among the first few.
  const candidates = (resolved.recs || []).slice(0, 4);
  let bestReviews = [];

  for (const rec of candidates) {
    if (bestReviews.length >= MAX_REVIEWS) break;
    const sku = rec.bestBuySku;
    const url = 'https://api.bestbuy.com/v1/reviews(sku=' + sku + ')?apiKey=' + KEY +
      '&format=json&pageSize=' + MAX_REVIEWS + '&show=id,sku,rating,title,comment,submissionTime,reviewer';

    let data = null, gotError = false, got403 = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 403) {
          if (attempt < 3) { await sleep(RETRY_GAP_MS); continue; }
          gotError = true; got403 = true;
          process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' sku ' + sku + ' — 403 after 3 tries  \n');
          break;
        }
        if (!res.ok) {
          gotError = true;
          process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' sku ' + sku + ' — HTTP ' + res.status + '   \n');
          break;
        }
        data = await res.json();
        break;
      } catch (e) {
        if (attempt < 3) { await sleep(RETRY_GAP_MS); continue; }
        gotError = true;
        process.stdout.write('\r  ⚠ ' + p.n.slice(0, 40) + ' sku ' + sku + ' — ' + e.message + '   \n');
      }
    }

    await sleep(CALL_GAP_MS);

    // Track sustained rate-limiting. A 403 streak means Best Buy has
    // blocked us; abort rather than grinding through hundreds of failures.
    if (got403) {
      consecutive403++;
      if (consecutive403 >= ABORT_AFTER_403) {
        console.log('\n\n⛔ ABORTING: ' + consecutive403 + ' consecutive 403s — Best Buy is rate-limiting.');
        console.log('   Partial results saved. Re-run later to continue (already-done products are skipped).');
        aborted = true;
        break;
      }
    } else if (!gotError) {
      consecutive403 = 0;
    }

    if (gotError || !data) { errors++; continue; }

    const reviews = (data.reviews || []).slice(0, MAX_REVIEWS).map(r => ({
      rating: r.rating,
      title: r.title || '',
      comment: r.comment || '',
      date: r.submissionTime || '',
      author: (Array.isArray(r.reviewer) && r.reviewer[0] && r.reviewer[0].name) || 'Anonymous',
      source: 'bestbuy',
    }));
    if (reviews.length > bestReviews.length) bestReviews = reviews;
  }

  fetched++;
  if (bestReviews.length) {
    store[key] = { reviews: bestReviews, updated: new Date().toISOString() };
    withReviews++;
  }
  process.stdout.write('\r  processed ' + processed + ' | with reviews ' + withReviews + '          ');

  // Abort triggered inside the candidate loop — save progress and stop.
  if (aborted) break;
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
