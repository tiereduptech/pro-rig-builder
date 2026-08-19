// ═══════════════════════════════════════════════════════════════════
// asin-override-table.js — the known-good ASIN table, and the rule that a
// known-good ASIN belongs to ONE product.
//
// The table is keyed by canonicalizeProductName(). That key is a class for
// GPUs, cases and boards by design — "NVIDIA|RTX|5080" is 31 distinct cards in
// this catalog — so a lookup by key alone answers "which ASIN is verified for
// this class", and hands the same ASIN, at score 1.0, to every card in it.
// That is not a hypothetical: B0BNLSDRKB sits on the RX 7900 XTX, the 7900 XT
// and the 7900 GRE simultaneously, and verify-catalog-asins.js consults this
// table FIRST when repairing a mismatched ASIN, on a cron that runs every two
// days with --fix-asins.
//
// So the lookup here refuses to answer for a class. Two independent guards,
// because they fail differently:
//
//   1. THE BINDING. Each entry names the product it was verified against
//      (`verifiedName`). A product whose name is not that name gets nothing,
//      whatever key it shares. This is what makes an entry per-product.
//
//   2. THE COUNT. Built against the live catalog: if a key answers for more
//      than one product, it is refused outright, entry or no entry. This
//      catches a class key re-added later, or a key that becomes a class
//      because the catalog grew into it — neither of which the binding sees.
//
//   3. THE ASIN. One listing, one entry. The Ryzen 9 7900X and the 7900 each
//      key uniquely and each names its own product — both guards pass — and
//      both claimed B0BBJ59WJ4. Any ASIN claimed twice is refused for every
//      entry claiming it, because the table records nothing that says which.
//
// A refusal is not a failure. The verifier falls through to search, which is
// the path every product without an override already takes.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs';
import { canonicalizeProductName } from './normalize-product-name.js';

export const OVERRIDES_PATH = './src/data/asin-overrides.json';

/** Compare names the way a person would: same letters and digits, same order. */
export const normalizeForBinding = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function loadOverrides(file = OVERRIDES_PATH) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    console.warn(`Failed to load ${file}: ${e.message}`);
    return {};
  }
}

/**
 * @param {Array} parts    the live catalog
 * @param {Object} overrides  key -> {asin, verifiedName, ...}
 * @returns {{lookup: Function, stats: Object, refusals: Array}}
 */
export function buildOverrideIndex(parts, overrides) {
  // How many DISTINCT products each key answers for. Distinct by name, not by
  // row: a catalog that carries the same product twice is a dedupe problem,
  // and refusing an override over it would punish the wrong bug.
  const namesPerKey = new Map();
  for (const p of parts || []) {
    let k = null;
    try { k = canonicalizeProductName(p.n, p.c); } catch { k = null; }
    if (!k) continue;
    if (!namesPerKey.has(k)) namesPerKey.set(k, new Set());
    namesPerKey.get(k).add(normalizeForBinding(p.n));
  }

  // One listing, one entry (guard 3).
  const keysPerAsin = new Map();
  for (const [k, e] of Object.entries(overrides || {})) {
    if (!e?.asin) continue;
    if (!keysPerAsin.has(e.asin)) keysPerAsin.set(e.asin, []);
    keysPerAsin.get(e.asin).push(k);
  }

  const refusals = [];
  const stats = { hits: 0, refusedAmbiguous: 0, refusedContested: 0, refusedBinding: 0, refusedUnbound: 0, misses: 0 };

  function lookup(product) {
    let key = null;
    try { key = canonicalizeProductName(product.n, product.c); } catch { key = null; }
    if (!key) { stats.misses++; return null; }
    const entry = overrides[key];
    if (!entry) { stats.misses++; return null; }

    const answers = namesPerKey.get(key)?.size || 0;
    if (answers > 1) {
      stats.refusedAmbiguous++;
      refusals.push({ id: product.id, key, asin: entry.asin, why: `key answers for ${answers} distinct products` });
      return null;
    }
    const claims = keysPerAsin.get(entry.asin) || [];
    if (claims.length > 1) {
      stats.refusedContested++;
      refusals.push({ id: product.id, key, asin: entry.asin,
        why: `ASIN also claimed by ${claims.filter((k) => k !== key).join(', ')}` });
      return null;
    }
    // An entry with no binding predates this rule and cannot prove which
    // product it was verified for. Refuse rather than assume it meant this one.
    if (!entry.verifiedName) {
      stats.refusedUnbound++;
      refusals.push({ id: product.id, key, asin: entry.asin, why: 'entry names no verified product' });
      return null;
    }
    if (normalizeForBinding(entry.verifiedName) !== normalizeForBinding(product.n)) {
      stats.refusedBinding++;
      refusals.push({ id: product.id, key, asin: entry.asin,
        why: `verified for "${entry.verifiedName}", asked about "${product.n}"` });
      return null;
    }
    stats.hits++;
    return { asin: entry.asin, source: 'known-good-table', score: 1.0 };
  }

  return { lookup, stats, refusals, namesPerKey };
}
