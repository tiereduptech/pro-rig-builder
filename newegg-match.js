// Newegg matching + first-party preference + sanity gate (Stage B2).
//
// Shared by fetch-newegg-via-rakuten.cjs, refresh-newegg-prices.cjs (both .cjs,
// via dynamic import()), and the B2 sample test, so all exercise identical logic.
//
// THE FIX: Newegg's Rakuten feed returns both Newegg-Official ("N82E…") and
// marketplace-seller ("9SI…") listings for the same product. The old selection
// broke ties by raw API order, so a marketplace reseller could win. We now PREFER
// first-party (N82E) regardless of price; marketplace (9SI) is last resort. This
// is INTENTIONALLY price-independent — most marketplace listings are reasonably
// priced but are still the wrong seller.

import { parseCapacityGB, capacityCompatible, isHardDrive, isPricePlausibleForCapacity }
  from './normalize-product-name.js';
import { classifyDeal, effectivePrice, dispersion, CLASS, neweggSkuClass } from './price-sanity.js';

const STORAGE_CATS = new Set(['Storage', 'ExternalStorage']);
// Floor for a match to be considered AT ALL. Stays at 0.5 because scoreMatch()
// also gates refresh's REPRICING path, where a low name score usually reflects
// a truncated catalog title rather than a wrong product — real repricing
// matches score as low as 0.571 (IronWolf 12TB) and 0.583 (Proteus 360).
// Raising this globally would freeze prices on every truncated title.
const MIN_NAME_SIM = 0.5;

// Floor for a FIRST ATTACH (ingest). Higher than MIN_NAME_SIM because the two
// situations carry different risk: repricing a SKU whose identity is already
// settled is safe at a low score, but attaching a brand-new link on weak name
// evidence puts a wrong product in front of a buyer. A weak first attach is
// worse than no attach — we can always re-attempt next run.
//
// Set to 0.70 to match MIN_MIGRATE_SIM: both are "am I confident enough to
// bind this product to this SKU", and there is no reason for the first bind to
// be looser than a re-bind. 0.5 was too loose given three false accepts
// observed at 0.75 — the digit-level variant guard is the real remedy for
// those, but the floor should not be the thing that lets them through.
export const MIN_ATTACH_SIM = 0.70;
// Minimum name score to ATTACH A DIFFERENT SKU than the one we already hold.
//
// Deliberately higher than MIN_NAME_SIM, and deliberately NOT applied to
// repricing: once a SKU matches, identity is settled and the name score only
// reflects how badly our catalog title is truncated. Real repricing matches
// score as low as 0.571 (IronWolf 12TB) and 0.583 (Proteus 360) for that
// reason alone — gating those would freeze prices on every truncated title.
//
// Calibrated against refresh dry-run 29758284829, not guessed:
//   legit SKU-changing candidates:  0.765, 0.882, 0.882, 1.0 x6
//   the variant collapse we caught: 0.59
// 0.70 clears the collapse with margin while keeping the 0.765 case (a correct
// match scored low only because our title lacks the "LIAN LI" brand prefix).
// Anything >= 0.80 starts rejecting that whole brand-prefix-missing class.
export const MIN_MIGRATE_SIM = 0.70;
const MAX_PRICE_MULTIPLIER = 2.5;

// Verified Newegg category filters (from fetch-newegg-via-rakuten.cjs).
export const CAT_FILTER = {
  CPU: 'Processors', Motherboard: 'Motherboards', RAM: 'Memory',
  Storage: 'Storage Devices', PSU: 'Power Supplies',
  Case: 'Desktop Computer & Server Cases',
  CPUCooler: 'Computer System Cooling Parts', CaseFan: 'Computer System Cooling Parts',
  Monitor: 'Monitors',
};

