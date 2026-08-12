#!/bin/bash
# =============================================================================
#  cp-verify.sh — CP-1..CP-5 against the Epik ORIGIN, directly.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  Run this on the box after the production docroot flip and BEFORE DNS moves.
#
#  WHY EVERY REQUEST IS PINNED. prorigbuilder.com resolves to Railway until the
#  Cloudflare/DNS step. A check that follows DNS in this window measures the
#  stack we are migrating away from and reports the difference as this box's
#  fault — which is exactly what made a clean flip print "left flipped and
#  unhealthy". So every request here is pinned with:
#
#      curl --resolve prorigbuilder.com:443:<origin ip>
#
#  and sent with -k. The origin now carries a CLOUDFLARE ORIGIN CA cert
#  (installed 2026-08-12), which no public trust store validates BY DESIGN —
#  only Cloudflare's edge does. So -k is permanent here, not a migration
#  shortcut, and CP-5 reads the issuer rather than treating curl's exit 60 as a
#  verdict. See PHASE-B-INSTALL.md §6.
#
#  WHAT EACH CP ASSERTS
#    CP-1  the origin serves the release the box has staged, on every worker,
#          with R1 intact (dir_resolved). Ten requests, not one: the convergence
#          band is per worker.
#    CP-2  routing and status parity — the same 15-case fixture CI runs, driven
#          with curl. NOT via _ops/verify-epik.cjs: a release published before
#          EPIK_RESOLVE existed carries a copy that ignores it and follows DNS,
#          i.e. it would grade Railway and call it a pass.
#    CP-3  what the pages actually RENDER: the five HARD checks from
#          verify-prerender.cjs, applied to what the origin serves rather than
#          to dist/. A noindex here is the failure that cost ~10 days of product
#          indexing in July.
#    CP-4  production is unauthenticated and exposes nothing: no guard, no
#          .htpasswd, /_ops/ denied, robots.txt not a blanket disallow.
#    CP-5  cache headers and the origin cert.
#
#  EXIT CODE
#    Non-zero if CP-1..CP-4 has any failure — those gate DNS moving.
#    CP-5 is split deliberately:
#      * the CERT lines are NOTED and never affect the exit code. Read them:
#        "Cloudflare Origin CA + not expired" is the correct steady state and
#        curl's exit 60 there is permanent, whereas an expired Origin CA cert or
#        an unrecognised issuer IS a Full (Strict) blocker. The note says which.
#      * the CACHE-CONTROL lines DO affect it. A cacheable _deploy-status.json
#        or RELEASE.json means CI's confirm-poll reads a stale answer and
#        reports a deploy that did not happen — every future deploy
#        verification becomes unreliable, silently. That is a bug, not a nicety
#        (DESIGN §11), so it blocks like CP-1..CP-4 does.
#
#  READ-ONLY. It fetches and greps. It writes nothing outside a temp directory
#  and touches no release, no docroot and no config.
#
#  Overridable:  HOST= ORIGIN= ROOT= SAMPLE=  (defaults are production's)
# =============================================================================
set -u

HOST="${HOST:-prorigbuilder.com}"
ORIGIN="${ORIGIN:-66.223.49.32}"
ROOT="${ROOT:-$HOME/prb}"
SAMPLE="${SAMPLE:-20}"          # CP-3 product pages to sample
HC_N="${HC_N:-10}"              # CP-1 worker samples; 10 = epik-pull.sh's default

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CURL=(curl -sS -k --resolve "$HOST:443:$ORIGIN" --connect-timeout 10 --max-time 30)
get()  { "${CURL[@]}" "https://$HOST$1"; }                                    # body -> stdout
save() { "${CURL[@]}" -o "$2" -w '%{http_code}' "https://$HOST$1"; }          # body -> file, prints status
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "https://$HOST$1"; }     # status only
hdrs() { "${CURL[@]}" -o /dev/null -D - "https://$HOST$1"; }                  # headers -> stdout

