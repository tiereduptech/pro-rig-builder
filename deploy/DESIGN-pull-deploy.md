# Pull-based deploy to Epik — design for review

Status: **draft, awaiting approval. No implementation written.**
Written 2026-08-12 after the stage-1 symlink probe. Revised the same day against
the stage-2 PHP probe (`deploy/probe-php-dir.sh`), which confirmed the one fact
§3 needed and contradicted two of the three arguments built on top of it.

---

## 1. Why pull

The Epik host firewalls **inbound** connections, so CI cannot SFTP into it. Outbound
from the box is confirmed healthy (`git clone --depth 1` in 0.582s, `npm ping` 154ms).
So we invert the direction: Actions **publishes** an artifact to a place both sides can
reach over outbound 443, and a cron on Epik **pulls** it. Nothing ever connects in.

## 2. What the probe established

### Stage 1 — symlinks and static serving

Green, on the staging docroot:

- LiteSpeed follows symlinks with no `Options +FollowSymLinks` needed
- two hops resolve (`docroot -> current -> releases/<sha>`)
- PHP runs from a linked tree; `open_basedir` permits it
- a release-local `.htaccess` is honored and its headers come through
- nested paths and the `mod_dir` 301 behave; no scheme downgrade, no path leak
- `mv -T` works; the atomic swap flips **static content in 0s**
- the release-local `.htaccess` lagged the swap by ~8s

### Stage 2 — PHP path resolution and caching (`deploy/probe-php-dir.sh`)

- **`__DIR__` inside a swapped release is already the resolved real path**
  (`DIR_IS_RESOLVED=YES`). The one fact §3 is built on is confirmed.
- **Nothing PHP-served flips instantly.** In-tree PHP first served the new release
  at 3s, and every endpoint converged in a **3–8s band** — the same band as stage
  1's ~8s `.htaccess` figure.
- **The lag is per-worker, not per-request.** Three LSAPI worker pids served the
  probe (1210548, 1210772, 1210897), each with its own primed cache. A single
  request reporting the new release proves *one worker* flipped, nothing more.
  This is what §6.7 is rewritten around.
- **`realpath_cache_ttl` does not govern.** It reads 120, the stable path was
  primed immediately before the swap, and it still flipped at 4s. The 120s figure
  the previous §3 reasoned from is not what this host does.
- **opcache state is unknown, not confirmed-safe.** `opcache.enable`,
  `validate_timestamps` and `revalidate_freq` all read empty and
  `opcache_get_status()` is unavailable — introspection is locked down. The
  identical-size-and-mtime include flipped at 0s, which is exactly what an
  *inactive* opcache looks like. It is **not** evidence that per-release path
  keying saved us. See §3.3.

**One band, not three caches.** Static at 0s, everything path-resolved (PHP
execution, `.htaccess`) at 3–8s: that is the entire measured picture, and it is an
**envelope, not a mechanism**. Which cache produces it was not identified. The
design below is written against the envelope deliberately — the previous §3
reasoned from documented cache semantics to a specific number, and the host then
contradicted it.

## 3. The skew, and why the design survives it

The swap is not atomic as far as clients are concerned: for 3–8s afterwards, some
workers still serve the old release. Three things make that survivable. The order
below is the order of how much weight each now carries — which is not the order
the previous draft had.

### 3.1 — `.htaccess` is byte-identical between releases

`build-epik.cjs:98` copies `deploy/.htaccess` to `dist/.htaccess` **verbatim**. The
staging Basic-Auth guard is the only thing ever appended, and only under
`--staging`. No per-release data reaches `.htaccess`. The 301 map is
`redirects.php` (line 75) and the product/410 boundary is `resolver-config.php`
(line 57) — separate files, both read through PHP.

So the config layer that lags is a file that does not differ between releases, and
its lag is a no-op. **R2** (§3.4) is the rule that keeps that true.

### 3.2 — R1: the resolver stays inside the swapped tree

The previous draft justified R1 by a staleness cost: a stable-docroot resolver
would be "exposed to PHP's realpath cache (120s default TTL — worse than the 8s we
are fixing)". **The probe did not support this.** With `realpath_cache_ttl` at 120
and the path primed immediately before the swap, the stable-path resolver flipped
at **4s** — inside the same band as everything else. The cost of breaking R1 is a
few seconds, not two minutes. That argument is withdrawn.

R1 survives on a different and stronger one: **mid-request atomicity.**

