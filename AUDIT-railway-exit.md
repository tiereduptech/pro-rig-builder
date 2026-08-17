# Railway Exit Audit

**Date:** 2026-08-17
**Scope:** everything stranded by the move off Railway — credentials that never
reached GitHub secrets, jobs that never got a workflow, and jobs that have a
workflow but do not actually run.
**Status:** 5 of 21 findings fixed (see §7). The rest are open and tracked in §8.

---

## 0. Why this file exists

Best Buy prices froze for roughly four months and nothing noticed. The reason
nothing noticed is the important part, and it generalises:

> `record-price-snapshot.js` reads prices out of `src/data/parts.js` and never
> contacts a retailer. It runs daily at 07:00. So every day it re-recorded
> whatever number was already in the file, stamped with today's date.

That produced 139,080 Best Buy price points across 1,591 series, of which
**exactly one ever changed value**. Density was being read as liveness. It never
was. Every derived artifact downstream — the history file, the charts, the
per-retailer splits — kept looking healthy while the underlying data was dead.

Five more datasets were frozen the same way, for the same reason, and had been
for months. This file is the full accounting so the next one is found by a
failing job rather than by noticing.

### Method, and what it can and cannot tell you

- **Credentials**: every `process.env.*` read across all `.js`/`.mjs`/`.cjs`/`.jsx`
  outside `node_modules`, `dist` and `_archive`, cross-referenced against
  `secrets.*` in `.github/workflows/` and the known GitHub secret list.
- **Freshness**: computed directly from `src/data/parts.js` deal stamps and
  `catalog-build/price-history.json`.
- **Last ran**: read from the **GitHub Actions REST API** (`/actions/workflows/*/runs`),
  not inferred. An earlier revision of this audit inferred run dates from commit
  dates and said so; that limitation is now removed, and it changed two
  conclusions materially (§1.1, §6.1).

Reproduce any table here with the commands in §8.

---

## 1. Two corrections to the first revision of this audit

Recorded rather than quietly edited, because both were wrong in the direction of
under-reporting and the reasoning that produced them is worth not repeating.

### 1.1 `sftp-ingest.yml` is not working — it has not succeeded since 2026-05-14

The first revision credited it as "real fetch — Newegg feed, working," on the
evidence that it has a daily cron and recent runs. Both true. But:

```
sftp-ingest.yml — 99 runs:  success 2   cancelled 88   failure 9
both successes were on 2026-05-14
```

It had failed or been cancelled **every single day for 95 days**. Reading the
cron told me it was scheduled; only the run history told me it never finishes.
Full diagnosis and the fix in §6.1.

**The lesson is the same one this whole audit is about**: a schedule is not a
signal that work happened, any more than a dated price point is. Both were read
that way, one revision apart.

### 1.2 Dead-ASIN quarantine was never broken

The first revision reported that `recheck-dead-asins.mjs` could not run in CI and
that dead ASINs therefore accumulated unconfirmed with broken links left live.
The first half was true and is fixed (§7.2). The consequence was wrong.

`amazon-asin-identity-audit.mjs` implements its own two-strike rule internally —
`DEAD_STRIKES = 2` against a `deadStreak` ledger in
`amazon-asin-audit-state.json` — and runs daily in CI with credentials already
wired. It quarantined 7 rows on 2026-08-15. 341 of 346 dead-ASIN findings are
quarantined; 338 ASINs sit at streak 3. The 5 apparent stragglers are a
report-snapshot ordering artifact inside a single run, not a gap.

So `recheck-dead-asins.mjs` is a **superseded manual tool**, not a broken link in
the live chain. It should not be scheduled.

---

## 2. Per-retailer truth

From `parts.js` stamps and `price-history.json`, as of 2026-08-17.

| Retailer | Rows | Ever confirmed | Last *real* price change | Flat series | Verdict |
| --- | --: | --: | --- | --: | --- |
| `amazon` | 3,758 | 2,810 | 2026-08-14 | 27% | Healthy |
| `newegg` | 2,666 | 893 | 2026-08-12 | 83% | Manual only |
| `bestbuy` | 1,523 | **9** | 2026-08-11 *(one series, once)* | **100%** | No refresher exists |
| `msi` | 157 | **0** | never | 100% | No creds, no workflow |
| `newegg_openbox` | 60 | 0 | never | 100% | Stale 94 days |
| `newegg_marketplace` | 37 | 31 | never | 100% | New, never refreshed |

