#!/bin/bash
# =============================================================================
#  epik-pull.sh — pull-based deploy for prorigbuilder.com on the Epik host.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  The host firewalls INBOUND connections, so CI cannot reach us. CI publishes a
#  single-commit orphan branch; this script pulls it over outbound 443, verifies
#  it completely BEFORE anything is swapped, flips one symlink, proves the site
#  is healthy, and rolls back if it is not. Nothing ever connects in.
#
#  Full design + the measurements behind every number here:
#    deploy/DESIGN-pull-deploy.md
#
#  THREE NUMBERS THAT ARE NOT ARBITRARY (probe, 2026-08-12):
#    - the post-swap convergence band is 3-8s and it is PER WORKER, not per
#      request. So there is no immediate healthcheck: pass 1 is at T+15s (~2x the
#      top of the band). An immediate pass reads a not-yet-flipped worker and
#      rolls back a perfectly good release. (§6.7)
#    - one green request proves ONE worker flipped. Every assertion therefore
#      needs unanimity across HC_REQUESTS requests. (§6.7, unanimous())
#    - the settle path waits T+150s, as margin against an UNIDENTIFIED mechanism.
#      The 120s realpath TTL the first draft cited was measured not to govern.
#
#  This script never moves, renames, or deletes a live directory. If the docroot
#  symlink is wrong it refuses and alarms rather than repairing (§6.1) — the
#  alarm is cron mail + epik-watchdog.yml, not "someone notices".
#
#  MODES
#    (none)       routine tick. Cheap poll; exits 0 silently if nothing changed.
#    --bootstrap  first install: fetch + verify + create `current`, WITHOUT the
#                 docroot assertion and WITHOUT a healthcheck, because nothing is
#                 serving the tree yet. The operator flips the docroot after.
#    --check      healthcheck the current live release and rewrite the status
#                 file. No fetching, no swapping. Safe to run any time.
#    --force      ignore the sha short-circuit and redeploy the published
#                 release even if it matches what is already live.
#
#  CURL FLOOR. The box's curl rejected --etag-save/--etag-compare (7.68+, 2020)
#  outright: "option --etag-save: is unknown", exit 2, before a packet moved.
#  Every curl option used below has existed since 7.12.3 (2004): -sS -o -u -L
#  --fail --connect-timeout --max-time --retry --retry-delay -w '%{http_code}'.
#  Do not add a newer one without checking `curl --version` ON THE BOX first.
# =============================================================================
set -euo pipefail
umask 022
export PATH=/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}

MODE=routine
for a in "$@"; do
  case "$a" in
    --bootstrap) MODE=bootstrap ;;
    --check)     MODE=check ;;
    --force)     MODE=force ;;
    *) echo "epik-pull: unknown argument '$a'" >&2; exit 2 ;;
  esac
done

# The script finds its own install root, so ONE copy of this file serves both the
# staging and the production install with no per-target edits:
#   ~/prb-staging/bin/epik-pull.sh -> root ~/prb-staging
#   ~/prb/bin/epik-pull.sh         -> root ~/prb
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/config"
if [ ! -r "$CONFIG" ]; then
  echo "epik-pull: missing config at $CONFIG" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$CONFIG"

: "${REPO:?config must set REPO}"
: "${BRANCH:?config must set BRANCH}"
: "${SITE_URL:?config must set SITE_URL}"
: "${DOCROOT:?config must set DOCROOT}"
RETAIN="${RETAIN:-10}"
EXPECT_GUARD="${EXPECT_GUARD:-0}"
HC_REQUESTS="${HC_REQUESTS:-10}"
SITE_URL="${SITE_URL%/}"

STATE="$ROOT/state"; RELDIR="$ROOT/releases"; TMP="$ROOT/tmp"; LOGDIR="$ROOT/log"
mkdir -p "$STATE" "$RELDIR" "$TMP" "$LOGDIR"

ts()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s %s\n' "$(ts)" "$*"; }                    # stdout -> deploy.log
err() { printf '%s ERROR %s\n' "$(ts)" "$*" >&2; }          # stderr -> cron MAIL

# Two arrays, deliberately. BASIC_AUTH is the STAGING site credential; sending it
# to raw.githubusercontent.com / codeload would hand our password to a third party
# for no reason. The release branch is public by design (§2) — GitHub gets no -u.
CURL_BASE=(curl -sS --connect-timeout 10 --max-time 30 --retry 2 --retry-delay 3)
SITE_CURL=("${CURL_BASE[@]}")
if [ -n "${BASIC_AUTH:-}" ]; then SITE_CURL+=(-u "$BASIC_AUTH"); fi
site_get() { "${SITE_CURL[@]}" "$SITE_URL$1"; }

