#!/usr/bin/env node
// =============================================================================
//  scripts/assert-retailer-freshness.cjs
//
//  Assert that every retailer in the catalog has been confirmed against its
//  retailer recently enough, and that the scheduled job responsible for doing
//  the confirming is actually still scheduled.
//
//  ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//  Best Buy prices froze for roughly four months and nothing noticed, because
//  the signal everyone was reading was manufactured. record-price-snapshot.js
//  reads src/data/parts.js and never contacts a retailer, so it appended a fresh
//  dated point every single day for retailers no job had touched since April:
//  139,080 Best Buy price points across 1,591 series, of which exactly one ever
//  changed value. Density was being read as liveness. It never was.
//
//  The lesson is not "watch Best Buy". It is that a frozen retailer is INVISIBLE
//  unless something asserts the absence of confirmation, because every derived
//  artifact downstream keeps looking healthy. Four more retailers were frozen the
//  same way and went unnoticed for the same reason.
//
//  So this gate measures the only thing that cannot be faked by a derivation:
//  the stamp a WRITE PATH leaves on a deal when it actually talked to a retailer.
//
//  ── AND IT MEASURES THE MEDIAN ROW, NOT THE NEWEST ──────────────────────────
//  The staleness check originally read the age of the NEWEST stamp across a
//  retailer's rows. That is a max, and a max is exactly the shape of the bug
//  this file exists to catch: one row confirmed today reports the whole
//  retailer as 0d old, no matter what the other three thousand are doing.
//
//  It is not theoretical. Measured against the live catalog on 2026-08-28:
//
//    retailer          rows   NEWEST   MEDIAN    P90
//    newegg            3178       1d      10d    35d
//    newegg_openbox     182       1d      10d   106d
//
//  Newegg's re-pricer has not written a single row since 2026-07-20 — 0 of
//  3,178 rows carry `refreshedAt` — yet the gate read it as 1d fresh, because
//  sftp-ingest stamps `matchedAt` on newly ATTACHED deals and a max picks those
//  up. This gate's own CADENCE note already says sftp-ingest "refreshes nothing
//  for a row already in the catalog"; the max was quietly counting it anyway.
//
//  Today that lie is harmless only by accident: both retailers fail on
//  schedule-disabled and unscheduled instead. Re-enable Newegg's cron and this
//  gate goes green while most rows sit stale.
//
//  So staleness is judged on the MEDIAN confirmed row. It asks "has the typical
//  row been confirmed", which is the question the budget was always meant to
//  answer, and it is robust in both directions: one active row cannot vouch for
//  a catalog, and one forgotten row cannot condemn it. The newest stamp is
//  still reported next to it, because the GAP between the two is the diagnostic.
//
//  Same reasoning as scripts/price-movement.cjs, which replaced the identical
//  max in the MSI/Best Buy/Newegg refreshers.
//
//  ── AND THE TAIL, NOT ONLY THE MEDIAN ───────────────────────────────────────
//  The median fixed the max's weakness and inherited its mirror image: a max is
//  held at 0d by one active row, a median by any MAJORITY. A retailer whose
//  sweep reaches two thirds of its rows and never touches the rest reports a
//  healthy 0d median forever.
//
//  Measured 2026-09-02: refresh-newegg-prices reaches 2,102 of 3,189 rows on
//  every run and 1,064 are reached by nothing — a fixed, strictly nested set,
//  not a rate. Consecutive runs reach the same 2,100 rows and zero rows reached
//  by the earlier run are missed by the later one. deals.newegg only read STALE
//  at all because sftp-ingest was erasing the re-pricer's stamps between runs;
//  the moment that was fixed the median went to 0d and this gate would have
//  gone GREEN over all 1,064.
//
//  So the p90 is gated too, against a wider budget, and reported as a row COUNT
//  beside the quantile — 'p90 23d' describes 4 forgotten rows and 1,064
//  unreachable ones identically. STALE and STALE TAIL are deliberately distinct
//  verdicts: one means the job is not keeping up with the catalog, the other
//  means something is permanently outside its reach, and "run it more often"
//  fixes only the first. See P90_BUDGET_MULTIPLE.
//
//  ── AND A ROW WE FAILED TO CONFIRM IS STALE, NOT ABSENT ─────────────────────
//  The negative stamp used to `continue` — a row whose priceUnconfirmedAt was
//  newer than every positive stamp was skipped entirely, landing in neither
//  `stamped` nor `ages`. That does not make the row read as stale. It DELETES
//  the row from the quantiles, and the effect is backwards: stamping "we could
//  not confirm this" made a retailer's numbers BETTER.
//
//  Measured on the live catalog 2026-09-08:
//
//    lane              rows   dropped   p90 as measured   p90 counting them
//    newegg_openbox     225       143               0d                117d
//    amazon            3755       215              12d                 14d
//    newegg            3198        21              21d                 21d
//
//  newegg_openbox read OK on 82 of 225 rows because the other 143 were
//  invisible, while its median row had gone 6 days unconfirmed and its tail
//  117. That is the same shape as the Best Buy freeze this file was written
//  for: a green light produced by not looking.
//
//  So the precedence rule now decides only what it was ever about — whether the
//  row counts as CONFIRMED — and the row is measured regardless, at the age of
//  its last real confirmation. That is a fact about the row that a later
//  failure does not erase: `best` is still the last day anything vouched for
//  this price, and the age since it is still exactly how stale it is.
//
//  This is the same precedence rule as priceFreshness() in src/App.jsx, and the
//  copy was where it went wrong: there the precedence decides how to LABEL a
//  row, and a labelled row is still on the page. Here it decided whether the
//  row exists at all. `stamped` and `unconfirmed` are reported side by side so
//  the two populations stay separable.
//
//  ── AND A ROW NOTHING EVER CONFIRMED IS THE STALEST ROW, NOT ABSENT ─────────
//  The same hole, one line earlier: a row carrying no positive stamp of any kind
//  was dropped by `if (!found.length) continue`. On main 2026-09-10 that was 50
//  published amazon rows, 70 bestbuy and 10 msi — prices the site shows under an
//  UNCONFIRMED tag — and 13 of the amazon ones were sponsored-ad redirect links
//  with no /dp/ASIN in them: rows the verifier cannot even SELECT, so nothing had
//  ever asked about them and nothing ever would. A row no check can reach is
//  invisible to every check, and this gate was one of them.
//
//  The note that stood here said such rows "need a threshold of their own rather
//  than a quantile". They do not. A row never confirmed is at least as stale as
//  the stalest confirmed row, so it enters the quantiles as MAXIMALLY stale — age
//  Infinity, printed 'never'. That keeps the quantiles' own robustness: a handful
//  cannot condemn a healthy lane, a tenth of them fails it. `never` is reported
//  beside `unconfirmed` so the three populations stay separable.
//
//  ── AND A HIDDEN ROW IS COUNTED SEPARATELY, NOT DROPPED ─────────────────────
//  The quantiles used to measure every row in a lane, including products the
//  site does not show. A quarantined product (needsReview) is filtered out of
//  App.jsx, prerender and the sitemap, so its price is published nowhere. It is
//  also the population verify-catalog deliberately stopped paying to re-check
//  (785d4ce2444), so every quarantined Amazon row PA API cannot confirm ages
//  into the tail by construction. Measured on main 2026-09-10:
//
//    amazon   655 rows past budget   559 of them hidden   96 published
//
//  The verdict was reading the quarantine backlog as the verifier failing, and
//  Amazon's STALE TAIL mostly described rows no visitor could see.
//
//  So the quantiles now measure PUBLISHED rows — this gate's question has always
//  been "is a retailer publishing prices nothing refreshes". Hidden rows are NOT
//  dropped, because that is the negative-stamp hole above wearing a different
//  hat: quarantining a stale row would delete it from the alarm. They get their
//  own count and their own failure, HIDDEN TAIL, whose allowance is fixed by the
//  lane's TOTAL size (see HIDDEN_TAIL_SHARE). A row that moves from published to
//  hidden moves from one alarm to the other and buys no slack.
//
//  ── WHY IT FAILS INSTEAD OF WARNING ─────────────────────────────────────────
//  Twice in August a real signal was emitted and ignored. refresh-newegg-prices
//  reported "0 updated" on every run from 2026-07-06 and kept deleting; the
//  Best Buy charts were visibly dead-flat in the UI for months. Both were
//  observable. Neither was actionable, because nothing had to be done about
//  them. A warning is a signal with no consequence attached, and this codebase
//  has now demonstrated twice that it will route around one. Exit code 1 is the
//  entire point of the file.
//
//  ── WHAT IS DERIVED VS STATED ───────────────────────────────────────────────
//  Following scripts/derive-constants.cjs: nothing about the schedule is
//  transcribed. Each retailer names the workflow and cron responsible for
//  confirming it, and this gate goes and READS that workflow to check the cron
//  is still live. The staleness budget is then computed from that cron's real
//  interval via one stated policy (MISSED_CYCLES_ALLOWED / MIN_BUDGET_DAYS)
//  rather than hand-written per retailer, so a schedule change cannot silently
//  invalidate the budget it justified.
//
//  That second layer is the one that would have caught Newegg. Its cron was
//  commented out on 2026-07-20 and the data took weeks to visibly rot; the
//  disabled schedule was detectable the same day.
//
//  Usage:
//    node scripts/assert-retailer-freshness.cjs           # assert, exit 1 on failure
//    node scripts/assert-retailer-freshness.cjs --json     # machine-readable tally
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Overridable so the gate can be PROVEN to fire against doctored inputs without
// touching the real tree — the same affordance, for the same reason, as WF_DIR in
// scripts/derive-constants.cjs and test/verify-main-writer-lock.cjs. A guard only
// ever seen passing is not known to be discriminating.
const DEFAULT_WF_DIR = path.join(ROOT, '.github', 'workflows');
const DEFAULT_PARTS = path.join(ROOT, 'src', 'data', 'parts.js');