"Last real price change" is the most recent date on which *any* series for that
retailer changed value — the only proxy for when a refresher last did work that
cannot be faked by a derivation.

### Stamp vocabulary

A deal is confirmed only by a stamp a write path left after contacting the
retailer. The fields that actually occur on deal objects:

| Field | Where it occurs | Meaning |
| --- | --- | --- |
| `priceConfirmedAt` | amazon 2,810 · newegg 893 · bestbuy 9 · marketplace 31 | price checked against retailer |
| `matchedAt` | newegg 2,666 · openbox 60 · marketplace 37 | deal attached / re-matched |
| `priceUnconfirmedAt` | amazon 777 | explicit "we tried and could NOT confirm" |
| `refreshedAt` | **zero rows** | what `refresh-newegg-prices.cjs:466` writes on a successful re-price |

`refreshedAt` being on zero rows is itself the evidence that the Newegg
re-pricer has never had a successful production run — its own workflow cites
"0 of 5,428 products carry refreshedAt" for exactly this reason.

> **Open follow-up:** `priceFreshness()` in `src/App.jsx:87` reads only
> `priceConfirmedAt` and `matchedAt`. The moment the Newegg re-pricer runs it will
> stamp `refreshedAt`, and the UI will still render those rows as unverified.
> `scripts/assert-retailer-freshness.cjs` counts all three; `App.jsx` counts two.

---

## 3. Scheduled coverage, with real run history

6 of 21 workflows carry a cron. Everything scheduled is a *derivation* —
snapshot, prerender, split, verify, audit — while every *acquisition* job except
the Newegg SFTP feed is dispatch-only. And the SFTP feed does not complete.

| Workflow | Cron (UTC) | Runs | Last success | Health |
| --- | --- | --: | --- | --- |
| `epik-watchdog.yml` | `*/30 * * * *` | 100 | 2026-08-17 | 13% flake rate |
| `asin-identity-audit.yml` | `0 3 * * *` | 13 | 2026-08-17 | Healthy since 2026-08-12 |
| `prerender.yml` | `0 6 * * *` | 95 | 2026-08-17 | Healthy |
| `price-history.yml` | `0 7 * * *` | 92 | 2026-08-17 | 0 failures — **and it is the illusion** |
| `verify-catalog.yml` | `0 8 */2` · `0 9 */3` · `0 10/11 * * 1` | 100 | 2026-08-17 | Healthy — the one real fetch |
| `sftp-ingest.yml` | `0 12 * * *` | 99 | **2026-05-14** | **Dead 95 days** |

Dispatch-only (15): `apply-newegg`, `bestbuy-dead-sku-audit`, `case-sweep-newegg`,
`catalog-stats`, `deploy-admin`, `deploy-epik`, `deploy-pages`,
`discover-newegg-dry`, `epik-origin-probe`, `feed-overlap-audit`,
`ingest-newegg-dry-run`, `publish-epik`, `refresh-newegg-prices`, `sync-data-r2`,
`verify-catalog` *(also scheduled)*.

Two workflows exist in Actions history but not in the current tree:
`probe-bestbuy-price.yml` (2 runs, 2026-08-17) and `sftp-measure.yml` (4 runs,
2026-07-23) — branch or deleted workflows, no action needed.

`price-history.yml` having a perfect 92-for-92 record is worth sitting with. It
is the healthiest job in the repo and it is the one that manufactured the
illusion. Reliability of a derivation says nothing about the truth of its input.

---

## 4. Credentials

### 4.1 Missing from GitHub — blocking

| # | Variable | Scripts | What breaks |
| --: | --- | --- | --- |
| 1 | `IMPACT_ACCOUNT_SID`<br>`IMPACT_AUTH_TOKEN` | `ingest-msi-impact-v2.cjs`, `relink-bucketA.cjs`, `impact-download.js`, `impact-bestbuy.js`, `bestbuy-discover.js`, `impact-test.js` | All six hard-exit at startup. MSI's 157 deals have no refresh path; the Impact Best Buy catalog download and bucket-A relink are unrunnable. |
| 2 | `RAKUTEN_WEB_SERVICES_TOKEN` | `fetch-newegg-coupons.cjs` | Hard-exits. **No practical impact** — nothing imports its output (§5, item 15). Not referenced by any workflow, so almost certainly absent despite matching the `RAKUTEN_*` set. |
| 3 | `PRORIG_AMAZON_CREDS` | `recheck-dead-asins.mjs` | **FIXED** — §7.2. Was the only script with no env fallback. |

