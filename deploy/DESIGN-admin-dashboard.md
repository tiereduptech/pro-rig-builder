# Admin dashboard — design

Copyright © 2026 TieredUp Tech, Inc.

Status: **Phase 0 and Phase 1 are built** (read-only view + dispatch). Phases 2–4
(the editable config store) are designed here and deliberately NOT built. Price
bands are out of v1 by decision — see §7.

Sibling documents: `DESIGN-cloudflare-pages.md` for the Pages stack this reuses,
`CUTOVER-cloudflare-pages.md` §3.7 for the Access argument this one inverts.

---

## 1. Scope

`admin.prorigbuilder.com` — a private operator view of the catalog pipeline.

What it is for, stated as the two questions it must answer, because those are the
questions that were actually being asked by hand:

1. **When did each workflow last run, and did it succeed?**
2. **How many products are live, how many are quarantined, and why?**
   The quarantine count moved 1,251 → 955 and was noticed only because someone
   asked. A number nobody is shown is a number nobody watches.

What it is **not**: it is not a catalog editor, not a settings panel (yet), and
not a deploy tool. It reads. The one thing it writes is a `workflow_dispatch`,
which is a button for a run that could already be started from the Actions tab.

| | Phase 0 | Phase 1 | Phase 2–4 |
|---|---|---|---|
| status | **built** | **built** | designed only |
| workflow last-run + result | ✅ | | |
| catalog counts incl. by-reason | ✅ | | |
| pipeline constants, derived from source | ✅ | | |
| "run tier N now" / "run discovery dry" | | ✅ | |
| editable tier membership | | | Phase 2 |
| editable discovery config | | | Phase 3 |
| editable price bands | | | Phase 4, behind a PR — or not at all |

## 2. Topology — a separate Pages project, confirmed

`admin.prorigbuilder.com` is its **own Cloudflare Pages project**, deployed from
`admin/` in this repo by `.github/workflows/deploy-admin.yml`. It is not a route
on the catalog project.

```
   prorigbuilder.com                    admin.prorigbuilder.com
          │                                        │
   Pages project: catalog              Pages project: admin
   ├── dist/            (~5.6k files)  ├── admin/public/    (3 files)
   ├── functions/parts/[[path]].js     ├── admin/functions/_middleware.js
   └── _routes.json → /parts/*         └── admin/functions/api/{state,runs,dispatch}.js
                                                   │
                                            Cloudflare Access
                                       (+ JWT verified in the Function)
```

The instinct — "a broken admin page shouldn't be able to affect the catalog
site" — is right, and it is right for four specific reasons rather than as a
general principle:

- **The 20,000-file ceiling.** `deploy-pages.yml` already warns at 18,000 and the
  catalog grows every night. Admin assets would consume headroom from the budget
  that a *product page* needs.
- **`_routes.json` is project-wide.** The catalog project scopes its Function to
  `/parts/*` precisely so the other 35 routes stay pure static
  (`DESIGN-cloudflare-pages.md` §5). Adding `/api/*` widens that scope on the
  catalog project, which is the thing that document refuses to do.
- **A deploy is all-or-nothing.** One project means an admin change redeploys the
  catalog, and an admin bug can fail a deploy that the catalog needed.
- **Blast radius of the credential.** The admin Function holds a GitHub token
  with write scope. Nothing on the catalog project should be in the same
  isolation boundary as that token.

The cost of separation is one more project, one more deploy workflow, and one
more DNS record. That is the whole cost, and it is paid once.

## 3. What is hard-coded today

The inventory. `exposure` is the recommendation for Phases 2–4, not what is built
now — nothing in this table is editable from the UI today.

### 3.1 Green — safe to expose

| Value | Where | Today |
|---|---|---|
| `TIERS` (tier → categories) | `verify-catalog-asins.js:57` | T1 CPU/GPU/Motherboard/RAM/Storage/PSU/Case · T2 CPUCooler/CaseFan/Monitor · T3 8 peripherals · T4 13 accessories |
| `fix_asins` scheduled default | `verify-catalog.yml:77` | `true` |
| discovery `--category` | `apply-newegg-discoveries.cjs:44` | `RAM` |
| discovery `--limit` | `apply-newegg-discoveries.cjs:45` | `0` (uncapped) |
| dry-run sample size | `discover-newegg-dry.cjs:44` | `60` |
| `PRICE_MULT` (relative median floor) | `apply-newegg-discoveries.cjs:56` | `3` |
| `DOLLAR_CEILING` | `verify-spend-guard.js:42` | `10` |
| `RETENTION_DAYS` | `record-price-snapshot.js:25` | `90` |

