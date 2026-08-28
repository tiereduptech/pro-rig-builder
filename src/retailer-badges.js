// =============================================================================
//  src/retailer-badges.js
//
//  What the badges next to a retailer row are allowed to say.
//
//  Extracted from App.jsx for the same reason src/price-freshness.js was: the
//  decision and the check on the decision must be the same code. There the
//  check was a report; here it is a unit test, because the decision is what
//  regressed.
//
//  ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//  #73 added a freshness guard to the BEST badge and an UNCONFIRMED tag beside
//  stale prices. Both went into PriceCompare — a component that, per
//  `git log -S"<PriceCompare"`, has NEVER been rendered in the history of this
//  repo. Rollup tree-shakes an unreferenced component, so the string
//  "UNCONFIRMED" appeared zero times in the shipped bundle while the two
//  components that DO render retailer rows kept the old stock-only badge:
//
//      {ri===0 && r.inStock && rr.length>1 && <Tag>BEST</Tag>}
//
//  The data half of #73 shipped and works — retailers() sinks stale rows, so a
//  stale price no longer sorts to index 0 and no longer wins BEST positionally.
//  What did not ship is the half that matters when EVERY row is stale: index 0
//  is then stale, and with no freshness guard on the badge it still gets BEST.
//
//  The badge markup existed in the source the whole time. That is why the fix
//  is not "write the JSX again" but "have one definition of the rule, render it
//  from one component, and assert the result survives the build" — see
//  scripts/assert-bundle-markers.cjs.
// =============================================================================

// Whether the endorsement may be shown on this row.
//
// BEST is POSITIONAL — retailers() sorts, and the caller passes isBest for
// index 0. Because that sort already sinks out-of-stock and stale rows, index 0
// fails these tests only when every row does. That is exactly the case worth
// guarding: a "best price" nobody can buy, or that nobody has confirmed within
// PRICE_STALE_AFTER_DAYS, is not a best price. Badge the row or badge nothing.
//
// `isBest` carries the caller's own positional condition (index 0, and more
// than one retailer to be best OF) so this function stays a pure predicate over
// one row plus that verdict.
export function showBestBadge(r, isBest) {
  return Boolean(isBest && r && r.inStock && r.fresh);
}

// The text of the staleness tag, or null when the row does not warrant one.
//
// Say HOW stale, not just that it is: "UNCONFIRMED 93d" is a fact a reader can
// act on, where "UNCONFIRMED" alone reads as boilerplate. The bare form is the
// fallback for a row with no stamp at all, which is not a smaller problem — it
// is a row we have never confirmed even once — but we cannot put a number on
// something we never measured.
//
// Out-of-stock rows return null: the callers already print "✗ Out of Stock"
// next to the row, and stacking a staleness tag on top of it buries the harder
// failure under the softer one.
export function unconfirmedBadgeText(r) {
  if (!r || !r.inStock || r.fresh) return null;
  return r.ageDays == null ? 'UNCONFIRMED' : `UNCONFIRMED ${r.ageDays}d`;
}

// The literal substrings that must survive tree-shaking into the built bundle.
//
// This list is the contract between the render path and
// scripts/assert-bundle-markers.cjs. It lives HERE, next to the code that
// produces the strings, so that renaming a badge updates the assertion in the
// same edit rather than leaving a checker that greps for a string nothing
// emits any more — a green check proving only that it no longer looks at
// anything.
export const REQUIRED_BUNDLE_MARKERS = [
  {
    marker: 'UNCONFIRMED',
    why: 'the staleness tag from #73; absent from the bundle for as long as it lived in the unrendered PriceCompare',
  },
  {
    marker: 'BEST',
    why: 'the price endorsement; if this goes missing the row lost its badge cluster entirely',
  },
];