### 4.2 Read by scripts, absent from GitHub — not blocking

| # | Variable | Why it is fine |
| --: | --- | --- |
| 4 | `RAKUTEN_FTP_HOST` | Defaults to `aftp.linksynergy.com` (`sftp-ingest.cjs:45`) |
| 5 | `RAKUTEN_FTP_USER` | Defaults to `rkp_4681679` (`sftp-ingest.cjs:46`) |
| 6 | `AMAZON_PARTNER_TAG` | Defaults to `tiereduptech-20` (`amazon-paapi.js:26`) |
| 7 | `EPIK_SFTP_PASSWORD` | `deploy/sftp-deploy.cjs:56` needs a key **or** a password; key auth is wired |
| 8 | `PRORIG_AMAZON_CREDS` *(in `amazon-paapi.js`)* | `loadCreds()` checks `AMAZON_CREATORS_CLIENT_ID/SECRET` first; CSV is local-dev only |

Only `RAKUTEN_FTP_PASSWORD` is genuinely required for SFTP ingest, and it is
wired. The credential gap is small. The scheduling gap is not.

---

## 5. Stranded — no workflow runs it

| # | Script / dataset | What it does | Last ran | Would anything notice? |
| --: | --- | --- | --- | --- |
| 9 | **Best Buy price refresh** | *Does not exist.* No script writes `priceConfirmedAt` for a bestbuy deal. Prices captured once at merge by `bestbuy-merge.js`. | Ingest ~2026-04-20 | **No.** 139,080 fabricated points made it look alive. |
| 10 | `refresh-newegg-prices.cjs` | Daily Newegg re-price / re-match | **2026-07-20** (94 scheduled runs, then cron commented out) | Partly — 83% flat series, masked by `matchedAt`. |
| 11 | `ingest-msi-impact-v2.cjs` | MSI Impact catalog (id 16410), UPC-matched | Never successfully in CI | **No.** 157 rows, zero stamps of any kind. |
| 12 | `fetch-amazon-reviews.js`<br>`fetch-bestbuy-reviews.js` | Up to 5 reviews/product into `catalog-build/reviews.json` | 2026-05-18 | **Visible but silent** — rendered by `App.jsx` + `ReviewStars.jsx` with no staleness signal. |
| 13 | `newegg_openbox` | Written only by `phase2-name-match-newegg.cjs`, `case-gate-audit.cjs`, `dedupe-case-batch.cjs` | 2026-05-15 | **No** — and it is the most volatile inventory in the catalog. |
| 14 | `newegg_marketplace` | Written only by `dedupe-case-batch.cjs` | 2026-08-10 | **No.** 37 rows, never a price change. |
| 15 | `fetch-newegg-coupons.cjs` | Newegg coupon feed → `src/data/newegg-coupons.json` | 2026-05-14 | **No, and nothing would.** Output imported by nothing; holds one coupon that expired 2026-06-17. |
| 16 | ~50 other orphans | `probe-*`, `backfill-*`, `expand-catalog-*`, `dataforseo-enrich-*` | various | Correctly manual — genuine one-off tooling. |

### 5.1 Secondary obstacles

Two stranded jobs cannot simply be scheduled as written:

- `fetch-bestbuy-reviews.js:119` calls `readdirSync(catalog-build/bestbuy-discovery)`
  with no existence guard, and `catalog-build/*` is gitignored. On a clean CI
  checkout it throws `ENOENT` before making a single call.
- `catalog-build/bestbuy-discovery/`, `bestbuy-enriched/` and `bestbuy-raw/` are
  all absent — they only ever existed on the machine that ran discovery.
  `bestbuy-merge.js` reads them too.

`bestbuy-dead-sku-audit.mjs` avoids this correctly by reading SKUs straight out
of `parts.js`. **`parts.js` is the only durable state; any scheduled Best Buy job
should treat it as the input of record.**

---

## 6. Working — with one large exception