# curl exit codes, spelled out. "HTTP 000" means the request never completed, so
# the HTTP status is the one thing that CANNOT explain it — the exit code can.
# A fetch failure that reports nothing actionable is a second bug on top of the first.
curl_why() {
  case "$1" in
    0)  echo "no error" ;;
    2)  echo "curl could not parse its command line — almost always an option THIS curl is" \
             "too old to know. Run 'curl --version' on the box and read the flag it names" \
             "in the message below; nothing was ever sent" ;;
    3)  echo "malformed URL" ;;
    6)  echo "could not resolve host (DNS)" ;;
    7)  echo "could not connect — refused, or outbound 443 is firewalled" ;;
    22) echo "server returned an HTTP error and --fail was set" ;;
    23) echo "write error — the -o path is not writable" ;;
    26) echo "read error — curl could not read a local file it was told to use" ;;
    28) echo "timed out (--connect-timeout/--max-time)" ;;
    35) echo "TLS handshake failed" ;;
    56) echo "failure receiving data" ;;
    60) echo "server certificate not trusted" ;;
    77) echo "CA certificate bundle missing or unreadable" ;;
    *)  echo "see EXIT CODES in 'man curl'" ;;
  esac
}

# fetch <url> <outfile> <label> [extra curl args...]
#   stdout: the HTTP status code.  return: 0 if curl itself completed.
# Extra args come AFTER the base array, so a caller can override a base option
# (curl takes the last occurrence) — that is how the tarball gets its own timeout.
# The args are assembled into ONE array rather than expanding "$@" inline: bash
# 4.3 and older (CentOS 7 ships 4.2) treat "$@" as an unset variable under
# `set -u` when there are no positional parameters, so the zero-extra-arg caller
# below would die on the expansion itself.
fetch() {
  local url="$1" out="$2" label="$3"; shift 3
  local code rc=0 elog="$TMP/curl.$label.err"
  local args=("${CURL_BASE[@]}")
  if [ "$#" -gt 0 ]; then args+=("$@"); fi
  args+=(-w '%{http_code}' -o "$out" "$url")
  : > "$elog"
  code="$("${args[@]}" 2>"$elog")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    err "$label: curl exited $rc — $(curl_why "$rc")"
    err "  url: $url"
    if [ -s "$elog" ]; then
      sed 's/^/  curl: /' "$elog" >&2 || true
    else
      err "  curl wrote nothing to stderr"
    fi
    return 1
  fi
  printf '%s' "${code:-000}"
  return 0
}

# node is confirmed present on this host (DESIGN §10) and is the only sane way to
# parse JSON here — jq is not guaranteed.
jget() {
  node -e '
    const fs=require("fs");
    let o; try { o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch(e) { process.exit(3); }
    const v=process.argv[2].split(".").reduce((a,k)=>(a==null?a:a[k]),o);
    process.stdout.write(v==null?"":String(v));
  ' "$1" "$2"
}

read_state() { cat "$STATE/$1" 2>/dev/null || true; }

# ── status: the site IS the status channel ──────────────────────────────────
# Written into whichever release actually WON, so it stays honest after a
# rollback. `env` is what turns §3.3's untested opcache assumption into a
# monitored one — epik-watchdog.yml asserts on it every 30 minutes.
write_status() {
  local health="$1" msg="$2" live_dir envjson
  live_dir="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
  if [ -z "$live_dir" ] || [ ! -d "$live_dir" ]; then return 0; fi
  envjson="$(site_get "/_env.php?cb=$$" 2>/dev/null || true)"
  if [ -z "$envjson" ]; then envjson='{}'; fi
  LIVE_SHA="$(read_state live.sha)" PREV_SHA="$(read_state prev.sha)" \
  HEALTH="$health" MSG="$msg" ENVJSON="$envjson" TARGET_BRANCH="$BRANCH" \
  node -e '
    let env={}; try { env=JSON.parse(process.env.ENVJSON||"{}"); }
    catch(e) { env={parse_error:true, raw:(process.env.ENVJSON||"").slice(0,200)}; }
    process.stdout.write(JSON.stringify({
      live_sha:   process.env.LIVE_SHA || null,
      prev_sha:   process.env.PREV_SHA || null,
      branch:     process.env.TARGET_BRANCH,
      health:     process.env.HEALTH,
      message:    process.env.MSG,
      checked_at: new Date().toISOString(),
      env,
    }, null, 1) + "\n");
  ' > "$live_dir/_deploy-status.json.tmp"
  mv -f "$live_dir/_deploy-status.json.tmp" "$live_dir/_deploy-status.json"
}

fail() {   # loud, mailed by cron, status recorded on the live tree
  local health="$1"; shift
  err "$*"
  write_status "$health" "$*" || true
  exit 1
}

# ── healthcheck ─────────────────────────────────────────────────────────────
# unanimous(): the convergence band is per-worker, so this is the whole point.
# _env.php reports the release from ITS OWN __DIR__, so N requests sample N
# (possibly repeated) workers. Unanimity over HC_REQUESTS is not proof the whole
# pool flipped — a worker idle during pass 1 is exactly what pass 2 catches.
unanimous() {
  local want="$1" i r bad=0 unresolved=0
  for i in $(seq 1 "$HC_REQUESTS"); do
    r="$(site_get "/_env.php?cb=$$.$i" 2>/dev/null || true)"
    case "$r" in
      *'"dir_resolved":false'*) unresolved=$((unresolved + 1)) ;;
    esac
    case "$r" in
      *"\"release\":\"$want\""*) ;;
      *) bad=$((bad + 1)) ;;
    esac
  done
  if [ "$unresolved" -gt 0 ]; then
    err "R1 INVARIANT BROKEN: _env.php reports dir_resolved=false on $unresolved/$HC_REQUESTS requests."
    err "  __DIR__ is no longer the resolved release path, so resolver.php's four reads are not pinned"
    err "  to one release (DESIGN §3.2). This is a correctness failure, not a timing one."
    return 1
  fi
  if [ "$bad" -gt 0 ]; then
    err "worker pool not converged: $bad/$HC_REQUESTS requests did not report release=$want"
    return 1
  fi
  return 0
}

