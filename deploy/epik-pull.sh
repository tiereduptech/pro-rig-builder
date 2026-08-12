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
#                 EXIT 0 = healthy, 1 = unhealthy, 3 = COULD NOT VERIFY (see below).
#    --force      ignore the sha short-circuit and redeploy the published
#                 release even if it matches what is already live.
#
#  ORIGIN_IP — WHAT THE HEALTHCHECK IS ACTUALLY MEASURING.
#  SITE_URL is a hostname, and a hostname is resolved by DNS to whatever the
#  world currently points it at. During a cutover that is deliberately NOT this
#  box: prorigbuilder.com answers from Railway until DNS moves. A check that
#  follows DNS then measures the OTHER stack and reports the difference as a
#  fault here — which is how a clean flip got called "unhealthy".
#  Set ORIGIN_IP (config or env) and every site request is pinned to this box
#  with --resolve, so the check measures the thing it claims to measure. Unpinned
#  and unanswered, it reports exit 3 "could not verify" rather than inventing a
#  fault: see hc_verdict().
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

# ── the healthcheck verdict ─────────────────────────────────────────────────
# hc_verdict <pinned 0|1> <bad> <mine> <foreign>  ->  ok | unhealthy | unverified
#
# The judgement that was previously made wrongly: "the site did not answer as
# expected" is NOT the same claim as "this box is broken". They are the same
# claim only when we know the request reached this box.
#
#   mine     responses carrying a release field. _env.php ships in every release,
#            so a response shaped like ours came from a tree of ours. mine>0
#            means the box WAS reached, and a mismatch is then really ours.
#   foreign  responses that were HTTP 200 and a web page which is NOT an
#            unexecuted copy of our own _env.php (that would start "<?php").
#            This docroot cannot produce that at this path — another stack can.
#
# Pinned (--resolve to ORIGIN_IP): the request went to this box by construction,
# so every failure is this box's. Unpinned, with nothing of ours in the sample
# and a page from something else, we have not measured this box at all — say so,
# rather than picking the alarming interpretation of evidence that allows both.
#
# Defined up here, above the config read, so the truth table can be driven
# off-box with no config, site or box: test/epik-pull.hcverdict.test.sh.
hc_verdict() {
  local pinned="$1" bad="$2" mine="$3" foreign="$4"
  if [ "$bad" -eq 0 ]; then echo ok; return 0; fi
  if [ "$pinned" = 1 ]; then echo unhealthy; return 0; fi
  if [ "$mine" -eq 0 ] && [ "$foreign" -gt 0 ]; then echo unverified; return 0; fi
  echo unhealthy
}
[ -n "${EPIK_PULL_LIB_ONLY:-}" ] && return 0 2>/dev/null

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

# ── origin pinning ──────────────────────────────────────────────────────────
# ORIGIN_IP may come from the config (survives cron) or the environment (a
# one-off check). Empty means "follow DNS", which is correct only once DNS
# points here.  ORIGIN_INSECURE=1 skips cert validation on the pinned request —
# needed while the origin's cert is issued for a name that still validates
# elsewhere (AutoSSL's DNS validation resolves to Railway until cutover).
ORIGIN_IP="${ORIGIN_IP:-}"
ORIGIN_INSECURE="${ORIGIN_INSECURE:-0}"
SITE_HOST="${SITE_URL#*://}"; SITE_HOST="${SITE_HOST%%/*}"; SITE_HOST="${SITE_HOST%%:*}"
case "$SITE_URL" in https://*) SITE_PORT=443 ;; *) SITE_PORT=80 ;; esac
ORIGIN_PINNED=0

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

# --resolve is curl 7.21.3 (2010) — almost certainly present, but the CURL FLOOR
# note above exists because this box already refused one option we assumed it
# had. MEASURE it. A pin that silently did nothing would be worse than no pin:
# the check would go back to measuring DNS while reporting that it did not.
curl_has_resolve() {
  local rc=0 out
  out="$(curl -sS --resolve 'pin.invalid:1:127.0.0.1' --connect-timeout 1 --max-time 2 \
         -o /dev/null 'http://pin.invalid:1/' 2>&1)" || rc=$?
  # 2 = curl could not parse its command line; anything else means it parsed
  # --resolve and went on to fail at the network, which is what we want here.
  case "$rc" in
    2) printf '%s' "$out"; return 1 ;;
    *) return 0 ;;
  esac
}

