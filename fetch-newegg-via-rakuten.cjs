// =============================================================================
//  fetch-newegg-via-rakuten.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Matches active products in parts.js to Newegg's catalog via Rakuten
//  Product Search. Uses verified cat= filters + exact= phrase search to
//  bypass prebuilt-PC noise. GPUs are skipped (Rakuten Product Search does
//  not include them — those need the SFTP Product Catalog feed).
//
//  Matching strategy (STRICT — accuracy first):
//    1) Look up Rakuten cat= filter for product.c.
//    2) Search with exact= (product name keywords) + cat= filter + mid=44583.
//    3) For each result:
//         - Reject if name contains bundle markers (Custom/Workstation/PC/Combo).
//         - Reject if price > 2.5× our pr (likely a bundle).
//         - Score: UPC match (normalized) = 1.0; else Jaccard name similarity.
//    4) Accept best if UPC match OR name sim >= MIN_ATTACH_SIM (0.70). This is
//       stricter than the 0.5 floor refresh uses for REPRICING: a first attach
//       binds a product to a SKU on name evidence alone, and a weak bind shows
//       a buyer the wrong product. Repricing a settled SKU is safe at 0.5.
//    5) Seller rank: first-party (N82E) always wins; marketplace (9SI) is only
//       ever attached when NO higher-ranked candidate matched, and is labelled
//       sellerClass so the site can badge it.
//    6) Store in deals.newegg = { sku, price, saleprice, linkurl, imageurl,
//                                  sellerClass, matchedAt, matchMethod, matchScore }.
//
//  Resumable: products with existing deals.newegg.sku are skipped on re-run.
//  Rate limited: REQ_PER_SECOND req/sec, under Rakuten's 100/min ceiling,
//  with retry-after-honouring retries so a 429 never becomes a result.
//
//  Usage:
//    railway run node fetch-newegg-via-rakuten.cjs --dry-run
//      Full live scoring pass that writes NOTHING — no parts.js, no progress
//      file, no in-memory attach. Emits newegg-ingest-dry-run.json with every
//      accepted candidate and every variant rejection (both names), so the
//      shared matcher can be eyeballed on the ingest path before a live write.
//    railway run node fetch-newegg-via-rakuten.cjs --limit 50
//    railway run node fetch-newegg-via-rakuten.cjs
//    railway run node fetch-newegg-via-rakuten.cjs --force
//    railway run node fetch-newegg-via-rakuten.cjs --category CPU
// =============================================================================

const fs = require('fs');
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

// Full catalog + its load-time count, captured by loadParts(). saveParts()
// writes ALL_PARTS (not the filtered `active` subset — writing that would drop
// every product ingest wasn't looking at), and the count feeds writeCatalog's
// catastrophic-shrink brake.
let ALL_PARTS = null;
let LOADED_COUNT = 0;

// Newegg matching + capacity guard + first-party preference + sanity gate
// (shared ESM, dynamic-imported at startup). newegg-match.js owns the capacity
// gate internally, so this file no longer needs its own CAP handle.
let NEG = null;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const ONLY_CAT = arg('category', null);

const PARTS_PATH = './src/data/parts.js';
const PROGRESS_PATH = './catalog-build/_newegg-progress.json';
const DRY_REPORT = './newegg-ingest-dry-run.json';

// Rakuten's documented ceiling, straight from the 429 response headers:
//   x-ratelimit-limit-minute: 100   retry-after: 17
// 2/sec was 120/min and sat permanently over it, which is why failures arrived
// in bursts every ~40 products rather than randomly. 1.5/sec is 90/min, leaving
// headroom for the token call and for clock skew against their window.
// 85, not 100: the token call shares the bucket, and their minute boundary is
// not ours. Measured — 90/min via a fixed gap still drew 429s.
const REQ_PER_MINUTE = 85;
const MIN_REQUEST_GAP_MS = 500;
// A 429 must never become a data outcome. Retries honour the server's own
// retry-after, so we wait exactly as long as it asks and no longer. 5 attempts
// because retry-after can be up to a full window and we would rather spend the
// wall clock than record a throttled lookup as a missing product.
const MAX_RETRIES = 5;
const SAVE_EVERY = 25;

