# Phase B — production box bootstrap (step 2)

**What this step does:** stands up the pull-deploy tree on the Epik box for
**production**, verifies a real production artifact end to end, and leaves it
staged at `~/prb/current` **serving nothing**.

**What it does not do:** it does not touch the production docroot, does not
install a cron entry, and does not move DNS or Cloudflare. Production keeps
serving from `~/prorigbuilder.com` (via Railway at the edge) until the flip in
step 3.

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

**MEASURED (steps 2–3): the production docroot is `/home/tier5415/prorigbuilder.com`.**
`~/public_html` on this account belongs to **`tiereduptech.com`** — a different
site. Pointing the installer at it would have flipped another live domain's
docroot to this release tree.

That is why this section exists and why it runs first. `~/public_html` is the
cPanel convention and what `DESIGN-pull-deploy.md` §4 assumed, but the
convention does not hold on this box in either direction: staging serves from
`~/staging.prorigbuilder.com`, production from `~/prorigbuilder.com`, and
`public_html` is a third domain entirely. Re-probe rather than copying the path
below if anything about the account changes.

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
DOCROOT=$HOME/prorigbuilder.com bash ~/install-phase-a.sh --production
```

**Not `$HOME/public_html`** — that is `tiereduptech.com`'s docroot on this
account (§1). Re-probe rather than trusting this line if the account changes.
What this run does:

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
   docroot:   /home/tier5415/prorigbuilder.com  (real directory, UNTOUCHED)
   staged:    /home/tier5415/prb/current -> /home/tier5415/prb/releases/<sha>
   config:    EXPECT_GUARD=0, BASIC_AUTH empty, secrets/ 700 and empty
```

Do **not** curl `https://prorigbuilder.com` to check this. That hostname answers
from Railway; a 200 there is not evidence about this box. Verify on the box:

```sh
cat ~/prb/current/RELEASE.json
ls -la ~/prorigbuilder.com    # still a real directory
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

## 6. The origin cert — Cloudflare Origin CA (step 6a, before the SSL mode)

CP-5 notes that the origin cert is self-signed as
`CN=prorigbuilder.com.tiereduptech.com`, so it does not validate for
`prorigbuilder.com`. That is the Cloudflare **Full (Strict)** blocker, and it is
fixed here — *before* the SSL mode is chosen at step 8, not after.

### Why not AutoSSL, and why not DNS-01

**AutoSSL cannot issue for this name yet** — its validation for
`prorigbuilder.com` resolves to Railway. Worse, it would not be safe *after*
cutover either: cPanel does HTTP DCV by writing `.well-known/acme-challenge/`
**into the docroot**, and after step 3 the docroot is `~/prb/current` →
`releases/<sha>`. That write lands inside an immutable, manifest-verified
release tree — it diverges the tree from `MANIFEST.sha256`, disappears on the
next symlink swap mid-validation, and is eventually `rm -rf`'d by the N=10 prune
(`epik-pull.sh` §10). cPanel's DNS-based DCV is not a way out: it needs cPanel
to control the zone, and Cloudflare does.

**DNS-01 via acme.sh works**, but it costs three things this design spent effort
avoiding: a Cloudflare DNS-edit token living on a shared host (the release
branch is public precisely so the box holds *no* credential — nothing to rotate,
nothing to leak), a second crontab entry beside the one installed at step 6, and
a 90-day renewal that fails silently. Reach for it only if you need a
**publicly trusted** cert — see "What this forecloses" below.

**Origin CA needs no validation of any kind.** No challenge file, no DNS record,
no token, no renewal for 15 years, and it is the exact chain Full (Strict)
checks.

### 6.1 Generate it in Cloudflare

1. Cloudflare dashboard → select the **`prorigbuilder.com`** zone.
2. **SSL/TLS** → **Origin Server** → **Create Certificate**.
3. Leave **Generate private key and CSR with Cloudflare** selected. Key type
   **RSA (2048)**.
4. **Hostnames** — the box is pre-filled with both of these. Keep both:
   ```
   prorigbuilder.com
   *.prorigbuilder.com
   ```
   The wildcard costs nothing and covers `www.` and any future proxied
   subdomain. Including `*.prorigbuilder.com` in the cert is **not** the same as
   installing it on the staging vhost — see the warning in 6.3.
5. **Certificate Validity: 15 years.**
6. **Create**. Two PEM blocks are shown:
   - **Origin Certificate** — `-----BEGIN CERTIFICATE-----` … `-----END CERTIFICATE-----`
   - **Private Key** — `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----`

   **The private key is displayed once and never again.** Copy both before
   leaving the page. Do not commit either one — this repo is public.

### 6.2 Install it in cPanel

cPanel → **Security** → **SSL/TLS** → under *Install and Manage SSL for your
site (HTTPS)*, **Manage SSL sites** → scroll to **Install an SSL Website**.

| cPanel field | paste this |
|---|---|
| **Domain** (dropdown) | `prorigbuilder.com` |
| **Certificate: (CRT)** | the **Origin Certificate** block, `BEGIN CERTIFICATE` → `END CERTIFICATE` |
| **Private Key: (KEY)** | the **Private Key** block, `BEGIN PRIVATE KEY` → `END PRIVATE KEY` |
| **Certificate Authority Bundle: (CABUNDLE)** | **leave empty** |

Then **Install Certificate**.

cPanel may auto-populate the CABUNDLE box, or warn that it could not determine
the CA bundle. Both are expected and neither is a problem: Cloudflare's edge
already holds the Origin CA root, and a bundle is only needed for chains a
public client must build. If cPanel refuses to install without one, clear the
field and retry rather than pasting an unrelated bundle.

### 6.3 Install it on `prorigbuilder.com` ONLY

**Do not install this on `staging.prorigbuilder.com`.** Staging is grey-cloud —
`66.223.49.32` direct, no Cloudflare in front — so a browser meets the origin
cert itself. An Origin CA cert there would hard-fail TLS on every staging visit,
with no click-through in some browsers. Staging's AutoSSL cert is valid today
*because* its DNS genuinely points at the box; leave AutoSSL enabled for that
subdomain and leave that vhost alone.

### 6.4 What changes while DNS still points at Railway

Nothing load-bearing. Enumerated, because "it's only trusted by Cloudflare" is
easy to hand-wave and the consequences are worth naming individually:

| | before | after |
|---|---|---|
| public traffic to `prorigbuilder.com` | Railway | **Railway, unchanged** — nothing here touches DNS |
| a direct browser hit to the origin (IP, or a hosts entry) | warns: self-signed `CN=prorigbuilder.com.tiereduptech.com` | warns: untrusted issuer *CloudFlare Origin SSL Certificate Authority*. Same class of warning, different name |
| `staging.prorigbuilder.com` | AutoSSL cert, valid | **untouched**, provided 6.3 is respected |
| `epik-pull.sh` healthcheck | `ORIGIN_INSECURE=1`, `-k` | unchanged |
| `cp-verify.sh` CP-1…CP-4 | pinned with `-k` | unchanged |
| `cp-verify.sh` CP-5 cert line | "does not validate" | **still "does not validate" — and now misleading.** See 6.5 |

There is no window in which the live site is served by this cert before DNS
moves, because nothing routes to this box yet.

### 6.5 What CP-5 reports now

`cp-verify.sh` checks the cert *without* `-k` against the system trust store, and
Cloudflare's Origin CA root is deliberately absent from every public trust store
— so **curl exits 60 here permanently**, and that is correct rather than broken.
CP-5 no longer treats that exit code as a verdict; it reads the issuer, judges
expiry separately, and reports one of:

```
  note  the origin carries a CLOUDFLARE ORIGIN CA cert — CORRECT for Full (Strict). NOT a blocker.
  note    curl exit 60 is EXPECTED AND PERMANENT: CF's Origin root is in no public trust store
  note    by design, so only Cloudflare's edge validates this chain. Nothing to fix, ever.
  note    expires Aug  8 21:00:00 2041 GMT (~15y out). Keep ORIGIN_INSECURE=1 — PHASE-B-INSTALL §6.7.
```

The issuer match alone is not the pass. `curl` exits 60 for an untrusted issuer
**and** for an expired cert, so an issuer-only check would hide an expired Origin
CA cert behind "expected and permanent" — and Cloudflare's edge *does* check
expiry. CP-5 therefore reports expired, expiring-within-30-days, and
expiry-unreadable as distinct outcomes, and only the first form above is a clean
bill. An unrecognised issuer is still called the Full (Strict) blocker.

`cp-verify.sh` is fetched from `main` at run time, so re-running the one-liner in
§5 picks this up with nothing to install.

To verify independently — the way Cloudflare's edge actually will, against the
Origin CA root: 

```sh
curl -fsSL https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem -o /tmp/cf_origin_root.pem
curl -sS --resolve prorigbuilder.com:443:66.223.49.32 \
     --cacert /tmp/cf_origin_root.pem \
     -o /dev/null -w 'chain verified, HTTP %{http_code}\n' \
     https://prorigbuilder.com/_env.php
```

Exit 0 means the chain Full (Strict) validates is intact. Then confirm the
install landed on the right vhost:

```sh
curl -sSv --resolve prorigbuilder.com:443:66.223.49.32 -k https://prorigbuilder.com/ 2>&1 \
  | grep -E '^\* +(subject|issuer|expire)'