`DOLLAR_CEILING` is green only with a hard schema maximum (~$25). `RETENTION_DAYS`
is green but is a **one-way ratchet in practice** — lowering it permanently trims
history on the next run, and no UI confirmation gets that data back.

### 3.2 Amber — expose only with an impact preview and a second confirmation

| Value | Where | Today |
|---|---|---|
| `PRICE_TABLE` (all bands) | `normalize-product-name.js:256` | RAM DDR5 `2.0–40` $/GB · DDR4 `0.6–20` · Storage SSD `0.012–1.0` $/GB · HDD `0.006–0.35` · PSU `0.008–0.8` $/W · CPU `$25–1500` · Case `$20–2000` |
| `RISE_TRIGGER` | `drift-gate.js:40` | `1.30` |
| `ASIN_FIX_MIN_SCORE` | `verify-catalog-asins.js:73` | `0.8` |
| `MIN_MIGRATE_SIM` | `newegg-match.js:52` | `0.70` |
| `price-sanity` thresholds | `price-sanity.js:14-17` | `LOW 0.45` · `HIGH 0.40` · `DISAGREE 1.5` · `LOW_FLOOR 0.30` |

`RISE_TRIGGER` carries an invariant that a UI can silently break.
`drift-gate.js:14-16` states it: *"A loose drift trigger is safe only because the
ceilings backstop it. Never loosen both."* Drift on one screen and ceilings on
another is a machine for violating that. If both are ever exposed, they go on one
screen, the invariant is printed on it, and a save that loosens both is rejected.

### 3.3 Red — keep in code, require a commit

| Value | Where | Why not |
|---|---|---|
| `MAX_SHRINK` `0.05` / `MAX_GROWTH` `0.15` | `scripts/write-catalog.cjs:48,58` | Last brake before a catalog-destroying write. `case-ingest.mjs:336` asserts `MAX_GROWTH === 0.15` and throws otherwise. A UI-editable brake gets raised by whoever wants tonight's import to go through — which is the exact moment the brake exists for. The deliberate per-run override already in `case-ingest.mjs` is the correct escape hatch. |
| `COST_PER_SELLERS_TASK` `0.0015` | `verify-spend-guard.js:29` | A *measured fact*, not a policy. Editing it silently rescales every spend projection. |
| `TIER_BAND_MAX_RATIO` `1.0` | `verify-spend-guard.js:53` | "The resolved set is a subset of the tier" is a logical truth, not a tunable. |
| `MAX_LOOKUP_FAILURE_RATE` `0.20`, `MIN_HEALTHY_CANDIDATES` `3`, `MAX_REMOVAL_RATE` `0.02`, `MAX_REMOVAL_FLOOR` `5`, `REMOVALS_ENABLED` `false` | `refresh-newegg-prices.cjs:79-107` | Circuit breakers. A breaker you can raise from a web form is not a breaker. |
| `BATCH_SIZE` `50`, `POST_DELAY_MS` `500`, `GET_CONCURRENCY` `8`, `RATE_DELAY_MS` `720`, poll windows | `verify-catalog-asins.js:67-72`, `refresh-newegg-prices.cjs:63` | Vendor rate-limit contracts. A slider gets you 429'd. |
| `SPEC_BAR`, `LEAF_MATCH`, `CATEGORY_REJECT`, `PREBUILT_RE` | `apply-newegg-discoveries.cjs:83-118` | Predicates and regexes. A regex in a text field is an injection-shaped hole *and* a silent-catastrophe shape: a bad pattern rejects everything or nothing, and both look like a normal run. Expose as per-rule on/off toggles if ever, never as editable pattern text. |

### 3.4 The rule that cuts across all of it

`PRICE_TABLE_CALIBRATED_AT`, `DRIFT_GATE_CALIBRATED_AT`,
`DOLLAR_CEILING_CALIBRATED_AT` and `CEILINGS_LAST_REVIEWED` must **never** be
editable fields. If a UI can bump the date without re-verifying against
NeweggBusiness (`normalize-product-name.js:241-244`), every staleness warning in
the codebase becomes a lie, and the warnings are load-bearing — they are what
caught the stale DDR5 ceiling.