// ── Seller classification (the heart of B2) ──────────────────────────────────
// 'official' (N82E… or dashed 2AM-00CN-00060) | 'marketplace' (9SI…) |
// 'other' (unknown prefix) | 'none'
export function sellerClass(itemNumber) { return neweggSkuClass({ sku: itemNumber }); }
export function isFirstParty(itemNumber) { return sellerClass(itemNumber) === 'official'; }
export function isMarketplace(itemNumber) { return sellerClass(itemNumber) === 'marketplace'; }
// Lower rank = preferred. Official < other/unknown < marketplace.
export function sellerRank(itemNumber) {
  const c = sellerClass(itemNumber);
  return c === 'official' ? 0 : c === 'marketplace' ? 2 : 1;
}

// ── XML parsing (copied verbatim from fetch-newegg-via-rakuten.cjs) ───────────
function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
export function parseItems(xml) {
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

// ── Scoring (copied verbatim) ────────────────────────────────────────────────
function normalizeUpc(upc) { return String(upc || '').replace(/^0+/, '').replace(/\D/g, ''); }
// Exported so tests and calibration runs can measure real pairs against the
// floors instead of guessing where a given pair lands.
export function nameSimilarity(a, b) {
  const norm = (s) => new Set(
    String(s).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2));
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter < 3) return 0;
  const containment = inter / Math.min(A.size, B.size);
  const jaccard = inter / (A.size + B.size - inter);
  return Math.max(containment, jaccard);
}
export function extractKeywords(name, brand) {
  let s = String(name || '')
    .replace(/Gaming Graphics Card|Graphics Card|Video Card/gi, '')
    .replace(/PCIe \d+\.\d+|HDMI \d+\.\d+|DisplayPort \d+\.\d+/gi, '')
    .replace(/GDDR\d+(\s*Memory)?|DDR\d+\s*Memory/gi, '')
    .replace(/Edition|Memory|Motherboard|Desktop Processor/gi, '')
    .replace(/[-,()|]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean).slice(0, 8);
  let q = words.join(' ');
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) q = `${brand} ${q}`;
  return q.slice(0, 100);
}
// ── Variant-collapse guard ───────────────────────────────────────────────────
//
// Same bug class as the wrong-capacity defect: token-overlap scoring happily
// merges DISTINCT variants that share most of their words. "Fractal Design AIR
// 903 Series" and "Fractal Design AIR 903 MAX" overlap on every token except
// one — nameSimilarity returns ~0.9 and we attach the wrong product's listing.
//
// The fix is the same shape as the capacity gate: make the distinguishing token
// a HARD gate rather than letting it be outvoted by the shared tokens.
//
// Two independent checks, either one rejects:
//   1. Variant markers (MAX, Pro, SE, Ti, Plus, …) must match EXACTLY. Present
//      on one side and not the other => different product.
//   2. Every model-ish alphanumeric token in OUR name must appear in theirs
//      (903 vs 900, A620M vs A620, 5900X vs 5900).
//
// Deliberately biased toward rejection: a false reject costs one refresh cycle
// (LOOKUP_FAILED touches nothing), a false accept corrupts the catalog.

// Phrases where a marker word is NOT a variant — stripped before extraction.
// "80 PLUS Gold" is a PSU efficiency rating, not a "Plus" model.
const MARKER_NOISE = /\b(80\s*\+?\s*plus|plus\s*gold|plus\s*bronze|plus\s*platinum|plus\s*titanium)\b/gi;
// Generic words that carry no model identity — dropped so "AIR 903 Series"
// and "AIR 903" are not split by "Series" alone.
const GENERIC_NOISE = /\b(series|edition|version|model|retail|new|gaming|desktop|computer|pc)\b/gi;

// Multi-word markers, folded to ONE token before tokenization. Without this,
// "Open Box" tokenizes to <open><box> — two ordinary words that no marker set
// can safely contain ("box contents", "open air"). Folding makes the phrase
// addressable without making its halves trigger-happy.
const PHRASE_MARKERS = [
  [/\bopen[\s-]*box\b/gi, ' openbox '],
  [/\breverse[\s-]*blade[sd]?\b/gi, ' reverseblade '],
  [/\b(?:factory|manufacturer)[\s-]*recertified\b/gi, ' refurbished '],
  [/\brecertified\b/gi, ' refurbished '],
  [/\brefurb(?:ished)?\b/gi, ' refurbished '],
  [/\bgrade\s+[abc]\b/gi, ' refurbished '],
];