if [ -n "$ORIGIN_IP" ]; then
  if WHY="$(curl_has_resolve)"; then
    SITE_CURL+=(--resolve "$SITE_HOST:$SITE_PORT:$ORIGIN_IP")
    if [ "$ORIGIN_INSECURE" = 1 ]; then SITE_CURL+=(-k); fi
    ORIGIN_PINNED=1
  else
    echo "epik-pull: ORIGIN_IP=$ORIGIN_IP is set, but this curl rejected --resolve:" >&2
    echo "  $WHY" >&2
    echo "  Refusing to run: continuing would follow DNS while reporting a pinned check." >&2
    exit 2
  fi
fi

# Every message that names the URL uses this, so a log line can never leave you
# guessing whether the request went to the box or to whatever DNS says today.
site_desc() {
  if [ "$ORIGIN_PINNED" = 1 ]; then
    printf '%s (pinned: %s:%s -> %s%s)' "$SITE_URL" "$SITE_HOST" "$SITE_PORT" "$ORIGIN_IP" \
      "$([ "$ORIGIN_INSECURE" = 1 ] && printf ', cert not validated')"
  else
    printf '%s (whatever DNS resolves %s to)' "$SITE_URL" "$SITE_HOST"
  fi
}
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

# Says WHICH credential went out, without ever printing the password. "401 having
# sent no -u at all" and "401 as user 'prb'" are different faults with different
# fixes, and the old message could not tell them apart.
auth_desc() {
  if [ -n "${BASIC_AUTH:-}" ]; then
    printf "user '%s' + %s-char password, from %s" \
      "${BASIC_AUTH%%:*}" \
      "$(printf '%s' "${BASIC_AUTH#*:}" | wc -c | tr -d ' ')" \
      "$CONFIG"
  else
    printf 'NO -u sent — %s defines no BASIC_AUTH' "$CONFIG"
  fi
}

# One sampled request. Body -> $1. Prints the HTTP status; returns curl's exit.
probe_env() {
  local out="$1" cb="$2" code rc=0
  code="$("${SITE_CURL[@]}" -w '%{http_code}' -o "$out" \
          "$SITE_URL/_env.php?cb=$cb" 2>"$TMP/hc.curl.err")" || rc=$?
  printf '%s' "${code:-000}"
  return "$rc"
}

# Turn one response into a short outcome label. These labels are what get tallied,
# so they must NOT contain the per-request cache-buster or anything else unique —
# otherwise every request looks like its own distinct failure.
classify_env() {  # <curl-rc> <status> <bodyfile> <want-sha>
  local rc="$1" status="$2" f="$3" want="$4" got
  if [ "$rc" -ne 0 ]; then printf 'curl exit %s — %s' "$rc" "$(curl_why "$rc")"; return 0; fi
  if [ "$status" != 200 ]; then printf 'HTTP %s' "$status"; return 0; fi
  if [ ! -s "$f" ]; then printf 'HTTP 200 with an EMPTY body'; return 0; fi
  case "$(cat "$f")" in
    *"\"release\":\"$want\""*) printf 'match'; return 0 ;;
  esac
  got="$(jget "$f" release 2>/dev/null || true)"
  if [ -n "$got" ]; then printf 'release=%s (wanted %s)' "$got" "$want"; return 0; fi
  case "$(head -c 1 "$f" 2>/dev/null || true)" in
    '<') printf 'HTML body, not JSON — a server error/login page' ;;
    *)   printf 'JSON without a release field' ;;
  esac
}

