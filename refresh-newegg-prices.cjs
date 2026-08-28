#!/usr/bin/env node
//
// Daily Newegg re-price / re-match.
//
// HISTORY — why this script is shaped the way it is:
//   The original version looked products up by passing the Newegg item number to
//   productsearch/1.0 as `keyword=`. That endpoint indexes product NAMES, not item
//   numbers, so every lookup missed. A miss stamped `staleSince`, and 7 days later
//   the deal was deleted. On 2026-07-06 that matured into 1,655 removals, ~904 of
//   which were live, correct listings. Newegg coverage went 1,717 -> 62.
//
//   Two independent defects had to line up for that to happen:
//     1. The lookup never worked  ->  fixed here by using newegg-match.js's
//        searchNewegg() (name + UPC matching), the same path fetch-newegg-via-
//        rakuten.cjs uses successfully at ingest time.
//     2. A failed lookup was treated as evidence of absence  ->  fixed here by
//        splitting outcomes into LOOKUP_FAILED vs CONFIRMED_ABSENT and making
//        deletion reachable only from CONFIRMED_ABSENT, repeatedly, over time,
//        behind run-level circuit breakers.
//
//   Defect 2 is the dangerous one. Fixing only defect 1 would leave a script that
//   still deletes the whole catalog the next time Linkshare has a bad afternoon.
//
// Usage:
//   node refresh-newegg-prices.cjs [--dry-run] [--limit=N] [--report=FILE]
//
const fs = require('fs');
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const CLIENT_ID = process.env.RAKUTEN_CLIENT_ID;
const CLIENT_SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const NEWEGG_MID = process.env.RAKUTEN_NEWEGG_MID || '44583';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LIMIT = (() => { const a = argv.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : Infinity; })();
const REPORT = (() => { const a = argv.find(x => x.startsWith('--report=')); return a ? a.split('=')[1] : 'newegg-refresh-summary.json'; })();
// --parts= points the run at a fixture catalog instead of the live one, so the
// removal path can be exercised against seeded (aged) state without touching
// real data. Production runs omit it.
const USING_FIXTURE = argv.some(x => x.startsWith('--parts='));
const PARTS_PATH = (() => {
  const a = argv.find(x => x.startsWith('--parts='));
  return a ? path.resolve(a.split('=')[1]) : path.join(__dirname, 'src', 'data', 'parts.js');
})();

// Guarded on require.main so the pure decision functions below can be unit
// tested without credentials. Running the script still fails fast.
if (require.main === module && (!CLIENT_ID || !CLIENT_SECRET || !SID)) {
  console.error('Missing required env vars (RAKUTEN_CLIENT_ID / _SECRET / _SID)');
  process.exit(1);
}

// 600ms was 100 req/min — Rakuten's documented ceiling EXACTLY
// (x-ratelimit-limit-minute: 100), with nothing left for the token call or for
// the fact that their minute boundary is not ours. Measured on the ingest path:
// a rate at the ceiling draws 429s in bursts, and this file's own searchNewegg
// correctly reports those as http_error / no_results — neither of which proves
// absence, so a deal is never deleted for them. The exposure is therefore not
// wrong deletions but a THROTTLED RUN LOOKING LIKE A SICK FEED: inflated lookup
// failures trip the MAX_LOOKUP_FAILURE_RATE breaker and abort the run.
// 720ms ≈ 83/min leaves real headroom.
const RATE_DELAY_MS = 720;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Safety thresholds ────────────────────────────────────────────────────────
// A single confirmed absence means nothing; feeds flap. Deletion requires the
// product to go missing on MIN_ABSENT_STREAK separate runs spanning at least
// MIN_STALE_DAYS. At one run/day that is ~2 weeks of consistent evidence.
const MIN_ABSENT_STREAK = 3;
const MIN_STALE_DAYS = 14;
// Reprice-in-place quarantine: withhold a bad price write and keep the last good
// price, but after this many CONSECUTIVE failed repricings the price is genuinely
// wrong (not a feed blip) — quarantine the product. Reset on any good price.
const PRICE_SUSPECT_QUARANTINE_STREAK = 3;
// "The feed answered, with a healthy result set, and our product wasn't in it."
// Fewer than this many raw candidates back means the QUERY is weak, not that the
// product is gone — treated as a lookup failure.
const MIN_HEALTHY_CANDIDATES = 3;
// Run-level circuit breakers. If any trips, we do not delete anything this run.
const MAX_LOOKUP_FAILURE_RATE = 0.20;  // >20% failing => the feed is sick, not the catalog
const MAX_REMOVAL_RATE = 0.02;         // never remove >2% of matched products in one run
const MAX_REMOVAL_FLOOR = 5;           // ...but always allow at least this many

