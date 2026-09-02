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

// Rakuten's ceiling is 100 REQUESTS per minute (x-ratelimit-limit-minute: 100).
//
// This was a 720ms sleep after each ROW, reasoned as "≈83/min leaves real
// headroom". The unit was wrong. searchNewegg issues a ladder of up to six
// queries per row and stops at the first non-empty response, so one row costs
// one to six requests, and the row rate is not the request rate.
//
// Run 33189471054 is the measurement: 3,178 rows at 64.2 rows/min drew 362
// http_errors — 11.4% of the catalog — in bursts of 10-27 a minute separated by
// quiet minutes. The 200-row dry runs that same afternoon, identical pacing,
// drew zero. Errors that track run LENGTH rather than the feed are throttling.
// The old comment predicted this exactly ("a THROTTLED RUN LOOKING LIKE A SICK
// FEED: inflated lookup failures trip the MAX_LOOKUP_FAILURE_RATE breaker") and
// then counted rows instead of requests.
//
// 80/min against a ceiling of 100 leaves room for the token call and for the
// fact that their minute boundary is not ours. The limiter paces at the request
// itself, so a row that resolves on its first query is no longer made to wait
// for a budget it never spent — which is why removing the per-row sleep does not
// make the run slower in the common case.
const REQ_PER_MIN = 80;

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

// One limiter for the whole run — a per-call limiter would enforce nothing.
// Built on first use, not at module load: NEG is populated by loadMatcher(),
// and this file is require()d by tests that only want its pure decision
// functions and never call it.
let _acquire = null;
const acquire = async () => {
  if (!_acquire) _acquire = NEG.createRateLimiter({ perMinute: REQ_PER_MIN });
  return _acquire();
};

// Run-wide tally of every non-2xx, keyed by status. Collected on EVERY lookup,
// not just failed ones: a 429 on a row whose second query succeeded is still
// budget we overspent, and leaving it out would understate the throttle.
const httpStatusTally = {};
let requestsIssued = 0;