| # | Job | Evidence |
| --: | --- | --- |
| 17 | `verify-catalog.yml` | The only scheduled workflow that calls a live pricing API and stamps confirmation back. Amazon: 2,810 confirmed, changes on 62 separate days, newest 2026-08-14. 100 runs, healthy. |
| 18 | `asin-identity-audit.yml` | Two-strike dead-ASIN quarantine, working. Failed 2026-08-06→08-11, healthy since 08-12 (fixed by `f23481ed55b`). |
| 19 | `prerender.yml`, `price-history.yml` | Both healthy as *derivations*. Neither fetches anything. |

### 6.1 CRITICAL — `sftp-ingest.yml` has been dead for 95 days

The daily Newegg feed ingest. 99 runs, **2 successes, both 2026-05-14**. 88
cancelled, 9 failed. The commit step is skipped on every non-success, so it has
written nothing to the catalog in over three months.

**Root cause — JavaScript heap OOM on the marketplace feed.** From run
32029115254 (2026-08-17):

```
12:18:13  ⬇ 44583_4681679_mp.txt.gz        (149.8 MB)
12:22:40  ⬇ 44583_4681679_mp_MKPL.txt.gz   (886.4 MB)   ← 30 min to download
12:53:08  PHASE 2: Parse, Match, Apply
12:53:22    mp.txt.gz: parsed 1,034,587 records
12:56:38    Matched: 5,570 | Exclusives: 1,028,789
12:56:43  ── Merchant 44583: 44583_4681679_mp_MKPL.txt.gz ──
12:57:15  FATAL ERROR: Ineffective mark-compacts near heap limit
          Allocation failed - JavaScript heap out of memory
          Mark-Compact 6135.7 (6149.9) -> 6131.0 MB   ← at the 6,144 MB cap
          exit code 134 (SIGABRT, core dumped)
```

Two independent problems, either of which alone would break it:

1. **Memory.** `NODE_OPTIONS: --max-old-space-size=6144` and it dies at
   6,135 MB parsing the 886 MB `_MKPL` feed. The main feed parses fine and
   yields 1,028,789 exclusives held in memory — that accumulation is the likely
   hog. Commit `aef059640db` streamed the feed *download*; the *parse* still
   buffers.
2. **Wall clock.** `timeout-minutes: 60`, and the download alone takes 35
   minutes, leaving ~25 for a parse that needs more. The 88 cancellations are
   this timeout firing at ~3,620s; the 9 failures are the OOM landing first.

Raising the heap cap only moves the wall — the feed grows. The fix is to stream
the `_MKPL` parse and stop materialising the exclusives array.

**Would anything notice?** Nothing did, for 95 days. This is the sharpest case
in the file: the job is scheduled, it runs daily, it appears in Actions every
day, and it has accomplished nothing since May. Only the *conclusion* field
distinguishes it from a healthy job, and nothing was reading that — which is why
§7.4 now does.

#### FIXED 2026-08-17

`parseTxtFeed` became `streamTxtFeed(localPath, onRecord)`: records are handed to
a callback and dropped, never collected. Match-and-apply moved inside the
callback, so peak heap is the catalog index plus one record — flat in feed size.

Measured, not estimated:

| | Old (buffered) | New (streaming) |
| --- | --- | --- |
| 2,000,000 records | ~2.9 GB retained | **4.1 MB** peak growth |
| Throughput | — | 141,844 records/s |
| Projected for the ~6.1M-record `_MKPL` feed | **~9.3 GB** vs a 6,144 MB cap | unchanged, flat |

Backpressure was the necessary other half. The consumer writes ~1M exclusives to
a `WriteStream`; a loop that ignores `write()`'s `false` return grows the stream's
internal buffer without bound, which is the same OOM in a different costume and
would have surfaced the moment the record array stopped being the first thing to
blow. `ctl.backpressure(dest)` pauses the feed until `dest` drains.

`timeout-minutes` raised 60 → 180. Sixty could not fit the work: ~35 min to pull
~1 GB of feeds, leaving ~25 min for a parse that needs ~20 at the measured
throughput. Steady state should be far under 180 — the manifest cache skips
unchanged feeds, and it never got the chance to save before because
`actions/cache` writes in its post step and the job never reached one.