// ── stamp vocabulary ────────────────────────────────────────────────────────
//
// A deal is "confirmed" only by a stamp a write path left on it after contacting
// the retailer. Verified against the live catalog rather than assumed — these are
// the only *At fields that actually occur on deal objects today:
//
//   priceConfirmedAt   amazon (2,810) · newegg (893) · bestbuy (9) · newegg_marketplace (31)
//   matchedAt          newegg (2,666) · newegg_openbox (60) · newegg_marketplace (37)
//   priceUnconfirmedAt amazon (777) — an explicit "we tried and could NOT confirm"
//
// refreshedAt is included below even though it is currently on ZERO rows. It is
// what refresh-newegg-prices.cjs:466 writes on a successful re-price, and the
// reason its own workflow cites "0 of 5,428 products carry refreshedAt" as
// evidence the job never worked. The moment that cron is re-enabled it becomes
// the live Newegg confirmation stamp, and a gate that did not count it would
// report a working re-pricer as a frozen retailer.
const CONFIRMATION_STAMPS = ['priceConfirmedAt', 'matchedAt', 'refreshedAt'];

// An explicit failure NEWER than the last success means the most recent thing we
// know is that we could not confirm the price. Mirrors priceFreshness() in
// src/App.jsx, which applies the same precedence rule for the same reason.
const NEGATIVE_STAMP = 'priceUnconfirmedAt';

// ── staleness policy ────────────────────────────────────────────────────────
//
// Two stated numbers, applied uniformly, instead of a hand-picked budget per
// retailer. Per-retailer magic numbers are how a threshold ends up defensible to
// nobody: it is picked by feel, the schedule it was picked against changes, and
// the number stays.

// A retailer may miss this many of its own scheduled confirmation cycles before
// the gate fails. TWO, not one: a single miss is ordinary — a skipped run, a
// rebase collision on the main-writer lock, a retry that lands after midnight.
// Two consecutive misses is not jitter, it is a job that has stopped working.
// Same reasoning, and the same answer, as PRICE_STALE_AFTER_DAYS in
// src/price-freshness.js: weekly slowest tier x 2 missed cycles = 14 days.
const MISSED_CYCLES_ALLOWED = 2;

// Floor under the computed budget. Without it, a twice-daily job like
// refresh-newegg-prices ('0 6,18 * * *') gets a 1-day budget, and any single
// weekend of queue backlog reads as a frozen retailer. Three days is the
// smallest window that survives a Friday-evening failure plus a weekend without
// crying wolf — and an alarm that cries wolf is an alarm that gets commented out,
// which is the specific outcome this whole file exists to prevent.
const MIN_BUDGET_DAYS = 3;

