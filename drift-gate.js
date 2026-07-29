/**
 * drift-gate.js — SINGLE SOURCE OF TRUTH for catalog price-drift verification.
 *
 * Imported by verify-catalog-asins.js (the nightly, production writes) and by
 * reverify-604-report.mjs (report-only). There is exactly ONE copy of the gate
 * and its threshold; do not re-declare either anywhere else.
 *
 * ── WHY DRIFT AND CEILINGS ARE SEPARATE GATES ────────────────────────────────
 * Drift gate and absolute ceilings do different jobs.
 *   - Drift catches MOVEMENT: a price that changed more than the market
 *     plausibly could.
 *   - Ceilings catch IMPOSSIBLE VALUES: a price no real product has,
 *     regardless of history.
 * A loose drift trigger is safe only because the ceilings backstop it.
 * Never loosen both. If a future recalibration widens one, verify the
 * other still catches the 3x+ wrong-attach class.
 *
 * ── ASYMMETRIC BY DESIGN ─────────────────────────────────────────────────────
 * A price DROP is the market working, never a data defect — accepted freely.
 * The storage $/capacity floor is the ONLY guard that still fires on a drop,
 * because an impossibly-cheap price is a wrong-ASIN, not a sale. Upward moves:
 *   - rise <= RISE_TRIGGER  → normal / shortage volatility → accepted
 *   - rise >  RISE_TRIGGER  → cross-retailer sanity gate decides
 *
 * RISE_TRIGGER = 1.30 was calibrated 2026-07-28 against the 604-row re-verify:
 * the DDR5-shortage doublings top out at +105% (real), the 3x+ wrong-attach
 * class starts at +146% (corrupt), and +130% sits in the empty band between the
 * two populations. When the shortage ends this will read too loose — the stamp
 * (DRIFT_GATE_CALIBRATED_AT) and the staleness warning say so out loud.
 */

import { parseCapacityGB, capacityCompatible, isHardDrive, isPricePlausibleForCapacity } from './normalize-product-name.js';
import { selectNewOffer, lowestAnyConditionPrice, amazonPriceSanity } from './amazon-price.js';

// Categories where a stated capacity is a hard identity gate.
export const STORAGE_CATS = new Set(['Storage', 'ExternalStorage']);

// ── Drift-gate calibration (stamped like PRICE_TABLE; mirrors validatePriceBatch) ──
export const RISE_TRIGGER = 1.30;                 // upward drift trigger; drops always accept
export const DRIFT_GATE_CALIBRATED_AT = '2026-07-28';
export const DRIFT_GATE_MAX_AGE_DAYS  = 90;       // recalibrate at least this often
export const DRIFT_STALE_FAILURE_RATE = 0.30;     // > this share of a category flagged → gate stale, not data
// Below this |move| a price is treated as noise: accepted with no write and no
// review. Governs WHETHER WE REFRESH the stored price only — never quarantine.
export const PRICE_REFRESH_MIN = 0.05;

// ── Link-verification marker (mirrors asin-overrides "source: verified" / verifiedAt) ──
//
// A human-verified deal LINK carries `linkVerifiedAt` (YYYY-MM-DD) and, by the
// asin-overrides vocabulary, `linkVerifiedSource: 'verified'`. The nightly SKIPS
// re-verifying such a row — but ONLY while the verification is still current.
//
// CURRENCY RULE (the whole point): the marker INVALIDATES the moment the deal's
// link identity changes. It is compared against lastDealChangedAt(), never trusted
// as a bare boolean — a hand-verified row whose ASIN is later swapped by an ingest
// goes straight back through the gate. And a marker with NO deal-change baseline to
// compare against is NOT honored (re-verify), so it can never become a permanent
// bypass that hides later corruption forever.
export const LINK_VERIFIED_SOURCE = 'verified';