# node reads JSON here — jq is not guaranteed. A BARE `node` is deliberate and safe
# ONLY because this harness is run interactively, where nvm's shell hook has already put
# ~/.nvm/versions/node/*/bin/node on PATH; the preflight below (command -v node || die)
# refuses to grade anything if it is not. That is the exact assumption that does NOT hold
# under cron, where the environment is only /usr/local/bin:/usr/bin:/bin and a bare `node`
# is not found — see epik-pull.sh's resolve_node() and DESIGN §10 "present ≠ on PATH".
jget() {
  node -e '
    const fs=require("fs");
    let o; try { o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch(e) { process.exit(3); }
    const v=process.argv[2].split(".").reduce((a,k)=>(a==null?a:a[k]),o);
    process.stdout.write(v==null?"":String(v));
  ' "$1" "$2" 2>/dev/null
}

# ── tally ───────────────────────────────────────────────────────────────────
# Per-CP counters, so the summary is a tally and the body is only what needs
# reading. A check that cannot RUN counts as a failure, never as a pass — the
# whole point of this file is not to report a verdict it did not measure.
CP=0
for i in 1 2 3 4 5; do eval "P$i=0; F$i=0; N$i=0"; done
ok()   { eval "P$CP=\$((P$CP+1))"; printf '  ok    %s\n' "$*"; }
bad()  { eval "F$CP=\$((F$CP+1))"; printf '  FAIL  %s\n' "$*"; }
note() { eval "N$CP=\$((N$CP+1))"; printf '  note  %s\n' "$*"; }
banner() { CP="$1"; printf '\n############ CP-%s  %s ############\n' "$1" "$2"; }
die()  { printf '\n!! %s\n' "$*" >&2; exit 2; }

# ── preflight — refuse to produce a table that measured the wrong thing ─────
command -v node >/dev/null 2>&1 || die "node not found on PATH — needed to read JSON."
# --resolve is curl 7.21.3 (2010), but this box has already refused an option we
# assumed it had (--etag-save). Measure it: without the pin, every request below
# would silently go to whatever DNS says, under a banner claiming otherwise.
if ! curl -sS --resolve 'pin.invalid:1:127.0.0.1' --connect-timeout 1 --max-time 2 \
        -o /dev/null 'http://pin.invalid:1/' >/dev/null 2>&1; then
  rc=$?
  [ "$rc" = 2 ] && die "this curl has no --resolve, so nothing here can be pinned to the origin.
   Refusing to run: an unpinned table would grade whatever DNS points at."
fi
[ -d "$ROOT/current" ] || die "no release tree at $ROOT/current (set ROOT= if the install root moved).
   Run this ON THE BOX — CP-1 and CP-4 compare what is served against what is staged."

REL="$(readlink -f "$ROOT/current" 2>/dev/null || echo "$ROOT/current")"

printf '=============================================================\n'
printf ' CP-1..CP-5 — Epik origin, direct\n'
printf '   host          %s\n' "$HOST"
printf '   origin        %s   (pinned, cert not validated)\n' "$ORIGIN"
printf '   release tree  %s\n' "$REL"
printf '   when          %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '=============================================================\n'

# ── CP-1 ────────────────────────────────────────────────────────────────────
banner 1 "release identity + worker unanimity"

WANT="$(jget "$ROOT/current/RELEASE.json" source_sha)"
if [ -z "$WANT" ]; then
  bad "cannot read source_sha from $ROOT/current/RELEASE.json"
else
  ok "staged release: $WANT ($(jget "$ROOT/current/RELEASE.json" file_count) files)"

  st="$(save /RELEASE.json "$TMP/rel.json")"
  got="$(jget "$TMP/rel.json" source_sha)"
  if [ "$st" != 200 ]; then
    bad "GET /RELEASE.json -> HTTP $st (the origin is not serving the release marker)"
  elif [ "$got" = "$WANT" ]; then
    ok "served /RELEASE.json source_sha matches the staged tree"
  else
    bad "served source_sha '$got' != staged '$WANT' — the docroot is on a different release"
  fi

  fc_l="$(jget "$ROOT/current/RELEASE.json" file_count)"
  fc_s="$(jget "$TMP/rel.json" file_count)"
  if [ -n "$fc_s" ] && [ "$fc_l" = "$fc_s" ]; then
    ok "file_count agrees ($fc_l)"
  else
    bad "file_count staged=$fc_l served=${fc_s:-<none>}"
  fi

  # Ten requests: _env.php reports the release from its OWN __DIR__, so N
  # requests sample N (possibly repeated) workers. One green request proves one
  # worker flipped, which is not the claim being made here.
  : > "$TMP/env.txt"
  for i in $(seq 1 "$HC_N"); do get "/_env.php?cb=$$.$i" >> "$TMP/env.txt"; printf '\n' >> "$TMP/env.txt"; done
  m="$(grep -c "\"release\":\"$WANT\"" "$TMP/env.txt" 2>/dev/null || true)"
  r="$(grep -c '"dir_resolved":true'  "$TMP/env.txt" 2>/dev/null || true)"
  if [ "${m:-0}" -eq "$HC_N" ]; then
    ok "$m/$HC_N workers report release=$WANT"
  else
    bad "$m/$HC_N workers report release=$WANT — pool not converged, or something else answered"
    printf '        first 200B of a response: %s\n' "$(head -c 200 "$TMP/env.txt" | tr -d '\r' | tr '\n' ' ')"
  fi
  # R1: __DIR__ must already be the resolved release path, or resolver.php's four
  # reads are not pinned to one release (DESIGN §3.2). Correctness, not timing.
  if [ "${r:-0}" -eq "$HC_N" ]; then
    ok "$r/$HC_N report dir_resolved=true (R1 intact)"
  else
    bad "$r/$HC_N report dir_resolved=true — R1 INVARIANT BROKEN (DESIGN §3.2)"
  fi

  st="$(save /_deploy-status.json "$TMP/status.json")"
  if [ "$st" = 200 ]; then
    ls_="$(jget "$TMP/status.json" live_sha)"
    if [ "$ls_" = "$WANT" ]; then ok "_deploy-status.json live_sha agrees"
    else bad "_deploy-status.json live_sha '$ls_' != '$WANT'"; fi
  else
    note "/_deploy-status.json -> HTTP $st (not written yet: no successful --check since the flip)"
  fi