unanimous() {
  local want="$1" i status rc bad=0 unresolved=0 mine=0 foreign=0 outcome sample=''
  local body="$TMP/hc.body" tally="$TMP/hc.outcomes" verdict
  : > "$tally"
  for i in $(seq 1 "$HC_REQUESTS"); do
    rc=0
    status="$(probe_env "$body" "$$.$i")" || rc=$?
    outcome="$(classify_env "$rc" "$status" "$body" "$want")"
    printf '%s\n' "$outcome" >> "$tally"
    # Who answered, independent of whether the answer was the RIGHT one.
    case "$outcome" in
      match|release=*) mine=$((mine + 1)) ;;
    esac
    if [ "$rc" -eq 0 ] && [ "$status" = 200 ] && [ -s "$body" ]; then
      case "$(head -c 5 "$body" 2>/dev/null || true)" in
        '<?php') : ;;                       # our own file, unexecuted — our fault
        '<'*)    foreign=$((foreign + 1)) ;;  # a web page from something else
      esac
    fi
    if [ "$outcome" != match ]; then
      bad=$((bad + 1))
      # Keep ONE verbatim body. A tally says what class of thing went wrong; the
      # body is what tells you why. Newlines flattened so it stays one log line.
      if [ -z "$sample" ] && [ -s "$body" ]; then
        sample="$(head -c 300 "$body" | tr -d '\r' | tr '\n' ' ')"
      fi
    fi
    if [ -s "$body" ] && grep -q '"dir_resolved":false' "$body"; then
      unresolved=$((unresolved + 1))
    fi
  done

  # Printed by BOTH failure paths below — a healthcheck that says only "did not
  # match" cannot be debugged, which is the whole point of this block.
  report() {
    err "  what the workers actually returned ($HC_REQUESTS requests):"
    sort "$tally" | uniq -c | sort -rn | while read -r n what; do
      err "    ${n}x  $what"
    done
    err "  url:  $SITE_URL/_env.php"
    err "  went to: $(site_desc)"
    err "  auth: $(auth_desc)"
    if [ -n "$sample" ]; then err "  first non-matching body (300B): $sample"; fi
    if [ -s "$TMP/hc.curl.err" ]; then sed 's/^/  curl: /' "$TMP/hc.curl.err" >&2 || true; fi
    # The trap that cost a green staging install: a 401 while credentials WERE
    # sent almost never means the password is wrong. Two causes, both silent, in
    # the order they actually bit us. Point at them rather than sending anyone to
    # re-rotate a credential that was correct all along.
    if grep -q '^HTTP 401' "$tally" && [ -n "${BASIC_AUTH:-}" ]; then
      err "  401 WITH credentials sent is NOT a bad password. Two silent causes, check in order:"
      err "  1. HASH FORMAT. LiteSpeed accepts APR1 only and rejects {SHA} with no error at all:"
      err "       head -c 12 $ROOT/secrets/.htpasswd   # must show  user:\$apr1\$  — NOT  {SHA}"
      err "       fix: scripts/rotate-staging-auth.sh (rewrites it via openssl passwd -apr1)"
      err "  2. UNREADABLE auth db. The server reads it as 'nobody', not as the owner:"
      err "       ls -ld $ROOT/secrets            # needs 711"
      err "       ls -l  $ROOT/secrets/.htpasswd  # needs 644"
    fi
  }

  # dir_resolved=false comes out of OUR OWN _env.php, so whoever answered, it was
  # this tree. That is a correctness failure here regardless of pinning, and it is
  # judged before the verdict function ever runs.
  if [ "$unresolved" -gt 0 ]; then
    err "R1 INVARIANT BROKEN: _env.php reports dir_resolved=false on $unresolved/$HC_REQUESTS requests."
    err "  __DIR__ is no longer the resolved release path, so resolver.php's four reads are not pinned"
    err "  to one release (DESIGN §3.2). This is a correctness failure, not a timing one."
    report
    return 1
  fi

  verdict="$(hc_verdict "$ORIGIN_PINNED" "$bad" "$mine" "$foreign")"
  case "$verdict" in
    ok) return 0 ;;
    unhealthy)
      err "worker pool not converged: $bad/$HC_REQUESTS requests did not report release=$want"
      report
      return 1
      ;;
    unverified)
      err "COULD NOT VERIFY — and this is NOT a verdict on the release."
      err "  All $HC_REQUESTS requests to $SITE_URL/_env.php were answered with a web page by"
      err "  something that is not this release. _env.php ships in every release and answers"
      err "  JSON; an unexecuted copy of it would start '<?php'. Neither is what came back."
      err "  $SITE_HOST is a DNS name and nothing here proves it points at this box, so two"
      err "  very different situations are indistinguishable from this evidence:"
      err "    a) this box is serving a broken release, or"
      err "    b) the hostname still answers from another stack and this box was never asked."
      err "  Pin the origin and the answer is unambiguous:"
      err "    ORIGIN_IP=<this box's public IP> $0 --check"
      err "    (persist it by adding ORIGIN_IP= to $CONFIG; add ORIGIN_INSECURE=1 if the"
      err "     origin's cert does not yet validate for $SITE_HOST)"
      report
      return 3
      ;;
  esac
}

