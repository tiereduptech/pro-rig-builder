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

`prorigbuilder.com` resolves to Railway until step 8. Every check below therefore
pins the connection to the box with `--resolve` and skips cert validation with
`-k` — the origin's AutoSSL cert for this name is validated against Railway, so
it is not expected to validate here yet (CP-5 measures exactly that, and it is a
Cloudflare Full-Strict blocker, not a serving one).

**A hostname check is not an origin check.** The post-flip healthcheck learned
this the hard way: it curled the hostname, got Railway's HTML, and reported the
flip as unhealthy. `epik-pull.sh` now takes `ORIGIN_IP` and pins the same way,
and returns exit **3 = could not verify** rather than inventing a fault
(`hc_verdict()`, truth table in `test/epik-pull.hcverdict.test.sh`).

```sh
ORIGIN=66.223.49.32
HOST=prorigbuilder.com
C="curl -sS -k --resolve $HOST:443:$ORIGIN"
```

### CP-1 — the origin serves the intended release, on every worker

```sh
cat ~/prb/current/RELEASE.json                       # what the box has staged
$C https://$HOST/RELEASE.json                        # what the box SERVES
WANT=$(node -e 'console.log(require(process.env.HOME+"/prb/current/RELEASE.json").source_sha)')
for i in $(seq 1 10); do $C "https://$HOST/_env.php?cb=$i"; echo; done \
  | tee /tmp/cp1.txt | grep -c "\"release\":\"$WANT\""    # must be 10
grep -c '"dir_resolved":true' /tmp/cp1.txt               # must be 10 (R1, DESIGN §3.2)
```

Ten requests, not one: the convergence band is per worker. `dir_resolved:false`
on any of them is a correctness failure, not a timing one.

### CP-2 — routing and status parity (the 15-case fixture, direct)

The fixture ships inside the release. Drive it with curl rather than
`_ops/verify-epik.cjs`, because the copy in a release published before
`EPIK_RESOLVE` existed silently follows DNS — i.e. it would grade Railway.

```sh
node -e '
  const cs=require(process.env.HOME+"/prb/current/_ops/epik-fixture.json").cases;
  console.log(cs.map(c=>[c.path,c.status,c.expectLocation||"",
    (c.expectHeader&&c.expectHeader["X-Robots-Tag"])||""].join("\t")).join("\n"));
' > /tmp/cases.tsv

fail=0
while IFS=$'\t' read -r p want loc robots; do
  h=$(mktemp)
  code=$($C -o /dev/null -D "$h" -w '%{http_code}' "https://$HOST$p")
  gl=$(awk 'tolower($1)=="location:"{print $2}' "$h" | tr -d '\r' | sed 's#^https\?://[^/]*##')
  gr=$(awk 'tolower($1)=="x-robots-tag:"{sub(/^[^:]*:[ ]*/,"");print}' "$h" | tr -d '\r')
  ok=ok
  [ "$code" = "$want" ] || ok="BLOCKER status=$code want=$want"
  [ -z "$loc" ] || [ "$gl" = "$loc" ] || ok="$ok BLOCKER location=$gl want=$loc"
  [ -z "$robots" ] || case "$gr" in *"$robots"*) ;; *) ok="$ok BLOCKER robots=$gr want=$robots";; esac
  [ "$ok" = ok ] || fail=$((fail+1))
  printf '%-8s %-70s %s\n' "$code" "$p" "$ok"
  rm -f "$h"
done < /tmp/cases.tsv
echo "CP-2 blockers: $fail"      # must be 0
```

### CP-3 — what the pages actually render (the prerender gate, over the wire)

`verify-prerender.cjs` asserts these five on `dist/` in CI. CP-3 asserts them on
what the origin **serves**, which is the claim that matters after a flip.