// How many times the typical row's budget the SLOWEST DECILE may take.
//
// ── WHY A SECOND QUANTILE EXISTS ────────────────────────────────────────────
// The median replaced the newest stamp because a max is held at 0d by one
// active row. The median has the mirror weakness one quantile up: it is held at
// 0d by any MAJORITY, so a retailer whose sweep reaches two thirds of its rows
// and never touches the other third reports a perfectly healthy 0d median
// forever. That is not hypothetical and it is not small. Measured on
// 2026-09-02, refresh-newegg-prices reaches 2,102 of 3,189 rows on every run
// and the remaining 1,064 are reached by nothing:
//
//   run          processed   matched OK   lookup failed   no_cat_mapping
//   33607979228       3189         2102            1066               85
//   33547739235       3189         2097            1071               85
//   33490323017       3185         2097            1073               85
//
// and the set is fixed, not a rate — comparing the rows actually reached by
// consecutive runs, 2,100 of 2,125 are the same rows and ZERO rows reached by
// the earlier run were missed by the later one. It is a strictly nested,
// permanently unreachable tail.
//
// This gate could not see it. deals.newegg read STALE only because a later job
// was erasing the re-pricer's stamps (see sftp-ingest.cjs applyMatchToPart);
// with those carried across, the median goes to 0d and this gate goes GREEN
// over 1,064 rows nothing has ever confirmed. The stamp fix and this threshold
// ship together for exactly that reason: alone, the first one's only visible
// effect would have been to silence the alarm that found the second.
//
// FOUR, applied to the budget rather than to the cron: the tail decile is by
// construction the last thing a partial sweep reaches, so it earns real slack —
// but a row unconfirmed for four consecutive full budgets is not lagging behind
// the sweep, it is outside it. Multiplying the BUDGET rather than the interval
// keeps MIN_BUDGET_DAYS' weekend-backlog protection proportional instead of
// letting the floor collapse the two thresholds together (a twice-daily cron
// floors to a 3d median budget but computes a 4d p90 budget, which would make
// the tail check very nearly the median check again).
const P90_BUDGET_MULTIPLE = 4;

// How many HIDDEN (needsReview) rows may sit past the tail budget, as a share of
// ALL of the lane's rows.
//
// ── WHY A SHARE OF THE WHOLE LANE ───────────────────────────────────────────
// Hidden rows are measured apart from the published quantiles (see the header),
// and the one property their alarm must have is that quarantining cannot green
// the gate. A share of the HIDDEN population would not have it: every stale row
// quarantined grows the denominator along with the numerator. A share of the
// whole lane is fixed by lane size, so a row that leaves the published tail for
// the hidden one is charged against an allowance that did not move.
//
// Not a new number. It is the slack the published tail already gets — the p90
// check tolerates the slowest tenth of rows — measured against the same tail
// budget (budget x P90_BUDGET_MULTIPLE). TAIL_QUANTILE is derived from it rather
// than restated, so the two cannot drift apart.
const HIDDEN_TAIL_SHARE = 0.1;
const TAIL_QUANTILE = 1 - HIDDEN_TAIL_SHARE;

