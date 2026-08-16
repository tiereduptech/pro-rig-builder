# admin.prorigbuilder.com

Operator view of the catalog pipeline. **Phase 0 + Phase 1 only**: it reads, and
it can start a workflow run. It cannot change any setting.

Design and the reasoning behind every choice: `deploy/DESIGN-admin-dashboard.md`.

---

## What it answers

| Panel | Question | Source |
|---|---|---|
| Catalog | total / live / quarantined, by category, **by reason**, and the delta since the last catalog commit | `catalog-build/catalog-stats.json` on `main`, via `/api/stats` |
| Workflows | when did each workflow last run, did it succeed, is it overdue or disabled | GitHub Actions API, via `/api/runs` |
| Run a workflow | start an allowlisted run | `/api/dispatch` |
| Gate calibration | how stale each calibration stamp is | `constants.generated.json` |
| Pipeline constants | every hard-coded threshold, derived from source with `file:line` | `constants.generated.json` |

## Layout

```
admin/
  public/                        static assets (the Pages upload directory)
    index.html
    app.js                       panels
    cron.js                      interval estimator — shared with test/admin-cron.test.js
    style.css
    constants.generated.json     GENERATED, gitignored — see below
  functions/
    _middleware.js               auth gate for EVERY request, assets included
    api/{runs,stats,dispatch}.js
  functions-lib/
    access.js                    Cloudflare Access JWT verification
    allowlist.js                 what may be dispatched
    github.js                    the only GitHub calls made
```

`constants.generated.json` is gitignored on purpose, for the same reason as
`functions-lib/resolver-data.generated.js` in the catalog project: a committed
copy is exactly the stale number the derivation exists to prevent. It is
regenerated on every deploy.

## Deploying

`.github/workflows/deploy-admin.yml`, dispatch or (once `ADMIN_AUTO_DEPLOY` is
set) a push touching `admin/**`.

**Repository configuration**

| Kind | Name | Value |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Pages:Edit — shared with `deploy-pages.yml` |
| secret | `CLOUDFLARE_ACCOUNT_ID` | shared |
| var | `CF_ADMIN_PAGES_PROJECT` | the **admin** Pages project name |
| var | `ADMIN_AUTO_DEPLOY` | unset until you want pushes to deploy |

**Pages project configuration** (set on the project, never in the repo)

| Name | Value |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | the Access application's audience tag |
| `ADMIN_HOST` | `admin.prorigbuilder.com` |
| `GITHUB_REPO` | `tiereduptech/pro-rig-builder` |
| `GITHUB_TOKEN` (secret) | fine-grained PAT — see below |
| `DISPATCH_REF` | optional; defaults to `main` |

**The token**: fine-grained PAT, this repository only, `Contents: read` and
`Actions: read and write`. **No `workflows` scope** — that is what editing a cron
schedule would require, and per DESIGN §4 a dashboard must not. Withholding it
enforces that at the credential layer rather than by convention.

If `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` or `ADMIN_HOST` is missing, every request
answers **500**. An unconfigured auth check never means an open one.

## First run

The dashboard needs `catalog-build/catalog-stats.json` on `main`. It is written
by the **Catalog stats** workflow, which fires whenever the catalog changes — or
seed it once:

```bash
node scripts/catalog-stats.cjs
git add catalog-build/catalog-stats.json && git commit -m "chore(stats): seed catalog counts"
```

Until it exists, `/api/stats` answers 404 with that instruction rather than an
empty panel.

## Local development

```bash
node scripts/derive-constants.cjs      # required — the page fetches its output
cd admin && npx wrangler pages dev public
```

`wrangler pages dev` has no Access in front of it, so `guard()` will reject on
the host check (`localhost` ≠ `ADMIN_HOST`). Set `ADMIN_HOST=localhost` in a
local `.dev.vars` to work on the panels — and note that this also disables the
JWT check's usefulness locally, which is why `.dev.vars` is never committed.

Run `cd admin && wrangler pages dev public` from `admin/`, not the repo root:
`wrangler` resolves Functions from `./functions` relative to the working
directory, and from the root it would find the *catalog* project's resolver
instead.

## Adding a dispatch button

Edit `functions-lib/allowlist.js`. `test/admin-allowlist.test.js` asserts that
every allowlisted workflow exists, has a `workflow_dispatch` trigger, and
declares every input named here — so a typo fails the suite rather than
producing a button that has never worked.

Think about `writes` before adding one. It drives the typed confirmation in the
UI, and it is the only thing standing between a stray click and a commit.