The dashboard writes the **value**; the stamp is set to today automatically, as a
consequence of the value changing. There is no path where a stamp moves alone.

## 4. Cron schedules — what a dashboard cannot do

**"Fire every 3 days instead of 2" is not editable without a commit.** GitHub
reads `on.schedule.cron` from the workflow file on the default branch.

A dashboard *could* commit that through the contents API. It should not, for a
reason specific to this repo: `verify-catalog.yml:70-76` maps the schedule to a
tier by **exact string match**.

```yaml
case "${{ github.event.schedule }}" in
  "0 8 */2 * *") echo "tier=1" >> $GITHUB_OUTPUT ;;
  ...
  *)             echo "tier=1" >> $GITHUB_OUTPUT ;;
```

Change `'0 8 */2 * *'` to `'0 8 */3 * *'` and the `case` falls through to `*)`
— tier 1 runs on tier 2's slot, nightly, with a green checkmark. An honest cron
editor therefore has to atomically rewrite a bash `case` block inside YAML from a
web form. That is not a thing to build.

Enforced at the credential layer: the admin token deliberately has **no
`workflows` scope**, so this API call fails with a 403 rather than relying on
nobody writing the code. See §6.

Two related notes:

- `*/2` in day-of-month means days 1,3,5…31 — not "every 48 hours". The interval
  already stretches across month boundaries. True today; not caused by anything
  here.
- Scheduled workflows are best-effort under load, and GitHub disables them after
  60 days of repository inactivity.

**What a dashboard *can* do without a commit:**

- **`workflow_dispatch` through the API** — this is Phase 1, and it is real. The
  inputs already exist in the YAML, every run is already logged, and the existing
  spend guard still stands between a button and a mistake.
- **Which categories are in tonight's tier** — `TIERS` is a JS literal read at
  process start. Moving it to config hands it to the dashboard outright. Phase 2.
- **Config-gated no-op runs**, if cadence is ever wanted in the UI: keep the cron
  dense and fixed, have the job read config and exit 0 spending nothing when today
  is not its day. This converts cadence into config **in one direction only** —
  an interval can be lengthened, never shortened past the base tick. The cost is
  legibility: a skipped run still burns a runner minute and still shows green,
  unless the job summary says "skipped by config". Not built.

## 5. Config store — repo JSON (Phase 2, not built)

The store is a `config/` directory in this repo, written through the GitHub
contents API. Recorded here so Phase 2 does not re-litigate it.

**Why repo JSON over Cloudflare KV:**

- The consumers are Node scripts in Actions with the repo already checked out.
  Reading `config/tiers.json` is a `readFileSync`. A KV read adds a network
  dependency and a credential to a path that must work without either —
  `verify-catalog-asins.js:45-53` deliberately lets `--dry-run` run
  credential-free *so scope can be proven before anyone spends*. KV-backed config
  breaks that property.
- **The pattern already exists here.** `src/data/asin-overrides.json` is a
  hand-maintained table loaded at `verify-catalog-asins.js:80-87` inside a
  try/catch that degrades to `{}`. Same shape, already proven in this pipeline.
- Git history *is* the audit log. `git log -p config/` answers what changed and
  when, `git blame` answers which change caused last night's result, and revert is
  `git revert`. KV is last-write-wins with **no history** — you would hand-roll an
  audit log into a second key and hope it stays consistent with the first.
- **Repo writes are safer under concurrency than KV here.** Eight workflows share
  the `main-writer` lock. `PUT /contents` with the `sha` you read is a
  compare-and-swap: it 409s on a conflicting write instead of clobbering. KV
  offers nothing equivalent.

**Verified, because it is the one real cost:** a commit to `main` can trigger
workflows. `prerender.yml`'s push trigger is scoped to
`paths: ['src/data/parts.js']`, so a `config/**` commit will **not** kick off the
45-minute prerender. That is contingent on config living in `config/` and not in
`src/data/`. `deploy-pages.yml` is dispatch-only today; when a push trigger is
added at cutover, scope its paths too or every settings change becomes a deploy.

**KV would win** only if the config were read at the edge per request (nothing
user-facing consumes these), or writes were frequent, or sub-second propagation
mattered (the consumers are nightly). Keep KV in reserve for one future case: a
runtime kill-switch the edge reads without a deploy.

