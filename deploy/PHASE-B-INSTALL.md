# Phase B — production box bootstrap (step 2)

**What this step does:** stands up the pull-deploy tree on the Epik box for
**production**, verifies a real production artifact end to end, and leaves it
staged at `~/prb/current` **serving nothing**.

**What it does not do:** it does not touch the production docroot, does not
install a cron entry, and does not move DNS or Cloudflare. Production keeps
serving from `public_html` (via Railway at the edge) until the flip in step 3.

---

## 0. Prerequisite — publish a production artifact

`epik-release` **does not exist yet** (verified 2026-08-12: the repo has
`epik-release-staging` only). The installer's preflight refuses to continue
without it, so publish first:

> Actions → **Publish Epik release artifact** → Run workflow
> - `target`: **production**
> - `confirm`: **false**

`confirm: false` is not optional here. The confirm step polls
`https://prorigbuilder.com/_deploy-status.json`, and that hostname still
resolves to **Railway** until step 8. With confirm on, the workflow polls for
~20 minutes and then fails a publish that in fact succeeded — a red run that
means nothing, which is worse than no check.

The workflow builds with `build-epik.cjs` (no `--staging`), which refuses to
produce a production artifact carrying any guard, and scrubs a stale
`dist/.htpasswd` if one is present.

---

## 1. Find the production docroot — do not assume it

`~/public_html` is the cPanel convention and what `DESIGN-pull-deploy.md` §4
assumes, but that is an assumption, not a measurement. **This same account
serves staging from `~/staging.prorigbuilder.com`**, a docroot that is not under
`public_html` — so the convention demonstrably does not hold everywhere on this
box.

Run the installer with no `DOCROOT`. It probes, prints what it found, changes
nothing, and exits:

```sh
curl -fsSL https://raw.githubusercontent.com/tiereduptech/pro-rig-builder/main/deploy/install-phase-a.sh -o ~/install-phase-a.sh && bash ~/install-phase-a.sh --production
```

It lists each candidate with its entry count and which marker files it holds. A
docroot deployed by the current SFTP path should show `index.html` + `.htaccess`
+ `resolver.php`. Pick the one the live site serves.

---

## 2. Bootstrap

```sh
DOCROOT=$HOME/public_html bash ~/install-phase-a.sh --production
```

Substitute whatever step 1 actually reported. What this run does:

| | staging (Phase A) | production (this step) |
|---|---|---|
| release branch | `epik-release-staging` | `epik-release` |
| install root | `~/prb-staging` | `~/prb` |
| `EXPECT_GUARD` | `1` — guard required | **`0` — guard forbidden** |
| `secrets/.htpasswd` | written, mode 644 | **never written** |
| `secrets/` mode | 711 | **700** |
| `BASIC_AUTH` in config | the credential | **empty** |
| docroot flip | prompted | **skipped** (needs `--flip`) |
| crontab entry | prompted | **skipped** (needs `--cron`) |

### Why 700 and no `.htpasswd`

The 711 on staging exists for exactly one reason: LiteSpeed's core reads
`AuthUserFile` as `nobody` (suEXEC governs CGI, not the auth db), so `nobody`
needs `+x` to traverse into `secrets/`. That path only exists because the
**staging** guard names `AuthUserFile <secrets dir>/.htpasswd`.

A production artifact carries no guard, so no `AuthType`, no `AuthUserFile`, no
`Require valid-user` — nothing on the production path reads `secrets/` at all.
It is empty and 700, and the installer **refuses to run** if a `.htpasswd` is
found under a production install root.

**APR1 is irrelevant on this path.** The APR1-vs-`{SHA}` trap only applies to a
hash LiteSpeed has to parse; production asks it to parse nothing. Nothing else
on the production path needs a web-readable secret: `resolver.php`,
`resolver-config.php`, `redirects.php` and `_env.php` read only their own
release tree, and `.htaccess` denies `_ops/`.

### The guard is asserted in both directions, four times

1. `build-epik.cjs` — refuses to build a production artifact containing a
   sentinel, `Auth*` directive, or blanket noindex; deletes a stale `.htpasswd`.
2. `publish-epik.yml` — refuses to publish one.
3. `epik-pull.sh` — `EXPECT_GUARD=0` fails verification if the sentinel is present.
4. `install-phase-a.sh` step 6 — checks the sentinel **and** the `Auth*`
   directives independently, because the sentinel is only a comment marker and a
   hand-edited `.htaccess` could carry auth without it.

---

## 3. What you should see

```
== Production bootstrap complete — nothing is serving this tree yet
   docroot:   /home/tier5415/public_html  (real directory, UNTOUCHED)
   staged:    /home/tier5415/prb/current -> /home/tier5415/prb/releases/<sha>
   config:    EXPECT_GUARD=0, BASIC_AUTH empty, secrets/ 700 and empty
```

Do **not** curl `https://prorigbuilder.com` to check this. That hostname answers
from Railway; a 200 there is not evidence about this box. Verify on the box:

```sh
cat ~/prb/current/RELEASE.json
ls -la ~/public_html          # still a real directory
ls -ld ~/prb/secrets          # drwx------  (700)
ls -A  ~/prb/secrets          # empty
grep -c PRB-STAGING-GUARD ~/prb/current/.htaccess   # 0
```

---

## 4. The preflight guard that matters most here

The flip renames the docroot to `<docroot>.pre-pull`. If something is *already*
at that name and the docroot is not already this install's symlink, that rename
buries a live tree. On production that tree is the live site's.