fi

# ── CP-2 ────────────────────────────────────────────────────────────────────
banner 2 "routing + status parity (the CI fixture, direct)"

FIX="$ROOT/current/_ops/epik-fixture.json"
if [ ! -f "$FIX" ]; then
  bad "no fixture at $FIX — cannot check routing parity (counted as a failure, not a pass)"
else
  # Fields are separated by "|", NOT by tab. Tab is an IFS *whitespace*
  # character, so `read` collapses a run of them and an empty expectLocation
  # silently shifts every later column into the wrong variable — which reads as
  # a routing failure on a case that was fine. A non-whitespace delimiter keeps
  # empty fields. No path, status or header value here can contain a "|".
  node -e '
    const cs=require(process.argv[1]).cases;
    console.log(cs.map(c=>[c.path, c.status, c.expectLocation||"",
      Object.entries(c.expectHeader||{}).map(([k,v])=>k+"="+v).join(";")
    ].join("|")).join("\n"));
  ' "$FIX" > "$TMP/cases.tsv" 2>/dev/null || true

  n=0
  if [ -s "$TMP/cases.tsv" ]; then
    while IFS='|' read -r p want loc hdrspec; do
      [ -z "${p:-}" ] && continue
      n=$((n + 1))
      H="$TMP/h.$n"
      st="$("${CURL[@]}" -o /dev/null -D "$H" -w '%{http_code}' "https://$HOST$p")"
      why=""
      [ "$st" = "$want" ] || why="status=$st want=$want"
      if [ -n "$loc" ]; then
        gl="$(awk 'tolower($1)=="location:"{print $2}' "$H" | tr -d '\r' | sed 's#^https\?://[^/]*##')"
        [ "$gl" = "$loc" ] || why="$why location='$gl' want='$loc'"
      fi
      if [ -n "$hdrspec" ]; then
        # expectHeader is a contains-match, exactly as verify-epik.cjs does it.
        old_ifs="$IFS"; IFS=';'
        for kv in $hdrspec; do
          IFS="$old_ifs"
          k="${kv%%=*}"; v="${kv#*=}"
          gv="$(awk -v want="$(printf '%s' "$k" | tr 'A-Z' 'a-z')" \
                'BEGIN{IGNORECASE=1} tolower($1)==want":"{sub(/^[^:]*:[ ]*/,"");print}' "$H" | tr -d '\r')"
          case "$gv" in *"$v"*) ;; *) why="$why $k='$gv' want~'$v'" ;; esac
          IFS=';'
        done
        IFS="$old_ifs"
      fi
      if [ -z "$why" ]; then
        eval "P2=\$((P2+1))"
      else
        bad "$p"
        printf '        %s\n' "$why"
      fi
    done < "$TMP/cases.tsv"
    if [ "$F2" -eq 0 ]; then printf '  ok    %s/%s fixture cases matched (status, Location, X-Robots-Tag)\n' "$P2" "$n"
    else printf '        %s/%s matched\n' "$P2" "$n"; fi
  else
    bad "could not parse $FIX"
  fi
