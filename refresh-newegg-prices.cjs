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

if (!CLIENT_ID || !CLIENT_SECRET || !SID) {
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
  const currentSku = String(p.deals.newegg.sku || '').trim();
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

(async () => {
  console.log(`Loading parts.js...${DRY_RUN ? '  [DRY RUN — no writes]' : ''}`);
  NEG = await import(`file://${path.join(__dirname, 'newegg-match.js').replace(/\\/g, '/')}`);
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

  const stats = { ok: 0, priced: 0, unchanged: 0, migrated: 0, rematched: 0, priceSuspect: 0, lookupFailed: 0, variantRejected: 0, downgradeBlocked: 0, weakMatchBlocked: 0, confirmedAbsent: 0 };
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
          id: p.id, name: p.n, cat: p.c, ourSku: sku,
          candidateName: c.item.name, candidateSku: cSku,
          candidateClass: NEG.sellerClass(cSku),
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
      // CHANGED: previously this deleted the deal (and quarantined the product).
      // A suspicious price is a reason to distrust the NEW number, not to destroy
      // the listing we already have. Keep the old price, flag for review.
      stats.priceSuspect++;
      d.priceSuspect = true;
      d.priceSuspectAt = new Date().toISOString();
      d.priceSuspectValue = eff;
      d.priceSuspectClass = sanity.cls;
      changes.push({ name: p.n, change: 'price-suspect-flagged', kept: d.price, rejected: eff, cls: sanity.cls, sku });
      await sleep(RATE_DELAY_MS);
      continue;
    }

    // Confirmed live: clear any prior absence evidence and suspicion.
    delete d.staleSince;
    delete d.absentStreak;
    delete d.priceSuspect;
    delete d.priceSuspectAt;
    delete d.priceSuspectValue;
    delete d.priceSuspectClass;

    const oldPrice = Number(d.price);
    const oldSale = Number(d.saleprice || 0);
    const newSale = item.saleprice && item.saleprice > 0 ? item.saleprice : null;
    const newLink = item.linkurl || d.linkurl;
    const skuChanged = String(item.sku).trim() !== String(sku).trim();
    const priceChanged = item.price !== oldPrice || (newSale || 0) !== oldSale || newLink !== d.linkurl;

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
  console.log(`Price suspect:    ${stats.priceSuspect}  (flagged, deal KEPT)`);
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

  const report = {
    timestamp: new Date().toISOString(),
    dryRun: DRY_RUN,
    processed, ...stats,
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

  const mutating = stats.priced + stats.priceSuspect + stats.confirmedAbsent + removed;
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