// ── The lookup ───────────────────────────────────────────────────────────────
// Replaces the old searchBySku(). Uses the SAME matcher that ingest uses, so a
// product that could be found at ingest time can be found again here.
//
// Returns { outcome, candidates, reason, rawCount }.
async function lookupProduct(p) {
  let search;
  try {
    const token = await getToken();
    search = await NEG.searchNewegg(p, { token, mid: NEWEGG_MID, acquire });
  } catch (e) {
    // Token failure, network death, parser throw — all "we learned nothing".
    return { outcome: OUTCOME.LOOKUP_FAILED, reason: `exception: ${e.message}`, candidates: [], rawCount: 0, httpStatuses: [] };
  }

  requestsIssued += search.queriesTried || 0;
  for (const st of search.httpStatuses || []) httpStatusTally[st] = (httpStatusTally[st] || 0) + 1;

  if (search.ok) {
    return { outcome: OUTCOME.OK, reason: 'matched', candidates: search.candidates, rawCount: search.rawCount, httpStatuses: search.httpStatuses || [] };
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
    return { outcome: OUTCOME.CONFIRMED_ABSENT, reason: 'no_match', candidates: [], rawCount: search.rawCount, httpStatuses: search.httpStatuses || [] };
  }
  return { outcome: OUTCOME.LOOKUP_FAILED, reason: search.reason, candidates: [], rawCount: search.rawCount, httpStatuses: search.httpStatuses || [] };
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

// ── Feed health ──────────────────────────────────────────────────────────────
// Exported and pure so the breaker's own arithmetic is testable. It decides
// whether removals may run at all, and it was previously computed inline where
// nothing could assert on it.
//
// FEED health, not MATCHER strictness. 'variant_rejected' means the feed
// answered and we declined the variants it offered — a decision we made, not
// a symptom of an unhealthy feed. Counting it here inflated the rate to 56%
// and permanently tripped the breaker, which turns a diagnostic into noise.
//
// 'downgrade_blocked' deliberately STAYS in: it means the feed failed to
// surface the official listing we already know exists, which is exactly the
// feed defect this breaker is watching for.
//
// 'no_cat_mapping' comes out of BOTH sides. CAT_FILTER has no entry for the
// row's category, so searchNewegg returns before issuing a single request —
// we never asked Newegg anything, and a question never asked is not evidence
// about the answer. Leaving it in the numerator counted our own coverage gap
// as their outage; leaving it in the denominator would then dilute the real
// rate by rows that could never have contributed to it either way.
//
// This is the same reasoning as isPriced() gating the movement population in
// scripts/price-movement.cjs: a row that cannot be measured is not part of
// the population being measured.
//
// It differs from 'variant_rejected', which is subtracted from the numerator
// ONLY. Those rows were looked up and the feed answered — that answer is real
// evidence the feed is alive, so they belong in the denominator. The
// asymmetry is the point, not an oversight.
//
// ── THE RULE, APPLIED TO EVERY OUTCOME THAT MEETS IT ────────────────────────
// 'variant_rejected' was the only decision-of-ours ever subtracted, and it was
// not the only one. Two more meet the identical test — the feed answered, and
// WE declined what it offered:
//
//   guard_rejected      208 rows on run 33607979228. newegg-match.js says it
//                       outright: "A guard reject is ALSO evidence of presence,
//                       not absence: the capacity gate only fires on a candidate
//                       that got far enough to have a capacity compared."
//   weak_match_blocked   32 rows. Candidates scored below MIN_MIGRATE_SIM. The
//                       feed surfaced them; our floor turned them down.
//
// Leaving those in charged our own matcher's strictness to Newegg's uptime,
// which is precisely the error the variant_rejected exclusion was written to
// correct. The rate was 23.0% against a 20% breaker on EVERY run — 33607979228,
// 33547739235, 33490323017 and 33440406391 all landed 23.0-23.2% — so the
// breaker tripped every single time it was evaluated. A breaker that is always
// tripped conveys nothing: it cannot distinguish a sick feed from a healthy one,
// and this codebase has twice demonstrated it routes around a signal with no
// discrimination in it. Consistency here is what makes the number mean
// something again, not a threshold that was tuned until it went quiet.
//
// 'downgrade_blocked' deliberately STAYS in, and the distinction is the whole
// point of the rule rather than an exception to it: those 136 rows are not us
// declining an answer, they are the feed FAILING TO SURFACE the official
// listing we already know exists. That is a feed defect, and it is exactly what
// this breaker watches for.
//
// Recomputed on run 33607979228 with the rule applied consistently:
//
//   lookupable    3189 - 85                              = 3104
//   feedFailures  1066 - 268 - 85 - 208 - 32             =  473
//                 (no_results 318 + no_match 19 + downgrade_blocked 136)
//   rate          473 / 3104                             = 15.2%   (was 23.0%)
//
// Under the 20% breaker with real headroom, and every row still counted
// somewhere — nothing is hidden, it is attributed to whichever side actually
// caused it. The threshold is untouched.
//
// On run 33189471054 this is 83 rows, 66 of them GPU. GPU is absent from
// CAT_FILTER deliberately — Rakuten Product Search does not carry GPUs at all
// (see fetch-newegg-via-rakuten.cjs:108, "awaiting SFTP feed") — so adding a
// mapping would convert 83 no_cat_mapping into 83 no_results and spend ~400
// requests a run doing it. The rows need a different source, not a filter.
function feedHealth(stats, processed) {
  const lookupable = processed - stats.noCatMapping;
  // Every outcome where the feed ANSWERED and we declined it. Defaulted so a
  // caller built before these were counted still computes, rather than turning
  // an absent field into NaN and a silently-passing breaker.
  const ourDecisions =
    (stats.variantRejected || 0) + (stats.guardRejected || 0) + (stats.weakMatchBlocked || 0);
  const feedFailures = stats.lookupFailed - ourDecisions - stats.noCatMapping;
  return {
    lookupable, feedFailures, ourDecisions,
    failureRate: lookupable ? feedFailures / lookupable : 0,
  };
}

// ── WHAT ONE COMPLETED RUN LEAVES BEHIND ─────────────────────────────────────
//
// sftp-ingest.cjs's stampIntegrity() refuses to publish the coverage census
// when almost none of the re-pricer-reachable rows carry a refreshedAt stamp —
// a catalog in that state has had its evidence eaten, not its tail unreached.
// Deciding "almost none" needs a number, and that number is a fact about THIS
// script: how much of what it can address does a completed run actually stamp?
//
// It was a hand-picked 1/3 over there, with a comment saying so, because the
// figure lives here and was thrown away — written to newegg-refresh-summary.json,
// uploaded as an artifact, then `rm -f`'d by the workflow. This commits it, for
// the same reason #84 derives its unreachable lanes from CAT_FILTER rather than
// listing categories: a judgment constant that nothing recomputes is how the
// price ceilings went stale.
//
// A HIGH-WATER MARK, NOT THE LAST RUN, and that asymmetry is the whole design.
// If the floor tracked the most recent run, a run that reached fewer rows would
// LOWER the floor, and the gate would go slack exactly when the re-pricer is in
// trouble — least sensitive at the moment it matters most. A maximum is
// monotone: degradation can only make the census MORE likely to withhold a
// number, never less. The cost is the opposite error — a genuine, permanent
// drop in reach leaves the floor too high and the census over-refuses — and
// that is the direction this whole subsystem already chooses, out loud: no
// number rather than a confident wrong one.
//
// It is also self-consistent with the commit that carries it. This file is
// staged alongside src/data/parts/ in the same commit as the stamps it
// describes, so a push that fails takes both with it. The mark cannot come to
// claim a reach whose stamps never reached the catalog the census reads.
//
// WHAT IS EXCLUDED, and why each one would corrupt the mark:
//   --limit=N   the ratio is over a small subsample; one lucky draw sets a
//               spuriously high mark that then over-refuses forever.
//   --dry-run   probes the feed and writes no stamps. The mark describes what a
//               run LEAVES IN THE CATALOG, so a run that leaves nothing has not
//               demonstrated anything about it.
//   --parts=    a fixture catalog is not the population the census counts.
//
// COUNT WHAT THE CENSUS READS, NOT WHAT THIS RUN MATCHED. The numerator is
// `stats.stamped`, incremented at each of the three sites that actually write
// refreshedAt — NOT `stats.ok`. Those differ by exactly the price-suspect rows:
// a suspect price is withheld and the branch `continue`s before any stamp, so
// on run 33671549392 stats.ok was 2094 while only 2031 rows carried a stamp
// afterwards. Using the match count would have claimed a reach 63 rows higher
// than the catalog can show, and the floor derived from it would then void a
// census over stamps that were never written in the first place.
const REACH_FILE = path.join(__dirname, 'src', 'data', 'newegg-reach.json');

function recordReach({ stamped, lookupable, dryRun, limited, fixture, counterSound = true,
                      file = REACH_FILE }) {
  if (!counterSound) return { recorded: false, why: 'stamp counter drifted from priced+unchanged — the numerator is not trustworthy' };
  if (dryRun) return { recorded: false, why: 'dry run — no stamps written, nothing demonstrated' };
  if (limited) return { recorded: false, why: '--limit run — reach over a subsample is not the catalog figure' };
  if (fixture) return { recorded: false, why: '--parts= fixture — not the population the census counts' };
  if (!lookupable) return { recorded: false, why: 'no lookupable rows — the ratio is undefined' };

  const reach = stamped / lookupable;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first observation */ }
  const prevReach = prev && Number.isFinite(prev.reach) ? prev.reach : -Infinity;
  if (reach <= prevReach) {
    return { recorded: false, reach, previous: prevReach,
             why: `below the standing mark (${(100 * reach).toFixed(1)}% <= ${(100 * prevReach).toFixed(1)}%) — the mark only moves up` };
  }

  const next = {
    note: (prev && prev.note) || 'High-water mark of what one completed refresh-newegg-prices run leaves behind.',
    reach: Number(reach.toFixed(4)),
    stamped, lookupable,
    observedAt: new Date().toISOString(),
    run: process.env.GITHUB_RUN_ID || 'local',
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return { recorded: true, reach, previous: prevReach === -Infinity ? null : prevReach };
}

module.exports = { heldSku, chooseCandidate, applyMigrateFloor, effOf, feedHealth, loadMatcher, recordReach, REACH_FILE };

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

  const stats = { ok: 0, stamped: 0, priced: 0, unchanged: 0, migrated: 0, rematched: 0, priceSuspect: 0, priceQuarantined: 0, priceUnquarantined: 0, lookupFailed: 0, variantRejected: 0, guardRejected: 0, noCatMapping: 0, downgradeBlocked: 0, weakMatchBlocked: 0, confirmedAbsent: 0 };
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
      if (r.reason === 'no_cat_mapping') stats.noCatMapping++;
      // Counted for the same reason variant_rejected is: feedHealth subtracts it,
      // and a number the breaker depends on must be countable. It was reaching
      // the printed reason breakdown (208 rows on run 33607979228) and nothing
      // else, so the arithmetic could not see the largest single class of
      // outcome the feed answered.
      if (r.reason === 'guard_rejected') stats.guardRejected++;
      failures.push({ id: p.id, name: p.n, cat: p.c, sku, reason: r.reason, rawCount: r.rawCount, httpStatuses: r.httpStatuses });
      console.log(`  LOOKUP FAILED (no change): ${p.n} — ${r.reason}`);
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
      stats.stamped++;
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
      stats.stamped++;
      if (priceMoved) d.priceLastMovedAt = movedStamp;
      stats.priced++;
      changes.push({ name: p.n, change: 'price-update', from: oldPrice, to: item.price, sku });
    } else {
      d.refreshedAt = new Date().toISOString();
      stats.stamped++;
      stats.unchanged++;
    }

  }

  // ── Run-level circuit breakers ──────────────────────────────────────────────
  const processed = matched.length;
  const { lookupable, feedFailures, failureRate, ourDecisions } = feedHealth(stats, processed);
  const removalCap = Math.max(MAX_REMOVAL_FLOOR, Math.floor(processed * MAX_REMOVAL_RATE));
  const breakers = [];
  if (failureRate > MAX_LOOKUP_FAILURE_RATE)
    breakers.push(`feed failure rate ${(failureRate * 100).toFixed(1)}% > ${(MAX_LOOKUP_FAILURE_RATE * 100)}% — feed unhealthy (excludes ${ourDecisions} of our own decisions, ${stats.noCatMapping} unmappable)`);
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
  // Broken out rather than summed, because 'we declined it' and 'the feed did
  // not have it' are the two halves this breaker exists to tell apart.
  console.log(`  of which OUR decisions:    ${ourDecisions}  (EXCLUDED from feed health — ` +
    `${stats.variantRejected} variant, ${stats.guardRejected} guard, ${stats.weakMatchBlocked} weak-match)`);
  console.log(`Feed failure rate:${(failureRate * 100).toFixed(1)}%  (${feedFailures}/${lookupable}, breaker at ${MAX_LOOKUP_FAILURE_RATE * 100}%)`);
  if (stats.noCatMapping) {
    // Loud, not netted away. These rows are not healthy — they are unreachable,
    // and unreachable is worse: no refresher can ever reprice them, so whatever
    // price they carry is the price they will carry forever. Excluding them
    // from feed health is a statement about what the number MEASURES, never a
    // statement that the rows are fine.
    console.log(`  of which unmappable:${stats.noCatMapping}  (no CAT_FILTER entry — never queried, EXCLUDED from both sides)`);
  }
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

  // The line that ends the argument about whether http_error means "throttled"
  // or "Rakuten is down". 429 is us; 5xx is them; anything else is neither.
  const httpTotal = Object.values(httpStatusTally).reduce((a, b) => a + b, 0);
  console.log(`\nRequests issued:  ${requestsIssued}  (budget ${REQ_PER_MIN}/min)`);
  if (httpTotal) {
    console.log(`Non-2xx responses:${httpTotal}  (${(httpTotal / (requestsIssued || 1) * 100).toFixed(1)}% of requests)`);
    for (const [k, v] of Object.entries(httpStatusTally).sort((a, b) => b[1] - a[1])) {
      const gloss = k === '429' ? '  <- WE are over the rate limit'
        : /^5/.test(k) ? '  <- Rakuten server-side'
        : k === '401' || k === '403' ? '  <- auth, not rate'
        : '';
      console.log(`   ${v.toString().padStart(4)}  ${k}${gloss}`);
    }
  } else {
    console.log('Non-2xx responses:0');
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
    // Deliberately NOT gated on `breakers`: this run wrote its stamps whether
    // or not the feed-failure breaker tripped, so the epoch that dates them has
    // to be recorded too. Gating it here is what kept the warm-up clock pinned
    // at 0d across every unhealthy run. See movementFor in price-movement.cjs.
    wroteStamps: !DRY_RUN,
    // --limit means this run moved prices on `matched` and on nothing else.
    // Scoping keeps movedShare a ratio of one population instead of two; see
    // PARTIAL RUNS in scripts/price-movement.cjs. Full runs pass nothing.
    ...(Number.isFinite(LIMIT) ? { scopeIds: matched.map(x => x.id) } : {}),
  });
  console.log('');
  for (const line of movementReport(priceMovement)) console.log(line);

  // Drift guard on the counter above. Every branch that writes refreshedAt also
  // lands in exactly one of priced/unchanged, so these must agree; if a fourth
  // outcome is ever added and forgets stats.stamped++, the mark would quietly
  // start understating reach and lowering the census floor. Loud, not silent.
  const stampCounterSound = stats.stamped === stats.priced + stats.unchanged;
  if (!stampCounterSound) {
    console.log(`\n!! STAMP COUNTER DRIFT: stats.stamped=${stats.stamped} but priced+unchanged=${stats.priced + stats.unchanged}.`);
    console.log('   A refreshedAt write site is missing stats.stamped++. The reach mark is NOT recorded.');
  }

  // Commit the one figure sftp-ingest.cjs needs to stop guessing. See
  // recordReach() for why this is a high-water mark and what is excluded.
  const reachRecord = recordReach({
    stamped: stats.stamped, lookupable,
    dryRun: DRY_RUN, limited: Number.isFinite(LIMIT), fixture: USING_FIXTURE,
    counterSound: stampCounterSound,
  });
  if (reachRecord.recorded) {
    console.log(`\nRe-pricer reach:  ${(100 * reachRecord.reach).toFixed(1)}%  (${stats.stamped}/${lookupable} reachable rows stamped)` +
      (reachRecord.previous === null
        ? '  <- first committed observation'
        : `  <- NEW HIGH, was ${(100 * reachRecord.previous).toFixed(1)}%`));
    console.log(`  -> ${path.relative(__dirname, REACH_FILE)}; the census stamp floor derives from half of it.`);
  } else {
    console.log(`\nRe-pricer reach:  not recorded — ${reachRecord.why}`);
  }

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
    // The denominator the rate is over, and the rows held out of it. Both are
    // in the artifact so the figure can be recomputed rather than trusted.
    lookupable,
    // The numerator of the committed reach mark. `ok` counts matches; this
    // counts rows that actually came out carrying refreshedAt, and the two
    // differ by priceSuspect. See recordReach().
    stamped: stats.stamped,
    unmappable: stats.noCatMapping,
    ourDecisions,
    guardRejected: stats.guardRejected,
    // Attribution for the http_error bucket. `rateLimited` is the number the
    // pacing change is judged on: it should be 0, and if it is not, REQ_PER_MIN
    // is still too high rather than the feed being sick.
    requestsIssued,
    reqPerMinBudget: REQ_PER_MIN,
    httpStatuses: httpStatusTally,
    rateLimited: httpStatusTally['429'] || 0,
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