// Most-recent date this row's deal LINK identity (ASIN / URL / SKU / vendor) last
// changed, from every signal we keep: the canonical `dealChangedAt` an ingest stamps
// on a swap, the newegg feed's matchedAt / rematchedAt, and the row's creation stamps
// (addedAt / discoveredAt). Returns a YYYY-MM-DD string, or null if nothing is known.
// Lexical comparison of YYYY-MM-DD equals chronological order, so a plain max works.
export function lastDealChangedAt(product) {
  const p = product || {};
  const dates = [];
  const push = v => { if (v) dates.push(String(v).slice(0, 10)); };
  push(p.dealChangedAt);
  for (const d of Object.values(p.deals || {})) {
    if (!d) continue;
    push(d.linkedAt); push(d.matchedAt); push(d.rematchedAt);
  }
  push(p.addedAt); push(p.discoveredAt);
  return dates.length ? dates.sort().pop() : null;
}

// Is this row's link verification still valid RIGHT NOW? Requires a marker AND a
// known deal-change baseline AND the marker to be at least as new as that baseline
// (day granularity, matching asin-overrides' date-only verifiedAt). No baseline →
// not current: we cannot prove the deal is unchanged since verification, so we never
// blindly trust it.
export function linkVerificationCurrent(product) {
  const p = product || {};
  if (!p.linkVerifiedAt) return false;
  const changed = lastDealChangedAt(p);
  if (!changed) return false;
  return String(p.linkVerifiedAt).slice(0, 10) >= changed;
}

// Stamp a deal-identity change. Every ingest that swaps an ASIN / URL / SKU / vendor
// MUST call this so any prior linkVerifiedAt goes stale on the next gate pass.
export function stampDealChange(product, isoDate) {
  if (!product) return product;
  const day = String(isoDate || '').slice(0, 10);
  if (day) product.dealChangedAt = day;
  return product;
}

// Record a human link verification. Sets the marker AND guarantees a deal-change
// baseline exists (so the marker is comparable, never a bare boolean). Vocabulary
// mirrors asin-overrides: source 'verified' + a date.
export function markLinkVerified(product, { at, by } = {}) {
  if (!product) return product;
  const day = String(at || '').slice(0, 10);
  product.linkVerifiedAt = day;
  product.linkVerifiedSource = LINK_VERIFIED_SOURCE;
  if (by) product.linkVerifiedBy = by;
  if (!lastDealChangedAt(product)) product.dealChangedAt = day;
  return product;
}

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function titleMatches(storedName, amazonTitle, storedCap = null) {
  if (!storedName || !amazonTitle) return { match: false, score: 0 };
  const a = normalize(storedName);
  const b = normalize(amazonTitle);
  const tokensA = new Set(a.split(' ').filter(t => t.length >= 3));
  const tokensB = new Set(b.split(' ').filter(t => t.length >= 3));
  if (!tokensA.size) return { match: false, score: 0 };
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const score = hits / tokensA.size;
  const modelTokensA = [...tokensA].filter(t => /\d/.test(t) && /[a-z]/.test(t));
  const modelMatch = modelTokensA.length === 0 || modelTokensA.some(t => tokensB.has(t));
  // Capacity is a HARD gate: vendors reuse one title across every capacity, so
  // token overlap alone "matches" a 128GB listing to a 2TB product.
  const capA = storedCap ?? parseCapacityGB(storedName);
  const capB = parseCapacityGB(amazonTitle);
  const capConflict = !capacityCompatible(capA, capB);
  return { match: score >= 0.5 && modelMatch && !capConflict, score: Math.round(score * 100) / 100, capConflict };
}

function today() { return new Date().toISOString().slice(0, 10); }

