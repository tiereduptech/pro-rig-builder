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

import { parseCapacityGB, capacityCompatible, isHardDrive, isPricePlausibleForCapacity, priceValidate }
  from './normalize-product-name.js';
import { classifyDeal, effectivePrice, dispersion, CLASS, neweggSkuClass } from './price-sanity.js';
import { CONDITION_MARKERS } from './condition.cjs';

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
    // Quote marks used to survive into the query, so `27"` was sent to Rakuten
    // verbatim as a term its index cannot satisfy — and `keyword=` is AND, so
    // one such term zeroes the whole result. Stripping them can only widen what
    // this query reaches, never narrow it.
    .replace(/["'“”‘’″′]/g, ' ')
    .replace(/[-,()|]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean).slice(0, 8);
  let q = words.join(' ');
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) q = `${brand} ${q}`;
  return q.slice(0, 100);
}

// ── Query construction ───────────────────────────────────────────────────────
//
// THE LOOKUP BUG. extractKeywords() takes the first 8 words of our catalog
// title. Rakuten's `keyword=` is AND across every term, so each extra term can
// only ever REMOVE results — and our titles carry spec text worded differently
// than Newegg's ("27in" vs "27 inch", "1440p" vs "QHD 2K 1440P"). Every such
// token is a term Newegg's index cannot satisfy, so the query returns nothing
// for a product Newegg plainly carries. Measured live on 2026-07-20:
//
//   "Samsung 27" Essential S3 S36GD Series FHD 1800R Curved"  →  0 hits
//   "Samsung Odyssey G5"                                      → 11 hits
//   "Corsair Vengeance RGB DDR5 6000MHz CL30 32GB Kit"        →  0 hits
//   "Corsair Vengeance RGB DDR5 32GB"                         → 20 hits
//
// This is why no_results ran at 68% and why Monitors/RAM failed near-totally
// (90% each) — those categories have the longest, most spec-laden titles. It
// was never the matcher: we were asking questions the search cannot answer.
//
// The fix is a CASCADE, shortest-and-highest-signal first, stopping at the
// first query that returns anything. Broadening the query costs precision, but
// precision is the matcher's job — scoreMatch(), the variant guard and the
// attach floor all still run on whatever comes back. A query that returns 20
// candidates we then reject is strictly better than one that returns 0.

// Spec vocabulary: true of the product, useless for FINDING it, and frequently
// worded differently by Newegg. Dropped from the narrowed queries only — the
// full-title query is kept as the last rung, so nothing that works today stops
// working.
const SPEC_NOISE = new RegExp('\\b(' + [
  // display
  'curved', 'flat', 'ips', 'va', 'tn', 'oled', 'qled', 'led', 'lcd', 'hdr\\d*',
  'fhd', 'qhd', 'uhd', 'wqhd', 'uwqhd', '4k', '2k', '1080p', '1440p', '2160p',
  'freesync', 'gsync', 'g-sync', 'srgb', 'nits', 'ms', 'monitor', 'display',
  'screen', 'portable', 'ultrawide', 'widescreen', 'borderless', 'frameless',
  // memory / storage
  'cl\\d+', 'pc\\d+', 'udimm', 'dimm', 'sodimm', 'unbuffered', 'ecc',
  'nand', 'tlc', 'qlc', 'mlc', 'slc', 'nvme', 'sata', 'ssd', 'hdd',
  'internal', 'external', 'solid', 'state', 'drive', 'cache', 'rpm',
  // generic marketing
  'gaming', 'desktop', 'computer', 'laptop', 'pc', 'series', 'kit',
  'high', 'performance', 'premium', 'professional', 'ultra', 'slim',
  'compatible', 'support', 'supports', 'includes', 'included', 'with', 'for',
  'and', 'the', 'up', 'to', 'inch', 'in',
].join('|') + ')\\b', 'gi');

// Dimensional / rate tokens: "27in", "165hz", "6000mhz", "2560x1600", "32gb".
const MEASURE_TOKEN = /^\d+(\.\d+)?(x\d+)?(in|inch|hz|mhz|ghz|gb|tb|mb|w|mm|cm|bit|v|r)?$/i;

// A manufacturer part number: long, mixed letters+digits. Highest-signal token
// we have — when Newegg indexes it, it is close to a unique key.
function mpnTokens(name) {
  return String(name || '').split(/[\s,()|]+/)
    .map((w) => w.replace(/[^\w-]/g, ''))
    .filter((w) => w.length >= 6 && /\d/.test(w) && /[a-z]/i.test(w));
}