fi

# ── CP-3 ────────────────────────────────────────────────────────────────────
banner 3 "rendered output (verify-prerender.cjs HARD checks, over the wire)"

# PRODUCT pages only. The same sitemap carries /parts/<cat> indexes, which have
# no Product JSON-LD by design and would read as false blockers.
get /sitemap.xml > "$TMP/sitemap.xml" 2>/dev/null
grep -oE "https://$HOST/parts/[a-z0-9-]+/[a-z0-9-]+-[0-9]{4,}" "$TMP/sitemap.xml" > "$TMP/urls.all" 2>/dev/null || true
TOT="$(wc -l < "$TMP/urls.all" 2>/dev/null | tr -d ' ')"
if [ "${TOT:-0}" -eq 0 ]; then
  bad "no product URLs found in /sitemap.xml (served $(wc -c < "$TMP/sitemap.xml" 2>/dev/null || echo 0) bytes)"
else
  if command -v shuf >/dev/null 2>&1; then shuf -n "$SAMPLE" "$TMP/urls.all" > "$TMP/urls";
  else head -n "$SAMPLE" "$TMP/urls.all" > "$TMP/urls"; note "no shuf — sampled the first $SAMPLE, not a random $SAMPLE"; fi
  printf '  ..    sampling %s of %s product pages\n' "$(wc -l < "$TMP/urls" | tr -d ' ')" "$TOT"

  : > "$TMP/violations"
  shown=0
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    p="${u#https://$HOST}"
    f="$TMP/page.html"; ph="$TMP/page.hdr"
    st="$("${CURL[@]}" -o "$f" -D "$ph" -w '%{http_code}' "https://$HOST$p")"
    why=""
    if [ "$st" != 200 ]; then
      why="http=$st"
    else
      # The header, not just the meta tag. July's incident served robots:noindex
      # on 4573 live product pages; a page can be perfect in dist and still be
      # de-indexed by what the server attaches on the way out.
      grep -i '^x-robots-tag:' "$ph" | grep -qi 'noindex' && why="$why X-ROBOTS-NOINDEX-HEADER"
      t=$(grep -o '<title[ >]'            "$f" | wc -l | tr -d ' ')
      o=$(grep -o 'property="og:title"'   "$f" | wc -l | tr -d ' ')
      c=$(grep -o 'rel="canonical"'       "$f" | wc -l | tr -d ' ')
      href=$(grep -o '<link[^>]*rel="canonical"[^>]*>' "$f" | grep -o 'href="[^"]*"' | head -1 | cut -d'"' -f2)
      # Deliberately looser than verify-prerender.cjs's /content="noindex"/ — over
      # the wire we want content="noindex, nofollow" caught too.
      grep -qi 'content="noindex' "$f" && why="$why noindex-meta"
      grep -q 'name="robots" content="index' "$f" || why="$why no-index-directive"
      { [ "$t" = 1 ] && [ "$o" = 1 ] && [ "$c" = 1 ]; } || why="$why head-tags(title=$t,og=$o,canon=$c)"
      [ "$href" = "$u" ] || why="$why canonical-not-self"
      grep -qE '"@type" *: *"Product"' "$f" || why="$why no-product-jsonld"
      grep -qEi 'Skip the shop visit|Product Not Found' "$f" && why="$why SHELL-LEAK"
      [ "$(wc -c < "$f" | tr -d ' ')" -ge 30000 ] || why="$why thin-body"
    fi
    if [ -z "$why" ]; then
      eval "P3=\$((P3+1))"
    else
      eval "F3=\$((F3+1))"
      printf '%s\n' "$why" >> "$TMP/violations"
      if [ "$shown" -lt 10 ]; then printf '  FAIL  %s\n        %s\n' "$p" "$why"; shown=$((shown + 1)); fi
    fi
  done < "$TMP/urls"
  [ "$F3" -gt 10 ] && printf '        (+%s more, not shown)\n' "$((F3 - 10))"
  if [ "$F3" -eq 0 ]; then
    printf '  ok    %s/%s pages clean: robots-index · single head tags · self-canonical · Product JSON-LD · no shell leak\n' \
      "$P3" "$((P3 + F3))"
  else
    printf '        violation kinds:\n'
    tr ' ' '\n' < "$TMP/violations" | grep -v '^$' | sort | uniq -c | sort -rn | sed 's/^/          /'
  fi