```sh
# PRODUCT pages only — the same sitemap carries /parts/<cat> category indexes,
# which legitimately have no Product JSON-LD and would read as false blockers.
for u in $($C https://$HOST/sitemap.xml \
            | grep -oE "https://$HOST/parts/[a-z0-9-]+/[a-z0-9-]+-[0-9]{4,}" | shuf -n 20); do
  p=${u#https://$HOST}
  f=$(mktemp); $C "https://$HOST$p" -o "$f"
  t=$(grep -o '<title[ >]' "$f" | wc -l)
  o=$(grep -o 'property="og:title"' "$f" | wc -l)
  c=$(grep -o 'rel="canonical"' "$f" | wc -l)
  href=$(grep -o '<link[^>]*rel="canonical"[^>]*>' "$f" | grep -o 'href="[^"]*"' | head -1 | cut -d'"' -f2)
  bad=""
  grep -qi 'content="noindex"' "$f" && bad="$bad noindex"
  grep -q  'name="robots" content="index' "$f" || bad="$bad no-index-directive"
  { [ "$t" = 1 ] && [ "$o" = 1 ] && [ "$c" = 1 ]; } || bad="$bad head-tags(t=$t,og=$o,canon=$c)"
  [ "$href" = "$u" ] || bad="$bad canonical($href)"
  grep -qE '"@type" *: *"Product"' "$f" || bad="$bad no-product-jsonld"
  grep -qEi 'Skip the shop visit|Product Not Found' "$f" && bad="$bad SHELL-LEAK"
  [ "$(wc -c < "$f")" -ge 30000 ] || bad="$bad thin($(wc -c < "$f")B)"
  printf '%-6s %s%s\n' "$([ -z "$bad" ] && echo ok || echo BLOCK)" "$p" "$bad"
  rm -f "$f"
done
```

Any `noindex` here is the failure mode that cost ~10 days of product indexing in
July — it is the one line in this file to read first.

### CP-4 — production is unauthenticated and exposes nothing

```sh
$C -o /dev/null -w 'GET /            -> %{http_code}  (200, NOT 401)\n' https://$HOST/
$C -o /dev/null -w 'GET /_ops/fixture-> %{http_code}  (403)\n'          https://$HOST/_ops/epik-fixture.json
$C -o /dev/null -w 'GET /_ops/verify -> %{http_code}  (403)\n'          https://$HOST/_ops/verify-epik.cjs
$C -o /dev/null -w 'GET /.htpasswd   -> %{http_code}  (403 or 404)\n'   https://$HOST/.htpasswd
$C https://$HOST/robots.txt | head -20        # no blanket "Disallow: /"
grep -c PRB-STAGING-GUARD ~/prb/current/.htaccess          # 0
grep -Eci '^[[:space:]]*(AuthType|AuthUserFile|Require[[:space:]]+valid-user)' ~/prb/current/.htaccess   # 0
ls -A ~/prb/secrets                                        # empty
```

A 401 anywhere here means a staging artifact reached the production tree.

### CP-5 — cache headers, and the cert Cloudflare will judge

```sh
$C -I https://$HOST/_deploy-status.json | grep -i '^cache-control'   # must be no-store
$C -I https://$HOST/RELEASE.json        | grep -i '^cache-control'   # must be no-store
$C -I https://$HOST/                    | grep -i '^cache-control'   # must-revalidate
asset=$($C https://$HOST/ | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1)
$C -I "https://$HOST$asset"             | grep -i '^cache-control'   # immutable

# The cert, WITHOUT -k — this is allowed to fail today, and what it says matters.
curl -sS --resolve $HOST:443:$ORIGIN -o /dev/null -w '%{http_code}\n' https://$HOST/ \
  || echo "cert does not validate for $HOST at the origin (expected pre-cutover)"
curl -sSv --resolve $HOST:443:$ORIGIN https://$HOST/ -o /dev/null 2>&1 \
  | grep -E 'subject:|issuer:|expire date|SSL certificate'
```

Without `no-store` on the first two, CI's confirm-poll reads a cached answer and
reports a deploy that did not happen (DESIGN §11). Without a valid origin cert
for this name, Cloudflare **Full (Strict)** cannot be turned on at step 8 — fix
the cert before choosing the SSL mode, not after.

### Gate

CP-1…CP-4 clean is what DNS moving is conditional on. CP-5's cert line is allowed
to be red before cutover; its cache lines are not.

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