The CLI body is now gated on `require.main` so the parser can be imported and
tested. `test/sftp-ingest.streaming.test.js` (11 tests) covers field mapping,
HDR/TRL handling, the peak-heap bound, backpressure with no lost records, drain
listener leaks, and callback-error propagation.

> One bug the tests caught in the fix itself: `readline` emits `'close'`
> synchronously from `close()`, so rejecting *after* closing let `resolve` settle
> the promise first and a consumer error surfaced as a successful parse with a
> truncated record count. The rejection now precedes the close.

---

## 7. Fixed

### 7.1 The structural check — `scripts/assert-retailer-freshness.cjs`

Asserts that every retailer in `parts.js` has been confirmed within a cadence
stated in code, and **exits 1** when one goes quiet. Fails on its first run with
5 of 6 retailers.

Two layers, because the second one is the earlier signal:

- **Cadence** — newest confirmation stamp per retailer vs a budget computed from
  the cron responsible for confirming it, via two stated constants
  (`MISSED_CYCLES_ALLOWED = 2`, `MIN_BUDGET_DAYS = 3`), each carrying its
  reasoning. No per-retailer magic numbers.
- **Provenance** — each retailer's entry cites the workflow and cron that
  confirms it, and the gate reads that workflow to check the cron is still live.
  Newegg fails as `schedule-disabled`, not `stale`. That signal existed on
  2026-07-20, weeks before the data visibly rotted.

Failure classes, each with a test proving it fires: `stale`, `schedule-disabled`,
`cite-drift`, `missing-workflow`, `unscheduled`, `unknown-retailer`,
`phantom-retailer`, `no-stamps`, `malformed-entry`.

`unknown-retailer` is the one that prevents a repeat: a retailer added to
`parts.js` without a cadence entry fails the gate. That is precisely how `msi`
came to sit unrefreshed for four months.

Wiring: `.github/workflows/retailer-freshness.yml`, daily at 13:00 (after every
`parts.js` writer has had its slot), plus PRs touching the catalog or the
workflows. Deliberately **not** in `npm test` — a known-red assertion in the
shared suite turns every unrelated PR red, and an always-red suite gets
`|| true`-d within a week, which is the same signal-with-no-consequence failure
this gate replaces. `test/retailer-freshness.test.js` (20 tests) proves the gate
discriminates and stays green.

### 7.2 `recheck-dead-asins.mjs` — env-first credentials

Now checks `AMAZON_CREATORS_CLIENT_ID/SECRET` before the CSV, mirroring
`amazon-paapi.js`. Also closes a latent bug: `confirmedDead` is computed as
"every dead ASIN the API did NOT return", so a credential failure that reached
the batch loop would have returned zero recoveries and read as *all of them are
confirmed dead* — mass quarantine from an auth error. It now exits 2 before any
API work. Verified both branches.

Not scheduled, per §1.2.

### 7.3 `sftp-ingest.cjs` — streaming parse

See §6.1. The daily Newegg feed can complete again.

### 7.4 The outcome gate — `scripts/assert-workflow-outcomes.cjs`

The durable fix for the pattern this whole file documents. Three instances of one
mistake, each a proxy read as the thing it stands for:

| Proxy | Read as | Reality |
| --- | --- | --- |
| a dated price point | a retailer was checked | `record-price-snapshot.js` never contacts a retailer |
| a cron | a job succeeded | `sftp-ingest.yml` ran daily, succeeded twice in 99 runs |
| a green run | something deployed | — |

§7.1's provenance layer closed the second only as far as *"the cron exists"*. A
cron is still a proxy. This gate reads **run conclusions**:

- **Only `conclusion === 'success'` counts.** An allow-list, not a deny-list of
  bad outcomes — GitHub can add a conclusion at any time and an unknown one must
  read as not-succeeded rather than slip through as fine.
- **Cancelled is a failure.** 88 of sftp-ingest's runs were cancelled, which is
  the quietest outcome GitHub produces: grey in the UI, no notification, and it
  reads as *someone stopped it on purpose*. Nothing was stopping it; it was dying.
  The full outcome distribution is printed so a wall of cancellations is legible
  as one thing.
- **Failure is on not-having-succeeded, not on not-having-been-scheduled.** The
  budget comes from each workflow's own fastest cron via the same policy as §7.1.