const CID = process.env.RAKUTEN_CLIENT_ID;
const SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const MID = process.env.RAKUTEN_NEWEGG_MID;
if (!CID || !SECRET || !SID || !MID) {
  console.error('  ✗ Missing Rakuten env vars'); process.exit(1);
}

// Verified Newegg category filters (from earlier discovery tests).
const CAT_FILTER = {
  CPU:         'Processors',
  Motherboard: 'Motherboards',
  RAM:         'Memory',
  Storage:     'Storage Devices',
  PSU:         'Power Supplies',
  Case:        'Desktop Computer & Server Cases',
  CPUCooler:   'Computer System Cooling Parts',
  CaseFan:     'Computer System Cooling Parts',
  Monitor:     'Monitors',
  // GPU intentionally omitted — awaiting SFTP feed.
};

let cachedToken = null;
let tokenExpiresAt = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const basic = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', scope: SID }).toString(),
  });
  if (!res.ok) throw new Error(`Token HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    items.push({
      name: decodeEntities(xmlField(b, 'productname') || ''),
      sku: xmlField(b, 'sku') || '',
      upc: xmlField(b, 'upccode') || '',
      price: parseFloat(xmlField(b, 'price')) || null,
      saleprice: (() => { const v = parseFloat(xmlField(b, 'saleprice')); return v > 0 ? v : null; })(),
      linkurl: decodeEntities(xmlField(b, 'linkurl') || ''),
      imageurl: decodeEntities(xmlField(b, 'imageurl') || ''),
      secondary: decodeEntities(xmlField(b, 'secondary') || ''),
    });
  }
  return items;
}

// Scoring lives in newegg-match.js (NEG.scoreMatch / NEG.extractKeywords).
//
// This file used to carry a verbatim COPY of scoreMatch + nameSimilarity +
// extractKeywords. The copy is why the variant-collapse guard, added to
// newegg-match.js, protected the refresh path but not this one — ingest is
// where the wrong-product deals entered the catalog in the first place.
// Do not re-fork: one matcher, one place, both paths.

// ── Global request throttle ──────────────────────────────────────────────────
//
// The delay used to live in the product loop, which was correct only while a
// product cost exactly two requests. The query cascade made a product cost up
// to six, fired back-to-back with no spacing, and Rakuten throttled them. The
// failures were then swallowed by `if (!res.ok) continue`, so a rate-limited
// product was indistinguishable from a product Newegg does not carry: the
// 2026-07-20 dry run lost 166 attachments that way, ALL of which came back on a
// throttled retry.
//
// The limiter therefore has to sit at the REQUEST, not at the product. Anything
// that counts requests per second has to be enforced where requests are made.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ROLLING WINDOW, not a fixed gap.
//
// A fixed inter-request gap paces the average but not the WINDOW. Rakuten
// enforces a fixed per-minute bucket (x-ratelimit-limit-minute: 100), so a
// steady 90/min still overshoots whenever our requests straddle their minute
// boundary — which is why pacing alone left 13 lookups failed and 20 429s in a
// 260-product validation. Tracking the actual timestamps and waiting for the
// oldest to age out is the only thing that respects a bucket we cannot see.
const REQ_WINDOW_MS = 60_000;
const requestTimes = [];
async function throttle() {
  for (;;) {
    const cutoff = Date.now() - REQ_WINDOW_MS;
    while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
    if (requestTimes.length < REQ_PER_MINUTE) break;
    // +250ms so we resume just after the oldest leaves the window, never on the
    // boundary where their clock and ours can disagree.
    await sleep(requestTimes[0] + REQ_WINDOW_MS - Date.now() + 250);
  }
  // Keep a floor on spacing too, so a fresh window is not spent in one burst.
  const last = requestTimes[requestTimes.length - 1];
  const gap = last ? last + MIN_REQUEST_GAP_MS - Date.now() : 0;
  if (gap > 0) await sleep(gap);
  requestTimes.push(Date.now());
}

// Pacing alone is not enough: their minute-window and ours drift, so an
// occasional 429 is expected however conservative the rate. Retrying on the
// server's own retry-after is what keeps throttling out of the RESULTS —
// without it, a 429 silently becomes 'this product does not exist', which is
// exactly how the previous run lost 166 attachments.
// Returns { res, httpFail } — httpFail true when every attempt failed.
let rateLimitHits = 0;
async function fetchSearch(url, token) {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res = null;
    try {
      res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    } catch {
      if (attempt >= MAX_RETRIES) return { res: null, httpFail: true };
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) {
      rateLimitHits++;
      if (attempt >= MAX_RETRIES) return { res, httpFail: true };
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      await sleep((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt >= MAX_RETRIES) return { res, httpFail: true };
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return { res, httpFail: false };
  }
}

async function findNeweggMatch(product, token) {
  const catFilter = CAT_FILTER[product.c];
  if (!catFilter) return { ok: false, reason: 'no_cat_mapping' };
  // Query CASCADE. The legacy full-title pair (exact, then keyword) runs FIRST
  // and unchanged; the broadening rungs are reached only when it finds nothing.
  // See buildQueries() in newegg-match.js for the measurements.
  const queries = NEG.buildQueries(product.n, product.b,
    { broaden: !NEG.NO_BROADEN_CATS.has(product.c) })
    .map((q) => ({ [q.mode]: q.q, cat: catFilter, mid: MID, max: '20' }));

  let items = [];
  let httpErrors = 0;
  let queriesTried = 0;
  for (const params of queries) {
    const url = `https://api.linksynergy.com/productsearch/1.0?${new URLSearchParams(params)}`;
    queriesTried++;
    const { res, httpFail } = await fetchSearch(url, token);
    if (httpFail) { httpErrors++; continue; } // exhausted retries — never an absence
    const xml = await res.text();
    items = parseItems(xml);
    if (items.length > 0) break;
  }
  // A FAILED LOOKUP IS NOT AN ABSENCE. searchNewegg() has drawn this distinction
  // since the 2026-07-06 incident that deleted 1,655 deals; findNeweggMatch
  // never did, and swallowed every non-200 into 'no_results'. That is precisely
  // how rate limiting masqueraded as 166 products disappearing from the feed.
  if (items.length === 0 && httpErrors > 0 && httpErrors === queriesTried) {
    return { ok: false, reason: 'http_error', rawCount: 0, scores: [], variantRejects: [], httpErrors };
  }
  if (items.length === 0) {
    return { ok: false, reason: 'no_results', rawCount: 0, scores: [], variantRejects: [], httpErrors };
  }

  // Capture WHY each candidate lost, not just that it did. The dry run reports
  // this verbatim; without it a variant rejection is indistinguishable from
  // "the feed had nothing", which is the ambiguity that hid the bad matches.
  // Kept separate from variantRejects on purpose. Both are "rejected candidate",
  // but conflating them would make the attach-floor raise read as the variant
  // guard suddenly over-reaching — and the whole point of a dry run is that a
  // number moves for exactly one identifiable reason.
  const floorRejects = [];
  const variantRejects = [];
  // Guard rejects (capacity, price multiplier, prebuilt/bundle) used to be
  // invisible: scoreMatch returned null without a note, so a product whose
  // every candidate was thrown out by the CAPACITY GATE reported no_match —
  // the same code as "the feed had nothing". Broken out so the number is
  // reviewable, and so a capacity gate that starts over-rejecting is legible
  // as itself rather than as a mysterious rise in no_match.
  const guardRejects = [];
  const scored = [];
  for (const it of items) {
    const notes = {};
    // Ingest is a FIRST ATTACH, so it uses the stricter MIN_ATTACH_SIM floor
    // rather than the repricing floor. See newegg-match.js for why the two
    // differ: binding a new link on weak name evidence shows a buyer the wrong
    // product, while repricing a settled SKU at a low score is routine.
    const match = NEG.scoreMatch(product, it, notes, { minSim: NEG.MIN_ATTACH_SIM });
    if (match) { scored.push({ item: it, match }); continue; }
    const kind = NEG.rejectKind(notes.reject);
    if (kind === 'floor') {
      floorRejects.push({
        candidateName: it.name, sku: it.sku,
        sim: Number(NEG.nameSimilarity(product.n, it.name).toFixed(3)),
      });
    } else if (kind === 'variant') {
      variantRejects.push({ candidateName: it.name, sku: it.sku, reason: notes.reject });
    } else if (kind === 'guard') {
      guardRejects.push({ candidateName: it.name, sku: it.sku, reason: notes.reject });
    }
  }
  const detail = {
    rawCount: items.length,
    variantRejects,
    floorRejects,
    guardRejects,
    scores: scored.map((x) => ({
      candidateName: x.item.name, sku: x.item.sku,
      sellerClass: NEG.sellerClass(x.item.sku),
      method: x.match.method, score: Number(x.match.score.toFixed(3)),
    })),
  };

  if (scored.length === 0) {
    const reason = variantRejects.length ? 'variant_rejected'
      : floorRejects.length ? 'below_attach_floor'
      : guardRejects.length ? 'guard_rejected'
      : 'no_match';
    return { ok: false, reason, ...detail };
  }
  // First-party (N82E) preference — never let a marketplace (9SI) listing win when a
  // Newegg-Official listing also matched. Price-independent (see newegg-match.js).
  const best = NEG.selectWithFirstPartyPreference(scored);
  const firstPartyAvailable = scored.some((x) => NEG.isFirstParty(x.item.sku));

  // Seller-rank guard. Ingest must never CREATE a marketplace attachment when a
  // first-party candidate was available — selection above already prefers
  // first-party, so reaching this is a bug in selection rather than a normal
  // outcome. Assert it at the attach boundary anyway: this is the invariant the
  // catalog depends on, and it should not be enforced only as a side effect of
  // how selectWithFirstPartyPreference happens to sort.
  if (firstPartyAvailable && NEG.isMarketplace(best.item.sku)) {
    return { ok: false, reason: 'marketplace_over_firstparty', ...detail };
  }
  return {
    ok: true, item: best.item, method: best.match.method, score: best.match.score,
    firstPartyAvailable, ...detail,
  };
}