const VARIANT_MARKERS = new Set([
  // model tier
  'max', 'pro', 'plus', 'se', 'ti', 'super', 'xt', 'xtx', 'elite', 'lite',
  'mini', 'micro', 'ultra', 'extreme', 'premium', 'advanced', 'flow',
  'rgb', 'argb', 'itx', 'matx', 'atx', 'ii', 'iii', 'iv', 'v2', 'v3',
  'xl', 'xxl', 'compact', 'slim',
  // color-as-model — Newegg sells White/Black as separate SKUs
  'white', 'black', 'silver', 'pink', 'snow', 'grey', 'gray',
  // finish-as-model — Noctua ships NH-D15 and NH-D15 chromax.black as distinct SKUs
  'chromax',
  // ── ALPHA-ONLY MARKERS ────────────────────────────────────────────────────
  // Everything above happens to be alpha too, but these exist for a different
  // reason: they are the words that distinguish listings whose MODEL NUMBERS
  // are identical, so the digit-token check at the bottom of variantMismatch()
  // cannot see them. "SL-Infinity 120 Reverse Blade" vs "SL-Infinity Wireless
  // 120" share every digit token; only these words tell them apart.
  //
  // condition — a different condition is a different SKU at a different price
  'openbox', 'refurbished', 'renewed', 'used', 'oem',
  // connectivity — Lian Li ships wired and wireless-controller fan packs apart
  'wireless', 'wired',
  // blade geometry — reverse-blade fans are a separate SKU, same model number
  'reverseblade', 'reverse',
]);

// Units and spec noise that look model-ish but aren't identity.
//
// NOTE: single letters that are real MODEL suffixes are deliberately absent —
// x, t, a, c, f. Including 'x' made "5900x" parse as <5900><unit x>, which made
// 5900X and 5900XT indistinguishable. That is the exact defect this guard exists
// to catch, so ambiguous suffixes stay OUT of this list.
const UNIT_TOKEN = /^\d+(\.\d+)?(mm|cm|ghz|mhz|hz|w|kw|gb|tb|mb|kb|rpm|cfm|pin|v|bit|k|p|nm|db|dba|ms|gbps|mbps)?$/i;

// Shared normalization. Phrase folding runs FIRST so "Open Box" becomes a
// single token before the noise strippers or the tokenizer can split it.
function prepare(name) {
  let s = String(name || '').toLowerCase();
  for (const [re, to] of PHRASE_MARKERS) s = s.replace(re, to);
  return s.replace(MARKER_NOISE, ' ').replace(GENERIC_NOISE, ' ');
}

function markerSet(name) {
  const out = new Set();
  for (const w of prepare(name).replace(/[^\w\s]/g, ' ').split(/\s+/)) {
    if (VARIANT_MARKERS.has(w)) out.add(w);
  }
  return out;
}