- **No table to maintain.** The set of jobs under assertion *is* the set of
  workflow files carrying a live cron. Add a scheduled workflow and it is covered
  on the next run.
- **Exit 1**, and exit 2 with no token rather than passing by default — a gate
  that silently skips when it cannot see is worse than no gate, because it also
  removes the reason to look.

Failure classes, each with a test: `stale-success`, `never-succeeded`,
`workflow-disabled`, `not-on-remote`, `unparseable-cron`. Two deliberate
non-alarms keep it from crying wolf: a genuinely new workflow gets a grace window
equal to its budget, measured from GitHub's own `created_at` so it expires
without a suppression anyone has to remember; and `not-on-remote` only fails on
the default branch, so adding a scheduled workflow never reddens its own PR.

Both gates run in `.github/workflows/retailer-freshness.yml` (now *Freshness
Gates*) as one red light. `test/workflow-outcomes.test.js` (19 tests) is fully
hermetic — the run and metadata fetchers are injected, so no token or network is
involved and `npm test` is unaffected by the live repo's state.

On its first run it catches `sftp-ingest.yml`:

```
sftp-ingest.yml   96 runs   1 ok   2026-05-14   95d   3d   STALE SUCCESS
                  outcomes: 86 cancelled, 9 failure, 1 success
```

### 7.5 This file

---

## 8. Open, in dependency order

1. **Enable the Newegg cron.** Dispatch once with `dry_run=true`, confirm the
   summary, then uncomment lines 12–13 of `refresh-newegg-prices.yml`. Recovers
   2,666 rows. Note `REMOVALS_ENABLED = false` (`refresh-newegg-prices.cjs:107`)
   hard-gates every deletion at line 517, so the destructive path that motivated
   the disable is off in code. `assert-retailer-freshness` clears newegg's
   `schedule-disabled` failure automatically once the cron is live.
2. **Write the Best Buy refresher** (§5, item 9). Read SKUs from `parts.js`,
   call `/v1/products/<sku>.json`, write `priceConfirmedAt`. `BESTBUY_API_KEY` is
   already in GitHub. Settle the comp-value question first via
   `probe-bestbuy-price-truth.mjs` — a refresher that confidently writes comp
   value is worse than a frozen one.
3. **Decide MSI**: add the two Impact secrets and schedule the ingest, or drop
   `deals.msi`. Publishing never-confirmed prices is the option to rule out.
4. **Teach `App.jsx` about `refreshedAt`** (§2). One field in the `stamps` array
   at `src/App.jsx:87`.
5. **Schedule reviews** after fixing the `readdirSync` guard (§5.1).
6. **Fold `newegg_openbox` and `newegg_marketplace`** into the Newegg re-pricer,
   or drop them.

### Unrelated, found in passing

`test/amazon-paapi.failover.test.js` and `test/amazon-paapi.searchitems.test.js`
— 18 tests are not hermetic. They need `AMAZON_CREATORS_CLIENT_ID/SECRET` merely
to be *present*, or `loadCreds()` opens the circuit as `not_configured` before
the mocked fetch is reached. They pass with any non-empty value, so they are
green in CI on real secrets and red on every laptop.

---

## 9. Reproducing this

```bash
# the gate — per-retailer freshness, exits 1 when a retailer goes quiet
node scripts/assert-retailer-freshness.cjs
node --test test/retailer-freshness.test.js

# every env var any script reads
grep -rhoE "process\.env(\.[A-Za-z_][A-Za-z0-9_]*|\[['\"][A-Za-z_][A-Za-z0-9_]*['\"]\])" \
  --include="*.js" --include="*.mjs" --include="*.cjs" --include="*.jsx" \
  --exclude-dir=node_modules --exclude-dir=dist . \
  | sed -E "s/process\.env[\.\[]+['\"]?//; s/['\"]?\]?$//" | sort | uniq -c | sort -rn

# secrets any workflow references
grep -rhoE "secrets\.[A-Z_][A-Z0-9_]*" .github/workflows/ | sed 's/secrets\.//' | sort -u

# real run history (needs a token with actions:read)
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/tiereduptech/pro-rig-builder/actions/workflows/sftp-ingest.yml/runs?per_page=100" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
      const t={};for(const r of j.workflow_runs)t[r.conclusion]=(t[r.conclusion]||0)+1;console.log(t)})"
```