`resolver.php` reads four files — `resolver-config.php`, `redirects.php`,
`gone.html`, `index.html`. With `__DIR__` measured as the resolved release
directory, all four resolve *inside one release directory*, and a swap landing
between two of those reads cannot move where the later ones point. A stable-path
resolver re-resolves `current` on every read, so a swap mid-request yields release
A's redirect map applied to release B's content — a wrong 301 or a wrong 410,
served to a real user, from a request that looked fine at both ends.

This is a **structural** guarantee rather than an empirical one. It holds without
reference to any cache, TTL, or host tuning, so no future config change can erode
it. That is precisely why it is worth keeping a rule that measurement just showed
is cheap to break: R1's value was never the seconds, and the probe is what made
that clear.

### 3.3 — opcache: assert it, do not assume it

The previous draft claimed "distinct per-release real paths make opcache staleness
impossible." The mechanism is sound — a new release is a new real path, so a new
cache key, so a compile from disk even under `validate_timestamps=0`. But it rests
on two facts, and only one of them is tested:

| fact | status |
|---|---|
| `__DIR__` is the resolved release path | **measured YES** on this host |
| opcache keys on that resolved path | **untested** — introspection locked down |

E3 flipping at 0s with identical size *and* mtime is consistent with per-release
keying working, and equally consistent with opcache simply not being active. Those
two cannot be told apart from outside on this host, so the design must not quietly
rest on the flattering reading.

It does not need to. The fix is not more analysis — it is to make both facts
**observable at runtime and alarmed on** (§6.9, §8.2) instead of assumed at design
time. If a future host, or a cPanel PHP-version change, enables opcache with
`validate_timestamps` off and keys on something other than the real path, that
appears in `_deploy-status.json` and fails the watchdog within 30 minutes —
rather than silently serving last release's redirect map until someone notices.

**One trap worth recording now, so nobody loses a day to it later:** CLI PHP and
the web SAPI hold **separate** opcaches. `opcache_reset()` from the cron script
does nothing whatsoever to what LiteSpeed is serving. If invalidation ever becomes
necessary, it has to be triggered over HTTP against the live site. No such
machinery is being built now — on current evidence there is nothing to invalidate,
and building a cache-buster against a cache you cannot observe is how you end up
maintaining two problems.

### 3.4 — R2: `.htaccess` changes are detected and made loud, not blocked

The publish job compares `sha256(.htaccess)` against the currently-live release's
and sets `htaccess_changed: true` in `RELEASE.json` when it differs. It **warns, it
does not fail**: a hard block fires on legitimate edits, and an override flag
passed reflexively is worse than no gate at all. What the flag would have gated
happens automatically instead — see the settle path in §6.7.

R2 does not prevent the skew; it makes the one release per year where the skew could
matter visible, and puts that release on the slower, verified path without anyone having
to remember to ask for it.

## 4. Layout

```
~/prb/
  releases/<source-sha>/     extracted artifact (content + resolver + data + .htaccess)
  current -> releases/<source-sha>
  bin/epik-pull.sh
  state/{live.sha, prev.sha}
  log/deploy.log
  tmp/
~/public_html -> ~/prb/current      created ONCE, by hand, at cutover
```

Two hops on purpose. The docroot entry — the thing cPanel and LiteSpeed care about — is
written once and never touched again. Every deploy swaps only `current`.

The docroot symlink is created **manually, once**, by an operator. No script ever moves,
renames, or deletes a live directory.

## 5. Publish side — `.github/workflows/publish-epik.yml`

Trigger: push to `main` touching `dist/**`, `deploy/**`, `build-epik.cjs`, or the
workflow itself. Plus `workflow_dispatch` with a `config_release: boolean` input.

Concurrency: group `epik-publish`, `cancel-in-progress: false` — same reasoning as the
existing SFTP workflow. It force-pushes `epik-release`, never `main`, so it cannot join
the `main-writer` race.

Steps:

1. `actions/checkout@v4`, `setup-node@v4` (20), `npm ci`.
2. `node build-epik.cjs` — unchanged. Still the single source of truth for `.htaccess`,
   `resolver-config.php`, `redirects.php`, `gone.html`, and still the thing that refuses
   to build a guard-contaminated production artifact.
3. **Manifest.** Over `dist/`, excluding the two files below:
   `find . -type f -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256`
4. **RELEASE.json** at the artifact root:
   `{source_sha, built_at, file_count, manifest_sha256, htaccess_sha256}`
   where `manifest_sha256 = sha256(MANIFEST.sha256)`.