# The fixture harness ships inside the release (_ops/), so the box verifies
# itself with the exact code and fixture CI runs — no bash twin to drift.
run_fixture() {
  local dir="$1"
  if [ ! -f "$dir/_ops/verify-epik.cjs" ]; then
    err "release $dir has no _ops/verify-epik.cjs — cannot verify"
    return 1
  fi
  EPIK_BASIC_AUTH="${BASIC_AUTH:-}" node "$dir/_ops/verify-epik.cjs" epik="$SITE_URL"
}

healthcheck() {   # $1 = expected sha, $2 = label
  local want="$1" label="$2" out
  say "healthcheck ($label)"
  if ! unanimous "$want"; then return 1; fi
  out="$TMP/fixture.$label.out"
  if ! run_fixture "$RELDIR/$want" > "$out" 2>&1; then
    err "fixture FAILED ($label):"
    sed 's/^/    /' "$out" >&2 || true
    return 1
  fi
  say "  ok — $HC_REQUESTS/$HC_REQUESTS workers on $want, fixture clean"
  return 0
}

# ── 1. docroot assertion — refuse, never repair ─────────────────────────────
assert_docroot() {
  local want="$ROOT/current" got
  got="$(readlink "$DOCROOT" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    err "DOCROOT ASSERTION FAILED"
    err "  $DOCROOT -> '${got:-<not a symlink>}'"
    err "  expected  '$want'"
    err "  cPanel may have recreated it, or someone changed it. NOT repairing: auto-repair means"
    err "  moving or deleting a live directory, which this design never does (§6.1). Fix by hand."
    write_status "docroot_assertion_failed" "docroot is '${got:-not a symlink}', expected '$want'" || true
    exit 1
  fi
}

# ── --check: healthcheck the live release, rewrite status, exit ─────────────
if [ "$MODE" = check ]; then
  assert_docroot
  LIVE="$(read_state live.sha)"
  if [ -z "$LIVE" ]; then fail "unknown" "--check: no state/live.sha — nothing has been deployed yet"; fi
  if healthcheck "$LIVE" "check"; then
    write_status ok "manual --check passed"
    say "check ok ($LIVE)"
    exit 0
  fi
  fail "unhealthy" "--check failed for $LIVE"
fi

if [ "$MODE" != bootstrap ]; then assert_docroot; fi

