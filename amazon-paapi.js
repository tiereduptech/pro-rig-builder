// amazon-paapi.js — shared Amazon Creators (PA-API successor) client.
//
// ONE job: resolve ASINs to catalog items, and NEVER let a PA API problem break
// a caller. Every failure mode degrades to "no data" so the caller falls back to
// its own path (keep-price) instead of throwing mid-run.
//
// The failover lives HERE, not in callers, so every consumer inherits it:
//   - missing/!invalid credentials      -> circuit opens, empty result, alert
//   - 401 / 403 / AssociateNotEligible  -> circuit opens, empty result, alert
//   - network error / timeout / 5xx     -> retried, then empty result for that batch
//   - 429                               -> backed off and retried (not a failure)
//
// AssociateNotEligible matters specifically: PA API access is revoked below the
// qualifying-sales threshold in a trailing 30-day window. That WILL happen at some
// point, and when it does the price pipeline must keep running on DataForSEO alone
// rather than fall over. The circuit breaker means one 401 costs one request, not
// one per row.

import { readFileSync, existsSync } from 'node:fs';

const TOKEN_URL   = 'https://api.amazon.com/auth/o2/token';
const GETITEMS    = 'https://creatorsapi.amazon/catalog/v1/getItems';
const SEARCHITEMS = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const VARIATIONS  = 'https://creatorsapi.amazon/catalog/v1/getVariations';
const SCOPE       = 'creatorsapi::default';
const MARKETPLACE = 'www.amazon.com';
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'tiereduptech-20';
const CREDS_PATH  = process.env.PRORIG_AMAZON_CREDS || 'C:\\rigfinder\\PRB-credentials.csv';

export const BATCH_MAX = 10;      // hard API cap — 11+ is a 400
const PACE_MS = 950;              // ~1 req/s; throttling starts around a 6-call burst
const TOKEN_TTL_MS = 45 * 60 * 1000;

export const DEFAULT_RESOURCES = [
  'itemInfo.title',
  'offersV2.listings.price',
  'offersV2.listings.condition',
  'offersV2.listings.isBuyBoxWinner',
  'offersV2.listings.availability',
  'offersV2.listings.merchantInfo',
];

// SearchItems returns catalog rows keyword/brand-scoped rather than by ASIN, so it
// carries byLineInfo (the authoritative brand/manufacturer) which resolveDiscoveryBrand
// uses to brand budget/no-name rows the title alone can't.
export const SEARCH_RESOURCES = [
  'itemInfo.title',
  'itemInfo.byLineInfo',
  'offersV2.listings.price',
  'offersV2.listings.availability',
];

// GetVariations resolves a parent ASIN's variation family (colour/size/capacity …).
// variationSummary.variationDimension names WHICH axes vary, so a caller can tell a
// capacity family (relevant: a 1TB vs 2TB SKU is a different product) from a colour
// family (usually the same product), while the per-child offer/title come back too.
export const VARIATION_RESOURCES = [
  'itemInfo.title',
  'offersV2.listings.price',
  'offersV2.listings.condition',
  'variationSummary.variationDimension',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- circuit + observability -------------------------------------------
let circuitOpen = false;
let disabledReason = null;
const alerts = [];
let stats = { calls: 0, items: 0, throttled: 0, batchErrors: 0 };
const listeners = [];

/** Subscribe to degradation alerts. Called at most once per distinct reason. */
export function onPaapiAlert(fn) { if (typeof fn === 'function') listeners.push(fn); }

function raise(reason, detail) {
  if (disabledReason === reason) return;
  disabledReason = reason;
  const a = { reason, detail: String(detail || '').slice(0, 300), at: new Date().toISOString() };
  alerts.push(a);
  for (const fn of listeners) { try { fn(a); } catch { /* a bad listener must not break the run */ } }
}

export function paapiStatus() {
  return { available: !circuitOpen, disabledReason, alerts: [...alerts], stats: { ...stats } };
}

/** Test seam / long-run reset. */
export function resetPaapi() {
  circuitOpen = false; disabledReason = null; alerts.length = 0;
  stats = { calls: 0, items: 0, throttled: 0, batchErrors: 0 };
  token = null; tokenAt = 0;
}

// ---- credentials --------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function loadCreds() {
  const id = process.env.AMAZON_CREATORS_CLIENT_ID;
  const secret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  try {
    if (!existsSync(CREDS_PATH)) return null;
    const rows = parseCsv(readFileSync(CREDS_PATH, 'utf8'));
    if (rows.length < 2) return null;
    const h = rows[0].map(x => x.trim().toLowerCase()), d = rows[1];
    const g = n => { const i = h.indexOf(n); return i === -1 ? '' : (d[i] || '').trim(); };
    const cid = g('credential id'), csec = g('secret');
    return cid && csec ? { id: cid, secret: csec } : null;
  } catch { return null; }
}

