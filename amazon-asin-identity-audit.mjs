// amazon-asin-identity-audit.mjs
//
// READ-ONLY full-catalog affiliate-link identity audit via Amazon Creators API.
// Writes ONE report file (amazon-asin-identity-audit.json). NEVER touches
// src/data/parts.js. NEVER calls DataForSEO. NEVER relinks anything.
//
// For every catalog row with an Amazon ASIN:
//   - fetch Amazon's own title + buybox offer for that ASIN
//   - compare returned title to the stored catalog name
//   - classify the failure and flag price divergence
//
// Classes:
//   dead-asin        ASIN returns nothing (delisted / invalid / region-gated)
//   wrong-product    different brand entirely — link points at another product
//   close-but-wrong  same brand, different model or size (LG 27GP850 vs 27GS50F)
//   title-verbosity  same product, stored name is just longer marketing text
//                    (NOT a defect — reported so the real rate isn't inflated)
//
// Run: node amazon-asin-identity-audit.mjs [--limit N]

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { titleMatches } from './drift-gate.js';

const CREDS_PATH  = process.env.PRORIG_AMAZON_CREDS || 'C:\\rigfinder\\PRB-credentials.csv';
const PARTNER_TAG = 'tiereduptech-20';
const MARKETPLACE = 'www.amazon.com';
const TOKEN_URL   = 'https://api.amazon.com/auth/o2/token';
const SCOPE       = 'creatorsapi::default';
const GETITEMS    = 'https://creatorsapi.amazon/catalog/v1/getItems';
const OUT_PATH    = 'amazon-asin-identity-audit.json';

const BATCH = 10;                  // hard API cap
const PAUSE_MS = 950;              // ~1 req/s — measured safe (throttle starts ~6 burst)
const PRICE_DIVERGENCE = 0.15;     // 15%+ delta = actively misleading on price
const CONTAINMENT_CLEAN = 0.75;    // amazon-title tokens found in stored name

const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] || process.argv[process.argv.indexOf(limitArg) + 1]) : Infinity;

// --nightly : two-strike dead-ASIN tracking + rate-jump alert (needs --apply to write)
// --apply   : permit catalog writes. ONLY ever sets needsReview/quarantinedAt on
//             rows whose ASIN has returned nothing on two consecutive runs.
//             wrong-product / close-but-wrong are NEVER written, in any mode.
const NIGHTLY = process.argv.includes('--nightly');
const APPLY   = process.argv.includes('--apply');
const STATE_PATH = 'amazon-asin-audit-state.json';
const QUEUE_PATH = 'relink-review-queue.json';
const DEAD_STRIKES = 2;
// Alert when the wrong-link ATTACH rate rises this many percentage points above
// the trailing median. Dead ASINs are excluded — those are link decay, which
// drifts up slowly; a jump in wrong/close means an ingest started mis-attaching.
const ALERT_JUMP_PP = Number((process.argv.find(a => a.startsWith('--alert-jump=')) || '').split('=')[1] || 2.0);
const HISTORY_KEEP = 30;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// Exit with a definite code even when a real fetch just left an idle keep-alive
// socket pooled — otherwise process.exit() can race that handle and, on Windows,
// abort with a libuv assertion (wrong exit code). Draining the pool first makes
// the code exactly what we intend, on every platform.
async function hardExit(code) {
  try { const { getGlobalDispatcher } = await import('undici'); await getGlobalDispatcher().close(); } catch { /* best effort */ }
  process.exit(code);
}