**Shape**, when built: `config/` split by **blast radius, not topic** —
`config/tiers.json` (green), `config/discovery.json` (green),
`config/price-bands.json` (amber) — so different files can carry different
approval rules and `git log <file>` stays readable. Every file carries
`$schemaVersion`; every entry carries `calibratedAt`, `changedBy`, and a
**required free-text `reason`**, which is the field git alone cannot supply when
the commit message is generated. Code keeps today's constants as defaults and
config *overrides* them, so a missing or corrupt file degrades to current
behaviour rather than to zero — the same failure posture as the `asin-overrides`
try/catch.

## 6. Validation (Phase 2, not built)

Six layers, because any single one gets bypassed.

1. **Schema at write time**, in the Function, before the commit. Types, enums,
   ranges. Categories validated against the list *derived from the live catalog*,
   so a typo'd `"Storge"` cannot be saved.
2. **Cross-field invariants**, which is where the real bugs are:
   - `floor < ceiling` for every band.
   - **Every catalog category appears in exactly one tier.** Orphaning a category
     is the most likely UI-caused outage and it is completely silent: those rows
     stop being verified, forever, and every run stays green.
   - Reject any change that loosens `RISE_TRIGGER` *and* raises a ceiling
     together (§3.2).
   - Worst-case projected spend at the new ceiling, against current tier
     populations, stays under the ceiling.
3. **Impact dry-run before save — the layer that actually matters.** Never accept
   a price-band edit on the number alone. Run the proposed band over the live
   catalog and show the consequence: *"DDR5 ceiling 40 → 25 would newly quarantine
   312 of 1,104 live DDR5 rows (28%)."* It is nearly free — `priceValidate` is
   pure, over the committed catalog, no network and no spend. Refuse to save above
   `STALE_CEILING_FAILURE_RATE` (0.30) without a typed confirmation.
   Same for tiers: *"Moving Storage out of tier 1 leaves 812 rows unverified."*
4. **A CI gate on `config/**`** running the same validator as a node test, so a
   hand-edit in an editor cannot route around the UI's checks. The shape already
   exists in `test/verify-main-writer-lock.cjs`: a gate that audits the real tree
   and is itself unit-tested.
5. **Consumer-side re-validation at run start** — every job re-validates the
   config it loaded and fails loud *before spending*, rather than trusting the
   writer. That is the spend guard's own philosophy: abort before posting, no
   spend. On load failure: fall back to code defaults, emit `::warning::`, never
   proceed silently.
6. **A kill switch** — one repo variable that makes every job ignore config and
   use code defaults. The single place to go when a config change is suspected in
   a bad night.

## 7. Why price bands are out of v1

Recorded because the reasoning is the decision, not the outcome.

The DDR5 ceiling was set from memory and flagged ~96% of RAM as corrupt when the
data was fine. The code still carries the scar in `normalize-product-name.js:216-239`:
the ceiling went `10 → 22 → 40`, and the 2026-07-27 47-SKU audit found that of 47
rows the old ceiling flagged, exactly **one** was truly corrupt.

A UI that makes that a two-click change *before the impact preview has earned
trust* is a way to repeat it faster. Price bands are Phase 4, behind a PR — or not
at all. The preview described in §6.3 has to exist and be believed first.

Note what saved it: the table **quarantines rather than drops**. The 46 real rows
went to review, not the bin. Any future editable-bands UI inherits that property
or does not ship.

## 8. Auth

**Cloudflare Access on `admin.prorigbuilder.com`**, plus JWT verification inside
the Function.

This repo *rejected* Access on 2026-08-15 (`functions/parts/[[path]].js:57`,
`CUTOVER §3.7`). That objection was narrowly about `.pages.dev`: Access there has
to be torn down at cutover and serves a broken login on the custom domain if it is
forgotten — a failure that points at production. `admin.` is a permanent dedicated
host with no such flip, and its failure mode is "the operator cannot log in",
which points away from production. The objection does not transfer. Stated
explicitly because it would otherwise read as a contradiction later.

**Access alone is not the boundary.** Access protects the browser path to a
hostname; the Function is also reachable on the project's permanent `.pages.dev`
alias, which Cloudflare offers no way to disable. So `admin/functions/_middleware.js`:

- verifies the `Cf-Access-Jwt-Assertion` header against the team's JWKS, checking
  `aud` against the configured Access application ID and `exp`/`iat`;
- rejects any request whose hostname is not the configured admin host.

This is the same argument the resolver already makes for checking the host in code
rather than trusting a Transform Rule someone has to remember exists.