let token = null, tokenAt = 0;

async function getToken() {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  const creds = loadCreds();
  if (!creds) { circuitOpen = true; raise('not_configured', 'no env vars and no readable credentials CSV'); return null; }
  let res, body;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.id,
                                  client_secret: creds.secret, scope: SCOPE }).toString(),
      signal: AbortSignal.timeout(30000),
    });
    body = await res.text();
  } catch (e) {
    circuitOpen = true; raise('token_network_error', e?.message); return null;
  }
  let json = null; try { json = JSON.parse(body); } catch { /* keep raw */ }
  if (!res.ok || !json?.access_token) {
    circuitOpen = true;
    // Eligibility can surface at the TOKEN endpoint, not just on data calls. Split
    // the two authenticated-but-forbidden cases apart, because they demand opposite
    // responses: a 403 (or an explicit AssociateNotEligible marker) is Amazon GATING
    // a valid app -> warn and fall back; a 401 is a bad/rotated secret -> our bug,
    // fail loudly. Anything else is a transient token failure.
    const ineligible = res.status === 403 || /associatenoteligible|not eligible/i.test(body || '');
    raise(ineligible ? 'associate_not_eligible'
          : res.status === 401 ? 'credentials_rejected'
          : 'token_failed',
          `HTTP ${res.status} ${body?.slice(0, 200)}`);
    return null;
  }
  token = json.access_token; tokenAt = Date.now();
  return token;
}

// ---- one POST -----------------------------------------------------------
// Shared transport for every Creators-API endpoint (getItems, searchItems, …).
// Owns the ENTIRE failover contract so every caller inherits it identically:
// token acquisition, 429 backoff+retry, 401/403/eligibility → circuit-open,
// 5xx / network retry-then-give-up, and the batchError accounting. Returns the
// parsed JSON object on success, or null on any terminal failure (caller then
// falls back). NEVER throws.
async function paapiPost(url, payload) {
  const t = await getToken();
  if (!t) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, text;
    try {
      stats.calls++;
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json',
                   Accept: 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify({ marketplace: MARKETPLACE, partnerTag: PARTNER_TAG,
                               partnerType: 'Associates', ...payload }),
        signal: AbortSignal.timeout(45000),
      });
      text = await res.text();
    } catch (e) {
      if (attempt === 3) { stats.batchErrors++; return null; }
      await sleep(1500 * (attempt + 1));
      continue;
    }

    if (res.status === 429) { stats.throttled++; await sleep(2500 * (attempt + 1)); continue; }

    // Eligibility / auth loss — stop the whole run's PA API usage immediately.
    if (res.status === 401 || res.status === 403 || /associatenoteligible|not eligible/i.test(text || '')) {
      circuitOpen = true;
      raise(/associatenoteligible|not eligible/i.test(text || '') ? 'associate_not_eligible' : 'unauthorized',
            `HTTP ${res.status} ${String(text).slice(0, 200)}`);
      return null;
    }
    if (res.status >= 500) {
      if (attempt === 3) { stats.batchErrors++; return null; }
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) { stats.batchErrors++; return null; }

    let json = null; try { json = JSON.parse(text); } catch { stats.batchErrors++; return null; }
    return json;
  }
  stats.batchErrors++;
  return null;
}

// ---- one batch ----------------------------------------------------------
async function getItemsBatch(asins, resources) {
  const json = await paapiPost(GETITEMS, { itemIds: asins, itemIdType: 'ASIN', resources });
  if (!json) return null;
  return json.itemsResult?.items || json.items || [];
}