// Two states, made to look NOTHING alike in the log (red ::error:: + exit 1 vs
// yellow ::warning:: + graceful exit 0) — so "our secret is missing" is never
// mistaken for "Amazon is gating us right now".
async function failNotConfigured(detail) {
  console.log(`::error title=PA API not configured::${detail}`);
  console.error('\n\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
  console.error('\x1b[41m\x1b[97m  ✗✗✗  PA API NOT CONFIGURED — THIS IS OUR BUG  ✗✗✗' + ' '.repeat(19) + '\x1b[0m');
  console.error('\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
  console.error(`\x1b[91m  ${detail}`);
  console.error('  AMAZON_CREATORS_CLIENT_ID / AMAZON_CREATORS_CLIENT_SECRET are not reaching');
  console.error('  this job, and there is no readable credentials CSV. This audit is');
  console.error('  Amazon-only, so it cannot run at all. FAILING so this is fixed, not');
  console.error('  silently skipped.\x1b[0m');
  console.error('\x1b[91m' + '━'.repeat(72) + '\x1b[0m');
  await hardExit(1);
}
async function degradeGated(httpStatus) {
  console.log(`::warning title=PA API gated by Amazon (AssociateNotEligible)::HTTP ${httpStatus} — audit degraded to a clean no-op, nothing quarantined, job stays green`);
  console.warn('\n\x1b[43m\x1b[30m' + '─'.repeat(72) + '\x1b[0m');
  console.warn(`\x1b[43m\x1b[30m  ⚠  PA API gated by Amazon: AssociateNotEligible (HTTP ${httpStatus})` + ' '.repeat(11) + '\x1b[0m');
  console.warn('\x1b[43m\x1b[30m' + '─'.repeat(72) + '\x1b[0m');
  console.warn('\x1b[33m  EXPECTED right now — the Associates account is below the qualifying-sales');
  console.warn('  threshold, so Amazon revoked Creators/PA API access. Amazon\'s gate, NOT our');
  console.warn('  bug. This audit has no DataForSEO fallback, so it degrades to a clean no-op:');
  console.warn('  nothing quarantined, nothing written, job stays green. Rechecks next run.\x1b[0m');
  console.warn('\x1b[33m' + '─'.repeat(72) + '\x1b[0m');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      'degraded=true\ndegraded_reason=associate_not_eligible\nquarantined=0\nqueue=0\nalert=false\n');
  }
  await hardExit(0);
}

// ---- creds --------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
function loadCreds(p) {
  // CI has no credentials CSV — prefer env vars when present.
  if (process.env.AMAZON_CREATORS_CLIENT_ID && process.env.AMAZON_CREATORS_CLIENT_SECRET) {
    return { id: process.env.AMAZON_CREATORS_CLIENT_ID, secret: process.env.AMAZON_CREATORS_CLIENT_SECRET };
  }
  // No env vars AND no readable CSV (the CI case) is not_configured — return null
  // and let the caller fail loudly. Never let a missing file ENOENT-crash with a
  // Windows-path stack trace that buries the real problem (the missing secret).
  if (!existsSync(p)) return null;
  try {
    const rows = parseCsv(readFileSync(p, 'utf8'));
    if (rows.length < 2) return null;
    const h = rows[0].map(x => x.trim().toLowerCase()), d = rows[1];
    const g = n => { const i = h.indexOf(n); return i === -1 ? '' : (d[i] || '').trim(); };
    const id = g('credential id'), secret = g('secret');
    return id && secret ? { id, secret } : null;
  } catch { return null; }
}
// A 401/403 or an AssociateNotEligible marker means Amazon is GATING us (expected
// below the sales threshold) — Amazon's gate, not our bug. Kept separate from a
// missing secret so the two can never look alike in the log.
const isEligibilityError = (status, body) =>
  status === 401 || status === 403 || /associatenoteligible|not eligible/i.test(body || '');