function cleanTokens(name) {
  return String(name || '')
    // Quote marks survived the old stripper, so `27"` went to the API verbatim
    // as a term Newegg's index has no hope of matching.
    .replace(/["'“”‘’″′]/g, ' ')
    .replace(/[-,()|/+]/g, ' ')
    .replace(SPEC_NOISE, ' ')
    .split(/\s+/).filter(Boolean)
    .filter((w) => !MEASURE_TOKEN.test(w))
    .filter((w) => w.length >= 2);
}

// Categories where the broadening rungs are measured to be worth nothing.
//
// Live sample, 12 previously-unfindable products each: Monitor recovered 1 and
// RAM recovered 0 that would actually attach. Their catalog rows are long-tail
// Amazon listings ("Portable Monitor for Laptop, IPS USB-C HDMI") that Newegg
// does not carry at all, plus brand models whose MPN their index does not hold
// — LG 27GR95QE returns zero on EVERY query form, including the bare part
// number. Broadening cannot find what the feed does not contain; it just spends
// four requests per product against a hard 100/min ceiling.
//
// This is a COST decision, not a matching one. If Newegg's monitor coverage
// changes, re-measure and delete the entry — nothing else depends on it.
export const NO_BROADEN_CATS = new Set(['Monitor', 'RAM']);

/**
 * Ordered list of queries to try, most specific first. Callers issue them in
 * order and stop at the first non-empty response.
 * @param {{broaden?: boolean}} [opts] broaden:false emits only the legacy pair.
 * @returns {Array<{mode:'exact'|'keyword', q:string}>}
 */
export function buildQueries(name, brand, opts) {
  const out = [];
  const push = (mode, q) => {
    const t = String(q || '').trim().slice(0, 100);
    // Below two terms a query is not identifying anything — it is a category
    // scan, and its 20 rows of unrelated product waste a request and a rate
    // limit slot for a result the matcher will reject wholesale.
    if (t && t.split(/\s+/).length >= 2 && !out.some((x) => x.mode === mode && x.q === t)) {
      out.push({ mode, q: t });
    }
  };

  const toks = cleanTokens(name);
  const b = brand ? String(brand).trim() : '';
  const withBrand = (arr) => {
    const joined = arr.join(' ');
    return b && !joined.toLowerCase().includes(b.toLowerCase()) ? `${b} ${joined}` : joined;
  };

  // ORDER IS A SAFETY PROPERTY, NOT A PREFERENCE.
  //
  // The legacy full-title queries go FIRST, unchanged, so every product that
  // resolves today resolves today's way and binds today's SKU. The broadening
  // rungs are reached ONLY after the legacy pair returns nothing — which is
  // exactly the no_results population, by definition. That makes this change
  // strictly additive: it cannot move an existing attachment.
  //
  // Putting the short query first was tempting (it returns a wider candidate
  // pool, so it can surface a better listing than exact= does) but it would
  // re-open all 606 working attachments to reselection for a speculative gain.
  // Given how this catalog acquired wrong products in the first place, a
  // broader pool is not worth re-litigating matches that are already correct.
  // Widening the candidate pool for products that already match is a separate
  // question, worth its own dry run.
  const legacy = extractKeywords(name, brand);
  push('exact', legacy);
  push('keyword', legacy);

  if (opts && opts.broaden === false) return out;

  // Broadening rungs — reached only when the legacy pair found nothing.
  // Brand + the first few identifying tokens, spec text stripped.
  push('keyword', withBrand(toks.slice(0, 3)));
  // One token wider, for lines where the model needs a qualifier.
  push('keyword', withBrand(toks.slice(0, 5)));
  // MPN. Newegg indexes it inconsistently — CMH32GX5M2B6000C30 resolves,
  // LS27DG502ENXZA does not — so it is a rung, never the only attempt.
  for (const m of mpnTokens(name).slice(0, 2)) push('keyword', `${b} ${m}`);
  return out;
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
// "Core Ultra" is Intel's CPU family, and it appears in the COMPATIBILITY text
// of nearly every LGA1851 board ("Supports Intel Core Ultra Series 2"). Read as
// a marker it made "ultra" theirs-only on boards whose titles are otherwise
// identical to ours — same false-positive shape as "80 PLUS Gold".
const MARKER_NOISE = /\b(80\s*\+?\s*plus|plus\s*gold|plus\s*bronze|plus\s*platinum|plus\s*titanium|core\s*ultra|ultra\s*core)\b/gi;
// Generic words that carry no model identity — dropped so "AIR 903 Series"
// and "AIR 903" are not split by "Series" alone.
const GENERIC_NOISE = /\b(series|edition|version|model|retail|new|gaming|desktop|computer|pc)\b/gi;

// Multi-word markers, folded to ONE token before tokenization. Without this,
// "Open Box" tokenizes to <open><box> — two ordinary words that no marker set
// can safely contain ("box contents", "open air"). Folding makes the phrase
// addressable without making its halves trigger-happy.
const PHRASE_MARKERS = [
  // Form factor, folded to ONE canonical token. Folding runs before marker
  // extraction so "Mini-ITX" cannot leave a bare "mini" behind and "Micro ATX"
  // cannot leave a bare "micro" — those words are markers in their own right
  // ("Meshify 2 Compact", "H5 Flow Mini"), and letting a form-factor phrase
  // shed them was manufacturing marker mismatches out of pure spec text.
  [/\b(?:mini|m)[\s-]*itx\b/gi, ' ff_itx '],
  [/\bitx\b/gi, ' ff_itx '],
  [/\b(?:micro|m|u)[\s-]*atx\b/gi, ' ff_matx '],
  [/\bmatx\b/gi, ' ff_matx '],
  // E-ATX folds into the SAME bucket as ATX, deliberately. They share a mounting
  // standard, listings use the words interchangeably for one board ("Extended
  // ATX", "E-ATX", plain "ATX"), and an E-ATX case accepts ATX boards. Measured
  // on the 2026-07-21 accepts: keeping them distinct produced 4 false conflicts
  // out of 6 and caught nothing that collapsing them misses. mATX and ITX are
  // the genuinely exclusive formats.
  [/\bextended[\s-]*atx\b/gi, ' ff_atx '],
  [/\be[\s-]*atx\b/gi, ' ff_atx '],
  [/\batx\b/gi, ' ff_atx '],
  [/\bopen[\s-]*box\b/gi, ' openbox '],
  [/\breverse[\s-]*blade[sd]?\b/gi, ' reverseblade '],
  [/\b(?:factory|manufacturer)[\s-]*recertified\b/gi, ' refurbished '],
  [/\brecertified\b/gi, ' refurbished '],
  [/\brefurb(?:ished)?\b/gi, ' refurbished '],
  [/\bgrade\s+[abc]\b/gi, ' refurbished '],
];

// FORM FACTOR IS DELIBERATELY ABSENT (atx / matx / itx / eatx — folded to ff_*
// above and matched by nothing here, so they are inert).
//
// The marker check is symmetric: a marker on either side that the other lacks
// rejects. That is correct for tier words, because "AIR 903" and "AIR 903 MAX"
// really are different products. It was catastrophic for form factor, because
// Newegg spells the form factor out in EVERY title and our catalog titles
// usually do not — so "MSI MAG X870 Tomahawk WiFi" lost to "MSI MAG X870
// TOMAHAWK WIFI Motherboard, ATX - ..." on theirs-only=[atx]. Same board.
//
// Nothing is given up by dropping them. Where form factor genuinely marks a
// different product it is already carried by the MODEL NUMBER, which the
// model-token check gates hard: B650 vs B650M, H610M vs H610. Form factor was
// never the discriminator — it was the spec text sitting next to it.
//
// Measured on dry run 2026-07-20: 83 of 267 theirs-only marker rejections were
// driven by [atx] alone; the fold+demote clears 38 products that had ZERO
// surviving candidates. Colors stay markers on purpose — see below.
const VARIANT_MARKERS = new Set([
  // model tier
  'max', 'pro', 'plus', 'se', 'ti', 'super', 'xt', 'xtx', 'elite', 'lite',
  'mini', 'micro', 'ultra', 'extreme', 'premium', 'advanced', 'flow',
  'rgb', 'argb', 'ii', 'iii', 'iv', 'v2', 'v3',
  'xl', 'xxl', 'compact', 'slim',
  // color-as-model — Newegg sells White/Black as separate SKUs.
  //
  // These STAY, and stay symmetric, even though ablating them would clear 68
  // more products than the form-factor fix does. That number is a trap: when
  // our title is silent on color ("Fractal Design North") and Newegg offers
  // Chalk White and Charcoal Black as distinct SKUs at distinct prices, there
  // is no evidence in hand for choosing one. Tolerating the asymmetry does not
  // recover the right listing, it picks an arbitrary one — the wrong-product
  // failure this guard exists to prevent. Colorless titles need a color on OUR
  // side to be matchable; that is a catalog fix, not a matcher fix.
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

// CONDITION is not identity — and it is the one thing a UPC cannot tell you.
//
// An Open Box unit carries the manufacturer's UPC, identical to new stock,
// because it IS the same manufactured item. scoreMatch() treats UPC equality as
// strong evidence and returns before the variant guard runs, which is correct
// for model/tier confusion (a UPC match on a truncated title should not be
// thrown out over a missing word) and exactly wrong here: the guard identifies
// these perfectly (theirs-only=[openbox]) and never gets to speak.
//
// Result, measured on the 2026-07-20 dry run: 20 accepted attachments were Open
// Box SKUs, every one of them method='upc'. Nine were already in the pre-fix
// baseline, so this predates the query cascade — wider coverage only surfaced
// more of it. A buyer clicking through sees a used unit at the price we quoted
// for a new one.
//
// 'oem' is deliberately NOT here. It usually carries its own UPC, so it does not
// reach this path, and it is ambiguous enough on the name side that gating the
// UPC path on it would cost real matches. It stays in VARIANT_MARKERS, where the
// name path still catches it.
// CONDITION_MARKERS now lives in the shared ./condition.cjs (imported above) so the
// Amazon relink gate and this feed matcher share one source of truth. Values unchanged.

/**
 * True when the two names describe the same item in a DIFFERENT CONDITION.
 * Checked even when the UPCs match, because condition never changes the UPC.
 * @returns {false|{reason:string, detail:string}}
 */
export function conditionMismatch(ourName, theirName) {
  const ourM = markerSet(ourName), theirM = markerSet(theirName);
  const onlyOurs = [...ourM].filter((w) => CONDITION_MARKERS.has(w) && !theirM.has(w));
  const onlyTheirs = [...theirM].filter((w) => CONDITION_MARKERS.has(w) && !ourM.has(w));
  if (onlyOurs.length || onlyTheirs.length) {
    return {
      reason: 'condition',
      detail: `ours-only=[${onlyOurs.join(',')}] theirs-only=[${onlyTheirs.join(',')}]`,
    };
  }
  return false;
}

// A single trailing letter can be the WHOLE product distinction: ASUS ships
// B650E-E, B650E-F and B650E-I as three different boards. modelTokens() cannot
// see it — prepare() turns "b650e-e" into "b650e e", and the lone "e" carries no
// digit, so it is dropped as noise. The 2026-07-20 run attached our B650E-E to a
// B650E-I listing at score 0.895 for exactly this reason.
//
// Measured: 131 catalog products carry such a suffix, 115 of them motherboards;
// of the 53 that currently attach, 50 agree, 1 conflicts, 2 cannot be judged.
//
// DELIBERATELY CONFLICT-ONLY, not asymmetric like modelTokens. Rejecting when
// their title merely omits the suffix would break the 2 "cannot judge" cases and
// every legitimately-truncated Newegg title. We reject only when both sides name
// a suffix for the SAME base model and the letters disagree — which is not an
// absence of evidence, it is evidence of difference.
const MODEL_SUFFIX_RE = /\b([a-z]{1,3}\d{3,4}[a-z]{0,2})-([a-z])\b/gi;
function modelSuffixes(name) {
  const out = new Map();
  const re = new RegExp(MODEL_SUFFIX_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(name || ''))) !== null) out.set(m[1].toLowerCase(), m[2].toLowerCase());
  return out;
}
// FORM FACTOR: conflict-only, which is the shape I should have used the first
// time. Demoting it to inert was half right and half a regression.
//
// Right half: Newegg spells the form factor out in every title and our titles
// usually do not, so a SYMMETRIC marker check rejected correct matches on
// theirs-only=[atx] alone — 83 of 267 such rejections, 38 products with no
// surviving candidate.
//
// Wrong half: I justified dropping it entirely by claiming the model number
// already carries the distinction. It does not, because modelTokens() is
// ASYMMETRIC — it only requires OUR tokens to appear in THEIRS. For product
// 20171 ours is "B650 … ATX" and theirs is "B650M … micro ATX"; theirs contains
// both "b650m" AND "b650" (from "AMD B650"), so ours is a strict subset and the
// check passes. nameSimilarity then returns 1.000 by containment, and we bind an
// mATX board to an ATX product. The 2026-07-21 run did exactly that.
//
// Conflict-only gets both: silence on one side proves nothing, but two
// DIFFERENT form factors is positive evidence of two different products.
// Disjointness, not inequality — Newegg writes "ATX mATX" for cases that accept
// both boards, and that must still intersect our plain "ATX".
const FORM_FACTOR_TOKENS = new Set(['ff_itx', 'ff_matx', 'ff_atx']);
function formFactors(name) {
  const out = new Set();
  for (const w of prepare(name).replace(/[^\w\s]/g, ' ').split(/\s+/)) {
    if (FORM_FACTOR_TOKENS.has(w)) out.add(w);
  }
  return out;
}
export function formFactorConflict(ourName, theirName) {
  const ours = formFactors(ourName), theirs = formFactors(theirName);
  if (!ours.size || !theirs.size) return false; // one side silent — proves nothing
  for (const f of ours) if (theirs.has(f)) return false; // any overlap is agreement
  return {
    reason: 'form_factor',
    detail: `ours=[${[...ours].join(',')}] theirs=[${[...theirs].join(',')}]`,
  };
}

export function modelSuffixConflict(ourName, theirName) {
  const ours = modelSuffixes(ourName), theirs = modelSuffixes(theirName);
  for (const [base, letter] of ours) {
    if (theirs.has(base) && theirs.get(base) !== letter) {
      return { reason: 'model_suffix', detail: `${base}-${letter} vs ${base}-${theirs.get(base)}` };
    }
  }
  return false;
}

// ── Model-LINE / wattage / modularity conflicts (added 2026-07-28) ────────────
//
// These close two false-accept classes the token-overlap + suffix gate let through
// on the 2026-07-28 feed relink pass:
//
//   (1) same-family model-line defeat — "be quiet! Straight Power 12 850W" scored
//       0.833 against "Pure Power 12 850W": same brand, same wattage, same "12";
//       the only difference (Straight vs Pure) is an alpha word, so neither the
//       digit-only modelTokens check nor the variant-marker set could see it.
//   (2) modularity-tier defeat — "Pure Power 12 M 750W" (modular) scored 1.0 against
//       "Pure Power 12 750W Non-Modular": the distinguishing "M" is one char, dropped
//       by the tokenizer.
//
// All three are CONFLICT-ONLY and SYMMETRIC — they fire only when BOTH sides state
// the attribute and the two disagree. Silence on one side proves nothing (truncation),
// so a bare/short candidate title is never rejected by these. That is why they are
// safe to run even before the UPC shortcut: a barcode cannot change a product's
// wattage or family, so a stated conflict is positive evidence the UPC is wrong.

// The model line lives in the HEAD of a title, before the first model number. Collect
// distinctive alpha words (>=4, non-brand, non-commodity) that appear before the first
// digit-bearing token, cap 2. Tail spec/description text ("for Small to Medium Hands",
// a truncated "…Copp") is excluded by design — comparing it produced false rejects.
function headLineWords(name, brandToks) {
  const out = new Set();
  for (const t of String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)) {
    if (/\d/.test(t)) break;                    // reached the model number → the line is stated before it
    if (!/^[a-z]{4,}$/.test(t)) continue;
    if (SPEC_STOP.has(t)) continue;
    if (brandToks && brandToks.has(t)) continue;
    out.add(t);
    if (out.size >= 2) break;
  }
  return out;
}
export function lineConflict(ourName, theirName, brandToks) {
  const o = headLineWords(ourName, brandToks), t = headLineWords(theirName, brandToks);
  const ourResid = [...o].filter((w) => !t.has(w));
  const theirResid = [...t].filter((w) => !o.has(w));
  if (ourResid.length && theirResid.length) {
    return { reason: 'model_line', detail: `${ourResid[0]} vs ${theirResid[0]}` };
  }
  return false;
}

function wattage(name) { const m = String(name || '').match(/\b(\d{3,4})\s*w\b/i); return m ? Number(m[1]) : null; }
export function wattageConflict(ourName, theirName) {
  const a = wattage(ourName), b = wattage(theirName);
  return a != null && b != null && a !== b ? { reason: 'wattage', detail: `${a}W vs ${b}W` } : false;
}

function modularity(name) {
  const s = ' ' + String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (/\bnon\s*modular\b/.test(s) || /\bnonmodular\b/.test(s)) return 'NONMOD';
  if (/\bsemi\s*modular\b/.test(s)) return 'SEMI';
  if (/\bmodular\b/.test(s)) return 'MOD';
  if (/\b\d{2,3}\s*m\s+\d/.test(s)) return 'MOD';   // "Pure Power 12 M 750W" — lone M between model and wattage
  return null;
}
export function modularityConflict(ourName, theirName) {
  const a = modularity(ourName), b = modularity(theirName);
  return a && b && a !== b ? { reason: 'modularity', detail: `${a} vs ${b}` } : false;
}

// ── Brand presence ───────────────────────────────────────────────────────────
//
// nameSimilarity compares NAMES ONLY. When our catalog title carries no brand
// (the brand lives in a separate `b` field, or is spec-only — "32GB DDR4 3200
// CL22 SODIMM"), a DIFFERENT manufacturer's identical-spec product matches at
// name-score 1.0 on pure commodity tokens. The 2026-07-22 live ingest bound a
// Micron ECC RDIMM to a NEMIX module, a Samsung SODIMM to an A-Tech, and a
// Crucial P310 to a Kingston KC600 — all name=1.0, all wrong. It bites only
// sparse, brand-less, spec-defined names, which is why it clusters in RAM/
// Storage. UPC matches are immune (barcode is authoritative) and never reach
// this check.
//
// Corporate equivalents that are the SAME maker under different labels. Kept
// tight on purpose: this list rescues correct matches (WD listed as "Western
// Digital"), so a wrong entry here would RE-ADMIT a bad match. Crucial/Micron
// are the same company; SanDisk is WD's flash brand.
const BRAND_ALIASES = [
  ['wd', 'western digital', 'sandisk', 'wd_black', 'wdblack', 'wd black'],
  ['silicon power', 'siliconpower'],
  ['crucial', 'micron'],
  ['g skill', 'gskill', 'g.skill'],
  ['team', 'teamgroup', 'team group'],
];
function brandForms(token) {
  const t = token.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  for (const group of BRAND_ALIASES) {
    if (group.some((g) => g.replace(/[^a-z0-9 ]/g, '') === t)) {
      return group.map((g) => g.replace(/[^a-z0-9 ]/g, ''));
    }
  }
  return [t];
}
// Our product's identifying brand tokens: the `b` field AND the first word of
// the name, because `b` is sometimes MISLABELLED (an OWC part tagged "Crucial").
// Either identifying the true maker is enough — the check passes if any form of
// any of them appears in the candidate.
// The first name-token is only a usable brand when it is NOT itself spec text.
// "SODIMM 16GB …" leads with a form factor, not a maker; treating it as a brand
// let an A-Tech module keep a Samsung product because both say "SODIMM".
const SPECY_FIRST = /^\d|^(the|a|for|with|internal|external|gaming|desktop|laptop|notebook|ddr\d|pc\d|sodimm|dimm|udimm|rdimm|nvme|ssd|hdd|ram|sata|pcie|nand|kit|module|memory|solid|drive|m\.?2|micro|mini)$/i;
function ourBrandForms(product) {
  const out = new Set();
  const add = (tok) => { if (tok) brandForms(tok).forEach((f) => out.add(f)); };
  if (product.b) add(String(product.b));
  const first = String(product.n || '').trim().split(/[\s,()|/-]+/)[0] || '';
  if (first.length >= 2 && !SPECY_FIRST.test(first)) add(first);
  return [...out].filter((f) => f.length >= 2);
}
// Spec / descriptor vocabulary that carries NO product identity. A match that
// rests only on these tokens is a match on commodity attributes, not on the
// product. Anything NOT in here (and long enough, non-unit) is "distinctive" —
// a model line ("lancool", "sn850x"), a part number, a brand.
const SPEC_STOP = new Set([
  'ddr', 'ddr3', 'ddr4', 'ddr5', 'ecc', 'rdimm', 'udimm', 'dimm', 'sodimm', 'unbuffered',
  'nvme', 'ssd', 'hdd', 'sata', 'pcie', 'nand', 'ram', 'memory', 'internal', 'external',
  'solid', 'state', 'drive', 'cache', 'laptop', 'notebook', 'desktop', 'module', 'kit',
  'gaming', 'computer', 'tower', 'chassis', 'case', 'mesh', 'airflow', 'tempered', 'glass',
  'performance', 'mid', 'full', 'mini', 'micro', 'compact', 'atx', 'matx', 'itx', 'eatx',
  'power', 'supply', 'modular', 'cooler', 'fan', 'rgb', 'argb', 'black', 'white', 'series',
  'gen', 'high', 'speed', 'low', 'profile', 'dual', 'single', 'triple', 'rank', 'registered',
  'mhz', 'gbps', 'rpm', 'inch', 'class', 'plus', 'pro', 'max', 'boost', 'ready', 'edition',
  // PSU / power marketing — added 2026-07-28 to close the shared-commodity-word brand
  // defeat (a Montech PSU rescued a match to an NZXT one because both said "Fully
  // Modular"). These words carry no product identity; they must not count as a shared
  // distinctive token in brandMismatch().
  'fully', 'semi', 'gold', 'bronze', 'platinum', 'titanium', 'cybenetics', 'efficiency',
  'certified', 'compatible', 'coverage', 'warranty', 'watt', 'watts',
]);
function distinctiveTokens(name) {
  const out = new Set();
  for (const w of String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/)) {
    if (w.length < 4) continue;          // too short to identify (cl22, 2280 slip through as noise anyway)
    if (UNIT_TOKEN.test(w)) continue;    // 32gb, 5600mhz, 3200
    if (SPEC_STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * True when a name match rests ONLY on commodity spec — our brand is
 * identifiable, absent from the candidate, AND the two names share no
 * distinctive (non-spec) identifier. Truncation is safe: a candidate that omits
 * the brand but still shares the MODEL ("Lancool II" ↔ "Lancool II Chassis") is
 * kept; only a different maker sharing nothing but "32GB DDR5 ECC" is dropped.
 * Returns false (can't judge → don't gate) when we have no reliable brand token.
 */
export function brandMismatch(ourProduct, candidateName) {
  const forms = ourBrandForms(ourProduct);
  if (!forms.length) return false;
  const hay = ' ' + String(candidateName || '').toLowerCase().replace(/[^a-z0-9]/g, '') + ' ';
  const hayWords = ' ' + String(candidateName || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  for (const f of forms) {
    // Multi-word forms ("western digital") match on the word-normalized string;
    // single tokens match as a substring so "wd" catches "wd8005ffbx".
    if (f.includes(' ') ? hayWords.includes(' ' + f + ' ') || hayWords.includes(f) : hay.includes(f)) {
      return false; // brand (or a corporate alias) is present — fine
    }
  }
  // Brand absent. Only a mismatch if there is ALSO no shared distinctive token —
  // otherwise the candidate is a brand-truncated title of the same product.
  const ourD = distinctiveTokens(ourProduct.n);
  const theirD = distinctiveTokens(candidateName);
  for (const t of ourD) if (theirD.has(t)) return false;
  return { reason: 'brand', detail: `ours=[${forms.join('|')}] absent, no shared model token` };
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
  // Last, because these are the narrowest: both sides must name the thing
  // before either can say anything at all.
  return modelSuffixConflict(ourName, theirName)
    || formFactorConflict(ourName, theirName);
}

// Classify a notes.reject code into the bucket a caller should count it under.
// Prefix-based on purpose: adding a gate should not require touching every
// caller's tally, and a miscategorised guard reject would corrupt either the
// deletion clock ('variant') or the dry-run's variant numbers.
export function rejectKind(code) {
  if (!code) return null;
  if (code.startsWith('variant_')) return 'variant';
  if (code.startsWith('guard_')) return 'guard';
  if (code === 'below_attach_floor') return 'floor';
  return 'other';
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
  // Every gate below now STAMPS notes.reject. They used to return null in
  // silence, so their rejects were indistinguishable from "the feed had nothing
  // like our product" and were reported as no_match — the capacity guard in
  // particular could reject any number of candidates and show up as zero.
  // Callers classify by PREFIX (see REJECT_KIND); a guard reject must never be
  // counted as a variant reject, because variantRejects gates the deletion
  // clock in searchNewegg and inflating it would quietly suppress removals.
  const set = (r) => { if (notes) notes.reject = r; return null; };
  if (ourProduct.pr && neweggItem.price && neweggItem.price > ourProduct.pr * MAX_PRICE_MULTIPLIER) {
    return set('guard_price_multiplier');
  }
  if (/\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Bundle|Combo)\b/i.test(neweggItem.name)) {
    return set('guard_prebuilt_or_bundle');
  }
  const storedCap = ourProduct.cap != null ? ourProduct.cap : parseCapacityGB(ourProduct.n);
  if (!capacityCompatible(storedCap, parseCapacityGB(neweggItem.name))) {
    return set('guard_capacity_mismatch');
  }
  if (STORAGE_CATS.has(ourProduct.c) &&
      !isPricePlausibleForCapacity(neweggItem.price, storedCap, { isHDD: isHardDrive(ourProduct) })) {
    return set('guard_capacity_price_implausible');
  }
  // BEFORE the UPC shortcut, not after: an Open Box unit shares the new unit's
  // UPC, so this is the one check UPC equality cannot stand in for.
  const cond = conditionMismatch(ourProduct.n, neweggItem.name);
  if (cond) return set('variant_condition');
  // Model-line / wattage / modularity conflicts (2026-07-28). Conflict-only and
  // symmetric, so — like conditionMismatch above — they run BEFORE the UPC shortcut:
  // a barcode cannot change a product's wattage or family, so a stated disagreement
  // is positive evidence the UPC (or the name match) is wrong, not just truncation.
  if (wattageConflict(ourProduct.n, neweggItem.name)) return set('variant_wattage');
  if (modularityConflict(ourProduct.n, neweggItem.name)) return set('variant_modularity');
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
  // Model-line conflict runs HERE, after the similarity floor: it is a same-family
  // discriminator (Straight Power vs Pure Power), meaningful only between products
  // that are otherwise similar. Two unrelated products differ on every head word and
  // must be rejected as no_match by the floor above, never counted as a variant reject
  // (that would falsely signal the feed carries our product line — see searchNewegg).
  const brandToks = new Set(String(ourProduct.b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
  if (lineConflict(ourProduct.n, neweggItem.name, brandToks)) {
    if (notes) notes.reject = 'variant_model_line';
    return null;
  }
  // Brand gate — LAST, and name-path only (UPC returned above). A high name
  // score on commodity spec tokens is not evidence of the same PRODUCT when the
  // makers differ; require our brand to actually appear in the candidate.
  const bm = brandMismatch(ourProduct, neweggItem.name);
  if (bm) return set('variant_brand');
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
  const queries = buildQueries(product.n, product.b, { broaden: !NO_BROADEN_CATS.has(product.c) })
    .map((q) => ({ [q.mode]: q.q, cat: catFilter, mid, max: '20' }));
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
  const base = { rawCount: items.length, httpErrors, queriesTried, variantRejects: 0, guardRejects: 0 };
  // Every query we issued errored — we learned nothing about this product.
  if (httpErrors === queriesTried) return { ok: false, reason: 'http_error', candidates: [], ...base };
  if (!items.length) return { ok: false, reason: 'no_results', candidates: [], ...base };

  let variantRejects = 0;
  let guardRejects = 0;
  const scored = items.map((it) => {
    const notes = {};
    const match = scoreMatch(product, it, notes);
    if (!match) {
      const kind = rejectKind(notes.reject);
      if (kind === 'variant') variantRejects++;
      else if (kind === 'guard') guardRejects++;
    }
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
    // A guard reject is ALSO evidence of presence, not absence: the capacity
    // gate only fires on a candidate that got far enough to have a capacity
    // compared. Ranked below variant so an explicit variant rejection still
    // reads as one, but either must keep the deletion clock from starting.
    return {
      ok: false,
      reason: variantRejects ? 'variant_rejected' : guardRejects ? 'guard_rejected' : 'no_match',
      candidates: [], ...base, variantRejects, guardRejects,
    };
  }
  return { ok: true, candidates: scored, ...base, variantRejects, guardRejects };
}

// ── Cross-retailer sanity gate for a candidate Newegg price (peers: amazon, bestbuy)
export function neweggSanity(product, candidatePrice) {
  // Absolute per-type band FIRST — floor AND ceiling. A systematically inflated
  // feed sails past the relative peer check below (peers may be missing, or
  // equally inflated), and a mispriced/mismatched module can fall clean through
  // the floor; gate on the real-market band regardless of peers. See priceValidate
  // in normalize-product-name.js. This protects the ingest/refresh/fetch paths the
  // same way the discovery batch's absolute stage protects fresh rows.
  const av = priceValidate(product && product.c, {
    memType: product && (product.memType || product.ramType),
    ramType: product && product.ramType,
    ecc: product && product.ecc,
    cap: product && product.cap,
    storageType: product && product.storageType,
    isHDD: isHardDrive(product || {}),
    watts: product && (product.watts || product.wattage),
  }, candidatePrice);
  if (av.status === 'quarantine') {
    return { pass: false, cls: av.reason === 'below_floor' ? 'ABSOLUTE_FLOOR' : 'ABSOLUTE_CEILING',
      ref: av.reason === 'below_floor' ? av.floor : av.ceiling, deviation: av.ppu,
      unit: av.unit, dispConflict: false, spread: null };
  }
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