**The GitHub token**: fine-grained PAT, this repo only,
`Contents: read` + `Actions: read and write`, **no `workflows` scope** (§4).
Stored as a Pages secret on the admin project only. Rotation mirrors the ritual in
`scripts/rotate-staging-auth.sh`.

## 9. Phase 0 — what is built

### 9.1 Constants are derived, never transcribed

A dashboard that hard-codes the numbers in §3 will drift from the code and lie —
which is worse than not having it. `scripts/derive-constants.cjs` emits
`admin/public/constants.generated.json` at deploy time, following the same
generated-module pattern as `functions-lib/resolver-data.generated.js`.

Two extraction strategies, chosen per module:

- **Import** for the pure libraries (`normalize-product-name.js`, `drift-gate.js`,
  `verify-spend-guard.js`, `price-sanity.js`, `newegg-match.js`,
  `scripts/write-catalog.cjs`). Verified side-effect-free on import.
- **Parse** for the CLI entrypoints, because importing them has side effects —
  `verify-catalog-asins.js` calls `process.exit(1)` at load without `--tier`, and
  `record-price-snapshot.js` writes a file. These constants are extracted from
  source text with an anchored pattern per value.

Every extraction **asserts it found exactly what it expected and fails the build
otherwise**. A renamed or moved constant breaks the deploy; it never silently
serves a stale number. That assertion is the whole point of the script — the
JSON is incidental.

### 9.2 Catalog counts

`scripts/catalog-stats.cjs` → `catalog-build/catalog-stats.json`, recomputed by
`.github/workflows/catalog-stats.yml` whenever `src/data/parts/**` changes on
main. It joins the `main-writer` lock like every other main-pushing workflow.

Definitions, printed in the UI, because a count whose definition is invisible is a
count you cannot trust:

| | rule | matches |
|---|---|---|
| total | every row | — |
| live | `!needsReview` | `App.jsx:355`, `url-slugs.cjs:99` |
| quarantined | `!!needsReview` | same, inverted |

`live + quarantined === total` is asserted, not assumed.

**By-reason, and the honest part.** Reasons come from `reviewFlags[]` and
`priceQuarantine.reason`. `reviewFlags` embeds the value in the string
(`cpu_price:above_ceiling(2499$)`), so the parenthetical is stripped — otherwise
every ceiling breach is its own unique reason with a count of 1, and the
breakdown is noise.

Measured on the current catalog: of **1,469** quarantined rows, **1,013 (69%)
carry no reason at all** — only `needsReview` and `quarantinedAt`. The dashboard
reports those as `(no reason recorded)` rather than omitting them, so the
breakdown sums to the total. Hiding them would make the by-reason panel disagree
with the headline number, which is precisely the kind of quiet inconsistency this
dashboard exists to end. That 69% is itself a finding worth acting on — the
ingests that quarantine without stamping a flag should stamp one.

A bounded history array in the same file gives the **delta since last run**,
which is what turns "955" into "955, down 296 since Tuesday" — the form in which
the number would have been noticed without being asked for.

### 9.3 Workflow runs

`admin/functions/api/runs.js` queries the GitHub Actions API per workflow at
request time (no cache to go stale) and returns last run, conclusion, timestamp,
duration and URL. Schedules are read from the YAML by the same derive script, so
"last ran 3 days ago" sits next to "expected every 2 days" and the gap is visible.

## 10. Phase 1 — dispatch

`admin/functions/api/dispatch.js` calls `POST /actions/workflows/{id}/dispatches`
against a **hard allowlist** in `admin/functions/api/_allowlist.js`: workflow
file, permitted inputs, and permitted values per input. A request naming anything
else is rejected before the token is used.

The allowlist exists because "the workflow's own inputs are the schema" is only
true if the caller cannot invent inputs. `verify-catalog.yml` has a
`force_paapi_unconfigured` self-test input that blanks the PA API creds; that must
never be reachable from a web button, and an allowlist is how it is not.

Dispatch is intentionally the *only* write in v1. It starts a run that was already
startable from the Actions tab, under guards that already exist.

## 11. Not built, deliberately

- Any editable setting (Phases 2–4).
- Cadence editing (§4).
- Any catalog mutation — no un-quarantine, no price edit, no row delete. The
  dashboard shows the quarantine; the existing scripts remain the way to act on
  it.
- Alerting. The dashboard is pull, not push. A `catalog-stats.json` delta is the
  natural input to a future notification, but a dashboard that also pages you is
  two products.
