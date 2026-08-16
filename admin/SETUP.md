# admin.prorigbuilder.com — first-time setup

Copyright © 2026 TieredUp Tech, Inc.

Twenty-two steps, in order, to take the admin dashboard from committed code to a
working site. Do them in sequence — a few later steps depend on earlier ones
being *finished*, not merely started, and those are called out where they matter.

Design and reasoning: `deploy/DESIGN-admin-dashboard.md`.
Day-to-day reference: `admin/README.md`.

Everything below is Phase 0 + Phase 1 — a read-only view plus a dispatch button.
No setting is editable from the dashboard.

---

## A. Create the second Pages project

The admin dashboard is its own Cloudflare Pages project, not a route on the
catalog one. See `DESIGN-admin-dashboard.md` §2 for why.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Create using direct upload**.

2. Name it something like `prb-admin`. There is nothing to upload — the deploy
   workflow does that. **Write the name down**; it goes in step 17.

3. Open the new project → **Settings** → **Builds & deployments** → confirm the
   production branch is `main`.

4. **Custom domains** → **Set up a custom domain** → `admin.prorigbuilder.com` →
   follow the CNAME prompt.

   **Wait for it to show Active before step 5.** An Access application on a
   domain that is not attached yet looks like it is working and protects
   nothing.

## B. Put Cloudflare Access in front of it

5. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** →
   **Add an application** → **Self-hosted**.

6. Application name: `PRB admin`. Session duration is your call; 24 hours is
   reasonable.

7. Application domain: subdomain `admin`, domain `prorigbuilder.com`, **path
   blank**.

   The blank path matters. The API routes must be covered, not just the page —
   leaving a path here would protect `/` and leave `/api/dispatch` open.

8. Add a policy: name `Owner`, action **Allow**, include **Emails** →
   `coby@tiereduptech.com`. Add more people later if anyone else needs in.

9. Save, then reopen the application → **Overview** → copy the **Application
   Audience (AUD) Tag**. It is a long hex string. You need it in step 15.

10. Zero Trust → **Settings** → **Custom Pages** (or read it from the team
    selector, top left) → note your **team domain**, e.g.
    `https://tieredup.cloudflareaccess.com`. You need it in step 14.

## C. Mint the GitHub token

11. GitHub → your avatar → **Settings** → **Developer settings** → **Personal
    access tokens** → **Fine-grained tokens** → **Generate new token**.

    - Name: `prb-admin-dashboard`
    - Resource owner: `tiereduptech`
    - Repository access: **Only select repositories** → `pro-rig-builder`
    - Repository permissions: **Contents: Read-only**
    - Repository permissions: **Actions: Read and write**
    - **Workflows: No access** — leave it alone

    The withheld `workflows` scope is deliberate and load-bearing. It is what
    editing a cron schedule would require, and per `DESIGN-admin-dashboard.md`
    §4 a dashboard must not. Withholding it means a bug in the Function cannot
    edit a workflow file even if it tries — enforcement at the credential layer
    rather than by convention.

    Set an expiry and put the renewal in your calendar. Copy the token now;
    GitHub shows it exactly once.

## D. The five variables, on the Pages project

Project → **Settings** → **Variables and Secrets**. Add each one for
**Production**. Repeat for **Preview** if you intend to deploy `target=staging`.

12. `GITHUB_REPO` = `tiereduptech/pro-rig-builder` — plaintext.

13. `ADMIN_HOST` = `admin.prorigbuilder.com` — plaintext.

14. `ACCESS_TEAM_DOMAIN` = the team domain from step 10 — plaintext.
    A trailing slash is fine; it is normalized.

15. `ACCESS_AUD` = the AUD tag from step 9 — plaintext.

16. `GITHUB_TOKEN` = the token from step 11 — **encrypt this one.** Choose
    *Secret*, not plaintext.

There is an optional sixth, `DISPATCH_REF`, which defaults to `main`. You almost
certainly want that default; set it only if you deliberately want dispatches to
run from another branch.

## E. Repository configuration

17. GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
    **Variables** tab → **New repository variable**:
    `CF_ADMIN_PAGES_PROJECT` = the project name from step 2.

18. Leave `ADMIN_AUTO_DEPLOY` **unset** for now. Set it to `true` later if you
    want a push touching `admin/**` to deploy on its own.

    `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already set on this
    repo — `deploy-admin.yml` reuses them, and needs nothing new.

## F. First run

19. Merge `feat/admin-dashboard` into `main`.

    `catalog-build/catalog-stats.json` is seeded in that branch, so `/api/stats`
    has data from the first load. The **Catalog stats** workflow keeps it fresh
    from then on, firing whenever the catalog changes.

20. Actions → **Deploy admin dashboard** → **Run workflow** → target
    `staging`, dry run **true**.

    This exercises the preflight and the `derive-constants.cjs` assertions
    without deploying anything. If a pipeline constant has been renamed or moved
    since this was written, it fails here — which is the intended behaviour, not
    a setup problem.

21. Same workflow → target `production`, dry run **false**.

22. Visit `https://admin.prorigbuilder.com`. You should get the Access login,
    then the dashboard.

---

## Two things to expect

**The `.pages.dev` URL answers 404, not the dashboard.** That is the host check
in `admin/functions-lib/access.js`, and it is deliberate: the alias is permanent
and Cloudflare offers no way to disable it, so the Function refuses any hostname
that is not `ADMIN_HOST`. A 404 there is the system working. Do not read it as a
broken deploy.

**If every request returns 500 saying "misconfigured", one of steps 13–15 is
missing or misspelled.** The gate fails closed by construction — an unconfigured
auth check must never mean an open one — so a typo in the Pages dashboard is a
500, not a public admin panel. Check `ADMIN_HOST`, `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`, and confirm you set them on the environment you actually deployed
to (Production vs Preview are separate lists).

## If something else goes wrong

| Symptom | Almost always |
|---|---|
| `403 Access denied: aud does not match this application` | `ACCESS_AUD` is from a different Access application — recopy from step 9 |
| `403 Access denied: no Cf-Access-Jwt-Assertion header` | the request reached the Function without going through Access — check the custom domain from step 4 is Active |
| `503 jwks unavailable` | `ACCESS_TEAM_DOMAIN` is wrong, or Cloudflare is having a moment. This is reported as infrastructure rather than denial on purpose, so it does not send you hunting through Access policies |
| Catalog panel: `catalog-build/catalog-stats.json is not on the default branch yet` | step 19 is not merged; or run `node scripts/catalog-stats.cjs` and commit |
| Workflows panel: `502` with a GitHub message | `GITHUB_TOKEN` expired, or `GITHUB_REPO` is not `owner/name` |
| Dispatch: `403 … likely lacks Actions: read and write` | the token was minted with Actions read-only — remint per step 11 |
| Deploy fails: `wrangler reported 'No Functions'` | the deploy did not run from `admin/`. It is a hard failure because that combination would publish the dashboard with no authentication as a green deploy |