/**
 * Resolve ASINs to PA API items. NEVER throws.
 * Returns a Map<asin, item>; ASINs PA API did not return are simply absent, and
 * a fully-degraded client returns an empty Map so callers fall back cleanly.
 */
export async function resolveItems(asins, { resources = DEFAULT_RESOURCES, pace = PACE_MS } = {}) {
  const out = new Map();
  const unique = [...new Set((asins || []).filter(Boolean))];
  if (!unique.length || circuitOpen) return out;

  for (let i = 0; i < unique.length; i += BATCH_MAX) {
    if (circuitOpen) break;                       // opened mid-run: stop, do not thrash
    const items = await getItemsBatch(unique.slice(i, i + BATCH_MAX), resources);
    if (items) for (const it of items) { if (it?.asin) { out.set(it.asin, it); stats.items++; } }
    if (i + BATCH_MAX < unique.length) await sleep(pace);
  }
  return out;
}

// SearchItems max page size is 10 items; pages 1..10 (100 items max per query).
export const SEARCH_PAGE_MAX = 10;   // items per page (API cap)
const SEARCH_PAGE_LIMIT = 10;        // deepest page the API will serve

/**
 * Keyword/brand-scoped catalog search. NEVER throws.
 * Fetches `pages` pages (each ≤10 items), deduping ASINs across pages, honoring the
 * SAME circuit breaker and pacing as resolveItems. Returns
 *   { items: item[], totalResultCount: number|null, pagesFetched: number }
 * A degraded client (open circuit, bad creds, eligibility loss) returns an empty
 * item list so callers fall back cleanly instead of seeing an exception.
 */
export async function searchItems(keywords, {
  brand = null, searchIndex = null, pages = 1, itemCount = SEARCH_PAGE_MAX,
  resources = SEARCH_RESOURCES, minPrice = null, maxPrice = null, pace = PACE_MS,
} = {}) {
  const out = new Map();                 // asin -> item, deduped across pages
  let totalResultCount = null, pagesFetched = 0;
  const kw = String(keywords || '').trim();
  if ((!kw && !brand) || circuitOpen) return { items: [], totalResultCount, pagesFetched };

  const maxPages = Math.min(Math.max(1, pages | 0), SEARCH_PAGE_LIMIT);
  for (let page = 1; page <= maxPages; page++) {
    if (circuitOpen) break;              // opened mid-run: stop, do not thrash
    const payload = { keywords: kw, itemPage: page, itemCount, resources };
    if (brand) payload.brand = brand;
    if (searchIndex) payload.searchIndex = searchIndex;
    if (minPrice != null) payload.minPrice = minPrice;
    if (maxPrice != null) payload.maxPrice = maxPrice;

    const json = await paapiPost(SEARCHITEMS, payload);
    if (!json) break;                    // terminal error / circuit — stop paging
    pagesFetched++;
    const items = json.searchResult?.items || json.itemsResult?.items || json.items || [];
    const total = json.searchResult?.totalResultCount ?? json.totalResultCount ?? null;
    if (total != null) totalResultCount = total;
    for (const it of items) { const a = it?.asin; if (a && !out.has(a)) { out.set(a, it); stats.items++; } }
    if (!items.length) break;            // exhausted results — no point paging further
    if (page < maxPages) await sleep(pace);
  }
  return { items: [...out.values()], totalResultCount, pagesFetched };
}

// GetVariations serves at most SEARCH_PAGE_MAX (10) children per page; a large family
// (e.g. a capacity ladder) pages exactly like SearchItems does.
export const VARIATION_PAGE_MAX = 10;   // children per page (API cap)

/**
 * Resolve a parent ASIN's variation family. NEVER throws.
 * Pages children (each ≤10) under the SAME circuit breaker and pacing as the other
 * endpoints, deduping child ASINs across pages. Returns
 *   { items: item[], variationDimensions: string[], totalResultCount: number|null, pagesFetched: number }
 * A degraded client (open circuit, bad creds, eligibility loss) returns an empty item
 * list so callers fall back cleanly instead of seeing an exception.
 */
