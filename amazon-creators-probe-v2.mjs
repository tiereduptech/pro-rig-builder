// amazon-creators-probe-v2.mjs
//
// READ-ONLY capability probe for the Amazon Creators API (PA-API successor).
// Writes NOTHING: no DB, no parts.js, no files. Only GETs/POSTs to Amazon.
//
// Answers, per operation:
//   1. RAW JSON response (not a formatted summary)
//   2. GetItems batching  — how many ASINs per call before it rejects
//      SearchItems       — can we FIND ASINs (the paid-search replacement)
//      GetVariations     — do variation families come back
//   3. Which RESOURCES are authorized: price, availability, condition,
//      images, title, externalIds (UPC/EAN), merchant, etc.
//   4. Throughput — observed throttle behaviour + any rate-limit headers
//
// Run: node amazon-creators-probe-v2.mjs
// Zero dependencies (Node 18+ global fetch).

import { readFileSync, existsSync } from 'node:fs';

// ---- config -------------------------------------------------------------
const CREDS_PATH  = process.env.PRORIG_AMAZON_CREDS || 'C:\\rigfinder\\PRB-credentials.csv';
const PARTNER_TAG = 'tiereduptech-20';
const MARKETPLACE = 'www.amazon.com';
const TOKEN_URL   = 'https://api.amazon.com/auth/o2/token';
const SCOPE       = 'creatorsapi::default';
const BASE        = 'https://creatorsapi.amazon/catalog/v1';

const URLS = {
  getItems:      `${BASE}/getItems`,
  searchItems:   `${BASE}/searchItems`,
  getVariations: `${BASE}/getVariations`,
};

const PAUSE_MS = 1100; // stay under ~1 TPS between probes (burst test excepted)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- CSV creds (secret never printed) -----------------------------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Env vars first (the CI / Actions route — AMAZON_CREATORS_CLIENT_ID/SECRET, the
// same secrets verify-catalog.yml injects), CSV file only as a local fallback.
// The Windows CSV path is a Railway-era leftover, not the primary route.
function loadCreds() {
  const envId = process.env.AMAZON_CREATORS_CLIENT_ID;
  const envSecret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (envId && envSecret) {
    return { id: envId, secret: envSecret, version: process.env.AMAZON_CREATORS_VERSION || '(env)', source: 'env' };
  }
  if (!existsSync(CREDS_PATH)) {
    throw new Error(`no AMAZON_CREATORS_CLIENT_ID/SECRET env vars and no credentials CSV at ${CREDS_PATH}`);
  }
  const rows = parseCsv(readFileSync(CREDS_PATH, 'utf8'));
  if (rows.length < 2) throw new Error('CSV has no data row');
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const data = rows[1];
  const get = (n) => { const i = headers.indexOf(n); return i === -1 ? '' : (data[i] || '').trim(); };
  const id = get('credential id'), secret = get('secret'), version = get('version');
  if (!id || !secret) throw new Error('Could not find Credential Id / Secret columns');
  return { id, secret, version, source: 'csv' };
}

async function getAccessToken(id, secret) {
  const attempts = [
    { name: 'body-creds',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: SCOPE }).toString() },
    { name: 'basic-auth',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString() },
  ];
  let last = null;
  for (const a of attempts) {
    let res, text;
    try { res = await fetch(TOKEN_URL, { method: 'POST', headers: a.headers, body: a.body }); text = await res.text(); }
    catch (e) { last = { method: a.name, networkError: String(e?.message || e) }; continue; }
    let json = null; try { json = JSON.parse(text); } catch {}
    if (res.ok && json?.access_token) return { token: json.access_token, method: a.name, expiresIn: json.expires_in };
    last = { method: a.name, status: res.status, body: (text || '').slice(0, 600) };
  }
  return { error: last };
}

// ---- generic call -------------------------------------------------------
let TOKEN = null;
const RATE_HEADER_RE = /rate|limit|throttl|retry|quota|request-id|requestid/i;

async function call(url, body) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-marketplace': MARKETPLACE,
      },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    return { networkError: String(e?.message || e), ms: Date.now() - t0 };
  }
  let json = null; try { json = JSON.parse(text); } catch {}
  const headers = {};
  for (const [k, v] of res.headers.entries()) if (RATE_HEADER_RE.test(k)) headers[k] = v;
  return { status: res.status, ok: res.ok, json, raw: text, headers, ms: Date.now() - t0 };
}