fi

# ── CP-4 ────────────────────────────────────────────────────────────────────
banner 4 "production is unauthenticated and exposes nothing"

st="$(code /)";                          [ "$st" = 200 ] && ok "GET / -> 200 (unauthenticated)" || bad "GET / -> $st (401 here means a STAGING artifact reached production)"
st="$(code /_ops/epik-fixture.json)";    case "$st" in 403|404) ok "/_ops/epik-fixture.json -> $st (denied)";; *) bad "/_ops/epik-fixture.json -> $st (must not be served)";; esac
st="$(code /_ops/verify-epik.cjs)";      case "$st" in 403|404) ok "/_ops/verify-epik.cjs -> $st (denied)";; *) bad "/_ops/verify-epik.cjs -> $st (must not be served)";; esac
st="$(code /.htpasswd)";                 case "$st" in 403|404) ok "/.htpasswd -> $st";; *) bad "/.htpasswd -> $st (a credential file is reachable)";; esac

get /robots.txt > "$TMP/robots.txt" 2>/dev/null
if grep -qE '^[[:space:]]*Disallow:[[:space:]]*/[[:space:]]*$' "$TMP/robots.txt"; then
  bad "robots.txt carries a blanket 'Disallow: /' — the whole site is de-indexed"
elif [ -s "$TMP/robots.txt" ]; then
  ok "robots.txt served, no blanket disallow"
else
  bad "robots.txt is empty or missing"
fi

# Local evidence — the guard is asserted in both directions (PHASE-B §2).
if grep -q 'PRB-STAGING-GUARD' "$ROOT/current/.htaccess" 2>/dev/null; then
  bad "the live tree's .htaccess carries the STAGING guard sentinel"
else
  ok "no staging guard sentinel in the live .htaccess"
fi
if grep -Eqi '^[[:space:]]*(AuthType|AuthName|AuthUserFile|Require[[:space:]]+valid-user)\b' "$ROOT/current/.htaccess" 2>/dev/null; then
  bad "the live tree's .htaccess contains Basic-Auth directives"
else
  ok "no Auth* directives in the live .htaccess"
fi
if [ -n "$(find "$ROOT/releases" -name .htpasswd 2>/dev/null | head -1)" ]; then
  bad "a .htpasswd exists inside a release tree — that must never ship"
else
  ok "no .htpasswd inside any release tree"
fi

# ── CP-5 ────────────────────────────────────────────────────────────────────
banner 5 "cache headers, and the cert Cloudflare will judge"

# These two are the status channel. If either is cacheable, CI's confirm-poll
# reads a stale answer and reports a deploy that did not happen — every future
# deploy verification becomes unreliable, silently. Counts toward the exit code.
for pth in /_deploy-status.json /RELEASE.json; do
  cc="$(hdrs "$pth" | awk 'tolower($1)=="cache-control:"{sub(/^[^:]*:[ ]*/,"");print}' | tr -d '\r' | head -1)"
  case "$(printf '%s' "$cc" | tr 'A-Z' 'a-z')" in
    *no-store*)                      ok "$pth  Cache-Control: ${cc}" ;;
    *no-cache*|*"max-age=0"*)        bad "$pth  Cache-Control: '${cc}' — needs no-store. CI's confirm-poll can read a cached answer and pass a deploy that never happened (DESIGN §11)" ;;
    "")                              bad "$pth  no Cache-Control at all — CI's confirm-poll will read cached answers" ;;
    *)                               bad "$pth  Cache-Control: '${cc}' — needs no-store, this is cacheable (DESIGN §11)" ;;
  esac
