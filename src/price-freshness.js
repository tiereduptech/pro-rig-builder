// =============================================================================
//  src/price-freshness.js
//
//  How old a retailer price may be before the site stops quoting it.
//
//  Extracted from App.jsx so that the report which measures the impact of this
//  gate (scripts/report-stale-badges.mjs) runs the SAME rule the page runs. A
//  report that reimplements the predicate it is measuring can only tell you
//  about itself.
// =============================================================================

// 14 days is not a new number. It is the same window as MOVEMENT_WINDOW_DAYS in
// scripts/price-movement.cjs and the MSI quiet-days assert: the slowest weekly
// refresh tier x two missed cycles, i.e. long enough that a gap is a real
// outage rather than one skipped run.
//
// Both of those files already cite "PRICE_STALE_AFTER_DAYS in src/App.jsx" as
// their justification. It had never been defined there. Two backend thresholds
// were anchored to a frontend gate that did not exist, which is a large part of
// why the gap stayed invisible for so long — the backend read as though the
// frontend were enforcing something. Defining it makes those comments true.
//
// Change this and you change what the site is willing to put its name on.
export const PRICE_STALE_AFTER_DAYS = 14;

// The stamps that mean "we asked the retailer and this was the answer".
//
// `matchedAt` is deliberately NOT one of them: it records when a row was bound
// to a SKU, not when its price was last confirmed. Treating it as freshness
// would certify the worst rows in the catalog — all 182 newegg_openbox rows
// carry matchedAt and have never had a price confirmed even once.
export const priceStampOf = (d) => (d && (d.refreshedAt || d.priceConfirmedAt)) || null;

// '2026-08-28T13:00:00Z' | '2026-08-28' -> '2026-08-28'; anything else -> null.
//
// Same strict prefix match as dayOnly() in scripts/price-movement.cjs, and for
// the same reason: Date.parse is lenient enough to be dangerous here. It reads
// the number 42 as the year 2042 and finds a date in free text, so a garbage
// stamp would parse as a FUTURE date and certify the row as fresh forever.
// A stamp we cannot read is not evidence.
function dayOnly(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// A row with NO stamp is STALE, not fresh.
//
// That is the majority case for some retailers — 1,093 Newegg rows and every
// one of the 182 newegg_openbox rows carry no price stamp at all — and a
// default that favoured the unstamped row would exempt precisely the rows with
// the least evidence behind them.
export function isFresh(d, now = Date.now()) {
  const age = priceAgeDays(d, now);
  return age != null && age <= PRICE_STALE_AFTER_DAYS;
}

// Days since the price was last confirmed; null when it never was.
//
// BOTH sides are truncated to their day before subtracting. Stamps arrive in two
// shapes — '2026-08-28' from the Newegg refresher, a full ISO timestamp from
// Best Buy — so comparing a day-truncated stamp against a full-precision `now`
// silently added up to 24h of age. A row stamped exactly PRICE_STALE_AFTER_DAYS
// ago read as 14.5 days and went stale half a day early, and which side of the
// line a row fell on depended on the hour the page was rendered.
export function priceAgeDays(d, now = Date.now()) {
  const stamp = dayOnly(priceStampOf(d));
  if (!stamp) return null;
  const a = Date.parse(stamp + 'T00:00:00Z');
  const b = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}