const base = (extra = {}) => ({
  marketplace: MARKETPLACE,
  partnerTag: PARTNER_TAG,
  partnerType: 'Associates',
  ...extra,
});

// ---- response shape helpers --------------------------------------------
function itemsOf(json) {
  return json?.items || json?.itemsResult?.items || json?.searchResult?.items
      || json?.variationsResult?.items || json?.result?.items || [];
}
function errorsOf(json) {
  const e = json?.errors || json?.Errors || [];
  return Array.isArray(e) ? e : [e];
}
function errSummary(json, raw) {
  const errs = errorsOf(json);
  if (errs.length) return errs.map(x => `${x.code || x.Code || '?'}: ${x.message || x.Message || ''}`.trim()).join(' | ');
  return (raw || '').slice(0, 300);
}
// Does a dotted path resolve to something non-empty in the item?
function hasPath(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return false;
    const key = p in cur ? p : (p.charAt(0).toLowerCase() + p.slice(1)) in cur
      ? p.charAt(0).toLowerCase() + p.slice(1) : null;
    if (key == null) {
      if (Array.isArray(cur) && cur.length) { cur = cur[0]; const k2 = p in cur ? p : null; if (!k2) return false; cur = cur[k2]; continue; }
      return false;
    }
    cur = cur[key];
    if (Array.isArray(cur) && cur.length && parts.indexOf(p) < parts.length - 1) cur = cur[0];
  }
  return cur != null && !(Array.isArray(cur) && cur.length === 0);
}

function hr(t) { console.log('\n' + '='.repeat(72)); console.log(t); console.log('='.repeat(72)); }
function sub(t) { console.log('\n' + '-'.repeat(72)); console.log(t); console.log('-'.repeat(72)); }

// ---- fixtures from the real catalog (read-only import) ------------------
async function loadFixtures() {
  const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js');
  const parts = mod.default;
  const re = /(?:\/dp\/|\/gp\/product\/|ASIN=)([A-Z0-9]{10})/;
  const byCat = {};
  const all = [];
  for (const p of parts) {
    const url = p?.deals?.amazon?.url;
    if (!url) continue;
    const m = String(url).match(re);
    if (!m) continue;
    const row = { id: p.id, cat: p.c || p.cat || '?', name: p.n, asin: m[1] };
    all.push(row);
    (byCat[row.cat] ||= []).push(row);
  }
  // de-dupe ASINs, preserve order
  const seen = new Set(); const uniq = [];
  for (const r of all) if (!seen.has(r.asin)) { seen.add(r.asin); uniq.push(r); }
  return { uniq, byCat, totalAmazonRows: all.length, totalProducts: parts.length };
}

// ---- resource matrix ----------------------------------------------------
// Each: the resource string we ask for, and the item path we check for data.
const RESOURCES = [
  ['itemInfo.title',                 'itemInfo.title'],
  ['itemInfo.externalIds',           'itemInfo.externalIds'],
  ['itemInfo.byLineInfo',            'itemInfo.byLineInfo'],
  ['itemInfo.features',              'itemInfo.features'],
  ['itemInfo.productInfo',           'itemInfo.productInfo'],
  ['itemInfo.manufactureInfo',       'itemInfo.manufactureInfo'],
  ['itemInfo.classifications',       'itemInfo.classifications'],
  ['images.primary.large',           'images.primary.large'],
  ['images.variants.large',          'images.variants'],
  ['offersV2.listings.price',        'offersV2.listings.price'],
  ['offersV2.listings.availability', 'offersV2.listings.availability'],
  ['offersV2.listings.condition',    'offersV2.listings.condition'],
  ['offersV2.listings.merchantInfo', 'offersV2.listings.merchantInfo'],
  ['offersV2.listings.isBuyBoxWinner','offersV2.listings.isBuyBoxWinner'],
  ['offersV2.listings.dealDetails',  'offersV2.listings.dealDetails'],
  ['offersV2.listings.type',         'offersV2.listings.type'],
  ['offersV2.listings.loyaltyPoints','offersV2.listings.loyaltyPoints'],
  // legacy PA-API v5 spellings — do they still resolve?
  ['offers.listings.price',          'offers.listings.price'],
  ['offers.listings.availability.message', 'offers.listings.availability'],
  ['offers.listings.condition',      'offers.listings.condition'],
  ['offers.summaries.lowestPrice',   'offers.summaries'],
  ['parentASIN',                     'parentASIN'],
  ['browseNodeInfo.browseNodes',     'browseNodeInfo'],
];