// =============================================================================
//  THE TABLE
//
//  One entry per retailer that appears in src/data/parts.js. Every entry either
//  names the scheduled job that confirms it, or states plainly that no such job
//  exists. There is no third option and no default — a retailer missing from
//  this table fails the gate (see 'unknown-retailer'), which is what stops the
//  next silently-added retailer from repeating msi's four months of nothing.
// =============================================================================
// newegg_marketplace was REMOVED from this table on 2026-08-28, together with
// the 37 deals that fed it. It is not an omission and it must not be added back
// as an empty entry: audit() reports a CADENCE entry with no rows in the catalog
// as `phantom-retailer` and fails, which is the reverse direction of the
// unknown-retailer check and exists so this table cannot quietly describe a
// retailer that no longer ships.
//
// The rows are still guarded. dedupe-case-batch.cjs is a one-off script no
// workflow invokes, but it still writes deals.newegg_marketplace — and if it is
// ever run again those rows return to a catalog with no entry here, which fails
// as `unknown-retailer`. Deleting the entry is what keeps the guard armed;
// keeping a stale one is what would disarm it.
//
// Why dropped rather than refreshed: all 37 were Case, all 37 carried a
// deals.newegg peer on the same row (the lane exists because dedupe-case-batch
// preserved a cheaper 3P offer beside the 1P one), and 30 of those peers were
// in stock and confirmed inside the freshness window — so no row lost its only
// offer. The MKPL feed that would have refreshed them is deliberately not
// ingested (886MB, measurably dead), and Rakuten Product Search reaches
// marketplace listings only as a last resort behind first-party, so repricing
// would have needed a dedicated request lane against the budget #71 had just
// tightened. See drop-newegg-marketplace.cjs.
const CADENCE = {
  amazon: {
    confirmedBy: { workflow: 'verify-catalog.yml', cron: '0 11 * * *' },
    why:
      'verify-catalog.yml runs verify-catalog-asins.js in four tiers. The cadence was rewritten ' +
      'on 2026-08-25 (01008c23c79): tier 1 — the primary build components — twice a day at 08:00 ' +
      'and 20:00, and tiers 2, 3 and 4 once a day at 09:00, 10:00 and 11:00. The old citation ' +
      'here was the pre-rewrite weekly tier (0 10 * * 1) and this gate correctly reported it as ' +
      'cite-drift once the schedule moved underneath it. ' +
      'Tier 4 at 11:00 is cited because the SLOWEST tier sets the budget for every Amazon row, ' +
      'and all four are now daily — so the budget is a daily one. This is the retailer ' +
      'demonstrably working: 3,140 of 3,755 rows confirmed, newest stamp today, median age 0d.',
  },

  newegg: {
    // TWO writers, because this lane genuinely has two. See citesFor().
    confirmedBy: [
      { workflow: 'refresh-newegg-prices.yml', cron: '0 4,16 * * *' },
      { workflow: 'sftp-ingest.yml', cron: '0 12 * * *' },
    ],
    why:
      'refresh-newegg-prices.cjs is the designated re-pricer — its own header calls it the ' +
      'daily Newegg re-price / re-match. Its cron was commented out on 2026-07-20 and this ' +
      'gate correctly failed with schedule-disabled for 39 days, which is the alarm working. ' +
      'Re-enabled 2026-08-28: the disable cited a broken SKU lookup that 058b6959700 fixed the ' +
      'same day (searchNewegg by name/UPC, and a failed lookup no longer counts as absence), ' +
      'verified on a 2026-08-17 live dry run that repriced 22 of 50 rows and removed none. ' +
      'The hours moved from 6,18 to 4,16 because 06:00 is prerender\'s slot and both are in the ' +
      'main-writer group; frequency is unchanged, so the budget this entry justifies is too. ' +
      'sftp-ingest.yml IS a cite for this lane now, and the reason it was not has been ' +
      'restated twice because the old wording was wrong twice over. It read "stamps matchedAt ' +
      'only on newly attached deals (sftp-ingest.cjs:411)": that line number now points into ' +
      'matchRecord(), and the claim was never accurate either — applyMatchToPart() rewrites ' +
      'matchedAt on every replacement, not only on first attachment. ' +
      'The policy it was really protecting stands, unchanged: sftp-ingest confirms only the rows ' +
      'it ALONE writes, because a job certifying a lane that has its own re-pricer would let that ' +
      're-pricer die unnoticed. That is why this retailer read 1d newest against a 10d median ' +
      'while nothing had repriced it at all: 0 of 3,178 rows carried refreshedAt on 2026-08-28. ' +
      'WHAT CHANGED IS THE GRANULARITY OF "ALONE", not the rule. It was per CATEGORY — 85 rows ' +
      'in categories with no CAT_FILTER entry, where searchNewegg returns no_cat_mapping before ' +
      'issuing a request. But CAT_FILTER answers "may the re-pricer ask about this row", and the ' +
      'question that matters is "will it ever confirm it". searchNewegg queries by name and UPC ' +
      'while the feed is keyed by newegg_item_number, so a mapped row whose name never matches is ' +
      'asked about every run and confirmed by nothing. Measured on main 2026-09-08, that gap IS ' +
      'the tail and is nothing else: of 3,198 rows, all 860 past the 12d tail budget carry no ' +
      'refreshedAt at all — not one is a row the re-pricer reaches and is merely behind on. ' +
      'So sftp-ingest now certifies deals.newegg for a row the re-pricer has NEVER reached, ' +
      'stated as refreshedAt being absent (sftp-ingest.cjs lanesSolelyOwned). ' +
      'THE SAFETY PROPERTY IS UNTOUCHED, and it is load-bearing: this job carries refreshedAt, it ' +
      'never mints one, so a row the re-pricer has ever confirmed can never enter that set. The ' +
      '~2,100 rows it does reach stay under its own liveness, and a dead refresh-newegg-prices ' +
      'still drives them stale and still fails this gate on the MEDIAN. Both crons are checked ' +
      'here, and the budget comes from the slower of the two. ' +
      'EXPECT THIS TO STAY RED, SMALLER. The feed offers ~60% of the never-reached rows (five ' +
      'consecutive nightly censuses: 60.1/60.2/60.3/61.4/60.8%), and breakeven for p90 <= 12d is ' +
      '~54% — but the unreached set is fixed rather than random, so the ~400 rows the feed does ' +
      'not carry stay stale against a ~320-row p90 allowance. Those need an itemNumber-keyed ' +
      'lookup and are deliberately not in this change. Feed absence is NOT death: 19.7% of rows ' +
      'the re-pricer confirms ALIVE are also absent from the feed, so they must not be dropped.',
  },

  bestbuy: {
    confirmedBy: { workflow: 'refresh-bestbuy-prices.yml', cron: '0 1 * * *' },
    why:
      'This entry used to read "NO REFRESHER EXISTS", and it was right: Best Buy prices were ' +
      'captured once at merge time by bestbuy-merge.js and never touched again. The fix it asked ' +
      'for — "a refresher that reads SKUs from parts.js and writes priceConfirmedAt" — was built ' +
      'and its cron went on with the first watched apply run on 2026-08-19 (cf8337013a7: 561 ' +
      'prices, 39 stock flips, 175 held). 885 of 1,040 rows now carry priceConfirmedAt at a ' +
      'median age of 0 days. ' +
      'The refresher HOLDS a price it will not vouch for rather than laundering it — an upstream ' +
      'stamp older than 90 days, a peer retailer contradicting the number, a sku that names a ' +
      'different product — and a held row is deliberately not stamped, so the age this gate reads ' +
      'stays the age of the last CONFIRMED price. That is why the 155 unstamped rows are the gate ' +
      'working rather than the job failing.',
  },

  msi: {
    confirmedBy: { workflow: 'refresh-msi-prices.yml', cron: '0 2 * * *' },
    why:
      'The retailer this gate was written about. deals.msi was written once on 2026-05-27 and ' +
      'never re-read: 157 rows, not one stamp of any kind, the only retailer in the catalog with ' +
      'none. It reached that state because it had a link and no updater, which is the ' +
      'unknown-retailer case this table exists to make impossible. ' +
      'refresh-msi-impact.mjs is the updater; refresh-msi-prices.yml runs it daily at 02:00, ' +
      'after the Best Buy refresh finishes and before the 06:00 prerender. ' +
      'NOTE the ingest is deliberately NOT cited here. ingest-msi-impact-v2.cjs decides which ' +
      'catalog row an MSI item belongs to, and a scheduled job must not be able to relink the ' +
      'catalog — the refresher only moves price and stock on rows whose identity is already ' +
      'settled, which is the same reason sftp-ingest.yml is not the right cite for newegg. ' +
      'Impact returns no per-item upstream timestamp, so MSI rows cannot get the 90-day upstream ' +
      'hold Best Buy rows get. The compensating checks are daysSinceAnyPriceMoved and ' +
      'movement.freezeAlarm, both asserted in the workflow against priceLastMovedAt — a stamp ' +
      'only a real price change can advance — because a frozen Impact feed would otherwise ' +
      'produce a green run and a fresh priceConfirmedAt on a May price. The second is a ' +
      'distribution across rows rather than the age of the newest stamp anywhere: a max is held ' +
      'at 0 by any single active SKU, which is how a partial freeze hides. See ' +
      'scripts/price-movement.cjs.',
  },

  newegg_openbox: {
    confirmedBy: { workflow: 'sftp-ingest.yml', cron: '0 12 * * *' },
    why:
      'This entry previously read "written only by one-off scripts, no scheduled job touches it, ' +
      'newest matchedAt is 2026-05-15, these 60 rows". Every one of those was wrong by ' +
      '2026-08-28: 182 rows, newest matchedAt 2026-08-27, and sftp-ingest.yml had been writing ' +
      'the lane nightly at 12:00 the whole time — 175 of the 182 rows carry matchMethod ' +
      'sftp:upc. The lane was never unscheduled. It was UNSTAMPED. ' +
      'sftp-ingest.cjs wrote matchedAt and nothing else, and matchedAt records when a row was ' +
      'bound to a SKU rather than when its price was confirmed, so src/price-freshness.js ' +
      'correctly refused it and the render path read all 182 rows as never-confirmed. It now ' +
      'writes priceConfirmedAt on every condition-lane write, which is what this cite rests on. ' +
      'Note the asymmetry with the newegg entry below, which deliberately does NOT cite this ' +
      'workflow: deals.newegg has its own re-pricer, and letting this job certify that lane ' +
      'would let a dead refresh-newegg-prices read as healthy. These lanes have nothing else, ' +
      'so this job is their only possible cite. ' +
      'Open-box is single-unit inventory and should move MORE than new, not less. It moved 5.1% ' +
      'against deals.newegg\'s 27.1% over the same window, because the ingest\'s cross-run ' +
      'selector only replaced a same-rank in-stock listing when the new price was LOWER — a rise ' +
      'was never written. Same-listing repricing is now unconditional, and rows the full feed ' +
      'stops offering get priceUnconfirmedAt from the absence sweep rather than keeping their ' +
      'last price silently forever.',
  },

};

// =============================================================================
//  cron interval
// =============================================================================

const DAY_MS = 86400000;

/**
 * Interval between consecutive firings of a cron expression, in days.
 *
 * Deliberately handles ONLY the shapes this repo actually uses and THROWS on
 * anything else. Guessing an interval would silently produce a wrong budget,
 * which is worse than failing: the gate would keep passing with a threshold
 * nobody chose. Same principle as matchOnce() in derive-constants.cjs — an
 * ambiguous parse is a defect, not a fallback.
 *
 * Supported: 'M H * * *' daily · 'M H,H,... * * *' n-times-daily ·
 *            'M H *\/N * *' every N days · 'M H * * D' weekly · '*\/N * * * *' every N minutes
 */