# The fixture harness ships inside the release (_ops/), so the box verifies
# itself with the exact code and fixture CI runs — no bash twin to drift.
run_fixture() {
  local dir="$1"
  if [ ! -f "$dir/_ops/verify-epik.cjs" ]; then
    err "release $dir has no _ops/verify-epik.cjs — cannot verify"
    return 1
  fi
  # EPIK_RESOLVE/EPIK_INSECURE pin the fixture to the same origin as the rest of
  # the check. A release published before this option existed ignores them and
  # follows DNS — which is why unanimous() runs first and is the pinned gate.
  EPIK_BASIC_AUTH="${BASIC_AUTH:-}" \
  EPIK_RESOLVE="${ORIGIN_IP:-}" EPIK_INSECURE="$ORIGIN_INSECURE" \
  node "$dir/_ops/verify-epik.cjs" epik="$SITE_URL"
}

# 0 = healthy, 1 = unhealthy, 3 = could not verify (see hc_verdict).
healthcheck() {   # $1 = expected sha, $2 = label
  local want="$1" label="$2" out rc=0
  say "healthcheck ($label) — $(site_desc)"
  unanimous "$want" || rc=$?
  if [ "$rc" -ne 0 ]; then return "$rc"; fi
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
  HC_RC=0
  healthcheck "$LIVE" "check" || HC_RC=$?
  if [ "$HC_RC" -eq 0 ]; then
    write_status ok "manual --check passed"
    say "check ok ($LIVE)"
    exit 0
  fi
  if [ "$HC_RC" -eq 3 ]; then
    # Deliberately NOT written to _deploy-status.json. This run learned nothing,
    # and recording "unverified" would overwrite a real earlier verdict and hand
    # epik-watchdog.yml (health != ok) an alarm about a release it never measured.
    err "--check: NOT VERIFIED (exit 3). This is not a failure verdict, and the status"
    err "  file is left exactly as it was — this run measured nothing to record."
    exit 3
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
  local prc=0
  healthcheck "$PREV_SHA" "post-rollback" || prc=$?
  if [ "$prc" -eq 0 ]; then
    write_status "rolled_back" "$why; rolled back to $PREV_SHA and it is healthy"
    err "rolled back to $PREV_SHA — site healthy. Failed tree kept at $FINAL"
  elif [ "$prc" -eq 3 ]; then
    # The same evidence that could not judge the new release cannot judge the old
    # one either. Saying "ALSO UNHEALTHY" here would be the same error twice.
    write_status "rolled_back" "$why; rolled back to $PREV_SHA, whose health could not be verified either"
    err "rolled back to $PREV_SHA. Its health COULD NOT BE VERIFIED — same reason as above,"
    err "  not a second fault. Pin ORIGIN_IP and run: $0 --check"
  else
    write_status "rolled_back" "$why; rolled back to $PREV_SHA but IT IS ALSO UNHEALTHY"
    err "ROLLED BACK AND STILL UNHEALTHY — the site needs a human now."
  fi
  exit 1
}

# A deploy that cannot be VERIFIED still rolls back — going back to a release that
# was proven good is the conservative move when we know nothing about the new one.
# But the message says which of the two it was, because they need different fixes:
# a broken release needs a code change, an unverifiable one needs ORIGIN_IP.
hc_why() {  # <rc> <label>
  if [ "$1" -eq 3 ]; then
    printf 'healthcheck at %s COULD NOT VERIFY the release (%s did not answer from this box). Rolled back as the conservative move — this is not a fault verdict on %s. Set ORIGIN_IP in %s and re-run.' \
      "$2" "$SITE_HOST" "$SHA" "$CONFIG"
  else
    printf 'healthcheck failed at %s' "$2"
  fi
}

sleep 15
HC_RC=0
healthcheck "$SHA" "T+15s" || HC_RC=$?
if [ "$HC_RC" -ne 0 ]; then rollback "$(hc_why "$HC_RC" 'T+15s')"; fi

sleep $((PASS2_AT - 15))
HC_RC=0
healthcheck "$SHA" "T+${PASS2_AT}s" || HC_RC=$?
if [ "$HC_RC" -ne 0 ]; then
  if [ "$HC_RC" -eq 3 ]; then
    rollback "$(hc_why 3 "T+${PASS2_AT}s")"
  else
    rollback "healthcheck failed at T+${PASS2_AT}s (first pass had passed — a worker was idle, or it did not settle)"
  fi
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