The decision is a pure function, `docroot_verdict()`, driven through its whole
truth table by `test/install-phase-a.docroot.test.sh` (8/8 + a refuse
invariant). It cannot be exercised end-to-end from a Windows dev box — git-bash
has no symlink privilege, so `ln -s` silently makes a copy and every case
collapses to "real directory", which is how a guard gets called "confirmed" on
evidence that never reached it.

| docroot | `.pre-pull` | verdict | behaviour |
|---|---|---|---|
| real directory | absent | `pre-flip` | normal first run |
| real directory | **present** | `refuse-buried` | **stops, resolve by hand** |
| symlink → `~/prb/current` | absent | `resume` | already flipped |
| symlink → `~/prb/current` | present | `resume` | expected post-flip residue |
| symlink → elsewhere | absent | `foreign-link` | noted; flip renames the *link* |
| symlink → elsewhere | **present** | `refuse-foreign` | **stops, resolve by hand** |

Every run prints the inputs and the verdict on one line before acting:

```
   docroot state: real directory, .pre-pull absent  =>  pre-flip
```

---

## 5. Step 4 — CP-1…CP-5 against the origin, before DNS moves

One script, `deploy/cp-verify.sh`. It sets `HOST` and `ORIGIN` itself, runs all
five checks in order, prints a tally per check rather than a wall of output, and
exits non-zero if anything that gates the cutover failed.

```sh
curl -fsSL https://raw.githubusercontent.com/tiereduptech/pro-rig-builder/main/deploy/cp-verify.sh -o ~/cp-verify.sh && bash ~/cp-verify.sh
```

Read-only: it fetches and greps, writes nothing outside a temp directory, and
touches no release, docroot or config. Override with `HOST=` `ORIGIN=` `ROOT=`
`SAMPLE=` (defaults are production's).

**Every request is pinned** with `curl --resolve $HOST:443:$ORIGIN` and sent with
`-k`. `prorigbuilder.com` resolves to Railway until step 8, so a check that
follows DNS in this window measures the stack we are migrating away from and
reports the difference as this box's fault — which is exactly what made a clean
flip print "left flipped and unhealthy".

| | asserts | gates DNS |
|---|---|---|
| **CP-1** | the origin serves the staged release, on every worker, with `dir_resolved` intact. Ten requests, not one — the convergence band is per worker | yes |
| **CP-2** | routing/status parity: the same 15-case fixture CI runs, driven with curl | yes |
| **CP-3** | what the pages *render*: the five HARD checks from `verify-prerender.cjs`, applied to what the origin serves rather than to `dist/`, plus the `X-Robots-Tag` response header | yes |
| **CP-4** | production is unauthenticated and exposes nothing: no guard, no `.htpasswd`, `/_ops/` denied, `robots.txt` not a blanket disallow | yes |
| **CP-5** | cache headers, and the origin cert | headers yes, cert no |

**CP-2 does not use `_ops/verify-epik.cjs`.** A release published before
`EPIK_RESOLVE` existed carries a copy that ignores it and follows DNS — it would
grade Railway and call it a pass. The fixture is driven with curl instead.

**CP-3's `noindex` line is the one to read first.** That is the failure that
served `robots: noindex` on 4573 live product pages for ~10 days in July. It is
checked both as a meta tag and as a response header: a page can be perfect in
`dist/` and still be de-indexed by what the server attaches on the way out.

**CP-5 is split deliberately.** The **cert** is expected not to validate before
cutover — AutoSSL's DNS validation for this name resolves to Railway — so it is
NOTED and does not affect the exit code. It is the Cloudflare **Full (Strict)**
blocker: fix it before choosing the SSL mode at step 8, not after. The
**`Cache-Control`** lines *do* affect the exit code. If `_deploy-status.json` or
`RELEASE.json` are cacheable, CI's confirm-poll reads a stale answer and reports
a deploy that did not happen — every future deploy verification becomes
unreliable, silently (DESIGN §11). That is a bug, not a nicety, so it blocks like
CP-1…CP-4 does.

A check that cannot **run** counts as a failure, never as a pass — a missing
fixture or an unreadable `RELEASE.json` is reported as a failure of that CP. The
whole point of the file is to avoid reporting a verdict it did not measure.

```
 CP   what it asserts                                result
 --   ---------------------------------------------- ------
 CP-1 release identity + worker unanimity            6 pass
 CP-2 routing/status parity (fixture)                15 pass
 CP-3 rendered output (prerender HARD checks)        6 pass
 CP-4 unauthenticated, nothing exposed               8 pass
 CP-5 cache headers (cert is noted, not failed)      4 pass  (3 noted)

ALL CLEAR — CP-1..CP-4 clean, CP-5 cache headers clean.
```

---

## 6. Reversing

Nothing in this step changes what production serves, so there is nothing to roll
back — the install is additive. To remove it entirely:

```sh
bash ~/install-phase-a.sh --production --uninstall DOCROOT=$HOME/public_html
rm -rf ~/prb          # optional; leaves no trace
```

---

## 7. Not in this step

- **Docroot flip** — step 3, `bash ~/install-phase-a.sh --production --flip`.
- **Cron** — deliberately deferred. A `*/5` entry against an unflipped docroot
  fails the docroot assertion every five minutes and mails a failure each time,
  training the alarm to be ignored before it ever matters.
- **`EPIK_PULL_AUTO_PUBLISH`** — step 5. Note the trap recorded in
  `DESIGN-pull-deploy.md`: both `publish-epik.yml` and `deploy-epik.yml` default
  to `target: production` on a push event, so flipping that variable makes
  ordinary commits touching `deploy/**`, `dist/**` or `build-epik.cjs` ship
  production as a side effect.
- **Cloudflare** — steps 7–9.
