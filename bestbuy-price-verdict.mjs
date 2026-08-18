/**
 * bestbuy-price-verdict.mjs — what a probed row is allowed to conclude.
 *
 * Extracted from probe-bestbuy-price-truth.mjs, which is a straight-line
 * script and cannot be imported. This rule decides whether anyone builds a
 * Best Buy refresh cron, so it is worth pinning in a test rather than reading
 * off a run summary.
 *
 * ── WHY NO-SALEPRICE EXISTS ──────────────────────────────────────────────────
 * The probe compares three numbers: `stored` (deals.bestbuy.price in the
 * catalog), `sale` (the Developer API's salePrice) and `live` (what a customer
 * actually pays). The question it exists to answer is whether `sale` is the
 * right field — so a row with no `sale` at all cannot answer it.
 *
 * Until 2026-08-18 such a row fell through to STALE-ONLY on `stored != live`
 * alone, because the FIELD-WRONG test required a non-null sale→live delta and
 * nothing below it re-checked. Run 32172326071 did exactly that: sku 11013277
 * is a 404 at Best Buy, so the API published no salePrice, and the row was
 * still tallied STALE-ONLY — a bucket the summary defines as "`salePrice` is
 * correct, stored value is old — build the refresh job". A sample full of dead
 * skus would have read as a unanimous argument for the cron, which is the
 * opposite of what those rows show.
 *
 * A dead sku is a catalog-liveness finding, not a pricing-field finding. It
 * gets its own bucket and abstains.
 */

// Sub-cent differences are float noise, not price movement.
export const EPSILON = 0.01;

export const VERDICTS = ['FIELD-WRONG', 'STALE-ONLY', 'NO-SALEPRICE', 'AGREE', 'UNRESOLVED'];

/**
 * `stored` is always present — the sample is built from rows that carry a Best
 * Buy deal price. `sale` and `live` are each nullable and mean different kinds
 * of nothing: no salePrice is an answer about the sku, no live price is a
 * failure to reach one.
 */
export function classify({ stored, sale, live }) {
  if (live == null) return 'UNRESOLVED';
  if (sale == null) return 'NO-SALEPRICE';
  if (Math.abs(live - sale) > EPSILON) return 'FIELD-WRONG';
  if (stored != null && Math.abs(live - stored) > EPSILON) return 'STALE-ONLY';
  return 'AGREE';
}

/** Counts keyed by verdict, every bucket present so a zero prints as a zero. */
export function tallyOf(verdicts) {
  const t = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  for (const v of verdicts) if (v in t) t[v]++;
  return t;
}