# ── 2. cheap poll — ~287 of 288 daily ticks stop here, silently ─────────────
RAW="https://raw.githubusercontent.com/$REPO/$BRANCH"
RJ="$TMP/RELEASE.json"
# UNCONDITIONAL GET, deliberately. This used to be a conditional GET with
# --etag-save/--etag-compare, which the box's curl does not have (7.68+, 2020) —
# it exited 2 at argument parsing every tick, so the poll never ran at all.
#
# Removing it costs nothing worth having. RELEASE.json is ~380 bytes and this
# runs every 5 minutes: 288 GETs/day of a file smaller than the request headers
# that ask for it. And the etag was never the decision — `source_sha` vs
# state/live.sha, ten lines down, is what actually says deploy-or-not, and it
# stays correct across a re-published identical sha, a rolled-back box, and a
# GitHub CDN that changes an etag without changing a byte. A 304 was only ever a
# cheaper way to reach the same answer.
CODE="$(fetch "$RAW/RELEASE.json" "$RJ" "poll")" \
  || fail "poll_failed" "could not fetch $RAW/RELEASE.json — curl detail above"
if [ "$CODE" != 200 ]; then
  fail "poll_failed" "could not fetch $RAW/RELEASE.json (HTTP $CODE)"
fi

SHA="$(jget "$RJ" source_sha)"
if [ -z "$SHA" ]; then fail "poll_failed" "published RELEASE.json has no source_sha"; fi
LIVE_NOW="$(read_state live.sha)"
if [ "$SHA" = "$LIVE_NOW" ] && [ "$MODE" != force ]; then exit 0; fi

HT_CHANGED="$(jget "$RJ" htaccess_changed)"
say "new release $SHA (live: ${LIVE_NOW:-none}, htaccess_changed=${HT_CHANGED:-false})"

# ── 3. fetch ────────────────────────────────────────────────────────────────
TGZ="$TMP/$SHA.tgz"
NEW="$RELDIR/$SHA.tmp"
rm -rf "$NEW"; mkdir -p "$NEW"
# --fail so a 404/500 HTML body is never handed to tar as if it were a tarball,
# and its own --max-time: the base 30s is sized for a 2KB RELEASE.json, not for
# a 16k-file archive over a shared host's uplink. Extra args win over the base.
TARURL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
if ! TCODE="$(fetch "$TARURL" "$TGZ" "tarball" -L --fail --max-time 300)"; then
  rm -rf "$NEW" "$TGZ"; fail "fetch_failed" "tarball download failed for $BRANCH — curl detail above"
fi
if [ "$TCODE" != 200 ]; then
  rm -rf "$NEW" "$TGZ"; fail "fetch_failed" "tarball download for $BRANCH returned HTTP $TCODE"
fi
if ! tar -xzf "$TGZ" -C "$NEW" --strip-components=1; then
  rm -rf "$NEW" "$TGZ"; fail "fetch_failed" "tarball extraction failed for $SHA"
fi
rm -f "$TGZ"

# ── 4. verify EVERYTHING before anything is swapped ─────────────────────────
# Any failure here deletes the .tmp tree and exits. Nothing was swapped, so the
# live site was never at risk.
verify_fail() { rm -rf "$NEW"; fail "verify_failed" "$*"; }

if ! ( cd "$NEW" && sha256sum -c --quiet MANIFEST.sha256 ) > "$TMP/manifest.out" 2>&1; then
  err "manifest mismatch — per-file failures:"
  sed 's/^/    /' "$TMP/manifest.out" >&2 || true
  verify_fail "MANIFEST.sha256 verification failed for $SHA"
fi

WANT_MS="$(jget "$NEW/RELEASE.json" manifest_sha256)"
GOT_MS="$(sha256sum "$NEW/MANIFEST.sha256" | cut -d' ' -f1)"
if [ "$WANT_MS" != "$GOT_MS" ]; then
  verify_fail "manifest_sha256 mismatch: RELEASE.json says $WANT_MS, file is $GOT_MS"
fi

for f in index.html resolver.php resolver-config.php redirects.php gone.html .htaccess _env.php; do
  if [ ! -f "$NEW/$f" ]; then verify_fail "required file missing from artifact: $f"; fi
done

# Guard, asserted in BOTH directions. A production artifact carrying the sentinel
# would 401 the live site; a staging artifact that LOST it is publicly crawlable.
if [ "$EXPECT_GUARD" = "1" ]; then
  if ! grep -q 'PRB-STAGING-GUARD' "$NEW/.htaccess"; then
    verify_fail "staging artifact is MISSING its Basic-Auth guard — refusing to serve it crawlable"
  fi
else
  if grep -q 'PRB-STAGING-GUARD' "$NEW/.htaccess"; then
    verify_fail "production artifact carries the staging guard sentinel"
  fi
fi
if find "$NEW" -name '.htpasswd' | grep -q .; then
  verify_fail "artifact contains a .htpasswd — the release branch is public, this must never ship"
fi