done

cc="$(hdrs / | awk 'tolower($1)=="cache-control:"{sub(/^[^:]*:[ ]*/,"");print}' | tr -d '\r' | head -1)"
case "$cc" in
  *must-revalidate*) ok "/  Cache-Control: $cc" ;;
  *)                 bad "/  Cache-Control: '${cc:-<none>}' — HTML needs must-revalidate" ;;
esac

asset="$(get / | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1)"
if [ -n "$asset" ]; then
  cc="$(hdrs "$asset" | awk 'tolower($1)=="cache-control:"{sub(/^[^:]*:[ ]*/,"");print}' | tr -d '\r' | head -1)"
  case "$cc" in
    *immutable*) ok "$asset  Cache-Control: $cc" ;;
    *)           bad "$asset  Cache-Control: '${cc:-<none>}' — hashed assets should be immutable" ;;
  esac
else
  note "no hashed /assets/*.js reference found on / — skipped the immutable check"
fi

# ── the cert Cloudflare will judge ──────────────────────────────────────────
# THREE outcomes, not two, and the middle one is the point of this block.
#
# A CLOUDFLARE ORIGIN CA cert is the CORRECT cert for Full (Strict), and it will
# NEVER validate against the system trust store: CF's Origin root is in no public
# bundle, by design — only Cloudflare's edge validates that chain. So curl's exit
# 60 here is the expected PERMANENT steady state, not a defect. Reporting it as
# "the Full (Strict) blocker" was true until the cert was installed (2026-08-12)
# and false afterwards, and a check that keeps asserting a fault after the fault
# is fixed teaches people to skip reading it. Same rule as hc_verdict() in
# epik-pull.sh: do not assert a fault the evidence does not support.
#
# The inverse trap is just as real. curl exits 60 for an untrusted issuer AND for
# an EXPIRED cert, so matching the issuer and stopping there would hide an expired
# Origin CA cert behind "expected and permanent" — Cloudflare's edge does check
# expiry. Expiry is therefore judged separately, and when it cannot be read this
# says UNKNOWN rather than folding it into either verdict.
crc=0
curl -sS --resolve "$HOST:443:$ORIGIN" --connect-timeout 10 --max-time 30 \
     -o /dev/null "https://$HOST/" >/dev/null 2>&1 || crc=$?

# One -k request, kept, so the identity lines below and the verdict above are read
# from the SAME response rather than two independent handshakes.
CERTI="$TMP/cert.info"
curl -sSv --resolve "$HOST:443:$ORIGIN" -k --connect-timeout 10 --max-time 30 \
     "https://$HOST/" -o /dev/null 2>&1 \
  | grep -E 'subject:|issuer:|expire date' > "$CERTI" 2>/dev/null || true
C_ISSUER="$(sed -n 's/.*issuer: *//p'       "$CERTI" | head -1 | tr -d '\r')"
C_EXPIRE="$(sed -n 's/.*expire date: *//p'  "$CERTI" | head -1 | tr -d '\r')"

CF_ORIGIN=0
case "$(printf '%s' "$C_ISSUER" | tr 'A-Z' 'a-z')" in
  *cloudflare*origin*ssl*certificate*authority*) CF_ORIGIN=1 ;;
esac

# expired | soon | ok | unknown — never inferred from the trust result.
EXP_STATE=unknown; DAYS=0
if [ -n "$C_EXPIRE" ] && EXP_TS="$(date -d "$C_EXPIRE" +%s 2>/dev/null)" && [ -n "$EXP_TS" ]; then
  DAYS=$(( (EXP_TS - $(date +%s)) / 86400 ))
  if   [ "$DAYS" -lt 0 ]  ; then EXP_STATE=expired
  elif [ "$DAYS" -lt 30 ] ; then EXP_STATE=soon
  else                           EXP_STATE=ok
  fi
fi

if [ "$crc" -eq 0 ]; then
  note "the origin cert validates against the SYSTEM trust store for $HOST — Full (Strict) is"
  note "  available, and the origin would also serve correctly un-proxied (grey-cloud)."
