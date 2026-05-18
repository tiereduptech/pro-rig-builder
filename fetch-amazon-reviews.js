#!/usr/bin/env node
/**
 * fetch-amazon-reviews.js — Amazon customer reviews via DataForSEO.
 *
 * Posts merchant/amazon/asin tasks for catalog products, extracts
 * top_local_reviews (US English), merges into catalog-build/reviews.json
 * using the SAME reviewKey() scheme as fetch-bestbuy-reviews.js so Amazon
 * and Best Buy reviews coexist per product.
 *
 * Policy: a product already at MAX_REVIEWS (5) is skipped — Best Buy
 * reviews fetched earlier are kept; Amazon only fills empty/partial slots.
 *
 * Flags:
 *   --dry        resolve ASINs + count, post nothing
 *   --limit N    cap number of products processed
 *
 * Run:  railway run node fetch-amazon-reviews.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD env vars.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : Infinity;
})();

const MAX_REVIEWS = 5;
// proven constants mirrored from verify-catalog-asins.js
const BATCH_SIZE = 50;
const POST_DELAY_MS = 500;
const TASK_POLL_DELAY_MS = 30000;
const TASK_POLL_INTERVAL_MS = 10000;
const MAX_POLL_WAIT_MS = 1800000;
const GET_CONCURRENCY = 8;

const OUT_DIR = join(process.cwd(), 'catalog-build');
const OUT_FILE = join(OUT_DIR, 'reviews.json');
const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dfs(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) {
        await sleep(3000 + attempt * 5000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

// ── identity helpers — MUST match fetch-bestbuy-reviews.js ──
function normName(n) {
  return String(n || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}
function asinOf(p) {
  if (p && p.asin) return String(p.asin).toUpperCase();
  const u = p && p.deals && p.deals.amazon && p.deals.amazon.url;
  const m = u && String(u).match(/\/dp\/([A-Z0-9]{10})/);
  return m ? m[1].toUpperCase() : null;
}
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

// "Reviewed in the United States on February 16, 2026" -> "2026-02-16"
const MONTHS = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
  july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };
function parseSubtitleDate(subtitle) {
  const m = String(subtitle || '').match(/on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return '';
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return '';
  return m[3] + '-' + mo + '-' + String(m[2]).padStart(2, '0');
}

(async () => {
  // ── load catalog ──
  const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js has no PARTS array'); process.exit(1); }
  console.log('Loaded ' + parts.length + ' catalog products');

  // ── load existing reviews store ──
  let store = {};
  if (existsSync(OUT_FILE)) {
    try { store = JSON.parse(readFileSync(OUT_FILE, 'utf8')); }
    catch (e) { console.error('reviews.json unreadable, aborting: ' + e.message); process.exit(1); }
    console.log('Existing reviews store: ' + Object.keys(store).length + ' products');
  }

  // ── select products: have an ASIN, not already at MAX_REVIEWS ──
  const targets = [];
  const seenKey = new Set();
  for (const p of parts) {
    if (targets.length >= LIMIT) break;
    if (!p || !p.n) continue;
    const asin = asinOf(p);
    if (!asin) continue;
    const key = reviewKey(p);
    if (!key) continue;
    if (store[key] && store[key].reviews && store[key].reviews.length >= MAX_REVIEWS) continue;
    // one task per key — duplicate rows collapse onto the same key
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    targets.push({ id: p.id, asin, key });
  }
  console.log('Products to fetch Amazon reviews for: ' + targets.length +
    ' (skipped ' + (parts.length - targets.length) + ' — no ASIN, dup key, or already at 5)');

  if (DRY) {
    console.log('\n(dry run — posting nothing)');
    console.log('Estimated cost: ~$' + (targets.length * 0.0015).toFixed(2) +
      ' (' + targets.length + ' tasks @ ~$0.0015)');
    return;
  }
  if (!targets.length) { console.log('Nothing to do.'); return; }

  // ── post tasks ──
  console.log('\nPosting ' + targets.length + ' tasks (batch ' + BATCH_SIZE + ')...');
  const tasks = [];
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const payload = batch.map(t => ({
      asin: t.asin,
      language_code: 'en_US',
      location_code: 2840,
      tag: 'arev-' + t.id,
    }));
    let resp;
    try { resp = await dfs('POST', '/merchant/amazon/asin/task_post', payload); }
    catch (e) { console.log('\n  batch post failed: ' + e.message + ' — continuing'); continue; }
    for (const tk of (resp.tasks || [])) {
      if (!tk.id) continue;
      const id = Number(String(tk.data?.tag || '').replace('arev-', ''));
      const target = targets.find(x => x.id === id);
      if (target) tasks.push({ taskId: tk.id, key: target.key, asin: target.asin });
    }
    process.stdout.write('\r  posted ' + Math.min(i + BATCH_SIZE, targets.length) + '/' + targets.length);
    await sleep(POST_DELAY_MS);
  }
  console.log('\n  ' + tasks.length + ' tasks posted');
  if (!tasks.length) { console.log('No tasks accepted — aborting.'); return; }

  // ── poll results ──
  console.log('\nWaiting ' + (TASK_POLL_DELAY_MS / 1000) + 's before first poll...');
  await sleep(TASK_POLL_DELAY_MS);

  const pending = new Map(tasks.map(t => [t.taskId, t]));
  const startedAt = Date.now();
  let withReviews = 0, failed = 0;

  while (pending.size && (Date.now() - startedAt) < MAX_POLL_WAIT_MS) {
    console.log('\n  ' + pending.size + ' pending...');
    const ids = [...pending.keys()];
    for (let i = 0; i < ids.length; i += GET_CONCURRENCY) {
      const batch = ids.slice(i, i + GET_CONCURRENCY);
      await Promise.all(batch.map(async taskId => {
        let resp;
        try { resp = await dfs('GET', '/merchant/amazon/asin/task_get/advanced/' + taskId); }
        catch { return; }
        const t = resp.tasks && resp.tasks[0];
        const isPending = !t || t.status_code === 20100 || t.status_code === 40601 ||
          t.status_code === 40602 || !t.result;
        if (isPending) return;

        const meta = pending.get(taskId);
        pending.delete(taskId);

        if (t.status_code !== 20000) { failed++; return; }
        const item = t.result?.[0]?.items?.[0];
        if (!item) { failed++; return; }

        const local = Array.isArray(item.top_local_reviews) ? item.top_local_reviews : [];
        const reviews = local.slice(0, MAX_REVIEWS).map(r => ({
          rating: (r.rating && r.rating.value) || 0,
          title: r.title || '',
          comment: r.review_text || '',
          date: parseSubtitleDate(r.subtitle),
          author: (r.user_profile && r.user_profile.name) || 'Amazon Customer',
          source: 'amazon',
        })).filter(r => r.comment);

        if (reviews.length) {
          // merge: keep existing, top up to MAX_REVIEWS
          const existing = (store[meta.key] && store[meta.key].reviews) || [];
          if (existing.length >= MAX_REVIEWS) return;
          const merged = [...existing, ...reviews].slice(0, MAX_REVIEWS);
          store[meta.key] = { reviews: merged, updated: new Date().toISOString() };
          withReviews++;
        }
      }));
      process.stdout.write('\r    polled ' + Math.min(i + GET_CONCURRENCY, ids.length) + '/' + ids.length);
    }
    if (pending.size) {
      console.log('\n  ' + pending.size + ' still pending, waiting ' + (TASK_POLL_INTERVAL_MS / 1000) + 's...');
      await sleep(TASK_POLL_INTERVAL_MS);
    }
  }

  // ── write ──
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(store), 'utf8');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Tasks posted:            ' + tasks.length);
  console.log('Products that got revs:  ' + withReviews);
  console.log('Failed / empty:          ' + failed);
  console.log('Still pending at cutoff: ' + pending.size);
  console.log('Reviews store now:       ' + Object.keys(store).length + ' products');
  console.log('Written to:              ' + OUT_FILE);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})();