export function analyzeResult(product, amazonData) {
  const issues = [];
  const fixes = {};
  if (!amazonData) {
    issues.push({ type: 'no_data', severity: 'high', msg: 'No data returned' });
    return { issues, fixes };
  }
  const azTitle = amazonData.title || amazonData.product_title;
  const tm = titleMatches(product.n, azTitle, product.cap);

  if (!tm.match) {
    // A capacity conflict is a wrong-product attach, not just a renamed listing.
    if (tm.capConflict) {
      issues.push({ type: 'capacity_mismatch', severity: 'high',
        msg: `Capacity mismatch — stored ${product.cap ?? parseCapacityGB(product.n)}GB vs listing ${parseCapacityGB(azTitle)}GB; refusing to trust ASIN`,
        stored: product.n, amazon: azTitle });
    } else {
      issues.push({ type: 'title_mismatch', severity: 'high',
        msg: `Title mismatch (score=${tm.score})`, stored: product.n, amazon: azTitle });
    }
    return { issues, fixes };
  }

  // Pick the NEW-condition Buy Box price. Never a used/3rd-party-condition offer.
  const offer = selectNewOffer(amazonData);
  const storedPrice = product.deals?.amazon?.price;
  if (!offer) {
    issues.push({ type: 'no_new_offer', severity: 'high',
      msg: `No New-condition offer on listing (lowest any-condition $${lowestAnyConditionPrice(amazonData) ?? '?'}); refusing to write a price`,
      stored: storedPrice ?? null, amazon: null });
    fixes.needsReview = true;
    fixes.quarantinedAt = today();
    return { issues, fixes };
  }
  const azPrice = offer.price;

  if (azPrice != null && storedPrice != null) {
    const signed = (azPrice - storedPrice) / Math.max(storedPrice, 1);  // + rise, − drop
    const abs = Math.abs(signed);
    const cap = product.cap ?? parseCapacityGB(product.n);

    // (1) Ceiling backstop — an impossible $/capacity price is a wrong-ASIN in
    //     EITHER direction, so this fires even on a drop the drift path waves
    //     through. This is the guardrail that makes a loose RISE_TRIGGER safe.
    if (STORAGE_CATS.has(product.c) && !isPricePlausibleForCapacity(azPrice, cap, { isHDD: isHardDrive(product) })) {
      issues.push({ type: 'implausible_price', severity: 'high',
        msg: `Refused price $${azPrice} — $${(azPrice / (cap / 1000)).toFixed(2)}/TB impossible for ${cap}GB; ASIN likely wrong`,
        stored: storedPrice, amazon: azPrice });
      fixes.needsReview = true;
      fixes.quarantinedAt = today();

    // (2) Suspect upward spike — only the wrong-attach / gouge tail rises this
    //     far. Cross-retailer sanity gate decides: corroborated writes, else quarantine.
    } else if (signed > RISE_TRIGGER) {
      const sanity = amazonPriceSanity(product, azPrice);
      if (sanity.pass) {
        issues.push({ type: 'price_drift', severity: 'medium',
          msg: `Rise ${(signed * 100).toFixed(1)}% (> +${RISE_TRIGGER * 100 | 0}% trigger) — New ${offer.source} ($${azPrice}, ${offer.seller || '?'}); sanity OK`,
          stored: storedPrice, amazon: azPrice });
        fixes.amazonPrice = azPrice;
      } else {
        issues.push({ type: 'price_drift_flagged', severity: 'high',
          msg: `Rise ${(signed * 100).toFixed(1)}% (> +${RISE_TRIGGER * 100 | 0}% trigger) — New price $${azPrice} FLAGGED (cls=${sanity.cls}` +
               `${sanity.dispConflict ? `, spread=${sanity.spread?.toFixed(2)}x` : ''}); not auto-written`,
          stored: storedPrice, amazon: azPrice });
        fixes.needsReview = true;
        fixes.quarantinedAt = today();
      }

    // (3) A real move that is not a suspect upward spike: a drop of any size, or a
    //     rise within the volatility band. The market working — refresh, no review.
    } else if (abs > PRICE_REFRESH_MIN) {
      const dir = signed < 0 ? 'Drop' : 'Rise';
      issues.push({ type: signed < 0 ? 'price_drop' : 'price_rise', severity: 'low',
        msg: `${dir} ${(signed * 100).toFixed(1)}% — New ${offer.source} ($${azPrice}, ${offer.seller || '?'}); within tolerance, accepted`,
        stored: storedPrice, amazon: azPrice });
      fixes.amazonPrice = azPrice;

    // (4) Sub-refresh-epsilon noise — leave the stored price untouched, no review.
    } else {
      issues.push({ type: 'price_ok', severity: 'low',
        msg: `Move ${(signed * 100).toFixed(1)}% within ±${PRICE_REFRESH_MIN * 100 | 0}% — no change`,
        stored: storedPrice, amazon: azPrice });
    }
  } else if (azPrice != null && storedPrice == null) {
    // No stored price yet — attach the New price only if it passes the gate.
    const sanity = amazonPriceSanity(product, azPrice);
    if (sanity.pass) {
      fixes.amazonPrice = azPrice;
    } else {
      issues.push({ type: 'price_attach_flagged', severity: 'high',
        msg: `New price $${azPrice} FLAGGED on attach (cls=${sanity.cls}); not auto-written`,
        stored: null, amazon: azPrice });
      fixes.needsReview = true;
      fixes.quarantinedAt = today();
    }
  }

  // Stock: a live New offer implies in-stock. (No New offer handled above.)
  const azInStock = true;
  const storedStock = product.deals?.amazon?.inStock;
  if (storedStock !== azInStock) {
    issues.push({ type: 'stock_mismatch', severity: 'medium', msg: `Stock changed`, stored: storedStock, amazon: azInStock });
    fixes.amazonInStock = azInStock;
  }
  return { issues, fixes };
}