```

Expect issuer `C=US; O=CloudFlare, Inc.; CN=CloudFlare Origin SSL Certificate
Authority`, a subject covering `prorigbuilder.com`, and an expiry ~15 years out.
**If the issuer still reads `prorigbuilder.com.tiereduptech.com`, the install did
not take on this vhost** — recheck the Domain dropdown in 6.2.

### 6.6 AutoSSL may overwrite it. That is a recheck, not a hazard.

cPanel AutoSSL can decide the vhost lacks a trusted cert and replace this one on
its next run. Neither outcome is dangerous:

- **Pre-cutover** it would fail to issue (validation still resolves to Railway)
  and leave the self-signed cert — back where step 4 found things, not a
  regression.
- **Post-cutover** a successful AutoSSL replacement is a genuinely trusted cert,
  which Full (Strict) also accepts.

The detector is the issuer line in 6.5. Run it immediately before flipping the
SSL mode at step 8, and once more after the first AutoSSL cycle following
cutover.

### 6.7 `ORIGIN_INSECURE=1` stays, permanently — deliberately

Keep `ORIGIN_IP` and `ORIGIN_INSECURE=1` in `~/prb/config` after cutover. The
healthcheck is pinned with `--resolve` so that it measures **this box** rather
than whatever DNS resolves to (`epik-pull.sh`, ORIGIN_IP note), which means the
cert it meets is an Origin CA cert no public trust store carries. Validating it
would require installing the CF root on the box and threading `--cacert` through
every request — machinery whose only product is a chain check Cloudflare's edge
performs on every request anyway. What the healthcheck needs to establish is
which release each worker is serving; `-k` does not weaken that.

Unpinning instead would be the real regression: the check would then grade the
Cloudflare edge and its cache, not the origin.

### 6.8 What this forecloses

**Grey-clouding `prorigbuilder.com`.** With Origin CA installed and the proxy
off, browsers meet an untrusted issuer and hard-fail. If Cloudflare ever needs
to be bypassed — an edge outage, a debugging window — the move is to obtain a
publicly trusted cert *first* (AutoSSL will validate normally once DNS points
here, subject to the docroot-write caveat above, or acme.sh DNS-01), **not** to
flip the orange cloud off and see what happens.

---

## 7. Reversing

Nothing in this step changes what production serves, so there is nothing to roll
back — the install is additive. To remove it entirely:

```sh
bash ~/install-phase-a.sh --production --uninstall DOCROOT=$HOME/prorigbuilder.com
rm -rf ~/prb          # optional; leaves no trace
```

---

## 8. Not in this step

- **Docroot flip** — step 3, `bash ~/install-phase-a.sh --production --flip`.
- **Cron** — deliberately deferred. A `*/5` entry against an unflipped docroot
  fails the docroot assertion every five minutes and mails a failure each time,
  training the alarm to be ignored before it ever matters. When you do install
  it (`--production --cron`), **first confirm `grep ORIGIN ~/prb/config` shows
  `ORIGIN_IP`**: without it the healthcheck follows DNS to Railway,
  `hc_verdict()` returns `unverified` (exit 3), and `epik-pull.sh` rolls back on
  exit 3 as the conservative move — so the first real auto-deploy would roll
  itself back.
- **`EPIK_PULL_AUTO_PUBLISH`** — step 5. Note the trap recorded in
  `DESIGN-pull-deploy.md`: both `publish-epik.yml` and `deploy-epik.yml` default
  to `target: production` on a push event, so flipping that variable makes
  ordinary commits touching `deploy/**`, `dist/**` or `build-epik.cjs` ship
  production as a side effect.
- **Cloudflare SSL mode** — step 8, and only after §6 above is verified.

### Order

```
§6 cert  ->  pin publish-epik.yml (EPIK_ORIGIN_IP)  ->  --production --cron
         ->  burn in 2+ unattended nightlies        ->  EPIK_PULL_AUTO_PUBLISH
         ->  DNS + Full (Strict)                    ->  clear EPIK_ORIGIN_IP
```

The pin comes **before** the burn-in, not after. Two steps in
`publish-epik.yml` fetch `https://prorigbuilder.com/...`, which answers from
Railway until DNS moves: the confirm-poll then fails red for ~20 minutes on
every publish while the box is in fact green, and the R2 `.htaccess` detector
silently ships `htaccess_changed=false`, putting the box on the fast healthcheck
path for a release that changed `.htaccess`. Burning in through that produces a
red run per nightly that means nothing, in the exact window meant to build the
confidence to move DNS — the same way an unflipped-docroot cron trains its own
alarm to be ignored. Set the `EPIK_ORIGIN_IP` repo variable to `66.223.49.32`
first, and clear it once DNS points here.