// parts.js is no longer a literal array. scripts/split-parts-by-cat.cjs now
// generates it as a BARREL of per-category chunk imports:
//
//   import _4 from './parts/cpu.js';  ...
//   export const PARTS = [..._4, ..._17, ...];
//
// The old loader regex-matched that bracket expression and eval'd it with
// `new Function`, where _4 and friends do not exist — so ingest died at
// startup with "ReferenceError: _4 is not defined" on every invocation, live
// or dry. Import the module and let ESM resolve the chunks, exactly as
// refresh-newegg-prices.cjs already does.
async function loadParts() {
  const url = 'file://' + path.resolve(PARTS_PATH).replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) throw new Error(`PARTS is not an array in ${PARTS_PATH}`);
  ALL_PARTS = parts;
  LOADED_COUNT = parts.length;
  return { parts };
}

// The write path used to be blocked outright: ingest replaced the whole
// `export const PARTS = [...]` barrel with a JSON literal and stopped there,
// orphaning all 30 chunk imports. The fix is not a bespoke per-chunk writer —
// it is routing through scripts/write-catalog.cjs, which writes the literal and
// then regenerates the chunks in the same call, so the two can never diverge.
// See that file's header for why the literal itself was never the problem.
async function saveParts() {
  const res = await writeCatalog(ALL_PARTS, {
    loadedCount: LOADED_COUNT,
    reason: 'newegg ingest',
  });
  return res.backup;
}
function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return { matched: 0, no_match: 0, errors: 0, processedIds: [] };
  return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
}
function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

