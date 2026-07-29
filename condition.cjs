// Shared condition-marker gate — single source of truth for "is this listing a
// NON-NEW (renewed / refurbished / recertified / used / open-box) SKU?"
//
// Consumed by:
//   - newegg-match.js          (feed matcher — CONDITION_MARKERS token set)
//   - apply-amazon-discoveries.cjs   (Amazon discovery/relink TITLE gate)
//   - verify-catalog-asins.js  (replacement-ASIN TITLE gate, the newAsinUrl swap)
//
// CONDITION IS NOT IDENTITY: a renewed unit is a different product at a different
// price, and a UPC/ASIN/keyword search for a New part can return one. A live New
// offer on a renewed-titled listing does NOT make it the right SKU — the stored
// name (n: d.title) still advertises "Renewed" to the customer. Reject on title.
//
// Authored as CommonJS so the .cjs consumer can require() it synchronously; the
// ESM consumers import it via Node's CJS named-export interop.

// Token set for normalized name-vs-name comparison (newegg-match.js markerSet()).
// Kept identical to the set that lived inline in newegg-match.js — do not change
// values without updating newegg-match.variant.test.js.
const CONDITION_MARKERS = new Set(['openbox', 'refurbished', 'renewed', 'used']);

// Title-scan gate for the Amazon side. Deliberately conservative: unambiguous
// condition phrases only, so a genuine New product is never falsely rejected.
// Bare "used" is intentionally NOT matched (it collides with "for use", "used by")
// — Amazon used listings are caught by the "Used -", "Used:", "(Used" forms.
const RENEWED_TITLE_RE = new RegExp(
  [
    '\\b(?:renewed|refurbished|refurb|recertified|reconditioned|pre[\\s-]?owned|preowned|open[\\s-]?box|openbox)\\b',
    '\\bgrade\\s+[abc]\\b',
    '\\bused\\s*[-–—:]',   // "Used -", "Used:", "Used —"
    '\\(\\s*used\\b',                // "(Used", "(Used - Very Good)"
  ].join('|'),
  'i',
);

/** True when a listing TITLE advertises a non-New condition. */
function isRenewedTitle(title) {
  return RENEWED_TITLE_RE.test(String(title == null ? '' : title));
}

module.exports = { CONDITION_MARKERS, isRenewedTitle, RENEWED_TITLE_RE };