function cronIntervalDays(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron '${expr}': expected 5 fields, got ${f.length}`);
  const [min, hour, dom, mon, dow] = f;

  if (mon !== '*') throw new Error(`cron '${expr}': month restrictions are not modelled`);

  // */N in the minute field — sub-daily polling (epik-watchdog).
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && dow === '*') {
    return Number(min.slice(2)) / (24 * 60);
  }
  if (!/^\d+$/.test(min)) throw new Error(`cron '${expr}': unsupported minute field '${min}'`);

  // Weekly (or n-times-weekly) via day-of-week.
  if (dow !== '*') {
    if (dom !== '*') throw new Error(`cron '${expr}': both day-of-month and day-of-week set`);
    const days = dow.split(',');
    if (!days.every((d) => /^\d+$/.test(d))) throw new Error(`cron '${expr}': unsupported day-of-week '${dow}'`);
    return 7 / days.length;
  }

  // Every N days via */N in day-of-month. Approximate by construction: month
  // boundaries reset the cycle, so the true worst-case gap is larger than N.
  // Erring long here would shrink the budget and cause false alarms, so the
  // nominal N is used and the month-boundary slack is absorbed by
  // MISSED_CYCLES_ALLOWED.
  if (/^\*\/\d+$/.test(dom)) {
    const n = Number(dom.slice(2));
    if (!(n > 0)) throw new Error(`cron '${expr}': bad day step '${dom}'`);
    return n * hoursPerDayFactor(hour, expr);
  }
  if (dom !== '*') throw new Error(`cron '${expr}': unsupported day-of-month '${dom}'`);

  return hoursPerDayFactor(hour, expr);
}

/** Days between firings within a single day, from the hour field. */
function hoursPerDayFactor(hour, expr) {
  if (hour === '*') return 1 / 24;
  const hours = hour.split(',');
  if (!hours.every((h) => /^\d+$/.test(h))) throw new Error(`cron '${expr}': unsupported hour field '${hour}'`);
  return 1 / hours.length;
}

/** The stated policy, applied. */
function budgetDaysFor(intervalDays) {
  return Math.max(MIN_BUDGET_DAYS, Math.ceil(intervalDays * MISSED_CYCLES_ALLOWED));
}

/**
 * The cites for one retailer, always as a list.
 *
 * ── WHY A LANE MAY NAME MORE THAN ONE JOB ───────────────────────────────────
 * `confirmedBy` was one {workflow, cron} because one lane had one writer. That
 * stopped being true for deals.newegg: refresh-newegg-prices confirms the rows
 * it can address, and sftp-ingest confirms the rows it structurally cannot (see
 * lanesSolelyOwned() in sftp-ingest.cjs). Both are real confirmation paths for
 * the same lane and the gate has to know about both.
 *
 * Writing only the busier one would be the failure this file exists to prevent,
 * one level up: the SECOND job's schedule would go unchecked, and if its cron
 * were commented out — the precise thing that happened to refresh-newegg-prices
 * on 2026-07-20 — this gate would keep citing a live workflow while the rows it
 * actually confirms quietly froze. A cite that does not cover every writer is a
 * transcribed schedule with extra steps.
 *
 * Accepts a bare object so every single-writer entry stays exactly as it was.
 */
function citesFor(spec) {
  const c = spec.confirmedBy;
  return Array.isArray(c) ? c : [c];
}

/**
 * The budget for a lane with several writers is set by the SLOWEST of them.
 *
 * Same rule the amazon entry already states for its four tiers — "the SLOWEST
 * tier sets the budget for every Amazon row" — and the conservative direction:
 * taking the fastest cron would compute a budget no single writer's rows are
 * held to, which is how a threshold ends up defensible to nobody.
 */
function slowestIntervalDays(cites) {
  return Math.max(...cites.map((c) => cronIntervalDays(c.cron)));
}

// =============================================================================
//  workflow schedule reading
// =============================================================================

/**
 * Live and disabled crons for one workflow file.
 *
 * The commented-cron pattern is the load-bearing half. derive-constants.cjs
 * carries the same distinction for the same reason: showing a disabled schedule
 * as active is exactly the "expected every 12h, last ran in July" confusion
 * being prevented here.
 */
function readSchedule(wfDir, file) {
  const p = path.join(wfDir, file);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return {
    file,
    live: [...text.matchAll(/^\s{4,}- cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    disabled: [...text.matchAll(/^\s*#\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  };
}

// =============================================================================
//  catalog reading
// =============================================================================

const dayOnly = (t) => (t ? String(t).slice(0, 10) : null);

/**
 * Age in days of the row at quantile `q` of a list of 'YYYY-MM-DD' stamps.
 * Oldest first, so q=0.5 is the median row's age and q=0.9 is the age only a
 * tenth of rows are worse than. Null for an empty list — "no rows" is a
 * different verdict (NEVER CONFIRMED) and must not read as age 0.
 */
function quantileAgeDays(stamps, q, now) {
  if (!stamps || !stamps.length) return null;
  const ages = stamps
    .map((s) => ageOf(s, now))
    .sort((a, b) => a - b);
  const i = Math.min(ages.length - 1, Math.floor(ages.length * q));
  return ages[i];
}

/**
 * How many confirmed rows are older than `days`.
 *
 * The quantiles say where the distribution sits; this says how big the problem
 * is. A p90 of 23d against a 3d budget is the same number whether it describes
 * 4 forgotten rows or 1,064 unreachable ones, and those are different defects
 * with different fixes.
 */
function countOlderThan(stamps, days, now) {
  if (!stamps || !stamps.length) return 0;
  return stamps.filter((s) => ageOf(s, now) > days).length;
}

// Stands in the stamp list for a row nothing has EVER confirmed. It is not a date
// and must never be parsed as one: its age is Infinity, which sorts it to the
// stale end of every quantile and past every budget. See the header.
const NEVER = 'never';

function ageOf(stamp, now) {
  return stamp === NEVER ? Infinity : Math.floor((now - Date.parse(stamp + 'T00:00:00Z')) / DAY_MS);
}

/** An age for a human: '12d', 'never' for a row nothing ever confirmed, '-' for no rows. */
const fmtAge = (days) => (days == null ? '-' : days === Infinity ? 'never' : `${days}d`);

/** Per-retailer stamp rollup from parts.js. */
async function readCatalog(partsPath) {
  if (!fs.existsSync(partsPath)) throw new Error(`parts.js not found at ${partsPath}`);
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) throw new Error(`${partsPath} did not export a PARTS array`);

  const retailers = {};
  for (const p of parts) {
    const deals = (p && p.deals) || {};
    for (const [name, d] of Object.entries(deals)) {
      if (!d || typeof d !== 'object') continue;
      const r = (retailers[name] ??= {
        rows: 0, stamped: 0, unconfirmed: 0, never: 0, negative: 0, newest: null, ages: [], byStamp: {},
        hidden: 0, hiddenAges: [], hiddenNever: 0,
      });
      r.rows++;

      const found = [];
      for (const field of CONFIRMATION_STAMPS) {
        const v = dayOnly(d[field]);
        if (v) { found.push(v); r.byStamp[field] = (r.byStamp[field] || 0) + 1; }
      }
      if (d[NEGATIVE_STAMP]) r.negative++;

      // A product the site does not show is measured apart, never dropped — see
      // the header. Its age is the same fact as a published row's: days since
      // anything last confirmed it, whatever its latest news is.
      if (p.needsReview) {
        r.hidden++;
        if (found.length) r.hiddenAges.push(found.sort()[found.length - 1]);
        else { r.hiddenNever++; r.hiddenAges.push(NEVER); }
        continue;
      }

      // Nothing has ever confirmed this row. Measured as maximally stale rather
      // than skipped — skipping it is how a row no job can reach stayed out of
      // every alarm. See the header.
      if (!found.length) {
        r.never++;
        r.ages.push(NEVER);
        continue;
      }
      const best = found.sort()[found.length - 1];

      // A negative stamp newer than every positive one means the newest thing we
      // know is a failure to confirm. It must not count as CONFIRMATION — and it
      // must not remove the row from the MEASUREMENT either. See the header.
      const failedAt = dayOnly(d[NEGATIVE_STAMP]);
      const unconfirmed = !!(failedAt && failedAt > best);

      if (unconfirmed) {
        r.unconfirmed++;
      } else {
        r.stamped++;
        // `newest` stays confirmed-only: it is the "is anything alive here at
        // all" diagnostic, and a row whose latest news is a failure must not be
        // the thing that makes a retailer look recently touched.
        if (!r.newest || best > r.newest) r.newest = best;
      }

      // Every row that has EVER been confirmed, whether or not its latest news is
      // a failure — `best` is a real past confirmation date either way, and the
      // age since it is exactly how stale the row is. `newest` alone is a MAX,
      // and a max cannot distinguish "this retailer is being confirmed" from
      // "one row of this retailer was confirmed". See the header.
      r.ages.push(best);
    }
  }
  return { total: parts.length, retailers };
}

// =============================================================================
//  audit
// =============================================================================

async function audit(opts = {}) {
  const partsPath = opts.partsPath || DEFAULT_PARTS;
  const wfDir = opts.wfDir || process.env.WF_DIR || DEFAULT_WF_DIR;
  const now = opts.now ? new Date(opts.now) : new Date();
  const cadence = opts.cadence || CADENCE;

  const { total, retailers } = await readCatalog(partsPath);
  const rows = [];
  const failures = [];

  const seen = new Set(Object.keys(retailers));

  // A table entry for a retailer that is no longer in the catalog is stale
  // documentation asserting a fact about nothing. Fail so the table stays honest.
  for (const name of Object.keys(cadence)) {
    if (!seen.has(name)) {
      failures.push({
        retailer: name,
        kind: 'phantom-retailer',
        detail: `CADENCE has an entry for '${name}' but no deal in the catalog uses it — remove the entry or restore the retailer`,
      });
    }
  }

  for (const name of Object.keys(retailers).sort()) {
    const r = retailers[name];
    const spec = cadence[name];
    const row = {
      retailer: name,
      rows: r.rows,
      stamped: r.stamped,
      // Rows measured but NOT confirmed: something vouched for this price once,
      // and the newest thing we know is that we tried again and could not. They
      // are in `ages` and therefore in every quantile below.
      unconfirmed: r.unconfirmed,
      // Published rows nothing has EVER confirmed. In the quantiles at age
      // Infinity — the stalest a row can be, not absent. See the header.
      never: r.never,
      // Rows behind the quantiles: stamped + unconfirmed + never — every
      // published row. Deliberately reported, because it is the number that
      // used to silently differ from `rows`.
      measured: r.ages.length,
      negative: r.negative,
      byStamp: r.byStamp,
      newest: r.newest,
      // ageDays is the age of the NEWEST stamp — reported, never gated on. The
      // gate reads medianAgeDays; see the header for why.
      ageDays: r.newest == null ? null : Math.floor((now - Date.parse(r.newest + 'T00:00:00Z')) / DAY_MS),
      medianAgeDays: quantileAgeDays(r.ages, 0.5, now),
      p90AgeDays: quantileAgeDays(r.ages, TAIL_QUANTILE, now),
      budgetDays: null,
      p90BudgetDays: null,
      // The tail as a COUNT, not a quantile. 'p90 23d' says a tenth of rows are
      // worse than 23 days; it does not say how many rows are unconfirmed, and
      // that number is what someone has to go and fix. Filled in once the budget
      // is known.
      staleRows: null,
      // Everything above describes PUBLISHED rows. Hidden (needsReview) rows are
      // counted here instead, with their own verdict — see HIDDEN_TAIL_SHARE.
      // published + hidden === rows, always: nothing leaves the lane's count.
      published: r.rows - r.hidden,
      hidden: r.hidden,
      hiddenMeasured: r.hiddenAges.length,
      hiddenNever: r.hiddenNever,
      hiddenStaleRows: null,
      hiddenAllowance: null,
      hiddenVerdict: null,
      hiddenDetail: null,
      cite: null,
      verdict: null,
      detail: null,
    };

    // 1. Unknown retailer. The gate refuses to have an opinion it was not given,
    //    and refuses to stay silent — the msi failure mode was precisely a
    //    retailer nobody had ever written a cadence for.
    if (!spec) {
      row.verdict = 'UNKNOWN';
      row.detail = 'no CADENCE entry — add one naming the job that confirms it, or state that none exists';
      failures.push({ retailer: name, kind: 'unknown-retailer', detail: row.detail });
      rows.push(row);
      continue;
    }

    // 2. Explicitly unscheduled. Stated in the table, and still a failure: a
    //    documented gap is still a gap, and publishing prices nothing refreshes
    //    is the thing being prevented, not the thing being excused.
    if (spec.unscheduled) {
      row.verdict = 'UNSCHEDULED';
      row.detail = spec.unscheduled;
      failures.push({ retailer: name, kind: 'unscheduled', detail: spec.unscheduled });
      rows.push(row);
      continue;
    }

    const citesRaw = spec.confirmedBy ? citesFor(spec) : [];
    if (!citesRaw.length || !citesRaw.every((c) => c && c.workflow && c.cron)) {
      row.verdict = 'MALFORMED';
      row.detail = `CADENCE entry for '${name}' has neither unscheduled nor a complete confirmedBy {workflow, cron}`;
      failures.push({ retailer: name, kind: 'malformed-entry', detail: row.detail });
      rows.push(row);
      continue;
    }

    const cites = citesRaw;
    row.cite = cites.map((c) => `${c.workflow} [${c.cron}]`).join(' + ');

    // 3. Provenance. Checked BEFORE staleness, because it is the earlier and
    //    more actionable signal: a disabled cron is detectable the day it is
    //    commented out, whereas the data it stops refreshing takes weeks to
    //    visibly rot. Newegg's cron was disabled 2026-07-20; this is the check
    //    that would have said so on 2026-07-20.
    //
    //    EVERY cite is checked, not just the first. A lane with two writers has
    //    two schedules that can go off independently, and the one that fails
    //    silently is by definition the one nobody was watching.
    let provenanceFailed = false;
    for (const { workflow, cron } of cites) {
      const sched = readSchedule(wfDir, workflow);
      if (!sched) {
        row.verdict = 'NO WORKFLOW';
        row.detail = `${workflow} does not exist in ${path.relative(ROOT, wfDir) || wfDir}`;
        failures.push({ retailer: name, kind: 'missing-workflow', detail: row.detail });
        provenanceFailed = true;
        break;
      }
      if (!sched.live.includes(cron)) {
        const why = sched.disabled.includes(cron)
          ? `cron '${cron}' in ${workflow} is COMMENTED OUT — the schedule that justifies this retailer's budget is not running`
          : `cron '${cron}' is not present in ${workflow} (live crons: ${sched.live.join(', ') || 'none'}) — the citation drifted from the workflow`;
        row.verdict = sched.disabled.includes(cron) ? 'SCHEDULE OFF' : 'CITE DRIFT';
        row.detail = why;
        failures.push({
          retailer: name,
          kind: sched.disabled.includes(cron) ? 'schedule-disabled' : 'cite-drift',
          detail: why,
        });
        provenanceFailed = true;
        break;
      }
    }
    if (provenanceFailed) {
      rows.push(row);
      continue;
    }

    row.budgetDays = budgetDaysFor(slowestIntervalDays(cites));
    row.p90BudgetDays = row.budgetDays * P90_BUDGET_MULTIPLE;
    row.staleRows = countOlderThan(r.ages, row.budgetDays, now);

    // 3b. HIDDEN rows — their own count and their own failure. Checked BEFORE the
    //     published verdicts below, because those end in `continue`: a lane can be
    //     STALE on what it publishes AND carry a hidden backlog, and each must be
    //     reported without the other masking it.
    row.hiddenStaleRows = countOlderThan(r.hiddenAges, row.p90BudgetDays, now);
    row.hiddenAllowance = Math.floor(r.rows * HIDDEN_TAIL_SHARE);
    if (row.hiddenStaleRows > row.hiddenAllowance) {
      row.hiddenVerdict = 'HIDDEN TAIL';
      row.hiddenDetail =
        `${row.hiddenStaleRows} quarantined (needsReview) rows are past the ${row.p90BudgetDays}d tail budget, ` +
        `over an allowance of ${row.hiddenAllowance} (${HIDDEN_TAIL_SHARE * 100}% of the lane's ${r.rows} rows)` +
        (r.hiddenNever ? `; ${r.hiddenNever} of the ${r.hidden} hidden rows have never been confirmed at all` : '') +
        `. The site does not show these, so no visitor sees a stale price. It is a quarantine nothing ` +
        `re-checks, which is exactly where a stale row would go to stop counting against the alarm.`;
      failures.push({ retailer: name, kind: 'hidden-tail', detail: row.hiddenDetail });
    }

    // 4. No confirmation at all, despite having a live scheduled job. Distinct
    //    from staleness: there is no age to report, and the job has never once
    //    demonstrably worked.
    //    A lane with nothing published has nothing this check can fail on; its
    //    rows, if any, are judged by 3b.
    if (row.published > 0 && r.stamped === 0) {
      row.verdict = 'NEVER CONFIRMED';
      // `unconfirmed` distinguishes "nothing has ever confirmed these" from
      // "everything that once confirmed them has since failed". Both mean the
      // job is not confirming anything today; only the second says it used to.
      row.detail = `${row.published} published rows, zero confirmation stamps` +
        (r.unconfirmed ? ` (${r.unconfirmed} were confirmed once and have since failed to re-confirm)` : '') +
        `, though ${row.cite} is scheduled — the job runs but is not confirming anything`;
      failures.push({ retailer: name, kind: 'no-stamps', detail: row.detail });
      rows.push(row);
      continue;
    }

    // 5. Staleness — measured on the MEDIAN row, not the newest one.
    //
    //    `ageDays` (the newest stamp anywhere) is what this check used to read,
    //    and it is a max: a single confirmed row reports the whole retailer as
    //    fresh. That is the same failure this file was written about, rebuilt
    //    inside the gate meant to catch it.
    //
    //    The median asks "has the TYPICAL row been confirmed", which is the
    //    question the budget was always meant to answer, and it is robust in
    //    both directions — one active row cannot vouch for the catalog, and one
    //    forgotten row cannot condemn it.
    if (row.medianAgeDays > row.budgetDays) {
      row.verdict = 'STALE';
      row.detail =
        `the median measured row is ${fmtAge(row.medianAgeDays)} old (p90 ${fmtAge(row.p90AgeDays)}` +
        (row.unconfirmed ? `, ${row.unconfirmed} of ${row.measured} explicitly unconfirmed` : '') +
        (row.never ? `, ${row.never} of ${row.measured} never confirmed at all` : '') +
        `), over the ` +
        `${row.budgetDays}d budget (${row.cite} x ${MISSED_CYCLES_ALLOWED} missed cycles) — ` +
        `the job is scheduled but not landing across the catalog. ` +
        `Newest stamp anywhere is ${row.newest} (${row.ageDays}d), which is why reading the newest ` +
        `alone would have reported this retailer as fresh.`;
      failures.push({ retailer: name, kind: 'stale', detail: row.detail });
      rows.push(row);
      continue;
    }

    // 6. The TAIL — rows the sweep never reaches, which a healthy median hides.
    //
    //    Checked after the median and reported as a distinct verdict because it
    //    is a distinct defect. STALE means the job is not keeping up with the
    //    catalog; STALE TAIL means the job is keeping up with the part of the
    //    catalog it can see, and something else is permanently out of its reach
    //    — an unmapped category, a query shape the feed never answers, a guard
    //    that declines every candidate. Those are fixed by different work than
    //    "make the job run more often", so they must not report as the same
    //    thing.
    //
    //    This is the check that stops the sftp-ingest stamp-carry fix shipping
    //    alongside it from turning a 15d median into a green light over 1,064
    //    rows nothing reaches. See P90_BUDGET_MULTIPLE.
    if (row.p90AgeDays > row.p90BudgetDays) {
      row.verdict = 'STALE TAIL';
      row.detail =
        `the median row is fine (${row.medianAgeDays}d, budget ${row.budgetDays}d) but the slowest ` +
        `decile is ${fmtAge(row.p90AgeDays)} old, over the ${row.p90BudgetDays}d tail budget ` +
        `(${row.budgetDays}d x ${P90_BUDGET_MULTIPLE}) — ${row.staleRows} of ${row.measured} measured rows ` +
        `are past the ${row.budgetDays}d budget` +
        (row.unconfirmed ? `, ${row.unconfirmed} of them explicitly unconfirmed` : '') +
        (row.never ? `, ${row.never} of them never confirmed at all` : '') +
        `. ${row.cite} is landing across most of the catalog ` +
        `and never reaching these. A median alone would have reported this retailer as healthy.`;
      failures.push({ retailer: name, kind: 'stale-tail', detail: row.detail });
      rows.push(row);
      continue;
    }

    row.verdict = 'OK';
    rows.push(row);
  }

  return {
    total, rows, failures,
    policy: { MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS, P90_BUDGET_MULTIPLE, HIDDEN_TAIL_SHARE, CONFIRMATION_STAMPS },
  };
}

