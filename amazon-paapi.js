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
    raise(res.status === 401 || res.status === 403 ? 'credentials_rejected' : 'token_failed',
          `HTTP ${res.status} ${body?.slice(0, 200)}`);
    return null;
  }
  token = json.access_token; tokenAt = Date.now();
  return token;
}

// ---- one batch ----------------------------------------------------------
async function getItemsBatch(asins, resources) {
  const t = await getToken();
  if (!t) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, text;
    try {
      stats.calls++;
      res = await fetch(GETITEMS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json',
                   Accept: 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify({
          marketplace: MARKETPLACE, partnerTag: PARTNER_TAG, partnerType: 'Associates',
          itemIds: asins, itemIdType: 'ASIN', resources,
        }),
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
    return json?.itemsResult?.items || json?.items || [];
  }
  stats.batchErrors++;
  return null;
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
