// =============================================================================
//  src/search-match.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  The one product matcher. Every search box on the site routes through here:
//  the desktop and mobile browse pages, both builder part pickers, the tool
//  dropdowns (SearchSelect) and the compare tool. There were three separate
//  implementations before this file existed and they disagreed with each other
//  about what "rtx 5060 t" means.
//
//  ── The rule ────────────────────────────────────────────────────────────────
//  A query matches a product when EVERY query token is a prefix of SOME word in
//  that product's text. Order does not matter, punctuation does not matter, and
//  a half-typed word still matches.
//
//  Prefix-of-a-word, not substring-anywhere, is the whole design. Substring
//  matching is what made "650" match the ASIN fragment `cm8071504650608`, and
//  it is what a future change is most likely to reintroduce by reaching for
//  String.includes on a raw blob. test/search-match.test.js pins that shut.
//
//  ── Why the blob is a space-fenced string ───────────────────────────────────
//  Matching is one native indexOf per query token per product: we normalize the
//  product's text into a single string whose every word is preceded by a space,
//  pad the ends, and then a word-prefix test is exactly `blob.includes(' ' + t)`.
//  Over the ~5,000-row catalog that is ~2-4ms per keystroke against ~22ms for
//  the regex-per-token-per-product scheme it replaces, and the blobs are built
//  once per product rather than rebuilt on every keystroke.
//
//  ── What is deliberately NOT here ───────────────────────────────────────────
//  Ranking. This module answers yes/no; callers sort by price/bench as they
//  always have. Relevance scoring is a separate piece of work — an exact model
//  match does not float above a bundle that merely mentions the model, and that
//  is a known gap, not an oversight.
// =============================================================================

// A token that is letters-then-digits or digits-then-letters ("b650", "8gb",
// "5060ti"). Both the product text and the query get split on this boundary so
// "b650" is findable as "650" and "5060ti" finds a product spelled "5060 Ti".
const GLUED = /^([a-z]+)(\d+)$|^(\d+)([a-z]+)$/;
const gluePieces = (tok) => {
  const m = GLUED.exec(tok);
  if (!m) return null;
  return m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
};

// Query token -> alternates that also count as a hit. Kept small on purpose:
// every entry here is a permanent widening of the result set, so it earns its
// place only when the two spellings are genuinely the same thing to a shopper.
const SYNONYMS = {
  ram: ['memory'], memory: ['ram'],
  gpu: ['graphics', 'video'], graphics: ['gpu', 'video'], video: ['gpu', 'graphics'],
  cpu: ['processor'], processor: ['cpu'],
  mobo: ['motherboard'], motherboard: ['mobo'],
  psu: ['power'],
  ssd: ['nvme', 'solid'], hdd: ['hard'],
  // Brands the catalog and the shopper spell differently. "gskill" cannot reach
  // "G.SKILL" by prefix once the dot becomes a space, and "wd" is how everyone
  // types Western Digital.
  wd: ['western'], gskill: ['skill'],
};

/**
 * Fold arbitrary product text into the matchable form: lowercase, punctuation
 * to spaces, one leading and trailing space so the first and last words are
 * prefix-addressable like every other word.
 *
 * Glued alphanumeric words are ALSO indexed as their two pieces, appended after
 * the text. Each pair is fenced with a "~" because the pieces are appended
 * adjacently: without the fence, indexing "b650" and "x670" would leave the
 * string "...b 650 x 670..." and the query "650x" would match the seam between
 * two unrelated model numbers. "~" can never appear in a normalized query, so
 * the fence is unmatchable by construction.
 */
export function normalizeText(raw) {
  const base = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!base) return ' ';
  const pairs = [];
  for (const tok of base.split(' ')) {
    const pieces = gluePieces(tok);
    if (pieces) pairs.push(pieces[0] + ' ' + pieces[1]);
  }
  return ' ' + base + (pairs.length ? ' ~ ' + pairs.join(' ~ ') : '') + ' ';
}

