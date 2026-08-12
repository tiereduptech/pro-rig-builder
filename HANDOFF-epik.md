# Epik migration — handoff (written 2026-08-11, end of day)

## TL;DR for tomorrow morning
- **Nothing was unpushed.** The feature branch is fully merged and fully pushed. No push happened because there was nothing to push.
- **HEAD does NOT equal origin/main — and that's the healthy post-merge state, not a problem.** See "Git state" below.
- Next action: run the **symlink-docroot probe** before committing to the pull-based redesign.

## Git state (verified)
- Current branch: `feat/epik-migration`
- HEAD: `f1d165d` (`ci(epik): gate push-triggered prod deploy; allow ref override for staging`)
- origin/main: `8383eb8`
- `origin/main..HEAD` = **0 commits** (nothing unpushed)
- `origin/feat/epik-migration..HEAD` = **0 commits** (feature branch tip is pushed)
- HEAD is a strict ancestor of origin/main — `git merge-base --is-ancestor HEAD origin/main` = YES

origin/main is **2 commits ahead** of HEAD:
- `8383eb8` Merge pull request #3 from tiereduptech/feat/epik-migration
- `9f08066` chore(catalog): tier 4 auto-verification

So **PR #3 is merged** and every epik commit is contained in main. HEAD != origin/main only because main carries the merge commit + one catalog commit that never touched this branch. To get literal equality you'd `git checkout main && git pull` — the feature branch itself needs nothing.

Working tree: only `list-bad-prices.cjs` untracked (a scratch diagnostic — Amazon deal price > 1.5x base. Left alone, not committed, per "push commits only").

## Where the Epik migration stands
Static-hosting migration to Epik, landed on the branch and merged via PR #3. Commits, oldest→newest:
- `5e1cb6d` static-hosting migration — `.htaccess`, PHP resolver, deploy pipeline
- `ee4e230` force LF on deploy/ config, ignore generated dist/ artifacts
- `c90e2bf` staging Basic-Auth + noindex guard, with a prod guard-absence gate
- `0bdc786` fold cPanel PHP-ini block into deploy/.htaccess
- `8d288c5` resolver sets status via CGI `Status:` header, not `http_response_code`
- `f1d165d` CI: gate push-triggered prod deploy; allow ref override for staging

Key files: `deploy/.htaccess`, `deploy/resolver.php`, `deploy/sftp-deploy.cjs`, `build-epik.cjs`, `.github/workflows/deploy-epik.yml`, `test/verify-epik.cjs`, `test/epik-fixture.json`.

Phases done: build (`build-epik.cjs`) → deploy pipeline (SFTP) → staging guard (Basic-Auth + noindex, with prod gate that fails if the guard is absent) → resolver status-header fix → CI prod-deploy gating. Merged.

## The firewall finding + pull-based redesign (from the pre-/clear session — capturing your own summary; the detailed reasoning was in that now-cleared conversation)
- **Firewall finding:** the current deploy path is **push-based** (CI → SFTP into Epik), and that runs into a firewall constraint on the host side. This is what motivated rethinking the delivery direction.
- **Proposed redesign — pull-based:** instead of CI pushing artifacts into Epik over SFTP, have the **host pull** the built artifacts (Epik-side fetches from a published source rather than us reaching in). This sidesteps the firewall that blocks inbound push.
- NOTE: the specifics (exact firewall symptom, which ports/hosts, the exact pull mechanism) lived in the cleared session and are **not** in my current context — I did not want to fabricate them. Re-state them to me tomorrow (or they may be in your own notes) and I'll reconstruct the design precisely.

## The probe to run FIRST
- **Symlink-docroot probe:** before committing to the pull-based redesign, confirm whether the Epik docroot can be a **symlink** (e.g. docroot → a release dir we swap), i.e. whether the host honors a symlinked/relocatable docroot. The answer determines whether an atomic symlink-swap release model is even possible on this host, which the pull-based design likely depends on.
- This was explicitly "run this first" — it gates the redesign.

## Next action
1. Run the **symlink-docroot probe** on Epik and record the result.
2. Feed me the probe result + the firewall specifics, and I'll firm up the pull-based redesign into a concrete plan/diff.
3. (Optional housekeeping) `git checkout main && git pull` if you want local main current; decide whether to keep or delete `list-bad-prices.cjs`.