# ── 5. name it — a half-extracted tree can never be swapped to, because it does
#       not have its final name until it is complete ─────────────────────────
FINAL="$RELDIR/$SHA"
rm -rf "$FINAL"
mv -T "$NEW" "$FINAL" 2>/dev/null || {
  rm -rf "$NEW"
  fail "verify_failed" "mv -T unavailable — refusing a non-atomic rename. Atomicity is the whole design."
}
say "verified + staged $SHA ($(jget "$FINAL/RELEASE.json" file_count) files)"

if [ "$MODE" = bootstrap ]; then
  ln -sfn "$FINAL" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"
  printf '%s\n' "$SHA" > "$STATE/live.sha"
  say "BOOTSTRAPPED: $ROOT/current -> releases/$SHA"
  say "Nothing is serving this yet. Flip the docroot by hand, then run: $0 --check"
  exit 0
fi

# ── 6. swap ─────────────────────────────────────────────────────────────────
PREV_DIR="$(readlink "$ROOT/current" 2>/dev/null || true)"
PREV_SHA="$LIVE_NOW"
ln -sfn "$FINAL" "$ROOT/current.tmp"
mv -T "$ROOT/current.tmp" "$ROOT/current"
printf '%s\n' "$SHA" > "$STATE/live.sha"
if [ -n "$PREV_SHA" ]; then printf '%s\n' "$PREV_SHA" > "$STATE/prev.sha"; fi
say "swapped current -> releases/$SHA"

# ── 7. healthcheck: NO immediate pass (it would run inside the 3-8s band) ───
PASS2_AT=45
if [ "$HT_CHANGED" = "true" ]; then
  PASS2_AT=150
  say "htaccess_changed=true — taking the settle path (pass 2 at T+${PASS2_AT}s)"
fi

rollback() {
  local why="$1"
  if [ -z "$PREV_DIR" ] || [ ! -d "$PREV_DIR" ]; then
    err "ROLLBACK IMPOSSIBLE — no previous release to return to."
    err "  The failed tree is KEPT at $FINAL for inspection."
    write_status "failed" "$why; no previous release to roll back to" || true
    exit 1
  fi
  err "rolling back to $(basename "$PREV_DIR")"
  ln -sfn "$PREV_DIR" "$ROOT/current.tmp"
  mv -T "$ROOT/current.tmp" "$ROOT/current"
  printf '%s\n' "$PREV_SHA" > "$STATE/live.sha"
  # The failed tree is KEPT, not deleted, so it can be inspected.
  sleep 15
  if healthcheck "$PREV_SHA" "post-rollback"; then
    write_status "rolled_back" "$why; rolled back to $PREV_SHA and it is healthy"
    err "rolled back to $PREV_SHA — site healthy. Failed tree kept at $FINAL"
  else
    write_status "rolled_back" "$why; rolled back to $PREV_SHA but IT IS ALSO UNHEALTHY"
    err "ROLLED BACK AND STILL UNHEALTHY — the site needs a human now."
  fi
  exit 1
}

sleep 15
if ! healthcheck "$SHA" "T+15s"; then
  rollback "healthcheck failed at T+15s"
fi

sleep $((PASS2_AT - 15))
if ! healthcheck "$SHA" "T+${PASS2_AT}s"; then
  rollback "healthcheck failed at T+${PASS2_AT}s (first pass had passed — a worker was idle, or it did not settle)"
fi

# ── 8/9. status ─────────────────────────────────────────────────────────────
write_status ok "deployed $SHA"
say "LIVE $SHA"

# ── 10. prune, never touching current or prev ───────────────────────────────
CUR_T="$(readlink "$ROOT/current" 2>/dev/null || true)"
PRV_T="$RELDIR/$(read_state prev.sha)"
n=0
while IFS= read -r d; do
  [ -z "$d" ] && continue
  if [ "$d" = "$CUR_T" ] || [ "$d" = "$PRV_T" ]; then continue; fi
  n=$((n + 1))
  if [ "$n" -le "$RETAIN" ]; then continue; fi
  rm -rf "$d"
  say "pruned $(basename "$d")"
done < <(ls -1dt "$RELDIR"/*/ 2>/dev/null | sed 's#/$##' || true)

# ── 11. keep the log bounded ────────────────────────────────────────────────
LOGF="$LOGDIR/deploy.log"
if [ -f "$LOGF" ] && [ "$(stat -c %s "$LOGF" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 2097152 "$LOGF" > "$LOGF.trim" && mv -f "$LOGF.trim" "$LOGF"
  say "log truncated"
fi
exit 0