// Which issue types belong to the drift gate (for staleness accounting).
export const DRIFT_GRADED_TYPES  = new Set(['price_ok', 'price_drop', 'price_rise', 'price_drift', 'price_drift_flagged', 'implausible_price']);
export const DRIFT_FLAGGED_TYPES = new Set(['price_drift_flagged', 'implausible_price']);

function daysBetweenISO(fromISO, toISO) {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86400000);
}

/**
 * Mirrors validatePriceBatch(): the gate assumes the DATA is wrong when a price
 * moves too far — but if a WHOLE category suddenly trips, it is the GATE that is
 * stale (the market moved), not the data. Warn loudly, quarantine, never drop.
 *   perCategory: { [cat]: { graded, flagged } }
 */
export function driftGateStaleness(perCategory, todayISO = null) {
  const warnings = [];
  for (const [cat, { graded, flagged }] of Object.entries(perCategory)) {
    if (graded < 8) continue;                       // too few graded rows to judge
    const rate = flagged / graded;
    if (rate > DRIFT_STALE_FAILURE_RATE)
      warnings.push(`DRIFT GATE STALE SUSPECTED [${cat}]: ${(rate * 100).toFixed(1)}% of ${graded} priced rows drift-quarantined (> ${DRIFT_STALE_FAILURE_RATE * 100}%). The market moved, not the data — rows QUARANTINED (needsReview), never dropped. Recalibrate RISE_TRIGGER (calibrated ${DRIFT_GATE_CALIBRATED_AT}).`);
  }
  const ageDays = todayISO ? daysBetweenISO(DRIFT_GATE_CALIBRATED_AT, todayISO) : null;
  if (ageDays != null && ageDays > DRIFT_GATE_MAX_AGE_DAYS)
    warnings.push(`DRIFT GATE STALE: calibrated ${DRIFT_GATE_CALIBRATED_AT}, ${ageDays}d ago (> ${DRIFT_GATE_MAX_AGE_DAYS}d). Recalibrate RISE_TRIGGER.`);
  return { warnings, calibratedAt: DRIFT_GATE_CALIBRATED_AT, ageDays };
}