// ── HARD BLOCK ON REMOVALS ───────────────────────────────────────────────────
// Removals are disabled at the source level. This is deliberately NOT a CLI
// flag, env var, or workflow input: the 2026-07-06 incident (1,655 deletions,
// ~904 of them live listings) happened because deletion was reachable from a
// lookup path that silently never worked. Everything below this line — the
// absent streak, the stale-days floor, the circuit breakers — is layered ON TOP
// of a signal we do not yet trust. Safety thresholds on a broken input do not
// make the input correct; they only slow down the rate at which it does damage.
//
// WHAT MUST BE TRUE BEFORE FLIPPING THIS TO true:
//   1. SKU lookup is proven correct. searchNewegg() resolves by name/UPC, NOT
//      by item number — the field we actually store. Until a lookup keyed on
//      the stored SKU round-trips a known-live listing, CONFIRMED_ABSENT is
//      indistinguishable from "we asked the wrong question."
//   2. That proof is a checked-in test asserting a known-live SKU resolves,
//      and a known-dead SKU does not. Not a one-off manual run.
//   3. A full production dry run shows a removal-candidate list that a human
//      has spot-checked against live Newegg URLs and found genuinely dead.
//
// Until then this script is a re-pricer that records absence evidence. The
// evidence keeps accruing in `absentStreak` — nothing is lost by waiting, and
// the candidate list still prints every run so the signal stays observable.
const REMOVALS_ENABLED = false;

// Per-product outcome classes. Only CONFIRMED_ABSENT can ever lead to removal.
const OUTCOME = {
  OK: 'ok',                          // feed returned a candidate that matched our product
  LOOKUP_FAILED: 'lookup_failed',    // we learned NOTHING — never mutates the deal
  CONFIRMED_ABSENT: 'confirmed_absent', // feed healthy, product genuinely not in it
};

// Newegg matcher (shared ESM) — assigned at startup.
let NEG = null;
async function loadMatcher() {
  NEG = await import(`file://${path.join(__dirname, 'newegg-match.js').replace(/\\/g, '/')}`);
  return NEG;
}