export async function getVariations(asin, {
  pages = 1, itemCount = VARIATION_PAGE_MAX, resources = VARIATION_RESOURCES, pace = PACE_MS,
} = {}) {
  const out = new Map();                 // childAsin -> item, deduped across pages
  let totalResultCount = null, pagesFetched = 0;
  const dims = new Set();
  const parent = String(asin || '').trim();
  if (!parent || circuitOpen) return { items: [], variationDimensions: [], totalResultCount, pagesFetched };

  const maxPages = Math.min(Math.max(1, pages | 0), SEARCH_PAGE_LIMIT);
  for (let page = 1; page <= maxPages; page++) {
    if (circuitOpen) break;              // opened mid-run: stop, do not thrash
    const json = await paapiPost(VARIATIONS, { asin: parent, variationPage: page, variationCount: itemCount, resources });
    if (!json) break;                    // terminal error / circuit — stop paging
    pagesFetched++;
    const items = json.variationsResult?.items || json.result?.items || json.itemsResult?.items || json.items || [];
    const summary = json.variationsResult?.variationSummary || json.variationSummary || null;
    const total = summary?.variationCount ?? summary?.pageCount ?? json.variationsResult?.totalResultCount ?? null;
    if (total != null) totalResultCount = total;
    for (const d of (summary?.variationDimensions || summary?.variationDimension || [])) {
      const name = d?.name || d?.displayName || d; if (name) dims.add(String(name));
    }
    for (const it of items) { const a = it?.asin; if (a && !out.has(a)) { out.set(a, it); stats.items++; } }
    if (!items.length) break;            // exhausted the family — no point paging further
    if (page < maxPages) await sleep(pace);
  }
  return { items: [...out.values()], variationDimensions: [...dims], totalResultCount, pagesFetched };
}

// ---- configuration preflight -------------------------------------------
// A misconfigured second opinion (no creds wired) is OUR bug and must never look
// like a healthy run; an eligibility gate (403 AssociateNotEligible) is AMAZON's
// gate and is expected right now. Same log line for both is exactly the failure
// this module exists to prevent, so the preflight maps every disabledReason onto
// ONE of four policy states the caller branches on:
//
//   'ok'       creds valid, Amazon reachable            -> use PA API
//   'our_bug'  not_configured | credentials_rejected    -> FAIL the job loudly
//   'gated'    associate_not_eligible | unauthorized    -> WARN, fall back to DataForSEO
//   'degraded' token_failed | network | anything else   -> WARN, transient, fall back
function classifyReason(reason) {
  if (reason === 'not_configured' || reason === 'credentials_rejected') return 'our_bug';
  if (reason === 'associate_not_eligible' || reason === 'unauthorized')  return 'gated';
  return 'degraded';
}

/**
 * One-shot config + reachability probe. Makes ONE real getItems call (PA API is
 * free) so the true state is known even on a run with nothing to resolve — and so
 * an eligibility gate, which only surfaces on data calls, is actually observed
 * rather than assumed from a token that issued fine. NEVER throws.
 *
 * @param {string[]} probeAsins  up to one real ASIN to resolve; if none given,
 *   falls back to a token-only check (still catches not_configured / bad creds,
 *   but cannot observe a data-call eligibility gate).
 * @returns {Promise<{state:'ok'|'our_bug'|'gated'|'degraded', reason:string|null, detail:string}>}
 */
export async function preflightPaapi(probeAsins = []) {
  resetPaapi();                                  // clean slate: status reflects THIS probe only
  const asins = [...new Set((probeAsins || []).filter(Boolean))].slice(0, 1);
  const lastDetail = () => { const st = paapiStatus(); return st.alerts[st.alerts.length - 1]?.detail || ''; };

  if (asins.length) {
    const items = await resolveItems(asins);
    const st = paapiStatus();
    if (st.available) return { state: 'ok', reason: null, detail: `probe ASIN ${asins[0]} → ${items.size} item(s)` };
    return { state: classifyReason(st.disabledReason), reason: st.disabledReason, detail: lastDetail() };
  }

  const t = await getToken();
  const st = paapiStatus();
  if (t) return { state: 'ok', reason: null, detail: 'token acquired (no probe ASIN available)' };
  return { state: classifyReason(st.disabledReason), reason: st.disabledReason, detail: lastDetail() };
}