/** Split a user's query the same way the product text was split. */
export function tokenizeQuery(query) {
  return String(query == null ? '' : query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenHit(blob, tok) {
  if (blob.includes(' ' + tok)) return true;            // prefix of some word
  // A glued query token may be spelled apart in the product text: "5060ti"
  // against "RTX 5060 Ti". Require the two pieces ADJACENT — the loose version
  // of this ("the digits appear somewhere AND the letters match a word") is
  // what made "2tb" match every 1TB drive whose form factor is M.2 2280.
  const pieces = gluePieces(tok);
  if (pieces && blob.includes(' ' + pieces[0] + ' ' + pieces[1])) return true;
  const alts = SYNONYMS[tok];
  if (alts) { for (const alt of alts) if (blob.includes(' ' + alt)) return true; }
  return false;
}

/** Does a query match an already-normalized blob? Every token must hit. */
export function matchesNormalized(blob, query) {
  const toks = tokenizeQuery(query);
  for (let i = 0; i < toks.length; i++) if (!tokenHit(blob, toks[i])) return false;
  return true;
}

/**
 * Match a query against a raw string. For option lists (SearchSelect) that are
 * rebuilt on every render, so there is no stable object to cache against — the
 * lists are a few hundred short strings and normalizing them is not worth a
 * cache that would have to be invalidated.
 */
export function matchesText(text, query) {
  if (!query) return true;
  return matchesNormalized(normalizeText(text), query);
}

// The searchable text of a product, in one place. A field belongs here if a
// shopper might type it; `id`, `img`, prices and timestamps deliberately do not
// (an ASIN-looking number in a query should find the ASIN, not a price).
function productText(p) {
  const cap = p.cap;
  return [
    // identity
    p.n, p.b, p.fullTitle, p.model, p.mpn, p.asin,
    // platform / fit
    p.socket, p.arch, p.memType, p.chipset, p.interface, p.ff, p.formFactor,
    p.storageType, p.ramType, p.coolerType, p.tower, p.wifi, p.nand, p.color,
    p.eff, p.panel,
    // resolution lives under two different keys depending on the ingest that
    // wrote the row; indexing only `res` lost every row that carries the other
    p.res, p.resolution,
    p.pcie != null && 'pcie' + p.pcie,
    // numbers a shopper types with their unit attached. The glue-splitting in
    // normalizeText makes the bare number findable too, so "6000" still finds
    // a 6000MHz kit without indexing it twice.
    p.cores != null && p.cores + 'core',
    p.threads != null && p.threads + 'thread',
    p.vram != null && p.vram + 'gb',
    // capacity is stored in GB; nobody shops for a "2000GB" drive
    cap != null && (cap >= 1000 && cap % 1000 === 0 ? cap + 'gb ' + (cap / 1000) + 'tb' : cap + 'gb'),
    p.speed != null && p.speed + 'mhz',
    p.cl != null && 'cl' + p.cl,
    p.sticks != null && p.sticks + 'stick',
    p.watts != null && p.watts + 'w ' + p.watts + 'watt',
    p.tdp != null && p.tdp + 'w',
    p.refresh != null && p.refresh + 'hz',
    p.rpm != null && p.rpm + 'rpm',
    p.fanSize != null && p.fanSize + 'mm',
  ].filter(Boolean).join(' ');
}

/** Normalized searchable text for one product. Exported for the tests. */
export function buildProductBlob(p) {
  return normalizeText(productText(p));
}

// Blobs are built once and kept against the product OBJECT, not its id.
//
// The catalog arrives category by category (parts-frontend.js dynamic-imports
// each chunk) and App.jsx rebuilds its derived arrays each time a chunk lands,
// which produces fresh objects. Keying on the object means those rebuilds
// invalidate themselves — the old entries become unreachable and the GC takes
// them — where an id-keyed Map would hand back a blob built from a superseded
// row and there would be nothing to notice it. Rebuilding all ~5,000 blobs
// costs ~30ms, once, off the first keystroke after a chunk loads.
const blobCache = new WeakMap();

/** Normalized searchable text for a product, cached for the object's lifetime. */
export function blobOf(p) {
  let blob = blobCache.get(p);
  if (blob === undefined) {
    blob = buildProductBlob(p);
    blobCache.set(p, blob);
  }
  return blob;
}

/**
 * THE matcher. True when every token in `query` prefixes a word in the
 * product's searchable text. An empty query matches everything.
 */
export function smartMatch(p, query) {
  if (!query) return true;
  return matchesNormalized(blobOf(p), query);
}