// Tokens that identify a model: contain a digit, aren't a bare unit/measurement.
function modelTokens(name) {
  const out = new Set();
  for (const w of prepare(name).replace(/[^\w\s]/g, ' ').split(/\s+/)) {
    if (!/\d/.test(w)) continue;
    if (UNIT_TOKEN.test(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * True when the two names describe DIFFERENT variants of the same base product.
 * @returns {false|{reason:string, detail:string}}
 */
export function variantMismatch(ourName, theirName) {
  const ourM = markerSet(ourName), theirM = markerSet(theirName);
  const onlyOurs = [...ourM].filter((w) => !theirM.has(w));
  const onlyTheirs = [...theirM].filter((w) => !ourM.has(w));
  if (onlyOurs.length || onlyTheirs.length) {
    return {
      reason: 'variant_marker',
      detail: `ours-only=[${onlyOurs.join(',')}] theirs-only=[${onlyTheirs.join(',')}]`,
    };
  }
  const ourT = modelTokens(ourName), theirT = modelTokens(theirName);
  const missing = [...ourT].filter((t) => !theirT.has(t));
  if (missing.length) {
    return { reason: 'model_token', detail: `missing=[${missing.join(',')}]` };
  }
  return false;
}

// `notes` is an optional out-param: on a variant-guard rejection it receives
// { reject }. Callers that omit it are unaffected. searchNewegg uses it to tell
// "the feed had nothing like our product" apart from "the feed had our product
// line and we rejected every variant of it" — those two must NOT be treated as
// the same signal, because only the first is evidence of absence.
// opts.minSim overrides the name floor for callers that need a stricter bar
// than repricing does — ingest passes MIN_ATTACH_SIM. Defaults to MIN_NAME_SIM
// so every existing caller keeps its current behavior.
export function scoreMatch(ourProduct, neweggItem, notes, opts) {
  if (ourProduct.pr && neweggItem.price && neweggItem.price > ourProduct.pr * MAX_PRICE_MULTIPLIER) return null;
  if (/\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Bundle|Combo)\b/i.test(neweggItem.name)) return null;
  const storedCap = ourProduct.cap != null ? ourProduct.cap : parseCapacityGB(ourProduct.n);
  if (!capacityCompatible(storedCap, parseCapacityGB(neweggItem.name))) return null;
  if (STORAGE_CATS.has(ourProduct.c) &&
      !isPricePlausibleForCapacity(neweggItem.price, storedCap, { isHDD: isHardDrive(ourProduct) })) return null;
  const ourUpcN = normalizeUpc(ourProduct.upc || ourProduct.UPC);
  const newUpcN = normalizeUpc(neweggItem.upc);
  if (ourUpcN && newUpcN && ourUpcN === newUpcN) return { method: 'upc', score: 1.0 };
  const sim = nameSimilarity(ourProduct.n, neweggItem.name);
  const minSim = (opts && typeof opts.minSim === 'number') ? opts.minSim : MIN_NAME_SIM;
  if (sim < minSim) {
    if (notes && sim >= MIN_NAME_SIM) notes.reject = 'below_attach_floor';
    return null;
  }
  // Name similarity is WEAK evidence — it is exactly what collapses variants.
  // Gate it. (An exact UPC match above is strong evidence and bypasses this.)
  const vm = variantMismatch(ourProduct.n, neweggItem.name);
  if (vm) {
    if (notes) notes.reject = `variant_${vm.reason}`;
    return null;
  }
  return { method: 'name', score: sim };
}

// ── Selection WITH first-party preference ────────────────────────────────────
// Within a seller tier, rank by method (upc > name) then score.
function pickWithinTier(scored) {
  return [...scored].sort((a, b) => {
    if (a.match.method !== b.match.method) return a.match.method === 'upc' ? -1 : 1;
    return b.match.score - a.match.score;
  })[0];
}
// Prefer a first-party (N82E) candidate if ANY matched (and passed all gates);
// otherwise fall back to the best of the rest. Price-independent by design.
//
// The fallback used to be pickWithinTier(scored) over ALL non-first-party
// candidates at once, which threw away the distinction sellerRank() exists to
// draw: an 'other'/unknown-prefix listing (rank 1) and a marketplace reseller
// (rank 2) competed purely on match score, so a marketplace listing could beat
// an unknown-prefix one on a hundredth of a point. Now the fallback walks
// sellerRank in order and returns the best candidate from the FIRST non-empty
// tier — marketplace is reached only when nothing better exists at all.
export function selectWithFirstPartyPreference(scored) {
  if (!scored || !scored.length) return null;
  for (const rank of [0, 1, 2]) {
    const tier = scored.filter((x) => sellerRank(x.item.sku) === rank);
    if (tier.length) return pickWithinTier(tier);
  }
  return null;
}

// ── Live search (caller supplies token + mid; uses XML productsearch/1.0) ─────
//
// Returns { ok, reason, candidates, rawCount, httpErrors, queriesTried }.
//
// rawCount/httpErrors exist so callers can tell a FAILED LOOKUP apart from a
// CONFIRMED ABSENCE. Previously both collapsed to reason:'no_results' — a 500
// from Linkshare and "this product is genuinely delisted" were indistinguishable,
// and refresh-newegg-prices.cjs treated the pair identically (mark stale -> delete
// after 7d). That is what removed 1,655 deals on 2026-07-06. Callers MUST NOT
// treat 'http_error' or 'no_results' as evidence of absence.
export async function searchNewegg(product, { token, mid, fetchImpl = fetch }) {
  const catFilter = CAT_FILTER[product.c];
  if (!catFilter) return { ok: false, reason: 'no_cat_mapping', candidates: [], rawCount: 0, httpErrors: 0, queriesTried: 0 };
  const keywords = extractKeywords(product.n, product.b);
  const queries = [
    { exact: keywords, cat: catFilter, mid, max: '20' },
    { keyword: keywords, cat: catFilter, mid, max: '20' },
  ];
  let items = [];
  let httpErrors = 0;
  let queriesTried = 0;
  for (const params of queries) {
    const url = `https://api.linksynergy.com/productsearch/1.0?${new URLSearchParams(params)}`;
    queriesTried++;
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      httpErrors++; // network/DNS/timeout — a failure, never an absence
      continue;
    }
    if (!res.ok) { httpErrors++; continue; }
    items = parseItems(await res.text());
    if (items.length > 0) break;
  }
  const base = { rawCount: items.length, httpErrors, queriesTried, variantRejects: 0 };
  // Every query we issued errored — we learned nothing about this product.
  if (httpErrors === queriesTried) return { ok: false, reason: 'http_error', candidates: [], ...base };
  if (!items.length) return { ok: false, reason: 'no_results', candidates: [], ...base };

  let variantRejects = 0;
  const scored = items.map((it) => {
    const notes = {};
    const match = scoreMatch(product, it, notes);
    if (!match && notes.reject) variantRejects++;
    return { item: it, match };
  }).filter((x) => x.match);

  if (!scored.length) {
    // THE DISTINCTION THAT KEEPS THE DELETION CLOCK HONEST.
    //
    // Callers treat 'no_match' over a healthy candidate set as PROVEN ABSENCE
    // and start the stale/removal countdown. That inference only holds when the
    // feed genuinely had nothing resembling our product. If the variant guard
    // rejected candidates, the feed DID surface our product line and we declined
    // its variants — which is evidence the product still exists, the exact
    // opposite of absence. Reporting both as 'no_match' would let a stricter
    // guard quietly widen the deletion path, which is the same over-inference
    // that destroyed 1,655 deals on 2026-07-06.
    return {
      ok: false,
      reason: variantRejects ? 'variant_rejected' : 'no_match',
      candidates: [], ...base, variantRejects,
    };
  }
  return { ok: true, candidates: scored, ...base, variantRejects };
}

// ── Cross-retailer sanity gate for a candidate Newegg price (peers: amazon, bestbuy)
export function neweggSanity(product, candidatePrice) {
  const deals = (product && product.deals) || {};
  const peers = ['amazon', 'bestbuy'].map((r) => effectivePrice(deals[r])).filter((v) => v != null);
  const res = classifyDeal(candidatePrice, peers, product && product.pr, product && product.msrp);
  const hypo = { deals: { ...deals, newegg: { price: candidatePrice } } };
  const disp = dispersion(hypo);
  const perRetailerOk = res.cls === CLASS.OK || res.cls === CLASS.UNVERIFIED;
  return {
    pass: perRetailerOk && !disp.conflicting,
    cls: res.cls, ref: res.ref, deviation: res.deviation,
    dispConflict: disp.conflicting, spread: disp.spread,
  };
}
