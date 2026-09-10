#!/usr/bin/env node
/**
 * canonicalize-sponsored-amazon-links.mjs
 *
 * Rewrite Amazon deals whose link is a sponsored-ad click redirect to the
 * canonical product link every other Amazon row carries:
 *
 *   https://www.amazon.com/sspa/click?ie=UTF8&spc=…&url=%2F<slug>%2Fdp%2F<ASIN>%2F…&aref=…&tag=…
 *     ->  https://www.amazon.com/dp/<ASIN>?tag=tiereduptech-20
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node canonicalize-sponsored-amazon-links.mjs           # report only
 *   node canonicalize-sponsored-amazon-links.mjs --apply   # rewrite + write the catalog
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * verify-catalog selects a row only when its URL contains /dp/<ASIN>
 * (extractASIN in verify-catalog-asins.js). An sspa link carries the ASIN only
 * URL-ENCODED inside its `url=` parameter, so the verifier never selected these
 * rows. On main 2026-09-10 that was 13 visible products — headsets, mice, a
 * keyboard, a microphone, a webcam, cable kits — none ever confirmed, none ever
 * asked about, and none in any freshness measurement, because the gate dropped
 * rows with no stamp. A row no check can reach is invisible to every check.
 *
 * They were also ad clicks. Every visitor who followed one registered a click
 * on someone's sponsored placement, not an ordinary affiliate visit.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 * It does not guess an ASIN. The ASIN is the one inside the link we already
 * hold; a link whose `url=` has no /dp/<ASIN> is refused and listed. It does not
 * write a price or a confirmation stamp: the next verify-catalog tier pass
 * selects the row, checks the listing's title against the product, and either
 * confirms the price or sends it through ASIN repair like any other row.
 *
 * It also refuses an ASIN another product's Amazon deal already carries. Two rows
 * on one listing means at most one of them is right (audit-duplicate-asins.js),
 * and deciding which needs a person with the listing open.
 *
 * The rewrite changes the deal's link identity, so it calls stampDealChange —
 * the rule for every write path that swaps a URL.
 *
 * Writes through scripts/write-catalog.cjs. Fields only, no row added or
 * removed, so the size brakes stay at their defaults.
 */

import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { stampDealChange } from './drift-gate.js';

const require = createRequire(import.meta.url);
const PARTNER_TAG = 'tiereduptech-20';

// The verifier's own selection test (extractASIN in verify-catalog-asins.js).
export const SELECTABLE_ASIN = /\/dp\/([A-Z0-9]{10})/i;

/** Is this an Amazon sponsored-ad click redirect? */
export function isSponsoredRedirect(url) {
  try {
    const u = new URL(url);
    return /(^|\.)amazon\.com$/i.test(u.hostname) && u.pathname.startsWith('/sspa/click');
  } catch {
    return false;
  }
}

/**
 * The canonical link for a sponsored redirect, or null when the redirect does
 * not name a product. URLSearchParams has already decoded `url=` once, which is
 * exactly the one layer of encoding the redirect adds.
 */
export function canonicalFromSponsored(url) {
  if (!isSponsoredRedirect(url)) return null;
  const inner = new URL(url).searchParams.get('url') || '';
  const m = inner.match(/\/dp\/([A-Z0-9]{10})(?=[/?#]|$)/i);
  if (!m) return null;
  const asin = m[1].toUpperCase();
  return { asin, url: `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}` };
}

const IS_MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const APPLY = process.argv.includes('--apply');
  const TODAY = new Date().toISOString().slice(0, 10);
  const { writeCatalog } = require('./scripts/write-catalog.cjs');
  const { PARTS } = await import(`./src/data/parts.js?t=${Date.now()}`);
  const parts = PARTS;
  const loadedCount = parts.length;

  const asinOwner = new Map();
  for (const p of parts) {
    const m = String(p.deals?.amazon?.url || '').match(SELECTABLE_ASIN);
    if (m) asinOwner.set(m[1].toUpperCase(), p.id);
  }

  const rewritten = [], refused = [];
  for (const p of parts) {
    const d = p.deals?.amazon;
    if (!d || typeof d.url !== 'string' || !isSponsoredRedirect(d.url)) continue;
    const c = canonicalFromSponsored(d.url);
    if (!c) { refused.push({ id: p.id, why: 'redirect names no /dp/ASIN', n: p.n }); continue; }
    const owner = asinOwner.get(c.asin);
    if (owner != null && owner !== p.id) {
      refused.push({ id: p.id, why: `ASIN ${c.asin} is already product ${owner}'s Amazon deal`, n: p.n });
      continue;
    }
    rewritten.push({ id: p.id, c: p.c, asin: c.asin, hidden: !!p.needsReview, n: p.n });
    if (APPLY) {
      d.url = c.url;
      d.asin = c.asin;
      stampDealChange(p, TODAY);
    }
  }

  console.log(`SPONSORED AMAZON LINKS — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  rewrite ${rewritten.length} | refused ${refused.length}\n`);
  for (const r of rewritten) {
    console.log(`  #${String(r.id).padEnd(7)} ${r.c.padEnd(16)} ${r.asin}  ${r.hidden ? '(hidden) ' : ''}${String(r.n).slice(0, 56)}`);
  }
  for (const r of refused) console.log(`  REFUSED #${r.id}: ${r.why} — ${String(r.n).slice(0, 48)}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to rewrite these links.');
  } else if (rewritten.length) {
    await writeCatalog(parts, {
      loadedCount,
      reason: `canonicalize ${rewritten.length} sponsored-ad Amazon links to /dp/ASIN`,
    });
    console.log('Done.');
  }
}