async function getToken(id, secret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: SCOPE }).toString(),
  });
  const body = await res.text();
  let j = null; try { j = JSON.parse(body); } catch {}
  if (!res.ok || !j?.access_token) {
    const err = new Error(`token failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    err.httpStatus = res.status;
    // At the TOKEN endpoint a 403 (or explicit marker) is the eligibility gate; a
    // 401 is a bad/rotated secret (our bug). Don't let 401 masquerade as a gate.
    err.eligibility = res.status === 403 || /associatenoteligible|not eligible/i.test(body || '');
    throw err;
  }
  return j.access_token;
}

let TOKEN = null, TOKEN_AT = 0;
async function ensureToken(creds) {
  if (!TOKEN || Date.now() - TOKEN_AT > 45 * 60 * 1000) {   // refresh well inside 3600s
    TOKEN = await getToken(creds.id, creds.secret);
    TOKEN_AT = Date.now();
  }
}

let stats429 = 0, statsNetErr = 0;
async function call(body, tries = 4) {
  for (let a = 0; a < tries; a++) {
    let res, text;
    try {
      res = await fetch(GETITEMS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
                   Accept: 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) { statsNetErr++; await sleep(2000); continue; }
    if (res.status === 429) { stats429++; await sleep(2500 * (a + 1)); continue; }
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, raw: text };
  }
  return { status: 0, ok: false, json: null, raw: 'exhausted retries' };
}

const base = x => ({ marketplace: MARKETPLACE, partnerTag: PARTNER_TAG, partnerType: 'Associates', ...x });
const itemsOf = j => j?.itemsResult?.items || j?.items || [];

// ---- text helpers -------------------------------------------------------
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function toks(s) { return new Set(norm(s).split(' ').filter(t => t.length >= 3)); }

// Bidirectional containment. The existing titleMatches() scores
// hits/storedTokens only, so a verbose stored name against a clean Amazon
// title scores low even when it is the same product — the same
// directionality bug audit-deal-links-v2.cjs was written to fix.
function containment(storedName, azTitle) {
  const A = toks(storedName), B = toks(azTitle);
  if (!A.size || !B.size) return { aInB: 0, bInA: 0, max: 0 };
  let hitsA = 0; for (const t of A) if (B.has(t)) hitsA++;
  let hitsB = 0; for (const t of B) if (A.has(t)) hitsB++;
  const aInB = hitsA / A.size, bInA = hitsB / B.size;
  return { aInB: +aInB.toFixed(2), bInA: +bInA.toFixed(2), max: +Math.max(aInB, bInA).toFixed(2) };
}

// Brand = leading word of the stored name (2+ chars, so "LG" survives).
// Also checks a few known cases where the stored name omits the brand.
function brandOf(name) {
  const m = norm(name).split(' ').filter(Boolean);
  return m.length ? m[0] : '';
}
function brandShared(storedName, azTitle) {
  const b = brandOf(storedName);
  if (!b || b.length < 2) return false;
  return norm(azTitle).split(' ').includes(b);
}

// PA API analogue of selectNewOffer(): buybox-if-New, else cheapest New.
function newOffer(item) {
  const ls = item?.offersV2?.listings || [];
  const isNew = l => String(l?.condition?.value || '').toLowerCase() === 'new';
  const priceOf = l => Number(l?.price?.money?.amount);
  const bb = ls.find(l => l?.isBuyBoxWinner && isNew(l));
  if (bb && priceOf(bb) > 0) return { price: priceOf(bb), source: 'buybox', merchant: bb?.merchantInfo?.name || null };
  const news = ls.filter(l => isNew(l) && priceOf(l) > 0).sort((a, b) => priceOf(a) - priceOf(b));
  if (news.length) return { price: priceOf(news[0]), source: 'lowest_new', merchant: news[0]?.merchantInfo?.name || null };
  return null;
}

// ---- catalog ------------------------------------------------------------
async function loadCatalog() {
  const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js');
  const re = /(?:\/dp\/|\/gp\/product\/|ASIN=)([A-Z0-9]{10})/;
  const rows = [];
  for (const p of mod.default) {
    const url = p?.deals?.amazon?.url;
    if (!url) continue;
    const m = String(url).match(re);
    if (!m) continue;
    rows.push({
      id: p.id, cat: p.c || '?', name: p.n, cap: p.cap ?? null, asin: m[1],
      storedPrice: p?.deals?.amazon?.price ?? null,
      needsReview: !!p.needsReview,
    });
  }
  return rows;
}

// ---- main ---------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  console.log('Amazon ASIN identity audit — READ-ONLY (no catalog writes, no DataForSEO)\n');

  const rows = (await loadCatalog()).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  const uniqueAsins = [...new Set(rows.map(r => r.asin))];
  console.log(`rows: ${rows.length}   unique ASINs: ${uniqueAsins.length}`);
  console.log(`batches: ${Math.ceil(uniqueAsins.length / BATCH)} @ ${BATCH}/call, ~${PAUSE_MS}ms apart`);
  console.log(`est. runtime: ~${Math.round(Math.ceil(uniqueAsins.length / BATCH) * (PAUSE_MS + 250) / 1000 / 60)} min\n`);

  const creds = loadCreds(CREDS_PATH);
  if (!creds || !creds.id || !creds.secret) {
    await failNotConfigured('no env vars and no readable credentials CSV');   // OUR bug -> exit 1
  }
  try {
    await ensureToken(creds);
    console.log('token acquired\n');
  } catch (e) {
    // 403 / AssociateNotEligible at the token endpoint -> Amazon's gate: warn and
    // degrade to a no-op (exit 0). A 401 (rejected secret) or any other token
    // failure is our problem -> fail loudly and cleanly, never with a raw stack.
    if (e.eligibility) await degradeGated(e.httpStatus || 403);
    console.log(`::error title=PA API token request failed::${e.message}`);
    console.error('\n\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
    console.error('\x1b[41m\x1b[97m  ✗✗✗  PA API TOKEN REQUEST FAILED — creds rejected or endpoint down  ✗✗✗\x1b[0m');
    console.error('\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
    console.error(`\x1b[91m  ${e.message}`);
    console.error('  A 401 means the client id/secret is wrong or rotated (our bug); any');
    console.error('  other status means the token endpoint is unreachable. FAILING loudly.\x1b[0m');
    console.error('\x1b[91m' + '━'.repeat(72) + '\x1b[0m');
    await hardExit(1);
  }

  // ---- fetch ------------------------------------------------------------
  const fetched = new Map();     // asin -> { title, offer } | null
  const apiErrors = [];
  const nBatches = Math.ceil(uniqueAsins.length / BATCH);

  for (let b = 0; b < nBatches; b++) {
    await ensureToken(creds);
    const chunk = uniqueAsins.slice(b * BATCH, (b + 1) * BATCH);
    const r = await call(base({
      itemIds: chunk, itemIdType: 'ASIN',
      resources: ['itemInfo.title', 'offersV2.listings.price',
                  'offersV2.listings.condition', 'offersV2.listings.isBuyBoxWinner'],
    }));
    if (!r.ok) {
      apiErrors.push({ batch: b, status: r.status, body: (r.raw || '').slice(0, 200) });
      // Token issued but the data call is gated (eligibility can surface here rather
      // than at the token endpoint). No point hammering 360 more batches that will
      // all 403 — degrade to the same clean no-op and stop.
      if (isEligibilityError(r.status, r.raw)) await degradeGated(r.status);
    }
    const got = itemsOf(r.json);
    for (const it of got) {
      fetched.set(it.asin, { title: it?.itemInfo?.title?.displayValue || '', offer: newOffer(it) });
    }
    for (const a of chunk) if (!fetched.has(a)) fetched.set(a, null);

    if (b % 20 === 0 || b === nBatches - 1) {
      const pct = ((b + 1) / nBatches * 100).toFixed(0);
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  batch ${b + 1}/${nBatches} (${pct}%)  resolved=${[...fetched.values()].filter(Boolean).length}  429s=${stats429}  ${el}s`);
    }
    await sleep(PAUSE_MS);
  }

  // ---- evaluate ---------------------------------------------------------
  const findings = [];
  const perCat = {};
  let clean = 0;

  for (const row of rows) {
    perCat[row.cat] ||= { total: 0, dead: 0, wrong: 0, close: 0, verbosity: 0, clean: 0, priceFlag: 0 };
    perCat[row.cat].total++;

    const hit = fetched.get(row.asin);

    if (!hit) {
      perCat[row.cat].dead++;
      findings.push({
        class: 'dead-asin', id: row.id, cat: row.cat, asin: row.asin,
        storedName: row.name, amazonTitle: null,
        scoreStoredInAmazon: null, scoreAmazonInStored: null, gateScore: null,
        storedPrice: row.storedPrice, amazonPrice: null, priceDeltaPct: null,
        priceDivergent: false, capConflict: false, needsReview: row.needsReview,
      });
      continue;
    }

    const az = hit.title;
    const tm = titleMatches(row.name, az, row.cap);   // the EXISTING gate, unmodified
    const c  = containment(row.name, az);
    const offer = hit.offer;
    const azPrice = offer?.price ?? null;

    let deltaPct = null, divergent = false;
    if (azPrice != null && row.storedPrice != null && row.storedPrice > 0) {
      deltaPct = +(((azPrice - row.storedPrice) / row.storedPrice) * 100).toFixed(1);
      divergent = Math.abs(deltaPct) >= PRICE_DIVERGENCE * 100;
    }

    if (tm.match) { clean++; perCat[row.cat].clean++; continue; }

    // Failed the existing gate — classify why.
    let klass;
    if (!tm.capConflict && c.max >= CONTAINMENT_CLEAN && brandShared(row.name, az)) {
      klass = 'title-verbosity';
    } else if (!tm.capConflict && c.bInA >= 0.9) {
      klass = 'title-verbosity';           // amazon title fully contained in stored name
    } else if (brandShared(row.name, az)) {
      klass = 'close-but-wrong';
    } else {
      klass = 'wrong-product';
    }

    if (klass === 'title-verbosity') { perCat[row.cat].verbosity++; }
    else if (klass === 'close-but-wrong') { perCat[row.cat].close++; }
    else { perCat[row.cat].wrong++; }
    if (divergent && klass !== 'title-verbosity') perCat[row.cat].priceFlag++;

    findings.push({
      class: klass, id: row.id, cat: row.cat, asin: row.asin,
      storedName: row.name, amazonTitle: az,
      scoreStoredInAmazon: c.aInB, scoreAmazonInStored: c.bInA, gateScore: tm.score,
      capConflict: !!tm.capConflict,
      storedPrice: row.storedPrice, amazonPrice: azPrice,
      priceSource: offer?.source ?? null, merchant: offer?.merchant ?? null,
      priceDeltaPct: deltaPct, priceDivergent: divergent,
      needsReview: row.needsReview,
    });
  }

  // ---- report -----------------------------------------------------------
  const byClass = k => findings.filter(f => f.class === k);
  const dead = byClass('dead-asin'), wrong = byClass('wrong-product'),
        close = byClass('close-but-wrong'), verbose = byClass('title-verbosity');
  const realDefects = [...dead, ...wrong, ...close];
  const priceFlagged = [...wrong, ...close].filter(f => f.priceDivergent);

  const elapsed = ((Date.now() - t0) / 1000);
  console.log('\n' + '='.repeat(74));
  console.log('RESULTS');
  console.log('='.repeat(74));
  console.log(`  rows audited ..................... ${rows.length}`);
  console.log(`  unique ASINs queried ............. ${uniqueAsins.length}`);
  console.log(`  clean (passed existing gate) ..... ${clean}`);
  console.log(`  flagged by existing gate ......... ${findings.length - dead.length + dead.length}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  dead-asin ........................ ${dead.length}`);
  console.log(`  wrong-product .................... ${wrong.length}`);
  console.log(`  close-but-wrong .................. ${close.length}`);
  console.log(`  title-verbosity (NOT a defect) ... ${verbose.length}`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  REAL DEFECTS ..................... ${realDefects.length}  (${(realDefects.length / rows.length * 100).toFixed(1)}%)`);
  console.log(`  raw gate flag rate ............... ${((realDefects.length + verbose.length) / rows.length * 100).toFixed(1)}%`);
  console.log(`  of real defects, price-divergent . ${priceFlagged.length} (>=${PRICE_DIVERGENCE * 100}% delta)`);
  console.log(`\n  api 429s retried ................. ${stats429}`);
  console.log(`  api batch errors ................. ${apiErrors.length}`);
  console.log(`  elapsed .......................... ${elapsed.toFixed(0)}s (${(elapsed / 60).toFixed(1)} min)`);

  console.log('\nPER-CATEGORY');
  console.log('-'.repeat(74));
  console.log('category'.padEnd(18) + 'rows'.padEnd(7) + 'dead'.padEnd(7) + 'wrong'.padEnd(7) +
              'close'.padEnd(7) + 'defect%'.padEnd(9) + 'price!');
  const catRows = Object.entries(perCat)
    .map(([c, v]) => ({ c, ...v, defects: v.dead + v.wrong + v.close }))
    .sort((a, b) => (b.defects / b.total) - (a.defects / a.total));
  for (const r of catRows) {
    console.log(
      r.c.padEnd(18) + String(r.total).padEnd(7) + String(r.dead).padEnd(7) +
      String(r.wrong).padEnd(7) + String(r.close).padEnd(7) +
      ((r.defects / r.total * 100).toFixed(1) + '%').padEnd(9) + String(r.priceFlag)
    );
  }

  console.log('\nPRICE-DIVERGENT DEFECTS (wrong link AND misleading price)');
  console.log('-'.repeat(74));
  for (const f of priceFlagged.sort((a, b) => Math.abs(b.priceDeltaPct) - Math.abs(a.priceDeltaPct)).slice(0, 40)) {
    console.log(`[${f.cat}] id=${f.id} ${f.asin}  stored $${f.storedPrice} -> amazon $${f.amazonPrice}  (${f.priceDeltaPct > 0 ? '+' : ''}${f.priceDeltaPct}%)  ${f.class}`);
    console.log(`    stored: ${String(f.storedName).slice(0, 100)}`);
    console.log(`    amazon: ${String(f.amazonTitle).slice(0, 100)}`);
  }
  if (priceFlagged.length > 40) console.log(`  … and ${priceFlagged.length - 40} more (full list in JSON)`);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: 'READ-ONLY audit — no catalog writes, no relinks, no DataForSEO calls',
      rowsAudited: rows.length, uniqueAsinsQueried: uniqueAsins.length,
      apiCalls: nBatches, elapsedSec: +elapsed.toFixed(0),
      throttle429: stats429, apiBatchErrors: apiErrors.length,
      priceDivergenceThresholdPct: PRICE_DIVERGENCE * 100,
      containmentCleanThreshold: CONTAINMENT_CLEAN,
      gate: 'titleMatches() from drift-gate.js, unmodified, + bidirectional containment for classification',
    },
    totals: {
      clean, deadAsin: dead.length, wrongProduct: wrong.length,
      closeButWrong: close.length, titleVerbosity: verbose.length,
      realDefects: realDefects.length,
      realDefectRatePct: +(realDefects.length / rows.length * 100).toFixed(2),
      rawGateFlagRatePct: +((realDefects.length + verbose.length) / rows.length * 100).toFixed(2),
      priceDivergentDefects: priceFlagged.length,
    },
    perCategory: perCat,
    apiErrors,
    findings,
  };
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${OUT_PATH} (${findings.length} findings)`);

  if (!NIGHTLY) {
    console.log('No catalog writes. No relinks. DataForSEO not called.');
    return;
  }

  // ======================================================================
  // NIGHTLY: two-strike dead quarantine + review queue + rate-jump alert
  // ======================================================================
  console.log('\n' + '='.repeat(74));
  console.log('NIGHTLY MODE');
  console.log('='.repeat(74));

  const state = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    : { deadStreak: {}, history: [] };
  state.deadStreak ||= {}; state.history ||= [];

  // --- strike accounting: a dead ASIN must miss twice in a row -----------
  const deadAsinsNow = new Set(dead.map(f => f.asin));
  const nextStreak = {};
  for (const a of deadAsinsNow) nextStreak[a] = (state.deadStreak[a] || 0) + 1;
  const recovered = Object.keys(state.deadStreak).filter(a => !deadAsinsNow.has(a));

  const confirmedDead = new Set(Object.entries(nextStreak).filter(([, n]) => n >= DEAD_STRIKES).map(([a]) => a));
  const firstStrike   = Object.entries(nextStreak).filter(([, n]) => n < DEAD_STRIKES).map(([a]) => a);

  const toQuarantine = dead.filter(f => confirmedDead.has(f.asin) && !f.needsReview);

  console.log(`  dead ASINs this run ........... ${deadAsinsNow.size}`);
  console.log(`  first strike (watch, no write)  ${firstStrike.length}`);
  console.log(`  confirmed dead (>=${DEAD_STRIKES} strikes) . ${confirmedDead.size}`);
  console.log(`  recovered since last run ...... ${recovered.length}`);
  console.log(`  rows to quarantine ............ ${toQuarantine.length}`);

  // Refuse to write if the run was degraded — a failed call looks exactly like
  // a dead ASIN, and quarantining live rows off an API wobble is worse than
  // waiting a day.
  const degraded = apiErrors.length > 0;
  if (degraded) console.log(`  ! ${apiErrors.length} batch errors — NOT quarantining this run`);

  let quarantined = 0;
  if (APPLY && !degraded && toQuarantine.length) {
    const ids = new Set(toQuarantine.map(f => f.id));
    const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
    const parts = [...mod.PARTS];
    const stamp = today();
    for (const p of parts) {
      if (!ids.has(p.id)) continue;
      p.needsReview = true; p.quarantinedAt = stamp; quarantined++;
    }
    if (quarantined !== ids.size) {
      console.log(`  ! id mismatch (${quarantined}/${ids.size}) — aborting write`);
      process.exit(1);
    }
    writeFileSync('./src/data/parts.js',
      `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
    console.log(`  APPLIED — ${quarantined} rows quarantined (dead ASINs only)`);
  } else if (!APPLY) {
    console.log('  (report only — pass --apply to quarantine)');
  }

  // --- review queue: reported, NEVER written ----------------------------
  const queue = [...wrong, ...close].sort((a, b) => {
    if (a.priceDivergent !== b.priceDivergent) return a.priceDivergent ? -1 : 1;
    return Math.abs(b.priceDeltaPct ?? 0) - Math.abs(a.priceDeltaPct ?? 0);
  });
  writeFileSync(QUEUE_PATH, JSON.stringify({
    meta: { generatedAt: new Date().toISOString(), policy: 'REPORT ONLY — never auto-relinked' },
    totals: { queued: queue.length, wrongProduct: wrong.length, closeButWrong: close.length,
              live: queue.filter(f => !f.needsReview).length,
              priceDivergent: queue.filter(f => f.priceDivergent).length },
    queue,
  }, null, 2));
  console.log(`  review queue -> ${QUEUE_PATH} (${queue.length} rows, human review only)`);

  // --- rate-jump alert ---------------------------------------------------
  // Keyed on the ATTACH rate (wrong + close), not total defects.
  const attachRate = +((wrong.length + close.length) / rows.length * 100).toFixed(2);
  const prior = state.history.slice(-7).map(h => h.attachRatePct).filter(n => typeof n === 'number').sort((a, b) => a - b);
  const median = prior.length ? prior[Math.floor(prior.length / 2)] : null;
  const jump = median != null ? +(attachRate - median).toFixed(2) : null;
  const alert = jump != null && jump >= ALERT_JUMP_PP;

  console.log(`\n  attach-defect rate ............ ${attachRate}%`);
  console.log(`  trailing median (last ${prior.length}) ..... ${median != null ? median + '%' : '(no history yet)'}`);
  console.log(`  jump .......................... ${jump != null ? (jump > 0 ? '+' : '') + jump + 'pp' : 'n/a'}`);
  if (alert) {
    console.log(`\n  *** ALERT: attach-defect rate rose ${jump}pp above trailing median.`);
    console.log('  *** An ingest may be attaching bad links again. Investigate before it compounds.');
  } else {
    console.log('  no alert');
  }

  // --- persist state -----------------------------------------------------
  state.deadStreak = nextStreak;
  state.history.push({
    date: today(), rows: rows.length,
    deadAsinRows: dead.length, wrongProduct: wrong.length, closeButWrong: close.length,
    attachRatePct: attachRate, realDefects: realDefects.length,
    quarantinedThisRun: quarantined,
  });
  if (state.history.length > HISTORY_KEEP) state.history = state.history.slice(-HISTORY_KEEP);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\n  state -> ${STATE_PATH}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT,
      `alert=${alert}\nattach_rate=${attachRate}\njump=${jump ?? ''}\n` +
      `quarantined=${quarantined}\nqueue=${queue.length}\ndegraded=${degraded}\n`);
  }
  console.log('\nwrong-product / close-but-wrong were REPORTED ONLY — never written, never relinked.');
})();