elif [ "$CF_ORIGIN" = 1 ] && [ "$EXP_STATE" = ok ]; then
  note "the origin carries a CLOUDFLARE ORIGIN CA cert — CORRECT for Full (Strict). NOT a blocker."
  note "  curl exit $crc is EXPECTED AND PERMANENT: CF's Origin root is in no public trust store"
  note "  by design, so only Cloudflare's edge validates this chain. Nothing to fix, ever."
  note "  expires $C_EXPIRE (~$((DAYS / 365))y out). Keep ORIGIN_INSECURE=1 — PHASE-B-INSTALL §6.7."
  note "  What this locks in: grey-clouding $HOST would hard-fail in browsers (§6.8)."
elif [ "$CF_ORIGIN" = 1 ] && [ "$EXP_STATE" = expired ]; then
  note "the origin carries a Cloudflare Origin CA cert and it has EXPIRED ($C_EXPIRE)."
  note "  This one IS a Full (Strict) blocker — the edge checks expiry even though no public"
  note "  trust store is involved. Re-issue it: PHASE-B-INSTALL §6.1."
elif [ "$CF_ORIGIN" = 1 ] && [ "$EXP_STATE" = soon ]; then
  note "the origin carries a Cloudflare Origin CA cert expiring in $DAYS days ($C_EXPIRE)."
  note "  Correct for Full (Strict) today, but re-issue before it lapses: PHASE-B-INSTALL §6.1."
elif [ "$CF_ORIGIN" = 1 ]; then
  note "the origin carries a Cloudflare Origin CA cert (correct for Full (Strict)), but its expiry"
  note "  could not be read from '${C_EXPIRE:-<no expire date line>}', so this is NOT a clean bill:"
  note "  curl exit $crc cannot tell an untrusted issuer from an expired cert. Check by hand:"
  note "    openssl s_client -connect $ORIGIN:443 -servername $HOST </dev/null 2>/dev/null | openssl x509 -noout -enddate"
elif [ -z "$C_ISSUER" ]; then
  note "the origin cert does not validate for $HOST (curl exit $crc), and its issuer could NOT be"
  note "  read — so this says nothing about which of the two it is. Do not choose an SSL mode on"
  note "  this evidence. Check by hand:"
  note "    openssl s_client -connect $ORIGIN:443 -servername $HOST </dev/null 2>/dev/null | openssl x509 -noout -issuer -enddate"
else
  note "the origin cert does not validate for $HOST (curl exit $crc), and was issued by:"
  note "    $C_ISSUER"
  note "  That is neither publicly trusted nor a Cloudflare Origin CA cert, so it IS the Full"
  note "  (Strict) blocker: fix it before choosing the SSL mode, not after (PHASE-B-INSTALL §6)."
fi
sed 's/^\** */        /' "$CERTI" | head -4

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n=============================================================\n'
printf ' %-4s %-46s %s\n' "CP" "what it asserts" "result"
printf ' %-4s %-46s %s\n' "--" "----------------------------------------------" "------"
row() { # row <n> <label>
  eval "p=\$P$1; f=\$F$1; nn=\$N$1"
  if [ "$f" -eq 0 ]; then r="$(printf '%s pass' "$p")"; else r="$(printf '%s pass  %s FAIL' "$p" "$f")"; fi
  [ "$nn" -gt 0 ] && r="$r  ($nn noted)"
  printf ' %-4s %-46s %s\n' "CP-$1" "$2" "$r"
}
row 1 "release identity + worker unanimity"
row 2 "routing/status parity (fixture)"
row 3 "rendered output (prerender HARD checks)"
row 4 "unauthenticated, nothing exposed"
row 5 "cache headers (cert is noted, not failed)"
printf '=============================================================\n'

BLOCK=$((F1 + F2 + F3 + F4 + F5))
if [ "$BLOCK" -eq 0 ]; then
  printf '\nALL CLEAR — CP-1..CP-4 clean, CP-5 cache headers clean.\n'
  printf 'The origin is serving what it should. DNS can move.\n'
  exit 0
fi
printf '\n%s FAILURE(S) — do not move DNS.\n' "$BLOCK"
[ "$F5" -gt 0 ] && printf 'CP-5 counts here for its CACHE headers only; the cert line above is noted, not failed.\n'
printf 'Every request above was pinned to %s. These are the origin, not DNS.\n' "$ORIGIN"
exit 1