// Initialise the shared matcher (newegg-match.js) exactly once. Exported so
// external callers (e.g. the scoped bucket-A relink driver) can reuse
// findNeweggMatch/getToken without triggering this file's own ingest run.
async function initNEG() {
  if (!NEG) NEG = await import('file://' + process.cwd().replace(/\\/g, '/') + '/newegg-match.js');
  return NEG;
}

async function main() {
  console.log('\n  Newegg Catalog Match via Rakuten Product Search');
  console.log('  ═══════════════════════════════════════════════');

  await initNEG();

  // Fail before spending a single API call if this run could not write anyway.

  const { parts } = await loadParts();
  let active = parts.filter((p) => !p.needsReview && !p.bundle && p.n && CAT_FILTER[p.c]);
  if (ONLY_CAT) {
    if (!CAT_FILTER[ONLY_CAT]) {
      console.error(`  ✗ No cat mapping for "${ONLY_CAT}". Available: ${Object.keys(CAT_FILTER).join(', ')}`);
      process.exit(1);
    }
    active = active.filter((p) => p.c === ONLY_CAT);
  }

  console.log(`  Eligible (excluding GPUs): ${active.length}`);

  const progress = loadProgress();
  const processed = new Set(progress.processedIds);
  let candidates = active.filter((p) => {
    if (FORCE) return true;
    if (p?.deals?.newegg?.sku) return false;
    if (processed.has(p.id)) return false;
    return true;
  });

  if (LIMIT) candidates = candidates.slice(0, LIMIT);
  console.log(`  To process this run: ${candidates.length}`);
  if (FORCE) console.log('  (--force)');
  if (LIMIT) console.log(`  (--limit ${LIMIT})`);
  if (ONLY_CAT) console.log(`  (--category ${ONLY_CAT})`);
  console.log('');

  if (candidates.length === 0) { console.log('  Nothing to do.\n'); return; }

  // --dry-run used to return HERE, before getToken(), so it never scored a
  // single candidate and could not exercise the shared matcher at all — the
  // one path that most needed proving, since ingest is how bad matches enter
  // the catalog. It now runs the full live scoring pass and writes NOTHING:
  // no parts.js, no progress file, no in-memory mutation of p.deals/needsReview.
  if (DRY_RUN) {
    console.log('  --dry-run: scoring live responses, writing nothing.\n');
  }

  let matched = 0, noMatch = 0, errors = 0, flagged = 0;
  // Dry-run report accumulators.
  const dryStats = { scored: 0, accepted: 0, flagged: 0, variantRejected: 0, floorRejected: 0, guardRejected: 0, guardByCode: {}, marketplaceBlocked: 0, noMatch: 0, noResults: 0, httpErrors: 0, errors: 0 };
  const dryAccepts = [];
  const dryRejects = [];
  const dryFloorRejects = [];
  const dryGuardRejects = [];
  await getToken();
  console.log('  ✓ Token acquired\n');

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const tick = `[${(i + 1).toString().padStart(4)}/${candidates.length}]`;
    const cat = `[${p.c.slice(0, 4).padEnd(4)}]`;
    process.stdout.write(`  ${tick} ${cat} id ${String(p.id).padEnd(6)} ${p.n.slice(0, 45).padEnd(45)} `);

    try {
      const token = await getToken();
      const result = await findNeweggMatch(p, token);

      if (DRY_RUN) {
        dryStats.scored += result.scores ? result.scores.length : 0;
        dryStats.variantRejected += result.variantRejects ? result.variantRejects.length : 0;
        dryStats.floorRejected += result.floorRejects ? result.floorRejects.length : 0;
        if (result.floorRejects && result.floorRejects.length) {
          dryFloorRejects.push({ id: p.id, cat: p.c, ourName: p.n, rejected: result.floorRejects });
        }
        if (result.guardRejects && result.guardRejects.length) {
          dryStats.guardRejected += result.guardRejects.length;
          // Per-code so "the capacity gate rejected N" is answerable directly,
          // rather than being averaged in with the price and bundle gates.
          for (const g of result.guardRejects) {
            dryStats.guardByCode[g.reason] = (dryStats.guardByCode[g.reason] || 0) + 1;
          }
          dryGuardRejects.push({
            id: p.id, cat: p.c, ourName: p.n,
            rejected: result.guardRejects,
            survivors: result.scores ? result.scores.length : 0,
          });
        }
        if (result.reason === 'marketplace_over_firstparty') dryStats.marketplaceBlocked++;
        if (result.variantRejects && result.variantRejects.length) {
          dryRejects.push({
            id: p.id, cat: p.c, ourName: p.n,
            rejected: result.variantRejects,
            // Whether anything survived matters: a product with rejects AND an
            // accepted candidate is the guard working; rejects with nothing left
            // is the guard possibly over-reaching.
            survivors: result.scores ? result.scores.length : 0,
          });
        }
      }

      if (result.ok) {
        const sClass = NEG.sellerClass(result.item.sku);
        const effPrice = (result.item.saleprice && result.item.saleprice > 0)
          ? result.item.saleprice : result.item.price;
        const sanity = NEG.neweggSanity(p, effPrice);

        if (DRY_RUN) {
          if (sanity.pass) { dryStats.accepted++; } else { dryStats.flagged++; }
          dryAccepts.push({
            id: p.id, cat: p.c, ourName: p.n,
            candidateName: result.item.name, sku: result.item.sku, sellerClass: sClass,
            method: result.method, score: Number(result.score.toFixed(3)),
            price: effPrice, wouldAttach: sanity.pass, sanityClass: sanity.cls,
            firstPartyAvailable: result.firstPartyAvailable,
          });
          const tag = result.method === 'upc' ? '✓ UPC' : `~ ${(result.score * 100).toFixed(0)}%`;
          console.log(`${sanity.pass ? tag : '⚠ flag ' + sanity.cls}  $${effPrice} [${sClass}] (dry)`);
          // No per-product sleep: throttle() now paces every request individually,
    // which is the only place a per-second budget can actually be enforced.
    // Sleeping here as well would just idle between products that already
    // waited.
          continue;
        }

        if (!sanity.pass) {
          // Chosen price is a wild outlier vs the product's other retailers — do not
          // attach; flag for review (mirrors the Amazon attach gate). The first-party
          // selection still happened; only the WRITE is withheld.
          flagged++;
          p.needsReview = true;
          p.quarantinedAt = new Date().toISOString().slice(0, 10);
          console.log(`⚠ flag ${sanity.cls}${sanity.dispConflict ? ` ${sanity.spread.toFixed(2)}x` : ''} (${sClass})`);
        } else {
          p.deals = p.deals || {};
          p.deals.newegg = {
            sku: result.item.sku,
            price: result.item.price,
            saleprice: result.item.saleprice,
            linkurl: result.item.linkurl,
            imageurl: result.item.imageurl,
            sellerClass: sClass,
            matchedAt: new Date().toISOString().slice(0, 10),
            matchMethod: result.method,
            matchScore: Number(result.score.toFixed(2)),
          };
          matched++;
          const tag = result.method === 'upc' ? '✓ UPC' : `~ ${(result.score * 100).toFixed(0)}%`;
          const priceStr = result.item.saleprice ? `$${result.item.saleprice}` : `$${result.item.price}`;
          console.log(`${tag}  ${priceStr} [${sClass}]`);
        }
      } else {
        noMatch++;
        if (DRY_RUN) {
          // Only genuinely-unexplained outcomes may land in noMatch. Every
          // reason with its own tally is subtracted explicitly, so noMatch
          // stays a residual we can read rather than a bucket that silently
          // absorbs whatever gate we add next.
          if (result.reason === 'variant_rejected'
            || result.reason === 'guard_rejected'
            || result.reason === 'below_attach_floor') { /* counted above */ }
          else if (result.reason === 'no_results') dryStats.noResults++;
          // Lookup FAILURE, tracked apart from absence. A non-zero number here
          // invalidates the run's no_results figure — it means some products
          // were never actually asked about.
          else if (result.reason === 'http_error') dryStats.httpErrors++;
          else dryStats.noMatch++;
        } else {
          progress.processedIds.push(p.id);
        }
        console.log(`✗ ${result.reason}`);
      }
    } catch (e) {
      errors++;
      dryStats.errors++;
      console.log(`! ${e.message.slice(0, 50)}`);
    }

    if (!DRY_RUN && (i + 1) % SAVE_EVERY === 0) {
      saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
      await saveParts();
      console.log(`  ── checkpoint: ${matched} matched, ${noMatch} no-match, ${errors} errors ──`);
    }

    // No per-product sleep: throttle() now paces every request individually,
    // which is the only place a per-second budget can actually be enforced.
    // Sleeping here as well would just idle between products that already
    // waited.
  }

  if (DRY_RUN) {
    const report = {
      timestamp: new Date().toISOString(),
      dryRun: true,
      wroteParts: false,
      wroteProgress: false,
      processed: candidates.length,
      ...dryStats,
      accepts: dryAccepts,
      variantRejections: dryRejects,
      floorRejections: dryFloorRejects,
      guardRejections: dryGuardRejects,
    };
    fs.writeFileSync(DRY_REPORT, JSON.stringify(report, null, 2));

    console.log('\n  ═══ DRY RUN — NOTHING WRITTEN ═══');
    console.log(`  Products probed:     ${candidates.length}`);
    console.log(`  Candidates scored:   ${dryStats.scored}  (passed every gate)`);
    console.log(`  Would attach:        ${dryStats.accepted}`);
    console.log(`  Would flag (sanity): ${dryStats.flagged}  (not attached)`);
    console.log(`  Variant-rejected:    ${dryStats.variantRejected}  (candidates, across ${dryRejects.length} products)`);
    console.log(`  Below attach floor:  ${dryStats.floorRejected}  (candidates >=0.5 but <${NEG.MIN_ATTACH_SIM}, across ${dryFloorRejects.length} products)`);
    console.log(`  Guard-rejected:      ${dryStats.guardRejected}  (candidates, across ${dryGuardRejects.length} products)`);
    for (const [code, n] of Object.entries(dryStats.guardByCode).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${code.replace(/^guard_/, '').padEnd(26)} ${n}`);
    }
    console.log(`  Marketplace blocked: ${dryStats.marketplaceBlocked}  (first-party existed)`);
    console.log(`  No match:            ${dryStats.noMatch}  (residual — no gate claimed it)`);
    console.log(`  No results:          ${dryStats.noResults}`);
    console.log(`  HTTP-failed lookups: ${dryStats.httpErrors}  ${dryStats.httpErrors ? '<-- RUN IS NOT CLEAN: these were never asked' : ''}`);
    console.log(`  429s absorbed:       ${rateLimitHits}  (retried, did not affect results)`);
    console.log(`  Errors:              ${dryStats.errors}`);
    console.log(`  Report:              ${DRY_REPORT}\n`);
    return;
  }

  saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
  const backup = await saveParts();

  console.log('\n  ═══ DONE ═══');
  console.log(`  Matched:    ${matched}`);
  console.log(`  Flagged:    ${flagged} (sanity-gate outliers, not attached)`);
  console.log(`  No match:   ${noMatch}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Backup:     ${backup}\n`);
}

// Run the full ingest only when invoked directly. When require()'d as a module
// (scoped relink driver), export the reusable primitives and run nothing.
if (require.main === module) main();

module.exports = { findNeweggMatch, getToken, initNEG, CAT_FILTER };