// ---- main ---------------------------------------------------------------
(async () => {
  hr('Amazon Creators API — EXPANDED CAPABILITY PROBE (read-only)');
  console.log('No writes. No migration. Probing what is actually authorized.\n');

  // fixtures
  let fx;
  try {
    fx = await loadFixtures();
    console.log(`catalog: ${fx.totalProducts} products, ${fx.totalAmazonRows} Amazon-linked rows, ${fx.uniq.length} unique ASINs`);
  } catch (e) {
    console.log('Could not load parts.js fixtures:', e.message);
    fx = { uniq: [{ id: 0, cat: 'CPU', name: 'Ryzen 7 7700X', asin: 'B0BBHHT8LY' }], byCat: {}, totalAmazonRows: 0, totalProducts: 0 };
  }

  const PRIMARY = fx.uniq.find(r => r.asin === 'B0BBHHT8LY') || fx.uniq[0];
  console.log(`primary probe ASIN: ${PRIMARY.asin} (${PRIMARY.name})\n`);

  // creds + token
  let creds;
  try { creds = loadCreds(); }
  catch (e) { console.log('CREDS ERROR:', e.message); process.exit(1); }
  console.log('creds:', creds.id.slice(0, 35) + '…', '| version', creds.version, '| source', creds.source, '| tag', PARTNER_TAG);

  const tok = await getAccessToken(creds.id, creds.secret);
  if (tok.error) { console.log('TOKEN ERROR:', JSON.stringify(tok.error)); process.exit(2); }
  TOKEN = tok.token;
  console.log(`token: acquired via "${tok.method}", expires_in=${tok.expiresIn}s`);

  const report = { ops: {}, resources: {}, batch: {}, throughput: {} };

  // ======================================================================
  // 1. RAW JSON — GetItems, single ASIN, kitchen-sink resource list
  // ======================================================================
  hr('1. RAW JSON — GetItems, single ASIN, ALL resources requested');
  const allRes = RESOURCES.map(r => r[0]);
  const rawCall = await call(URLS.getItems, base({
    itemIds: [PRIMARY.asin], itemIdType: 'ASIN', resources: allRes,
  }));
  console.log(`HTTP ${rawCall.status}  (${rawCall.ms}ms)`);
  console.log('rate/meta headers:', JSON.stringify(rawCall.headers));
  console.log('\n--- RAW RESPONSE BODY (verbatim, pretty-printed if JSON) ---');
  if (rawCall.json) console.log(JSON.stringify(rawCall.json, null, 2));
  else console.log(rawCall.raw);
  console.log('--- END RAW BODY ---');
  report.ops.getItems_all_resources = { status: rawCall.status, ok: rawCall.ok };

  // If asking for everything fails, fall back to the known-good pair so the
  // rest of the probe still runs.
  let workingResources = allRes;
  if (!rawCall.ok || itemsOf(rawCall.json).length === 0) {
    console.log('\n[!] Kitchen-sink request did not return an item. Falling back to known-good resources.');
    workingResources = ['itemInfo.title', 'offersV2.listings.price'];
  }
  await sleep(PAUSE_MS);

  // ======================================================================
  // 2. RESOURCE MATRIX — request each resource ALONE
  // ======================================================================
  hr('2. RESOURCE MATRIX — each resource requested in isolation');
  console.log('accepted = HTTP 200 & no resource error; populated = data actually present\n');
  console.log('resource'.padEnd(40) + 'HTTP'.padEnd(6) + 'accepted'.padEnd(10) + 'populated');
  console.log('-'.repeat(72));
  for (const [resName, path] of RESOURCES) {
    const r = await call(URLS.getItems, base({
      itemIds: [PRIMARY.asin], itemIdType: 'ASIN',
      resources: ['itemInfo.title', resName],
    }));
    const items = itemsOf(r.json);
    const errs = errorsOf(r.json);
    const accepted = r.ok && errs.length === 0;
    const populated = items.length ? hasPath(items[0], path) : false;
    report.resources[resName] = {
      status: r.status, accepted, populated,
      error: accepted ? null : errSummary(r.json, r.raw).slice(0, 160),
    };
    console.log(
      resName.padEnd(40) +
      String(r.status).padEnd(6) +
      (accepted ? 'yes' : 'NO').padEnd(10) +
      (populated ? 'yes' : 'no')
    );
    if (!accepted) console.log('   └─ ' + errSummary(r.json, r.raw).slice(0, 200));
    await sleep(PAUSE_MS);
  }

  // Show a real populated offer block so we can see Condition/Availability shape
  sub('2b. Sample offer block (condition / availability / price shape)');
  const offerCall = await call(URLS.getItems, base({
    itemIds: [PRIMARY.asin], itemIdType: 'ASIN',
    resources: ['itemInfo.title', 'itemInfo.externalIds', 'images.primary.large',
                'offersV2.listings.price', 'offersV2.listings.availability',
                'offersV2.listings.condition', 'offersV2.listings.merchantInfo',
                'offersV2.listings.isBuyBoxWinner', 'offersV2.listings.type'],
  }));
  console.log(`HTTP ${offerCall.status}`);
  console.log(offerCall.json ? JSON.stringify(offerCall.json, null, 2).slice(0, 4000) : offerCall.raw.slice(0, 4000));
  await sleep(PAUSE_MS);

  // ======================================================================
  // 3. BATCH SIZE — how many ASINs per GetItems call?
  // ======================================================================
  hr('3. GetItems BATCHING — how many ASINs per call?');
  const pool = fx.uniq.map(r => r.asin);
  const sizes = [1, 5, 10, 11, 20, 50];
  console.log('batch'.padEnd(8) + 'HTTP'.padEnd(6) + 'items'.padEnd(8) + 'errors'.padEnd(8) + 'ms');
  console.log('-'.repeat(72));
  for (const n of sizes) {
    if (pool.length < n) { console.log(`${String(n).padEnd(8)}(not enough fixture ASINs)`); continue; }
    const ids = pool.slice(0, n);
    const r = await call(URLS.getItems, base({
      itemIds: ids, itemIdType: 'ASIN',
      resources: ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.condition'],
    }));
    const items = itemsOf(r.json); const errs = errorsOf(r.json);
    report.batch[n] = { status: r.status, returned: items.length, errors: errs.length, ms: r.ms };
    console.log(
      String(n).padEnd(8) + String(r.status).padEnd(6) +
      String(items.length).padEnd(8) + String(errs.length).padEnd(8) + r.ms
    );
    if (!r.ok || errs.length) console.log('   └─ ' + errSummary(r.json, r.raw).slice(0, 220));
    await sleep(PAUSE_MS);
  }

  // ======================================================================
  // 4. SearchItems — the paid-ASIN-search replacement
  // ======================================================================
  hr('4. SearchItems — can we FIND ASINs? (replaces paid ASIN search)');
  const searchBodies = [
    { label: 'keywords + searchIndex', body: base({
        keywords: 'AMD Ryzen 7 7700X desktop processor', searchIndex: 'Electronics', itemCount: 10,
        resources: ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.condition'] }) },
    { label: 'keywords only',          body: base({
        keywords: 'AMD Ryzen 7 7700X', itemCount: 10,
        resources: ['itemInfo.title', 'offersV2.listings.price'] }) },
  ];
  for (const s of searchBodies) {
    sub(`SearchItems — ${s.label}`);
    const r = await call(URLS.searchItems, s.body);
    console.log(`HTTP ${r.status}  (${r.ms}ms)`);
    const items = itemsOf(r.json);
    report.ops[`searchItems_${s.label.replace(/\W+/g, '_')}`] = {
      status: r.status, ok: r.ok, returned: items.length,
      error: r.ok ? null : errSummary(r.json, r.raw).slice(0, 300),
    };
    if (r.json) console.log(JSON.stringify(r.json, null, 2).slice(0, 3500));
    else console.log((r.raw || r.networkError || '').slice(0, 1500));
    await sleep(PAUSE_MS);
  }

  // ======================================================================
  // 5. GetVariations
  // ======================================================================
  hr('5. GetVariations — do variation families come back?');
  const varCandidates = [
    PRIMARY,
    fx.byCat.RAM?.[0], fx.byCat.Case?.[0], fx.byCat.Monitor?.[0], fx.byCat.Storage?.[0],
  ].filter(Boolean);
  for (const cand of varCandidates.slice(0, 4)) {
    sub(`GetVariations — ${cand.asin} (${cand.cat}: ${cand.name})`);
    const r = await call(URLS.getVariations, base({
      asin: cand.asin,
      resources: ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.condition',
                  'variationSummary.variationDimension'],
    }));
    console.log(`HTTP ${r.status}  (${r.ms}ms)`);
    const items = itemsOf(r.json);
    report.ops[`getVariations_${cand.asin}`] = {
      status: r.status, ok: r.ok, returned: items.length,
      error: r.ok ? null : errSummary(r.json, r.raw).slice(0, 300),
    };
    if (r.json) console.log(JSON.stringify(r.json, null, 2).slice(0, 2500));
    else console.log((r.raw || r.networkError || '').slice(0, 1200));
    await sleep(PAUSE_MS);
  }

  // ======================================================================
  // 6. THROUGHPUT — observed throttle behaviour
  // ======================================================================
  hr('6. THROUGHPUT — observed throttle (no documented value is exposed by the API)');
  console.log('Firing 12 GetItems calls back-to-back with NO delay to find the throttle point.\n');
  const burstIds = pool.slice(0, 10);
  const burst = [];
  const tStart = Date.now();
  for (let i = 0; i < 12; i++) {
    const r = await call(URLS.getItems, base({
      itemIds: burstIds, itemIdType: 'ASIN', resources: ['itemInfo.title', 'offersV2.listings.price'],
    }));
    burst.push({ i: i + 1, status: r.status, ms: r.ms, items: itemsOf(r.json).length,
                 err: r.ok ? '' : errSummary(r.json, r.raw).slice(0, 90), headers: r.headers });
  }
  const elapsed = (Date.now() - tStart) / 1000;
  console.log('#'.padEnd(5) + 'HTTP'.padEnd(6) + 'items'.padEnd(8) + 'ms'.padEnd(8) + 'error');
  console.log('-'.repeat(72));
  for (const b of burst) {
    console.log(String(b.i).padEnd(5) + String(b.status).padEnd(6) + String(b.items).padEnd(8) + String(b.ms).padEnd(8) + b.err);
  }
  const throttled = burst.filter(b => b.status === 429 || /throttl|toomanyrequest|rate/i.test(b.err));
  const okCount = burst.filter(b => b.status === 200).length;
  console.log(`\nelapsed: ${elapsed.toFixed(1)}s for 12 calls  →  ~${(12 / elapsed).toFixed(2)} req/s attempted`);
  console.log(`succeeded: ${okCount}/12   throttled: ${throttled.length}/12`);
  const hdrSample = burst.find(b => Object.keys(b.headers || {}).length);
  console.log('rate-limit headers seen:', hdrSample ? JSON.stringify(hdrSample.headers) : '(none exposed)');
  report.throughput = {
    calls: 12, elapsedSec: Number(elapsed.toFixed(1)), succeeded: okCount,
    throttled: throttled.length, attemptedRps: Number((12 / elapsed).toFixed(2)),
    headers: hdrSample?.headers || null,
  };

  // ======================================================================
  // SUMMARY
  // ======================================================================
  hr('SUMMARY — machine-readable');
  console.log(JSON.stringify(report, null, 2));

  hr('SUMMARY — what works / what errors');
  const okRes = Object.entries(report.resources).filter(([, v]) => v.accepted && v.populated).map(([k]) => k);
  const acceptedEmpty = Object.entries(report.resources).filter(([, v]) => v.accepted && !v.populated).map(([k]) => k);
  const badRes = Object.entries(report.resources).filter(([, v]) => !v.accepted).map(([k, v]) => `${k} (${v.status})`);
  console.log('\nRESOURCES returning data:'); okRes.forEach(r => console.log('  ✔', r));
  console.log('\nRESOURCES accepted but EMPTY for this ASIN:'); acceptedEmpty.forEach(r => console.log('  ○', r));
  console.log('\nRESOURCES rejected:'); badRes.forEach(r => console.log('  ✘', r));

  const maxBatch = Object.entries(report.batch).filter(([, v]) => v.status === 200 && v.returned > 0)
    .map(([k]) => Number(k)).sort((a, b) => b - a)[0];
  console.log('\nMax working GetItems batch observed:', maxBatch ?? 'none');
  console.log('SearchItems:', Object.entries(report.ops).filter(([k]) => k.startsWith('searchItems'))
    .map(([k, v]) => `${k}=HTTP ${v.status}${v.returned != null ? ` (${v.returned} items)` : ''}`).join(', '));
  console.log('GetVariations:', Object.entries(report.ops).filter(([k]) => k.startsWith('getVariations'))
    .map(([k, v]) => `${k.replace('getVariations_', '')}=HTTP ${v.status}${v.returned != null ? ` (${v.returned})` : ''}`).join(', '));
  console.log('\nNOTE: no migration performed. DataForSEO untouched.');
})();
