/**
 * scrape-common.js — shared utilities for manufacturer catalog scrapers (v2)
 *
 * FIXES from v1:
 *   - makeProduct coerces mpn/name to string before trim (was crashing on
 *     JSON-LD fields that returned numbers or nested objects)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as cheerio from 'cheerio';

export const CONFIG = {
  outputDir: './catalog-build',
  cacheDir: './catalog-build/cache',
  delayMinMs: 1500,
  delayMaxMs: 3500,
  backoffMinMs: 8000,
  backoffMaxMs: 20000,
  retryCount: 3,
  requestTimeoutMs: 20000,
};

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const rand = (min, max) => min + Math.floor(Math.random() * (max - min));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const politeDelay = () => sleep(rand(CONFIG.delayMinMs, CONFIG.delayMaxMs));

export const log = {
  info:  (...a) => console.log('  ', ...a),
  ok:    (...a) => console.log(' ✓', ...a),
  warn:  (...a) => console.log(' ⚠', ...a),
  err:   (...a) => console.log(' ✗', ...a),
  head:  (label) => console.log(`\n=== ${label} ===\n`),
  step:  (n, total, label) => console.log(`\n[${n}/${total}] ${label}`),
};

// Coerce any value to a trimmed string, or null if unusable
export function safeStr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Some JSON-LD libraries return arrays or objects for fields that should be strings
  if (Array.isArray(v) && v.length > 0) return safeStr(v[0]);
  if (typeof v === 'object' && v['@value']) return safeStr(v['@value']);
  return null;
}

export async function fetchHTML(url, { referer = null, useCache = true } = {}) {
  const cachePath = urlToCachePath(url);
  if (useCache && existsSync(cachePath)) {
    return readFileSync(cachePath, 'utf-8');
  }

  for (let attempt = 0; attempt <= CONFIG.retryCount; attempt++) {
    try {
      const ctl = AbortSignal.timeout(CONFIG.requestTimeoutMs);
      const resp = await fetch(url, {
        signal: ctl,
        headers: {
          'User-Agent':                pick(UA_POOL),
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':           'en-US,en;q=0.9',
          'Accept-Encoding':           'gzip, deflate, br',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest':            'document',
          'Sec-Fetch-Mode':            'navigate',
          'Sec-Fetch-Site':            referer ? 'same-origin' : 'none',
          ...(referer ? { 'Referer': referer } : {}),
        },
        redirect: 'follow',
      });

      if (resp.status === 429 || resp.status === 503) {
        if (attempt >= CONFIG.retryCount) { log.err(`${resp.status} on ${url}`); return null; }
        const wait = rand(CONFIG.backoffMinMs, CONFIG.backoffMaxMs);
        log.warn(`${resp.status} on ${url} — backing off ${Math.round(wait/1000)}s`);
        await sleep(wait);
        continue;
      }

      if (!resp.ok) { log.err(`HTTP ${resp.status} on ${url}`); return null; }

      const html = await resp.text();

      if (html.length < 1000 || /captcha|automated access|are you a robot/i.test(html.slice(0, 10000))) {
        if (attempt >= CONFIG.retryCount) { log.err(`bot-check hit on ${url}`); return null; }
        const wait = rand(CONFIG.backoffMinMs * 2, CONFIG.backoffMaxMs * 2);
        log.warn(`bot-check on ${url} — backing off ${Math.round(wait/1000)}s`);
        await sleep(wait);
        continue;
      }

      if (useCache) writeCache(cachePath, html);
      return html;

    } catch (err) {
      if (attempt >= CONFIG.retryCount) { log.err(`fetch error on ${url}: ${err.message}`); return null; }
      await sleep(rand(3000, 8000));
    }
  }
  return null;
}

function urlToCachePath(url) {
  const safe = url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 200);
  return join(CONFIG.cacheDir, `${safe}.html`);
}

function writeCache(path, html) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  } catch (e) {
    log.warn(`cache write failed: ${e.message}`);
  }
}

export function parseHTML(html) {
  return cheerio.load(html);
}

export function extractJsonLd(html) {
  const results = [];
  const matches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of matches) {
    try { results.push(JSON.parse(m[1].trim())); } catch {}
  }
  return results;
}

export function extractWindowJson(html, varName = '__NEXT_DATA__') {
  const re = new RegExp(`${varName}\\s*=\\s*({[\\s\\S]*?});?\\s*(?:<\\/script>|window\\.)`, 'i');
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// THE FIX: use safeStr everywhere instead of direct .trim()
export function makeProduct({ brand, category, name, mpn = null, imageUrl = null, specs = {}, sourceUrl }) {
  return {
    brand:     safeStr(brand) || '',
    category:  safeStr(category) || '',
    name:      safeStr(name) || '',
    mpn:       safeStr(mpn),
    imageUrl:  safeStr(imageUrl),
    specs:     specs || {},
    sourceUrl: safeStr(sourceUrl),
    scrapedAt: new Date().toISOString(),
  };
}

export function writeOutput(brand, category, products) {
  mkdirSync(CONFIG.outputDir, { recursive: true });
  const safeBrand = brand.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const safeCat = category.toLowerCase();
  const path = join(CONFIG.outputDir, `${safeBrand}-${safeCat}.json`);
  writeFileSync(path, JSON.stringify(products, null, 2));
  log.ok(`Wrote ${products.length} products → ${path}`);
  return path;
}

export function parseFlags() {
  const args = process.argv.slice(2);
  const get = (name, hasValue = false) => {
    const i = args.indexOf(name);
    if (i === -1) return hasValue ? null : false;
    return hasValue ? args[i + 1] : true;
  };
  return {
    limit:    Number(get('--limit', true)) || null,
    noCache:  get('--no-cache'),
    dryRun:   get('--dry-run'),
    verbose:  get('--verbose'),
  };
}

export function dedupeProducts(products) {
  const seen = new Map();
  for (const p of products) {
    const key = p.mpn ? `${p.brand}|${p.mpn}` : `${p.brand}|${(p.name || '').toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

export function cleanText(t) {
  if (!t) return '';
  return String(t).replace(/\s+/g, ' ').trim();
}

export function absoluteUrl(base, href) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}