5. **Guard assertions** (belt and braces over build-epik's own): no `PRB-STAGING-GUARD`
   sentinel, no `.htpasswd` in the tree. The repo is public — a committed `.htpasswd`
   would be a credential leak, so this is a hard fail.
6. **R2 detection (warn).** Fetch the live `RELEASE.json` from the site and compare
   `htaccess_sha256`. On a difference the job **continues**, and:
   - emits a GitHub `::warning::` annotation, so it surfaces on the run and in the PR
   - writes a `## .htaccess changed in this release` block into `$GITHUB_STEP_SUMMARY`
     with the old and new hashes and a one-line diff
   - sets `htaccess_changed: true` in `RELEASE.json`, which is what tells the box to take
     the settle path in §6.7 — the signal travels with the artifact, so it works even if
     nobody reads the annotation
   The confirm-poll in step 8 reprints the warning in its final output, so it is the last
   thing on a green run rather than something buried mid-log.
7. **Publish the orphan branch.** A fresh repo per run, so the branch is always exactly
   one commit and never accumulates history:
   ```
   rm -rf /tmp/rel && cp -a dist /tmp/rel && cd /tmp/rel
   git init -q && git checkout -qb epik-release
   git add -Af && git -c user.email=ci@… commit -qm "release <source-sha>"
   git push --force https://x-access-token:$GITHUB_TOKEN@github.com/$REPO epik-release
   ```
   Needs `permissions: contents: write`. The repo is public, so the **box needs no
   credential at all** — no PAT on the host, nothing to rotate, nothing to leak.
8. **Confirm.** Poll `https://prorigbuilder.com/_deploy-status.json?t=<run_id>` until
   `live_sha == source_sha` and `health == "ok"`, or fail at ~20 min.

Step 8 is the observability answer: with no inbound path, **the site itself is the
status channel.** The box writes its outcome into the live tree; CI reads it over HTTPS.
A failed or rolled-back deploy still turns CI red.

## 6. Pull side — `~/prb/bin/epik-pull.sh`

`set -euo pipefail`, explicit `PATH` (cPanel cron gives a minimal one), `umask 022`.

1. **Docroot assertion.** `readlink ~/public_html` must equal `~/prb/current`. If not —
   cPanel recreated it, or someone changed it — log loudly, emit the failure **on stderr**,
   and **exit non-zero without repairing**. Auto-repairing a docroot means moving or
   deleting a live directory, which this design never does. The alarm is §8, not "someone
   notices."
2. **Cheap poll.** Plain GET of
   `https://raw.githubusercontent.com/<repo>/epik-release/RELEASE.json`
   (~380 bytes). `source_sha == state/live.sha` exits 0 immediately. ~287 of 288 daily
   ticks stop here having moved a few bytes.

   This was a conditional GET using `curl --etag-compare/--etag-save` until 2026-08-12,
   when the box's curl turned out to predate those options (7.68+, 2020) and exited 2 at
   argument parsing on every single tick — the poll never ran. The etag was never the
   deploy decision anyway: `source_sha` vs `state/live.sha` is, and it stays right when a
   CDN rotates an etag without a byte changing, or when the box has rolled back and the
   published sha is unchanged. A 304 was only a cheaper route to the same answer, and the
   thing it would have saved is smaller than the request that asks for it.
3. **Fetch.** `codeload.github.com/<repo>/tar.gz/refs/heads/epik-release` ->
   extract to `releases/<sha>.tmp` with `--strip-components=1`.
4. **Verify, before anything is swapped.**
   - `sha256sum -c MANIFEST.sha256` — every file, per-file failure messages
   - `sha256sum MANIFEST.sha256` matches `RELEASE.json.manifest_sha256`
   - required files present: `index.html`, `resolver.php`, `resolver-config.php`,
     `redirects.php`, `gone.html`, `.htaccess`
   - `.htaccess` contains no `PRB-STAGING-GUARD`; no `.htpasswd` in the tree
   Any failure: delete the `.tmp` tree, write `status=verify_failed`, exit 1. **Nothing
   was swapped, so the live site was never at risk.**
5. **Name it.** `mv -T releases/<sha>.tmp releases/<sha>` — a half-extracted tree can
   never be swapped to, because it does not have its final name until it is complete.
6. **Swap.** Record `prev=$(readlink current)`, then
   `ln -sfn releases/<sha> current.tmp && mv -T current.tmp current`.
7. **Healthcheck**, origin-direct against the fixture (`test/epik-fixture.json`):
   home 200, a product page 200, a known 301 to the right target, a known 410, a hashed
   asset 200, and `/RELEASE.json` reporting the new `source_sha`.

   The stage-2 measurements forced two changes here, and the first is a bug fix:

   - **The immediate pass is removed.** The previous design ran a healthcheck
     "immediately" after the swap and rolled back on failure. The convergence band
     is 3–8s, so an immediate pass reads a worker that has not flipped yet and
     **rolls back a perfectly good release** — a self-inflicted outage on a healthy
     deploy. Pass 1 moves to **T+15s** (≈2× the top of the measured band) and pass
     2 to **T+45s**.
   - **Unanimity, not a sample.** The lag is per-worker and three worker pids
     served the probe, so one green request proves one worker flipped. Every
     assertion issues **10 requests with a cache-busting query string** and
     requires **all 10** to report the new `source_sha`. Ten requests across a
     small pool still does not prove every worker was hit — a worker that was idle
     during pass 1 is exactly what pass 2 exists to catch.

   **Settle path:** when `RELEASE.json.htaccess_changed` is true, pass 2 moves to
   T+150s and the redirect/410 fixture entries are re-asserted rather than sampled.
   This is the work the `config_release` flag would have gated, taken automatically
   from a fact in the artifact instead of from an operator remembering to pass it.
   The 150s is **margin against an unidentified mechanism** — not, as the previous
   draft had it, against the 120s realpath TTL, which was measured not to govern.
   Margin costs nothing on the one release a year that changes config, and the
   probe established the size of the band without establishing its cause.
8. **Rollback on failure.** Swap `current` back to `prev`, re-run the healthcheck,
   write `status=rolled_back`, exit 1. The failed tree is **kept**, not deleted, so it
   can be inspected.
9. **Status.** Write `_deploy-status.json` into whichever release actually won —
   `{live_sha, prev_sha, health, checked_at, verified_at, message, env}`. Always the
   live tree, so it is honest after a rollback too.

   **`checked_at` and `verified_at` are two different claims and must not be one
   field.** `checked_at` means *the loop ran*: every tick stamps it, including the
   ~287 of 288 daily ticks that find nothing to do (`touch_status()`, which does no
   site request and makes no health claim). `verified_at` means *a verdict about
   health was reached*, and moves only alongside `health` itself.

   The first version had only `checked_at`, and the quiet tick wrote nothing at all.
   With one publish a day that left it untouched for ~23 hours out of 24 while §8.2
   read it as "the cron has stopped running" — so the primary alarm was red almost
   permanently, and a stopped cron was indistinguishable from a quiet one. Split, a
   stale `verified_at` beside a fresh `checked_at` says "running fine, nothing
   deployed lately", which is exactly the state the single field could not express.

   `env` is what converts §3.3's untested assumption into a monitored one. The
   healthcheck fetches a small `_env.php` from inside the live release and records
   what it reports:

   ```json
   "env": { "dir_resolved": true, "release": "<sha>",
            "opcache_enable": "", "opcache_validate_timestamps": "",
            "opcache_introspectable": false, "realpath_cache_ttl": "120" }
   ```

   `dir_resolved` is `__DIR__ === realpath(__DIR__)` — the R1 invariant from §3.2,
   re-checked on the real host on every deploy rather than once in a probe. The
   watchdog (§8) fails on `dir_resolved: false`, and on opcache appearing with
   `validate_timestamps` off, which is the combination under which R1 stops being a
   correctness nicety and becomes the only thing standing between a deploy and
   stale compiled bytes.

   `_env.php` ships in the artifact like any other file, so it reports the release
   it lives in. It exposes no paths beyond the release directory name and no
   configuration beyond the four keys above.
10. **Prune** to **N = 10** releases, never touching `current` or `prev`. The
    provisional 5 was a guess against an unknown budget; the measurement closes it.
    One release is **22,081 inodes** against **910M free**, so ten releases cost
    ~0.02% of the pool. N is therefore set by how far back you might plausibly want
    to roll back, not by space — and 10 nightly prerender commits is a
    week and a half of history.
11. Truncate `log/deploy.log` if it exceeds ~5MB.

## 7. Crontab

```
MAILTO=coby@tiereduptech.com
*/5 * * * * /usr/bin/flock -n /home/tier5415/prb/deploy.lock /home/tier5415/prb/bin/epik-pull.sh >> /home/tier5415/prb/log/deploy.log
```

Note what is **not** redirected: only stdout goes to the log. The script is silent on
stdout for routine work and writes to **stderr only on failure**, so cron mails you
exactly when something broke and never otherwise. `2>&1` would have swallowed that —
it is deliberately absent.

`flock -n` means an overlapping tick **no-ops** rather than queueing — the same reasoning
as `cancel-in-progress: false` in the existing workflow, reached from the other side.
Absolute paths throughout because cPanel cron's environment is minimal.

## 8. Alarms — what you actually see, and where

The docroot assertion refuses to self-repair, so the alarm has to be real. Three
channels, deliberately not all depending on the same thing:

**1. Cron mail — within 5 minutes.** Subject is the cron line, body is the script's
stderr. Covers every pull-side failure: docroot missing, verify failed, healthcheck
failed, rollback taken. Requires nothing but cron. Caveat: shared-host cron mail can be
spam-filtered or silently dropped, which is why it is not the primary.

**2. `epik-watchdog.yml` — scheduled every 30 minutes.** This is the primary, and it is
the direct answer to the sftp-ingest timeout that went unnoticed for a week: a *passive*
signal that only appears when someone looks is not an alarm. The watchdog runs on a
schedule whether or not anyone deployed, fetches `https://prorigbuilder.com/_deploy-status.json`
plus the published `epik-release` `RELEASE.json`, and **fails the workflow** if any of:

  - the status file is unreachable, unparseable, or returns non-200
  - `checked_at` is older than 20 minutes — four missed `*/5` ticks. Every tick stamps it
    (§6.9), so this is the loop itself having stopped, **not** a lack of deploys: the exact
    silent-stall class of failure, now actually detectable
  - `verified_at` is **absent** — that box is running a pre-2026-08-12 `epik-pull.sh`.
    `bin/epik-pull.sh` is a *copy* curl'd at install time, so fixing the repo does not fix
    the box; without this the watchdog would grade a script it did not think it had
  - `health != "ok"`, or `status == "rolled_back"` / `"verify_failed"`. The failure names
    how long ago that verdict was **measured** (`verified_at`), not when the loop last ran

  and **warns**, without failing, if `verified_at` is older than `VERIFY_WARN_MIN` (26h —
  past a full nightly cycle plus margin). Health is only re-measured when something
  happens, so a day-old verdict is the normal steady state; failing on it would rebuild
  the cries-wolf problem the split was made to remove. It also **warns**, without failing,
  when the origin answers with its bot-protection interstitial instead of the status file
  (`blocked` — §8.4): that page is served in front of the box, so the box was never
  measured, and calling it a fault would be the same cries-wolf error.
  - `live_sha != ` the sha currently published on `epik-release` (a deploy that never
    landed, or landed and rolled back)
  - the docroot assertion flag is set
  - `env.dir_resolved` is false — the R1 invariant of §3.2 no longer holds on this
    host, so the resolver's four reads are no longer pinned to one release
  - `env.opcache_enable` has become truthy while `env.opcache_validate_timestamps`
    is off — R1 is now load-bearing under conditions this design has never been
    able to test (§3.3). Not necessarily broken; definitely no longer unexamined.

A failed scheduled workflow sends a GitHub notification by default, and shows as a red
run on the repo. Worst case detection is 30 minutes, with no human in the loop.

**3. CI confirm-poll — immediate, deploy-time only.** Step 8 of the publish job goes red
within ~20 minutes of a merge if the box never confirms. Fast, but only covers failures
that happen to coincide with a deploy — which is why it is the third channel and not the
plan.

Channel 2 is the one that makes the refuse-and-alert choice safe to live with: the site
being down and nobody knowing is what the watchdog exists to prevent.

Worst-case latency: 5 min cron + up to ~5 min of `raw.githubusercontent` CDN cache on
`RELEASE.json` ≈ 10 min from merge to live. If that is too slow, the poll can move to the
GitHub API (`/commits/epik-release`) which is not CDN-cached — at the cost of a 60/hr
unauthenticated rate limit shared across the host's IP.

### 8.4 — Origin bot protection: the shared-hosting constraint on the verification layer

Both remote checks — the watchdog (§8.2) and the confirm-poll (§8, channel 3) — read
`_deploy-status.json` over HTTPS **from a GitHub runner**. Epik's shared hosting sits
behind server-side bot protection that intermittently challenges datacenter IPs, GitHub's
runner ranges among them: instead of the JSON it answers **HTTP 200 with an HTML
interstitial** — a "please wait while your request is being verified" page carrying a
`wsidchk` JavaScript challenge. This is the one shared-hosting fact that reaches directly
into the layer the whole pull design leans on to know the box is alive.

**Why it is not a box fault, and why pinning does not fix it.** The interstitial is served
by a layer *in front of* the release, before the request reaches `_env.php` /
`_deploy-status.json`. The origin pin (`--resolve` to `EPIK_ORIGIN_IP`, §3/§11) forces the
request to the box's IP and so closes the DNS-resolves-to-Railway gap — but the challenge
is served **by that same origin IP**, ahead of the app, so a pinned request is challenged
just the same. This breaks the otherwise-safe inference "pinned, therefore any failure is
the box's". It is the same shape as `hc_verdict()`'s `unverified`: *something else
answered* is not *the box served garbage*.

**What the code now does.** `hc_verdict()` gains a fifth input, `challenged`, and a fourth
verdict, `blocked`, which **outranks the pinned verdict** (`deploy/epik-pull.sh`,
`test/epik-pull.hcverdict.test.sh` invariant 3). All three readers detect the signature
(`wsidchk` / "request is being verified") and treat it as *not a verdict on the box*: the
watchdog warns and stays green instead of failing with "the box did not return its status
file"; the confirm-poll, if the **entire** ~20-min window was challenged and our status
file never once got through, warns and stays green instead of "real failure to confirm";
the box's own `--check`/deploy path returns 3 (could-not-verify), leaving the prior status
untouched. Because both remote checks retry (watchdog every 30 min; confirm-poll 80× over
~20 min), an *intermittent* challenge self-heals — one clear read is enough, and the
production publish did confirm green, so not every request is challenged.

**Residual gap this buys.** Green-on-`blocked` removes the false red, but a *persistent*
challenge would make the watchdog silently stop verifying — it cannot read the status file
at all, so even the `verified_at` staleness guard (§8.2) never fires, because that guard
needs a successful read. A muted alarm is exactly what §8 exists to prevent, so this trade
is only acceptable while the block is intermittent. A durable fix is needed; a
"consecutive-`blocked` runs exceed a threshold → alarm" guard would need cross-run state
the stateless watchdog does not keep today (an artifact or a committed marker), so it is
noted here as the follow-up, not yet built.

**The structural options, assessed.** In rough order of preference:

1. **Exempt the status path from the challenge (preferred).** Serve `_deploy-status.json`
   (and `_env.php`) from a URL rule the bot protection skips. This keeps the pull model
   intact — the check still reads the *real live site*, which is the property the pin was
   added to guarantee. Viability depends on **where** the challenge sits: if it is applied
   at the edge before `.htaccess` runs, an `.htaccess` exclusion cannot reach it and the
   exemption has to be set in the bot-protection control (cPanel / provider UI). Next
   action: from a runner, confirm the challenge fires on these exact paths, then test a
   per-path allowlist in that control.
2. **Whitelist the runner ranges (fragile fallback).** GitHub publishes its Actions egress
   ranges at `api.github.com/meta`, but they are large and rotate without notice, so a
   static cPanel allowlist silently reopens the gap on the next rotation and needs ongoing
   upkeep. It may also not be exposed at all on managed bot protection. Use only if option
   1 is unavailable, and treat it as maintenance debt, not a fix.
3. **Invert to push — box publishes its status somewhere unchallenged (reserve, secondary
   only).** The box already runs cron; it could `PUT`/commit `_deploy-status.json` to a
   place the runner reads without touching Epik (a private gist, a status branch via the
   GitHub API, an object store). This sidesteps the challenge entirely. **But** the checks
   would then verify what the box *claims*, read from GitHub, not what the public site
   *serves* — which reopens the very "measured the wrong thing" gap the pinned read closed
   (a box can report `ok` while the live site serves something else). So this is a good
   *second* heartbeat for loop-liveness, and it adds an outbound credential to the box, but
   it must not become the sole health signal.

Recommendation: ship the detection above now (done — it stops the false red immediately),
pursue **option 1** as the real fix, and keep **option 3** only as a supplementary
liveness channel. Revisit the persistent-block guard if blocks stop being intermittent.

## 9. Transport: tarball, not shallow fetch — DECIDED

**Decision taken 2026-08-12: tarball. Since measured, and the measurement agrees.**
This was first recorded as a judgment call with nothing behind it, because the
transport bake-off was in the probe stage that got cut. The numbers have since
arrived and point the same way:

| transport | size | time |
|---|---|---|
| `git clone --depth 1` | 633M (584M tree + 49M `.git`) | 17s |
| codeload tarball | **95M** | **13s** |

6.7× smaller and faster, so the "what would still flip it" clause below is not
close to being met. `git ls-remote` at 266–419ms also confirms the cheap-poll
fallback in §8 is viable if `raw.githubusercontent`'s CDN cache proves too slow.

The reasoning, unchanged and now corroborated:

- **Integrity is transport-independent.** `sha256sum -c MANIFEST.sha256` validates what
  actually landed on disk, per file, with loud per-file failures — which was your stated
  criterion. A git fetch would need the same check anyway.
- **No object store on the box.** Shallow fetches into a persistent repo accumulate
  objects from every release and eventually need `gc` or a re-clone. That is ongoing
  operational surface for no benefit here.
- **No git dependency**, and the orphan force-push pattern gives git little delta reuse
  to work with in any case.

Atomicity is identical either way — both end in `mv -T` of a fully-materialized tree.

What would still flip it: the artifact being large enough that a full transfer per deploy
is painful *and* a shallow fetch demonstrably transferring materially less.

## 10. Measurements — taken 2026-08-12

**Host capability.** All read-only, none touched the docroot:

- `git`, `curl`, `flock`, `tar`, `sha256sum`, `timeout`, `node`, `php` — all present
  - **present is not capable.** This probe recorded that `curl` exists and stopped
    there, so a `curl` predating `--etag-save` (7.68, 2020) was not discovered until a
    cron tick failed with `curl exited 2 — option --etag-save: is unknown` (2026-08-12).
    `install-phase-a.sh` now prints and floor-checks `curl --version` and prints
    `$BASH_VERSION` in preflight. Record the VERSION of anything a script depends on a
    recent feature of — or depend only on features old enough not to ask.
  - **present is not the same as on PATH.** `node` was recorded present here — but that
    was measured in an INTERACTIVE shell, where nvm's shell hook has already put
    `~/.nvm/versions/node/*/bin/node` on PATH. Under cron the environment is only
    `/usr/local/bin:/usr/bin:/bin`, that hook never runs, and a bare `node` is not found.
    epik-pull.sh's first `node` call (`jget` for `source_sha`) then failed under `set -e`
    BEFORE any log line reached deploy.log, so the tick exited 0 with an empty log and a
    frozen `checked_at` — indistinguishable from cron not firing at all (2026-08-12). Same
    class of error as the curl one above: the probe measured the interactive shell and
    reported it as "the host". epik-pull.sh now resolves ONE absolute interpreter loudly
    (`resolve_node()` — nvm globbed newest-first, then a config `NODE=` recorded by
    install-phase-a, then fixed system paths) and refuses to run blind if none resolves.
- disk: ample free space, **910M free inodes**
- one `dist/` tree = **22,081 inodes** → sets N in §6.10
- `git clone --depth 1`: 17s, 584M tree + 49M `.git`
- codeload tarball: 13s, 95M → §9
- `git ls-remote` ×3: 419 / 266 / 417 ms

`node` being **installed** settles the open question in the old version of this section:
the healthcheck **reuses `test/verify-epik.cjs`** driven by the existing fixture,
rather than needing a bash reimplementation that would drift from it. What "present" did
NOT settle — and the sub-bullet above is the scar — is that a bare `node` resolves for
whatever cron runs. It does not. Anything cron invokes must reach the interpreter by
absolute path, never by name.

22,081 inodes per release also means a per-file copy deploy is slow, which is an
independent argument for the symlink swap the design was already built on.

**PHP behaviour.** See §2, stage 2, and `deploy/probe-php-dir.sh`. The `__DIR__`
micro-probe this section used to call for came back **YES** — and two of the three
claims the previous §3 built around it did not survive contact:

| claim | outcome |
|---|---|
| `__DIR__` is the resolved release path | **confirmed** — §3.2 rests on it |
| a stable-path resolver costs 120s of staleness | **refuted** — it flipped at 4s |
| per-release paths make opcache staleness impossible | **untestable here** — §3.3 |

The pattern is worth naming, because it is the same one that produced the
`.htaccess` skew surprise in stage 1: every claim that was *reasoned from
documented behaviour* was wrong or unverifiable, and the only one that held was
the one that was *measured directly*. §3 is now written so that its load-bearing
argument (mid-request atomicity) needs no cache behaviour to be true at all.

## 11. Cutover

- **Phase A** — stand up pull on **staging** only, alongside the existing SFTP-to-prod.
  Run it through a week of real nightly prerender commits. **Re-measure the
  convergence band before leaving Phase A:** the 3–8s figure comes from a staging
  docroot served by a three-worker pool, and a busier production pool is more
  independent caches to converge. The T+15s in §6.7 is sized against that band, so
  if the band moves, that number moves with it.
- **Phase B** — create `~/public_html -> ~/prb/current` by hand, once. Flip Cloudflare
  from Railway to Epik. **Between those two, the hostname is not evidence about this
  box** — it still answers from Railway. Everything in that window is checked against
  the origin directly: `ORIGIN_IP` in the config pins `epik-pull.sh`'s healthcheck with
  `curl --resolve`, `<BASE>_RESOLVE` pins the fixture harness, and the CP-1…CP-5
  sequence in `PHASE-B-INSTALL.md` §5 is that check by hand. Unpinned and answered by
  another stack, the healthcheck reports exit 3 "could not verify" — it does not
  manufacture a fault out of a DNS record (`hc_verdict()`).
- **Phase C** — keep `deploy-epik.yml` in the repo but disabled, as break-glass.
- **Phase D** — delete the SFTP path and its secrets after two clean weeks.

**Cloudflare.** Prod is currently proxied to Railway; staging is grey-cloud to
66.223.49.32. At Phase B, decide deliberately whether prod stays proxied. My inclination
is to keep it proxied but ensure origin `Cache-Control` is respected — `.htaccess`
already sets `must-revalidate` on HTML and `immutable` on hashed assets, so the 410/301
responses pass through intact. Two things need `no-store` regardless:
`_deploy-status.json` and `RELEASE.json`, or CI's confirm-poll reads a cached answer.
Also confirm Epik holds a valid cert for `prorigbuilder.com` before considering
Full (Strict) — AutoSSL's DNS validation currently resolves to Railway.

## 12. Risks

| Risk | Handling |
|---|---|
| `.htaccess` gains per-release data | R2 warns loudly and flips the artifact onto the settle path automatically |
| Config release genuinely needed | No flag to remember — `htaccess_changed` in the artifact drives it |
| Cron stops running entirely | Watchdog fails on a `checked_at` older than 20 min — every tick stamps it, so this detects the loop stopping rather than a quiet day (§6.9, §8.2) |
| A box keeps running an old `epik-pull.sh` after the repo is fixed | `bin/` holds a *copy*; the watchdog fails on a missing `verified_at` and prints the re-curl command (§8.2) |
| Docroot recreated by cPanel | Refuse-and-alert: cron mail ≤5 min, watchdog ≤30 min |
| Mixed-release read inside one request | Structurally impossible under R1 — `__DIR__` measured resolved, no cache involved (§3.2) |
| opcache active on a future host or after a PHP-version change | Untested, so detected rather than assumed: `env` in `_deploy-status.json` + watchdog (§3.3, §6.9, §8) |
| Healthcheck samples one stale worker and passes | 10-request unanimity per assertion; second pass at T+45s covers a worker idle during the first (§6.7) |
| A healthy release rolled back by a too-early check | The immediate pass is removed — it ran inside the measured 3–8s band (§6.7) |
| opcache entries accumulate one set per release path | ~4 PHP files per deploy against a 10k default `max_accelerated_files`; years of headroom, and evicted on restart |
| cPanel recreates `public_html` | Detected, alarmed, never auto-repaired |
| Inode quota exhaustion | Retention N=10, set from the §10 measurement: 22,081 inodes/release against 910M free |
| Partial download or extraction | Verified before naming; swapped only after `mv -T` |
| Two crons overlapping | `flock -n` no-op |
| Bad release reaches live | Two-pass healthcheck + automatic rollback to `prev` |
| Silent failure | CI confirm-poll goes red on timeout |
| Origin bot protection challenges the runner (`wsidchk` interstitial) | Detected and read as `blocked`, not a box fault — watchdog and confirm-poll warn and stay green, box returns exit 3 (§8.4). Intermittent challenges self-heal on retry; a *persistent* block is a residual coverage gap needing the option-1 path exemption (§8.4) |