// =============================================================================
//  report
// =============================================================================

/**
 * Prints a TALLY, not a boolean. Following test/verify-main-writer-lock.cjs: a
 * gate that only says FAIL cannot be sanity-checked, and the number that matters
 * when this fires is which retailer and how far past its budget — not the
 * exit code.
 */
function report(a) {
  const pad = (s, n) => String(s == null ? '-' : s).padEnd(n);
  const padL = (s, n) => String(s == null ? '-' : s).padStart(n);

  console.log(`RETAILER CONFIRMATION FRESHNESS — ${a.total} products`);
  console.log(
    `policy: ${a.policy.MISSED_CYCLES_ALLOWED} missed cycles allowed, ${a.policy.MIN_BUDGET_DAYS}d floor, ` +
    `tail budget = ${a.policy.P90_BUDGET_MULTIPLE}x, ` +
    `hidden rows past it <= ${a.policy.HIDDEN_TAIL_SHARE * 100}% of the lane`
  );
  console.log('quantiles measure PUBLISHED rows; HIDDEN = needsReview rows, H-PAST = hidden past tail budget / allowance');
  console.log(`stamps: ${a.policy.CONFIRMATION_STAMPS.join(', ')}\n`);

  // MEDIAN is the gated column; NEWEST/AGE are shown beside it because the gap
  // between them is the whole point — a retailer reading 0d newest and 35d
  // median is one where a handful of rows are carrying the report.
  // PAST is the tail as a count — the number someone has to go and fix. It sits
  // beside the quantiles because 'p90 23d' describes 4 forgotten rows and 1,064
  // unreachable ones identically, and only one of those is worth a morning.
  console.log(
    pad('RETAILER', 20) + padL('ROWS', 6) + padL('CONFIRMED', 11) + padL('UNCONF', 8) + padL('NEVER', 7) +
    padL('NEWEST', 13) +
    padL('AGE', 6) + padL('MEDIAN', 8) + padL('P90', 7) + padL('BUDGET', 10) +
    padL('PAST', 7) + padL('HIDDEN', 8) + padL('H-PAST', 10) + '  VERDICT'
  );
  console.log('-'.repeat(148));
  for (const r of a.rows) {
    console.log(
      pad(r.retailer, 20) + padL(r.rows, 6) + padL(r.stamped, 11) +
      padL(r.unconfirmed == null ? '-' : r.unconfirmed, 8) + padL(r.never == null ? '-' : r.never, 7) +
      padL(r.newest, 13) +
      padL(fmtAge(r.ageDays), 6) +
      padL(fmtAge(r.medianAgeDays), 8) +
      padL(fmtAge(r.p90AgeDays), 7) +
      padL(r.budgetDays == null ? '-' : `${r.budgetDays}d/${r.p90BudgetDays}d`, 10) +
      padL(r.staleRows == null ? '-' : r.staleRows, 7) +
      padL(r.hidden == null ? '-' : r.hidden, 8) +
      padL(r.hiddenStaleRows == null ? '-' : `${r.hiddenStaleRows}/${r.hiddenAllowance}`, 10) +
      '  ' + r.verdict + (r.hiddenVerdict ? ' + ' + r.hiddenVerdict : '')
    );
    if (r.cite) console.log(' '.repeat(20) + 'confirmed by: ' + r.cite);
  }

  if (!a.failures.length) {
    console.log(`\nPASS — all ${a.rows.length} retailers confirmed within their stated cadence.`);
    return 0;
  }

  console.log(`\nFAIL — ${a.failures.length} retailer(s) not confirmed within cadence:\n`);
  for (const f of a.failures) {
    console.log(`  [${f.kind}] ${f.retailer}`);
    for (const line of wrap(f.detail, 92)) console.log(`      ${line}`);
    console.log('');
  }
  if (a.failures.some((f) => f.kind !== 'hidden-tail')) {
    console.log('A retailer here is publishing prices nothing is refreshing. Fix the job, or');
    console.log('drop the retailer — those are the only two outcomes that make this pass.');
  }
  if (a.failures.some((f) => f.kind === 'hidden-tail')) {
    console.log('HIDDEN TAIL is not a price in front of a visitor. It is a quarantine nothing');
    console.log('re-checks: lift the rows that recover, drop the ones that will not, or re-check them.');
  }
  return 1;
}

/**
 * The --json tally. JSON has no Infinity — JSON.stringify writes it as null,
 * and null already means "no rows" here. A never-confirmed quantile must not
 * read as an empty lane, so it is written as 'never', the word the table uses.
 */
function toJson(a) {
  return JSON.stringify(a, (k, v) => (v === Infinity ? NEVER : v), 2);
}

function wrap(text, width) {
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out;
}

module.exports = {
  audit, report, toJson, cronIntervalDays, budgetDaysFor, readSchedule, readCatalog,
  citesFor, slowestIntervalDays,
  CADENCE, CONFIRMATION_STAMPS, NEGATIVE_STAMP, MISSED_CYCLES_ALLOWED, MIN_BUDGET_DAYS,
  P90_BUDGET_MULTIPLE, HIDDEN_TAIL_SHARE, TAIL_QUANTILE, countOlderThan,
  DEFAULT_WF_DIR, DEFAULT_PARTS,
};

if (require.main === module) {
  audit()
    .then((a) => {
      if (process.argv.includes('--json')) {
        console.log(toJson(a));
        return a.failures.length ? 1 : 0;
      }
      return report(a);
    })
    .then((code) => process.exit(code))
    .catch((e) => { console.error(String((e && e.message) || e)); process.exit(2); });
}