let tokenCache = { token: null, expiresAt: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=password&scope=${SID}`
  });
  if (!res.ok) throw new Error(`Token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// ── The lookup ───────────────────────────────────────────────────────────────
// Replaces the old searchBySku(). Uses the SAME matcher that ingest uses, so a
// product that could be found at ingest time can be found again here.
//
// Returns { outcome, candidates, reason, rawCount }.
async function lookupProduct(p) {
  let search;
  try {
    const token = await getToken();
    search = await NEG.searchNewegg(p, { token, mid: NEWEGG_MID });
  } catch (e) {
    // Token failure, network death, parser throw — all "we learned nothing".
    return { outcome: OUTCOME.LOOKUP_FAILED, reason: `exception: ${e.message}`, candidates: [], rawCount: 0 };
  }

  if (search.ok) {
    return { outcome: OUTCOME.OK, reason: 'matched', candidates: search.candidates, rawCount: search.rawCount };
  }

  // ---- The critical branch. Absence must be PROVEN, not assumed. ----
  // 'no_match' is the only reason that can indicate real absence, and only when
  // the feed handed us a healthy candidate set to have missed our product in.
  // Everything else (http_error, no_results, no_cat_mapping) is a failed lookup.
  //
  // 'variant_rejected' is deliberately NOT absence: it means the feed surfaced
  // our product line and the variant guard declined its variants. That is
  // evidence the product EXISTS. Falling through to LOOKUP_FAILED below is the
  // whole point — a stricter guard must never widen the deletion path.
  if (search.reason === 'no_match' && search.rawCount >= MIN_HEALTHY_CANDIDATES) {
    return { outcome: OUTCOME.CONFIRMED_ABSENT, reason: 'no_match', candidates: [], rawCount: search.rawCount };
  }
  return { outcome: OUTCOME.LOOKUP_FAILED, reason: search.reason, candidates: [], rawCount: search.rawCount };
}

// Take the first N in catalog order and you get whatever category happens to sit
// at the top of parts.js (Cases), which tells you nothing about how the matcher
// behaves on Storage or Monitors. Round-robin across categories so a limited run
// is a representative probe of the whole catalog, not one aisle of it.
function sampleAcrossCategories(products, limit) {
  if (!Number.isFinite(limit) || limit >= products.length) return products;
  const buckets = new Map();
  for (const p of products) {
    const k = p.c || 'unknown';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  // Smallest categories first, so a low limit still touches the rare ones.
  const lanes = [...buckets.values()].sort((a, b) => a.length - b.length);
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let placed = false;
    for (const lane of lanes) {
      if (round >= lane.length) continue;
      out.push(lane[round]);
      placed = true;
      if (out.length >= limit) break;
    }
    if (!placed) break; // every lane exhausted
  }
  return out;
}

function effOf(item) {
  return (item.saleprice && item.saleprice > 0) ? item.saleprice : item.price;
}

// WHICH FIELD IDENTIFIES THE LISTING WE HOLD.
//
// deals.newegg.sku is NOT reliably a Newegg item number. On 2,108 of the 3,178
// priced Newegg rows (66%) it holds a Rakuten affiliate link ID — a long digit
// string beginning with the Newegg MID — and the real item number lives in
// deals.newegg.itemNumber. sku === itemNumber on zero rows; the two fields are
// either both-real-and-absent (1,070 rows, sku is the item number, no
// itemNumber) or split (2,108 rows).
//
// Reading sku alone broke both halves of chooseCandidate() for that 66%:
//
//   exact  — matched feed item numbers against a link ID, so it never matched.
//            The refresher could not recognise the listing it already holds,
//            and every such row had to migrate or rematch; it could never
//            simply reprice in place.
//   rank   — sellerClass() reads a link ID as 'other' (rank 1). A row already
//            showing a marketplace listing therefore scored BETTER than the
//            marketplace candidate that was the same listing, and the downgrade
//            guard blocked its own SKU as a downgrade.
//
// Run 33181385798 (200-row dry run): of 49 downgrade blocks, 40 were this bug —
// 30 where the blocked candidate was byte-identical to the row's own
// itemNumber, 10 a rank-equal marketplace-to-marketplace swap. All 40 already
// carry sellerClass 'marketplace' and already render the 3RD-PARTY SELLER
// badge, so nothing was being protected and no disclosure was at stake. The
// remaining 9 are genuine official -> marketplace downgrades and still block.
//
// This changes what the guard READS, not what it permits. The split fields are
// deliberately NOT collapsed here: a reprice-in-place leaves sku/itemNumber
// exactly as found, so this PR carries no catalog migration. Rows only
// normalise to a single real item number when a genuine SKU change rebuilds
// deals.newegg, which is the behaviour that was already there.
function heldSku(deal) {
  return String((deal && (deal.itemNumber || deal.sku)) || '').trim();
}

// Choose which candidate to write. Keeps the first-party (N82E) preference:
// a first-party listing wins even if we currently hold a different SKU.
//
// DOWNGRADE GUARD: seller rank may only ever improve (official=0 < other=1 <
// marketplace=2). If we hold an official listing and no official candidate
// matched, that is a LOOKUP failure — the feed didn't surface the listing we
// already know exists — NOT a licence to rematch onto a marketplace reseller.
// Returns { downgrade: true, ... } for the caller to treat as LOOKUP_FAILED.
// SCORE FLOOR: a candidate may only REPLACE the SKU we hold on strong evidence.
// Filtering before selection (rather than vetoing after) means selection falls
// back to the SKU we already hold when the only alternative is weak — we reprice
// instead of migrating, rather than failing the whole product. Repricing the
// held SKU is exempt: identity is settled by the SKU, and a low name score there
// only reflects a truncated catalog title.
function applyMigrateFloor(candidates, currentSku) {
  const weak = [];
  const eligible = candidates.filter((c) => {
    if (String(c.item.sku || '').trim() === currentSku) return true;
    if (c.match.method !== 'name') return true; // UPC identity bypasses the floor
    if (c.match.score >= NEG.MIN_MIGRATE_SIM) return true;
    weak.push(c);
    return false;
  });
  return { eligible, weak };
}

function chooseCandidate(p, candidates) {
  const currentSku = heldSku(p.deals.newegg);
  const { eligible, weak } = applyMigrateFloor(candidates, currentSku);
  const exact = eligible.find(c => String(c.item.sku || '').trim() === currentSku);
  const best = NEG.selectWithFirstPartyPreference(eligible);

  // Every candidate that could have changed the SKU was too weak, and we hold
  // nothing to reprice. Treat as LOOKUP_FAILED — keep the existing deal.
  if (!eligible.length && weak.length) {
    return {
      weakMatch: true,
      bestWeakScore: Math.max(...weak.map(c => c.match.score)),
      bestWeakName: weak.slice().sort((a, b) => b.match.score - a.match.score)[0].item.name,
      floor: NEG.MIN_MIGRATE_SIM,
    };
  }

  // Rank of what we hold. No stored SKU => nothing to protect (worst rank).
  const currentRank = currentSku ? NEG.sellerRank(currentSku) : 99;

  // Keeping the SKU we already hold is always allowed — same rank by definition.
  if (exact && (!best || !NEG.isFirstParty(best.item.sku) || NEG.isFirstParty(exact.item.sku))) {
    return { pick: exact, kind: 'reprice' };
  }

  const pick = best || exact;
  if (!pick) return null;

  if (NEG.sellerRank(pick.item.sku) > currentRank) {
    return {
      downgrade: true,
      from: currentSku,
      fromClass: NEG.sellerClass(currentSku),
      to: pick.item.sku,
      toClass: NEG.sellerClass(pick.item.sku),
    };
  }

  if (NEG.isFirstParty(pick.item.sku) && (!exact || !NEG.isFirstParty(exact.item.sku))) {
    return { pick, kind: currentSku && pick.item.sku !== currentSku ? 'migrate' : 'reprice' };
  }
  if (exact) return { pick: exact, kind: 'reprice' };
  return { pick, kind: 'rematch' };
}

module.exports = { heldSku, chooseCandidate, applyMigrateFloor, effOf, loadMatcher };

if (require.main !== module) return;

(async () => {
  console.log(`Loading parts.js...${DRY_RUN ? '  [DRY RUN — no writes]' : ''}`);
  await loadMatcher();
  const partsModule = await import(`file://${PARTS_PATH.replace(/\\/g, '/')}?t=${Date.now()}`);
  const parts = partsModule.PARTS;
  const allMatched = parts.filter(p => p?.deals?.newegg?.sku);
  const matched = sampleAcrossCategories(allMatched, LIMIT);
  console.log(`Found ${allMatched.length} products with Newegg matches${matched.length !== allMatched.length ? ` (sampling ${matched.length} across categories)` : ''}`);
  {
    const byCat = {};
    for (const p of matched) byCat[p.c] = (byCat[p.c] || 0) + 1;
    console.log(`Sample by category: ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }

  const stats = { ok: 0, priced: 0, unchanged: 0, migrated: 0, rematched: 0, priceSuspect: 0, priceQuarantined: 0, priceUnquarantined: 0, lookupFailed: 0, variantRejected: 0, downgradeBlocked: 0, weakMatchBlocked: 0, confirmedAbsent: 0 };
  const changes = [];
  const failures = [];
  const removalCandidates = [];
  // Every gated candidate we scored, selected or not. This is what the accept
  // floor is calibrated against — without it the artifact only carried scores
  // for candidates we ALREADY decided to write, which is the one population
  // that cannot tell you where the floor belongs.
  const scoreSamples = [];

  for (let i = 0; i < matched.length; i++) {
    const p = matched[i];
    const sku = p.deals.newegg.sku;
    if (i % 25 === 0) console.log(`Progress: ${i}/${matched.length} (ok=${stats.ok} failed=${stats.lookupFailed} absent=${stats.confirmedAbsent})`);

    const r = await lookupProduct(p);

    // ── LOOKUP FAILED: touch nothing. Not the price, not staleSince, not the
    // absent streak. The deal is left exactly as found. This is the single most
    // important behaviour in this file.
    if (r.outcome === OUTCOME.LOOKUP_FAILED) {
      stats.lookupFailed++;
      if (r.reason === 'variant_rejected') stats.variantRejected++;
      failures.push({ id: p.id, name: p.n, cat: p.c, sku, reason: r.reason, rawCount: r.rawCount });
      console.log(`  LOOKUP FAILED (no change): ${p.n} — ${r.reason}`);
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // ── CONFIRMED ABSENT: record evidence only. Never deletes inline; removal is
    // decided after the loop, once run-level health is known.
    if (r.outcome === OUTCOME.CONFIRMED_ABSENT) {
      stats.confirmedAbsent++;
      const d = p.deals.newegg;
      d.absentStreak = (d.absentStreak || 0) + 1;
      if (!d.staleSince) d.staleSince = new Date().toISOString();
      const staleDays = (Date.now() - new Date(d.staleSince).getTime()) / 86400000;
      changes.push({ name: p.n, change: 'marked-absent', sku, streak: d.absentStreak, staleDays: Number(staleDays.toFixed(1)) });
      if (d.absentStreak >= MIN_ABSENT_STREAK && staleDays >= MIN_STALE_DAYS) {
        removalCandidates.push({ product: p, sku, streak: d.absentStreak, staleDays: Number(staleDays.toFixed(1)) });
      }
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // ── OK: we have a real, gated match. ──────────────────────────────────────
    stats.ok++;
    const chosen = chooseCandidate(p, r.candidates);
    {
      const selSku = chosen && chosen.pick ? String(chosen.pick.item.sku).trim() : null;
      for (const c of r.candidates) {
        const cSku = String(c.item.sku || '').trim();
        scoreSamples.push({
          id: p.id, name: p.n, cat: p.c, ourSku: sku, ourItemNumber: p.deals.newegg.itemNumber || null,
          ourHeldSku: heldSku(p.deals.newegg), ourClass: NEG.sellerClass(heldSku(p.deals.newegg)),
          // Prices, so a dry run answers "what would this row show instead?"
          // without a second feed call.
          //
          // BOTH sides carry list, sale and effective. 40 of the 103 matched
          // rows in run 33184569537 hold a saleprice, so comparing a stored
          // LIST price against candidateEff (which is the sale price when there
          // is one) reports a move on 24 rows that did not move. Compare like
          // with like: ourEff vs candidateEff, or ourPrice vs candidatePrice.
          ourPrice: Number(p.deals.newegg.price) || null,
          ourSalePrice: Number(p.deals.newegg.saleprice) || null,
          ourEff: effOf(p.deals.newegg) ?? null,
          candidateName: c.item.name, candidateSku: cSku,
          candidateClass: NEG.sellerClass(cSku),
          candidatePrice: c.item.price ?? null,
          candidateSalePrice: c.item.saleprice ?? null,
          candidateEff: effOf(c.item) ?? null,
          method: c.match.method, score: Number(c.match.score.toFixed(3)),
          selected: selSku != null && cSku === selSku,
          skuChanged: cSku !== String(sku).trim(),
          disposition: !chosen ? 'no_candidate_selected'
            : chosen.weakMatch ? 'weak_match_blocked'
            : chosen.downgrade ? 'downgrade_blocked' : chosen.kind,
        });
      }
    }
    if (!chosen) { // defensive: ok implies >=1 candidate, but never assume
      stats.lookupFailed++;
      failures.push({ id: p.id, name: p.n, cat: p.c, sku, reason: 'no_candidate_selected', rawCount: r.rawCount });
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // Score floor blocked the only SKU-changing candidates: same treatment as a
    // downgrade — LOOKUP_FAILED, deal left exactly as found. Better to keep the
    // existing deal than swap onto a weak match.
    if (chosen.weakMatch) {
      stats.ok--;
      stats.weakMatchBlocked++;
      stats.lookupFailed++;
      failures.push({
        id: p.id, name: p.n, cat: p.c, sku, reason: 'weak_match_blocked',
        rawCount: r.rawCount, bestScore: Number(chosen.bestWeakScore.toFixed(3)),
        floor: chosen.floor, candidateName: chosen.bestWeakName,
      });
      console.log(`  WEAK MATCH BLOCKED (no change): ${p.n} — best ${chosen.bestWeakScore.toFixed(2)} < ${chosen.floor}`);
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // Seller-rank downgrade blocked: treat exactly like LOOKUP_FAILED — the deal
    // is left exactly as found (price, staleSince, streak all untouched).
    if (chosen.downgrade) {
      stats.ok--;
      stats.downgradeBlocked++;
      stats.lookupFailed++;
      failures.push({
        id: p.id, name: p.n, cat: p.c, sku, reason: 'downgrade_blocked',
        rawCount: r.rawCount, fromClass: chosen.fromClass, to: chosen.to, toClass: chosen.toClass,
      });
      console.log(`  DOWNGRADE BLOCKED (no change): ${p.n} — ${chosen.fromClass} ${chosen.from} -> ${chosen.toClass} ${chosen.to}`);
      await sleep(RATE_DELAY_MS);
      continue;
    }

    const { pick, kind } = chosen;
    const item = pick.item;
    const eff = effOf(item);
    const d = p.deals.newegg;

    // Capacity/compatibility guards already ran inside scoreMatch(). This is the
    // cross-retailer price sanity gate.
    const sanity = NEG.neweggSanity(p, eff);
    if (!(eff > 0) || !sanity.pass) {
      // REPRICE-IN-PLACE policy (2026-07-27): a suspicious price is a reason to
      // distrust the NEW number, not to destroy the listing we already have —
      // withhold the bad write, KEEP the live product and its last known good
      // price. One bad feed tick must not hide a good product.
      //
      // BUT track it: three CONSECUTIVE failed repricings mean the price is
      // genuinely wrong, not a blip, so on the 3rd strike the PRODUCT is
      // quarantined (needsReview) — still keeping the last good price. The streak
      // resets the moment a good price validates (below), so isolated flaps never
      // accumulate to a quarantine.
      stats.priceSuspect++;
      d.priceSuspect = true;
      d.priceSuspectAt = new Date().toISOString();
      d.priceSuspectValue = eff;
      d.priceSuspectClass = sanity.cls;
      d.priceSuspectStreak = (d.priceSuspectStreak || 0) + 1;
      const changeRec = { name: p.n, change: 'price-suspect-flagged', kept: d.price, rejected: eff, cls: sanity.cls, streak: d.priceSuspectStreak, sku };
      if (d.priceSuspectStreak >= PRICE_SUSPECT_QUARANTINE_STREAK && !p.needsReview) {
        // Three strikes — quarantine the product. Mark WHY (priceQuarantined) so a
        // later recovery only lifts a price-quarantine, never one set for another
        // reason (bench backfill, category audit, …).
        p.needsReview = true;
        p.quarantinedAt = new Date().toISOString().slice(0, 10);
        p.priceQuarantined = true;
        stats.priceQuarantined++;
        changeRec.change = 'price-quarantined-3strikes';
      }
      changes.push(changeRec);
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // Confirmed live: clear any prior absence evidence and suspicion, and reset the
    // consecutive-failure streak. Only lift a quarantine WE set for price (never
    // un-hide a product quarantined for some other reason).
    delete d.staleSince;
    delete d.absentStreak;
    delete d.priceSuspect;
    delete d.priceSuspectAt;
    delete d.priceSuspectValue;
    delete d.priceSuspectClass;
    delete d.priceSuspectStreak;
    if (p.priceQuarantined) {
      delete p.needsReview;
      delete p.quarantinedAt;
      delete p.priceQuarantined;
      stats.priceUnquarantined++;
      changes.push({ name: p.n, change: 'price-unquarantined-recovered', price: eff, sku });
    }

    const oldPrice = Number(d.price);
    const oldSale = Number(d.saleprice || 0);
    const newSale = item.saleprice && item.saleprice > 0 ? item.saleprice : null;
    const newLink = item.linkurl || d.linkurl;
    // Compared against the listing we HOLD (itemNumber ?? sku), not against the
    // affiliate link ID — otherwise a reprice of the very same item number reads
    // as a SKU change and takes the wholesale-replace branch as a 'migrate'.
    const skuChanged = String(item.sku).trim() !== heldSku(d);
    const priceChanged = item.price !== oldPrice || (newSale || 0) !== oldSale || newLink !== d.linkurl;

    // ── The stamp that cannot be manufactured ─────────────────────────────────
    // refreshedAt below advances on every successful lookup, including the
    // `unchanged` branch — so it proves the feed answered, never that the
    // answer was new. That is the same gap that let Best Buy sit frozen for
    // four months while every downstream artifact looked alive.
    //
    // priceLastMovedAt advances only when the NUMBER moved. Deliberately
    // narrower than `priceChanged` above, which also trips on a link-only
    // change: a new affiliate URL is not a reprice, and counting it as one
    // would let a frozen feed keep the movement distribution looking healthy.
    // scripts/price-movement.cjs reads these across the catalog.
    const priceMoved = item.price !== oldPrice || (newSale || 0) !== oldSale;
    const movedStamp = priceMoved ? new Date().toISOString().slice(0, 10) : d.priceLastMovedAt;

    if (skuChanged) {
      p.deals.newegg = {
        sku: item.sku,
        price: item.price,
        ...(newSale ? { saleprice: newSale } : {}),
        linkurl: newLink,
        imageurl: item.imageurl || d.imageurl,
        sellerClass: NEG.sellerClass(item.sku),
        matchedAt: d.matchedAt || new Date().toISOString().slice(0, 10),
        matchMethod: pick.match.method,
        matchScore: Number(pick.match.score.toFixed(2)),
        refreshedAt: new Date().toISOString(),
        // This branch REPLACES deals.newegg wholesale, so the stamp has to be
        // carried across explicitly or a re-match would silently erase the
        // row's movement history and read as never-moved forever after.
        ...(movedStamp ? { priceLastMovedAt: movedStamp } : {}),
        ...(kind === 'migrate'
          ? { migratedAt: new Date().toISOString(), migratedFrom: sku }
          : { rematchedAt: new Date().toISOString(), rematchedFrom: sku }),
      };
      if (kind === 'migrate') stats.migrated++; else stats.rematched++;
      stats.priced++;
      changes.push({
        name: p.n, change: kind === 'migrate' ? 'migrated-to-firstparty' : 'rematched',
        from: sku, fromClass: NEG.sellerClass(sku), to: item.sku, toClass: NEG.sellerClass(item.sku),
        // Candidate name is what a human needs to spot a variant collapse.
        candidateName: item.name, method: pick.match.method, score: Number(pick.match.score.toFixed(2)),
        price: item.price,
      });
    } else if (priceChanged) {
      d.price = item.price;
      if (newSale) d.saleprice = newSale; else delete d.saleprice;
      d.linkurl = newLink;
      d.refreshedAt = new Date().toISOString();
      if (priceMoved) d.priceLastMovedAt = movedStamp;
      stats.priced++;
      changes.push({ name: p.n, change: 'price-update', from: oldPrice, to: item.price, sku });
    } else {
      d.refreshedAt = new Date().toISOString();
      stats.unchanged++;
    }

    await sleep(RATE_DELAY_MS);
  }

  // ── Run-level circuit breakers ──────────────────────────────────────────────
  const processed = matched.length;
  // FEED health, not MATCHER strictness. 'variant_rejected' means the feed
  // answered and we declined the variants it offered — a decision we made, not
  // a symptom of an unhealthy feed. Counting it here inflated the rate to 56%
  // and permanently tripped the breaker, which turns a diagnostic into noise.
  //
  // 'downgrade_blocked' deliberately STAYS in: it means the feed failed to
  // surface the official listing we already know exists, which is exactly the
  // feed defect this breaker is watching for.
  const feedFailures = stats.lookupFailed - stats.variantRejected;
  const failureRate = processed ? feedFailures / processed : 0;
  const removalCap = Math.max(MAX_REMOVAL_FLOOR, Math.floor(processed * MAX_REMOVAL_RATE));
  const breakers = [];
  if (failureRate > MAX_LOOKUP_FAILURE_RATE)
    breakers.push(`feed failure rate ${(failureRate * 100).toFixed(1)}% > ${(MAX_LOOKUP_FAILURE_RATE * 100)}% — feed unhealthy (excludes ${stats.variantRejected} variant rejections)`);
  if (stats.ok === 0 && processed > 0)
    breakers.push('zero successful lookups — cannot trust any absence signal');
  if (removalCandidates.length > removalCap)
    breakers.push(`${removalCandidates.length} removal candidates > cap ${removalCap} — refusing mass removal`);

  let removed = 0;
  if (removalCandidates.length && breakers.length === 0 && !DRY_RUN && REMOVALS_ENABLED) {
    for (const rc of removalCandidates) {
      delete rc.product.deals.newegg;
      changes.push({ name: rc.product.n, change: 'removed-confirmed-absent', sku: rc.sku, streak: rc.streak, staleDays: rc.staleDays });
      removed++;
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`\n=== SUMMARY ${DRY_RUN ? '(DRY RUN)' : ''} ===`);
  console.log(`Processed:        ${processed}`);
  console.log(`Matched OK:       ${stats.ok}  (repriced ${stats.priced}, unchanged ${stats.unchanged}, migrated ${stats.migrated}, rematched ${stats.rematched})`);
  console.log(`Price suspect:    ${stats.priceSuspect}  (bad price withheld, last good price KEPT)`);
  console.log(`Price quarantined:${stats.priceQuarantined}  (${PRICE_SUSPECT_QUARANTINE_STREAK}+ consecutive strikes -> needsReview, price KEPT)`);
  if (stats.priceUnquarantined) console.log(`Price recovered:  ${stats.priceUnquarantined}  (good price -> quarantine lifted)`);
  console.log(`Lookup failed:    ${stats.lookupFailed}  (no change written)`);
  console.log(`  of which variant-rejected: ${stats.variantRejected}  (matcher decision — EXCLUDED from feed health)`);
  console.log(`Feed failure rate:${(failureRate * 100).toFixed(1)}%  (${feedFailures}/${processed}, breaker at ${MAX_LOOKUP_FAILURE_RATE * 100}%)`);
  console.log(`Downgrade blocked:${stats.downgradeBlocked}  (seller rank protected, deal KEPT)`);
  console.log(`Weak match blocked:${stats.weakMatchBlocked}  (below ${NEG.MIN_MIGRATE_SIM} migrate floor, deal KEPT)`);
  console.log(`Confirmed absent: ${stats.confirmedAbsent}  (${removalCandidates.length} past removal threshold)`);
  if (breakers.length) {
    console.log(`\n!! CIRCUIT BREAKER TRIPPED — 0 removals this run:`);
    for (const b of breakers) console.log(`   - ${b}`);
  }
  if (!REMOVALS_ENABLED) {
    console.log(`\n!! REMOVALS HARD-BLOCKED at source (REMOVALS_ENABLED = false).`);
    console.log(`   ${removalCandidates.length} candidate(s) met the streak/stale thresholds and were NOT removed.`);
    console.log(`   Absence evidence is still being recorded. See the block comment for what must`);
    console.log(`   be fixed (SKU-keyed lookup + a test proving it) before re-enabling.`);
  }
  console.log(`Removed:          ${removed}${DRY_RUN && removalCandidates.length ? ` (dry run — ${removalCandidates.length} would have been evaluated)` : ''}`);

  if (failures.length) {
    console.log(`\nLookup failures by reason:`);
    const byReason = {};
    for (const f of failures) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
    for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`   ${v.toString().padStart(4)}  ${k}`);
  }

  // ── How much of Newegg is actually repricing? ──────────────────────────────
  // This job had no outcome assertion at all — its workflow reads the summary
  // inside `if [ -f ... ]`, which is the precise shape scripts/assert-outcome.cjs
  // was written to kill. It also reported "0 updated" on every run from
  // 2026-07-06 and kept going, because nothing had to be done about it.
  //
  // The distribution is what makes a partial freeze reportable: a max over the
  // catalog is held at 0 by any handful of active SKUs. See
  // scripts/price-movement.cjs for the threshold and the warm-up rule.
  const { movementFor, report: movementReport } = require('./scripts/price-movement.cjs');
  const priceMovement = movementFor({
    parts, retailer: 'newegg',
    today: new Date().toISOString().slice(0, 10),
    apply: !DRY_RUN && !breakers.length,
    // --limit means this run moved prices on `matched` and on nothing else.
    // Scoping keeps movedShare a ratio of one population instead of two; see
    // PARTIAL RUNS in scripts/price-movement.cjs. Full runs pass nothing.
    ...(Number.isFinite(LIMIT) ? { scopeIds: matched.map(x => x.id) } : {}),
  });
  console.log('');
  for (const line of movementReport(priceMovement)) console.log(line);

  const report = {
    timestamp: new Date().toISOString(),
    dryRun: DRY_RUN,
    processed, ...stats,
    // What Newegg has been doing across the catalog, as opposed to what this
    // run did. A frozen feed answers the first question wrongly.
    movement: priceMovement,
    // `updated` is read by .github/workflows/refresh-newegg-prices.yml for the
    // commit message; kept as an alias of the renamed `priced` counter.
    updated: stats.priced,
    removalCandidates: removalCandidates.length,
    removed,
    removalsEnabled: REMOVALS_ENABLED,
    removalsBlockedBySourceGate: !REMOVALS_ENABLED && removalCandidates.length > 0,
    // Both numbers, so a rising variant-rejection count stays visible even
    // though it no longer moves the breaker.
    feedFailures,
    feedFailureRate: Number(failureRate.toFixed(3)),
    breakers,
    thresholds: { MIN_ABSENT_STREAK, MIN_STALE_DAYS, MIN_HEALTHY_CANDIDATES, MAX_LOOKUP_FAILURE_RATE, removalCap, MIN_MIGRATE_SIM: NEG.MIN_MIGRATE_SIM },
    failures: failures.slice(0, 50),
    changes: changes.slice(0, 100),
    scoreSamples,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\nReport -> ${REPORT}`);

  if (DRY_RUN) { console.log('DRY RUN — parts.js not written.'); return; }

  const mutating = stats.priced + stats.priceSuspect + stats.priceUnquarantined + stats.confirmedAbsent + removed;
  if (mutating === 0) { console.log('No changes to write.'); return; }

  // Route through the shared writer so the re-split is part of the write
  // rather than a separate workflow step. Previously this wrote a raw literal
  // over the barrel and relied on refresh-newegg-prices.yml running
  // split-parts-by-cat.cjs afterwards — correct in CI, silently corrupting on
  // any manual/local run.
  //
  // --parts= fixture runs are exempt: they point at a standalone literal
  // catalog with no chunk barrel behind it, so there is nothing to re-split.
  if (USING_FIXTURE) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync(PARTS_PATH, header + body, 'utf8');
    console.log(`Wrote ${parts.length} products to fixture ${PARTS_PATH}`);
    return;
  }

  await writeCatalog(parts, { loadedCount: parts.length, reason: 'newegg price refresh' });
})().catch(e => { console.error(e); process.exit(1); });
