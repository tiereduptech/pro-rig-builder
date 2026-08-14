#!/bin/bash
# =============================================================================
#  install-phase-a.sh — stand up the pull deploy on the Epik box.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  TWO TARGETS, one script (deliberately — a forked prod copy is how a fix lands
#  in one and misses the other):
#
#    (default)      STAGING. Basic-Auth guard EXPECTED, secrets/.htpasswd written,
#                   secrets/ 711 so LiteSpeed's `nobody` can traverse to the auth db.
#    --production   PRODUCTION. EXPECT_GUARD=0: the artifact must carry NO guard,
#                   NO .htpasswd is written anywhere, secrets/ is 700, and the
#                   config has no BASIC_AUTH. Nothing on the production path
#                   reads secrets/, so `nobody` never needs to traverse it.
#
#  It never deletes anything that was here before it ran — the docroot flip
#  RENAMES the existing tree to <docroot>.pre-pull so it can be put straight back.
#
#  On --production the flip and the crontab entry are OFF by default (bootstrap
#  only): the tree is fetched, verified and staged, and the live docroot is not
#  touched. Add --flip when you actually intend to change what production serves.
#
#  Run it as:  curl -fsSL <raw url> -o ~/install-phase-a.sh && bash ~/install-phase-a.sh
#  Reverse it with:  bash ~/install-phase-a.sh --uninstall [--production]
#
#  Design + the measurements behind the numbers: deploy/DESIGN-pull-deploy.md
#  Manual equivalent of these steps:            deploy/PHASE-A-INSTALL.md
# =============================================================================
set -euo pipefail
umask 022

# ── target selection ────────────────────────────────────────────────────────
TARGET=staging
DO_FLIP=ask          # ask | never | yes
DO_CRON=ask
UNINSTALL=0
for a in "$@"; do
  case "$a" in
    --production|--prod) TARGET=production ;;
    --staging)           TARGET=staging ;;
    --flip)              DO_FLIP=ask ; FLIP_REQUESTED=1 ;;
    --cron)              DO_CRON=ask ; CRON_REQUESTED=1 ;;
    --uninstall)         UNINSTALL=1 ;;
    *) printf '!! unknown argument: %s\n' "$a" >&2; exit 2 ;;
  esac
done

REPO="${REPO:-tiereduptech/pro-rig-builder}"
REF="${REF:-main}"

if [ "$TARGET" = production ]; then
  BRANCH="${BRANCH:-epik-release}"
  SITE_URL="${SITE_URL:-https://prorigbuilder.com}"
  ROOT="${ROOT:-$HOME/prb}"
  EXPECT_GUARD=0
  # NO default. The production docroot is the live site's; guessing it and being
  # wrong renames the wrong tree. It must be named explicitly and is verified in
  # preflight — see the probe below, which runs when this is unset.
  DOCROOT="${DOCROOT:-}"
  # Production is unauthenticated — the config's BASIC_AUTH is forced empty at
  # step 4 so epik-pull.sh sends no -u and no credential is stored at all.
  SECRETS_MODE=700
  # Bootstrap only unless the operator explicitly asked for the live steps.
  [ "${FLIP_REQUESTED:-0}" = 1 ] || DO_FLIP=never
  [ "${CRON_REQUESTED:-0}" = 1 ] || DO_CRON=never
else
  BRANCH="${BRANCH:-epik-release-staging}"
  SITE_URL="${SITE_URL:-https://staging.prorigbuilder.com}"
  ROOT="${ROOT:-$HOME/prb-staging}"
  EXPECT_GUARD=1
  DOCROOT="${DOCROOT:-/home/tier5415/staging.prorigbuilder.com}"
  SECRETS_MODE=711
fi

# ── which origin the healthcheck talks to ───────────────────────────────────
# SITE_URL is a hostname, and until DNS is cut over that hostname answers from
# the OLD stack — so a healthcheck that follows DNS measures Railway and blames
# this box for the difference. ORIGIN_IP pins every site request to this box
# (curl --resolve), and epik-pull.sh reads it from the config so cron inherits it.
#
# $SSH_CONNECTION is "<client ip> <client port> <server ip> <server port>": field
# 3 is the address THIS session reached the box on. It is a measurement, not a
# guess — but it is only a default, printed every time, and overridable.
ORIGIN_IP="${ORIGIN_IP:-$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')}"
ORIGIN_INSECURE="${ORIGIN_INSECURE:-0}"

RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy/epik-pull.sh"
RAW_REAPER="https://raw.githubusercontent.com/$REPO/$REF/deploy/lock-reaper.sh"
# The tick, in three composed parts (see DESIGN §7):
#   1. lock-reaper.sh — runs BEFORE flock so it can recover a lock flock cannot
#      take: a wedged holder past the ceiling, or a GHOST held by no live process
#      (the 2026-08-14 "held by nothing" case that needed a manual rm -f).
#   2. flock -n — single-writer; an overlapping tick still no-ops.
#   3. timeout -s KILL 600 — a hard wall-clock ceiling on the run, so a stuck
#      tick DIES and frees the lock instead of holding it for hours.
# `;` not `&&` after the reaper: a reaper failure must never stop the flock tick.
# Only stdout is redirected, so the reaper's and the puller's stderr still reach
# cron mail on failure — 2>&1 is deliberately absent.
CRON_LINE="*/5 * * * * $ROOT/bin/lock-reaper.sh $ROOT/deploy.lock ; /usr/bin/flock -n $ROOT/deploy.lock /usr/bin/timeout -s KILL 600 $ROOT/bin/epik-pull.sh >> $ROOT/log/deploy.log"

say()  { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n!! %s\n' "$*" >&2; exit 1; }
ask()  { # ask <prompt> <required-word>
  local reply
  printf '\n?? %s\n   Type %s to proceed, anything else to skip: ' "$1" "$2"
  read -r reply < /dev/tty || reply=""
  [ "$reply" = "$2" ]
}

# ── the docroot verdict ─────────────────────────────────────────────────────
# This is the single most dangerous decision in the script: get it wrong and the
# flip renames a live tree onto an existing backup and buries it. It is therefore
# a PURE function of three observable facts, so it can be driven through its whole
# truth table off-box — see test/install-phase-a.docroot.test.sh. The caller does
# the probing; this function does no I/O and reads no globals.
#
#   docroot_verdict <is_symlink 0|1> <link_target> <expected_target> <backup_exists 0|1>
#
# Verdicts:
#   pre-flip        real directory, no backup — the normal first-run state
#   resume          already flipped to OUR current; a backup here is the expected
#                   residue of the flip that is live, not a fault
#   foreign-link    a symlink somewhere else, no backup — noted, not fatal: the
#                   flip would rename the LINK (its target is untouched)
#   refuse-buried   a flip is still ahead AND a backup exists — the rename would
#                   bury the tree under that name
#   refuse-foreign  same, and the docroot is someone else's symlink as well
docroot_verdict() {
  local is_link="$1" target="$2" expected="$3" backup="$4"
  if [ "$is_link" = 1 ] && [ "$target" = "$expected" ]; then
    echo resume; return 0
  fi
  if [ "$backup" = 1 ]; then
    if [ "$is_link" = 1 ]; then echo refuse-foreign; else echo refuse-buried; fi
    return 0
  fi
  if [ "$is_link" = 1 ]; then echo foreign-link; return 0; fi
  echo pre-flip
}

# Sourced by the test harness to get the function without running the installer.
[ -n "${INSTALL_PHASE_A_LIB_ONLY:-}" ] && return 0 2>/dev/null

# ── uninstall ───────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  say "Reversing the $TARGET install"
  [ -n "$DOCROOT" ] || die "--uninstall on production needs DOCROOT= so it knows which docroot to restore."
  if crontab -l 2>/dev/null | grep -qF "$ROOT/bin/epik-pull.sh"; then
    crontab -l 2>/dev/null | grep -vF "$ROOT/bin/epik-pull.sh" | crontab -
    info "crontab entry removed"
  else
    info "no crontab entry found"
  fi
  if [ -L "$DOCROOT" ] && [ -d "$DOCROOT.pre-pull" ]; then
    rm -f "$DOCROOT"
    mv "$DOCROOT.pre-pull" "$DOCROOT"
    info "docroot restored from $DOCROOT.pre-pull"
  else
    info "docroot is not a symlink with a .pre-pull backup — leaving it alone"
  fi
  info "release trees left at $ROOT (delete by hand if you want them gone)"
  say "Reversed. $TARGET is back on the SFTP-deployed tree."
  exit 0
fi

# ── 0. preflight ────────────────────────────────────────────────────────────
say "Preflight"
for c in curl tar sha256sum flock node php openssl crontab timeout pgrep; do
  command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
done
info "required commands present (incl. timeout + pgrep — the run ceiling and the lock reaper need them)"

mv --help 2>&1 | grep -q -- '-T' || die "this mv has no -T. Atomic swap is the whole design; stopping."
info "mv -T available"

# ── node the way CRON sees it, not the way this login shell does ─────────────
# `command -v node` above passes here because THIS shell has nvm's PATH, while
# every cron tick runs with PATH=/usr/bin:/bin and no nvm hook — so a bare `node`
# is not found and the puller dies before it logs a line (empty deploy.log,
# frozen checked_at). The check that only proved node existed in the login shell
# is exactly what let that ship. So: resolve node to an ABSOLUTE path, record it
# in config as NODE=, and PROVE that exact path runs under a cron-like env.
NODE_BIN="$(command -v node)"
NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")"
info "detected node: $NODE_BIN"
if env -i PATH=/usr/bin:/bin sh -c 'command -v node' >/dev/null 2>&1; then
  info "bare 'node' is also on the cron PATH — belt and suspenders"
else
  info "bare 'node' is NOT on the cron PATH (/usr/bin:/bin) — exactly why we record an absolute NODE="
fi
if env -i PATH=/usr/bin:/bin "$NODE_BIN" -e 'process.exit(0)'; then
  info "recorded node runs under a cron-like env (env -i PATH=/usr/bin:/bin)"
else
  die "the detected node ($NODE_BIN) does NOT run under 'env -i PATH=/usr/bin:/bin'.
   Cron would fail the same way. Point NODE_BIN at an absolute interpreter that does and re-run."
fi

# The first probe recorded "curl present" and stopped there, so a curl too old for
# --etag-save (7.68+) got discovered by a failing cron tick instead of here. Record
# the VERSION, and assert the floor every option in both scripts actually needs.
# 7.12.3 (2004) is where --retry/--retry-delay landed; everything else is older.
CURL_VER="$(curl --version 2>/dev/null | head -1 | awk '{print $2}')"
if [ -z "$CURL_VER" ]; then
  info "WARNING: could not parse 'curl --version' output — cannot check the version floor"
else
  info "curl $CURL_VER"
  printf '%s\n' "$CURL_VER" | awk -F. '
    { if (($1+0) > 7 || (($1+0) == 7 && (($2+0) > 12 || (($2+0) == 12 && ($3+0) >= 3)))) exit 0; exit 1 }
  ' || die "curl $CURL_VER is older than 7.12.3, which is where --retry/--retry-delay appeared.
   Both scripts use them on every fetch. Stopping before anything is changed."
fi
BASH_VER="${BASH_VERSION:-unknown}"
info "bash $BASH_VER"

# ── the production docroot is never guessed ─────────────────────────────────
# ~/public_html is the cPanel convention and what DESIGN §4 assumes, but it is an
# ASSUMPTION, not a measurement: this same account serves staging from
# ~/staging.prorigbuilder.com, a docroot that is NOT under public_html. Being
# wrong here renames the wrong live tree. So: probe, print the evidence, and make
# the operator name it. Read-only — this branch always exits.
if [ "$TARGET" = production ] && [ -z "$DOCROOT" ]; then
  say "Production docroot — candidates on this box (nothing has been changed)"
  printf '\n   %-46s %8s  %s\n' "PATH" "ENTRIES" "WHAT IS IN IT"
  printf '   %-46s %8s  %s\n' "----" "-------" "-------------"
  for c in "$HOME/public_html" "$HOME/www" "$HOME/prorigbuilder.com" "$HOME/public_html/prorigbuilder.com"; do
    if [ -L "$c" ]; then
      printf '   %-46s %8s  SYMLINK -> %s\n' "$c" "-" "$(readlink "$c")"
    elif [ -d "$c" ]; then
      n="$(find "$c" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
      marks=""
      [ -f "$c/index.html" ] && marks="$marks index.html"
      [ -f "$c/.htaccess" ] && marks="$marks .htaccess"
      [ -f "$c/resolver.php" ] && marks="$marks resolver.php"
      [ -f "$c/RELEASE.json" ] && marks="$marks RELEASE.json"
      [ -e "$c.pre-pull" ] && marks="$marks *** .pre-pull EXISTS ***"
      printf '   %-46s %8s %s\n' "$c" "$n" "${marks:- (none of the marker files)}"
    else
      printf '   %-46s %8s  does not exist\n' "$c" "-"
    fi
  done
  echo
  info "everything directly under \$HOME, for comparison:"
  ls -ld "$HOME"/*/ 2>/dev/null | sed 's/^/     /' || true
  echo
  info "A production docroot deployed by the current SFTP path should show"
  info "index.html + .htaccess + resolver.php. Pick the one the live site serves."
  die "DOCROOT is not set, and production must never be guessed. Re-run with, e.g.:
   DOCROOT=\$HOME/public_html bash $0 --production"
fi

# -e follows the link, so a symlink pointing at a pruned or not-yet-created
# release reports "does not exist" and sends you to set DOCROOT= when the docroot
# is in fact right there. Test the link itself too.
if [ ! -e "$DOCROOT" ] && [ ! -L "$DOCROOT" ]; then
  die "docroot $DOCROOT does not exist. Set DOCROOT= and re-run."
fi

# A docroot INSIDE the install root would make the flip point a tree at itself.
case "$DOCROOT" in
  "$ROOT"|"$ROOT"/*) die "DOCROOT ($DOCROOT) is inside ROOT ($ROOT). That cannot be right; stopping." ;;
esac

IS_LINK=0; LINK_TARGET=""
if [ -L "$DOCROOT" ]; then IS_LINK=1; LINK_TARGET="$(readlink "$DOCROOT")"; fi
BACKUP=0
[ -e "$DOCROOT.pre-pull" ] && BACKUP=1

VERDICT="$(docroot_verdict "$IS_LINK" "$LINK_TARGET" "$ROOT/current" "$BACKUP")"

# ALREADY_FLIPPED decides two things further down:
#   - whether an existing .pre-pull is a fault or the expected post-install state
#   - whether step 5 may use --bootstrap, which is UNSAFE once the docroot is live
ALREADY_FLIPPED=0

info "docroot state: $([ "$IS_LINK" = 1 ] && echo "symlink -> $LINK_TARGET" || echo "real directory"), .pre-pull $([ "$BACKUP" = 1 ] && echo present || echo absent)  =>  $VERDICT"

case "$VERDICT" in
  resume)
    ALREADY_FLIPPED=1
    info "docroot is ALREADY FLIPPED -> $LINK_TARGET"
    if [ "$BACKUP" = 1 ]; then
      info "$DOCROOT.pre-pull present — the backup left by the flip that is currently live (expected)"
      info "RESUMING an existing install: steps 1-4 are idempotent, step 7 is already done"
    fi
    ;;
  pre-flip)
    info "docroot $DOCROOT is a real directory (expected, pre-flip)"
    ;;
  foreign-link)
    info "NOTE: $DOCROOT is a symlink -> $LINK_TARGET (not this install's $ROOT/current)"
    ;;
  refuse-buried)
    die "$DOCROOT.pre-pull already exists, but $DOCROOT is NOT this install's symlink.
   The flip would rename the docroot onto that backup and lose the tree underneath it.
   Resolve by hand: decide which of the two trees is the one you want, then remove or
   rename the other before re-running."
    ;;
  refuse-foreign)
    die "$DOCROOT.pre-pull already exists, and $DOCROOT is a symlink -> $LINK_TARGET,
   which is NOT this install's $ROOT/current.
   Two installs, or a half-finished one, are pointing at the same docroot name.
   Resolve by hand: decide which tree production should serve, then remove or rename
   the other before re-running."
    ;;
  *)
    die "internal: unknown docroot verdict '$VERDICT'"
    ;;
esac

# Same exit-code table the puller carries. A preflight that can only say "000"
# sends you looking at the network when the fault is in the invocation.
curl_why() {
  case "$1" in
    0)  echo "no error" ;;
    2)  echo "curl could not parse its command line — almost always an option THIS curl is" \
             "too old to know (see the flag it names below). Nothing was sent" ;;
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

# The release branch must exist, or --bootstrap has nothing to pull.
# Written under $ROOT-to-be's parent rather than a bare /tmp/x.$$ so a hostile or
# full /tmp is a reported write error (exit 23), not a mystery.
REL_TMP="$(mktemp "${TMPDIR:-/tmp}/prb-rel.XXXXXX")" || die "cannot create a temp file — is ${TMPDIR:-/tmp} writable and non-full?"
REL_ERR="$(mktemp "${TMPDIR:-/tmp}/prb-curl.XXXXXX")" || die "cannot create a temp file in ${TMPDIR:-/tmp}"
REL_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/RELEASE.json"
trap 'rm -f "$REL_TMP" "$REL_ERR"' EXIT

# No -f here: we want to SEE the status code rather than have --fail collapse
# every distinguishable outcome into exit 22.
RC=0
HTTP="$(curl -sS --connect-timeout 10 --max-time 20 -w '%{http_code}' \
        -o "$REL_TMP" "$REL_URL" 2>"$REL_ERR")" || RC=$?
if [ "$RC" -ne 0 ]; then
  printf '\n!! could not fetch %s\n' "$REL_URL" >&2
  printf '   curl exit %s — %s\n' "$RC" "$(curl_why "$RC")" >&2
  printf '   HTTP status: %s\n' "${HTTP:-000 (request never completed)}" >&2
  if [ -s "$REL_ERR" ]; then sed 's/^/   curl: /' "$REL_ERR" >&2; else printf '   curl wrote nothing to stderr\n' >&2; fi
  die "aborting on the fetch failure above — this is the invocation or the host, not the branch."
fi
if [ "$HTTP" = 404 ]; then
  if [ "$TARGET" = production ]; then
    die "branch '$BRANCH' has no RELEASE.json yet (HTTP 404).
   Run 'Publish Epik release artifact' with target=production AND confirm=false.
   confirm=false matters: the confirm step polls https://prorigbuilder.com, which
   still answers from Railway until the edge is repointed, so with confirm on it
   would poll for ~20 minutes and fail a publish that actually succeeded."
  fi
  die "branch '$BRANCH' has no RELEASE.json yet (HTTP 404).
   Run the 'Publish Epik release artifact' workflow first (target: staging), then re-run this."
fi
[ "$HTTP" = 200 ] || die "$REL_URL returned HTTP $HTTP — expected 200."

# JSON.parse, NOT require(). require() on a path whose extension is not .json
# loads it with the .js loader, so valid JSON dies as a SyntaxError and the
# fallback prints "(unparseable)" for a file that parsed fine all along.
REL_DESC="$(node -e '
  const fs=require("fs");
  let o; try { o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
  catch(e) { console.error("RELEASE.json did not parse: "+e.message); process.exit(3); }
  if (!o.source_sha) { console.error("RELEASE.json has no source_sha"); process.exit(4); }
  console.log(o.source_sha.slice(0,12)+" built "+(o.built_at||"?")+"  files="+(o.file_count??"?"));
' "$REL_TMP" 2>&1)" || die "the published RELEASE.json is not usable:
   $REL_DESC"
info "published release: $REL_DESC"
rm -f "$REL_TMP" "$REL_ERR"
trap - EXIT

echo
info "REVERSE ANY TIME:  bash $0 --uninstall"

# ── 1. tree ─────────────────────────────────────────────────────────────────
say "Creating $ROOT"
mkdir -p "$ROOT"/{bin,releases,state,tmp,log,secrets}
# 711, NOT 700. LiteSpeed's core reads AuthUserFile as `nobody` — suEXEC governs
# CGI, not the auth db — so `nobody` needs +x on secrets/ to traverse into it.
# At 700 every request is a 401 EVEN WITH THE CORRECT PASSWORD.
#
# This line runs on EVERY invocation, including a resume, so it silently reverted
# a box that scripts/rotate-staging-auth.sh had already set to 711 and turned a
# green staging install into a total 401. Same measurement, same reason, both
# scripts: keep this in step with rotate-staging-auth.sh.
#
# PRODUCTION is 700, not 711. The 711 exists for exactly one reason — letting
# `nobody` traverse INTO secrets/ to read the auth db named by the staging
# guard's AuthUserFile. A production artifact carries no guard, no AuthUserFile
# and no .htpasswd (asserted three times: build-epik.cjs, publish-epik.yml, and
# epik-pull.sh's EXPECT_GUARD=0 branch), so nothing on the production path ever
# reads this directory and the server has no business traversing it.
chmod "$SECRETS_MODE" "$ROOT/secrets"
if [ "$SECRETS_MODE" = 711 ]; then
  info "done (secrets/ 711 — server reads the auth db as 'nobody')"
else
  info "done (secrets/ 700 — nothing on the production path reads it)"
fi

# ── 2. the credential the artifact deliberately does not carry ──────────────
# The release branch is PUBLIC — that is what lets the box pull with no
# credential — so the Basic-Auth hash lives here, never in the artifact.
#
# PRODUCTION writes NO .htpasswd, anywhere. There is no guard to authenticate
# against, so a credential here would be a secret on disk protecting nothing —
# and a stray .htpasswd is exactly what the artifact assertions hunt for.
if [ "$TARGET" = production ]; then
  say "Basic-Auth credential — skipped (production is unauthenticated)"
  if [ -s "$ROOT/secrets/.htpasswd" ]; then
    die "$ROOT/secrets/.htpasswd exists on a PRODUCTION install root.
   Nothing on the production path reads it, so it is either a copy-paste from the
   staging install or the wrong ROOT. Remove it (or fix ROOT=) and re-run."
  fi
  info "no .htpasswd written; secrets/ stays empty and 700"
elif [ -s "$ROOT/secrets/.htpasswd" ]; then
  info "secrets/.htpasswd already present — keeping it"
  # Repair the MODE, never the contents — an install re-run must not disturb a
  # rotated credential. 644 for the same reason secrets/ is 711: the server reads
  # this file as `nobody`, so 600 is a guaranteed 401.
  chmod 644 "$ROOT/secrets/.htpasswd"
  if [ -z "${EPIK_STAGING_BASIC_AUTH:-}" ] && [ ! -s "$ROOT/config" ]; then
    printf '   Enter the SAME user:password again (needed for config): ' >&2
    read -r EPIK_STAGING_BASIC_AUTH < /dev/tty
  fi
else
  if [ -z "${EPIK_STAGING_BASIC_AUTH:-}" ]; then
    printf '   Basic-Auth USER (must match the EPIK_STAGING_BASIC_AUTH repo secret): '
    read -r AUSER < /dev/tty
    printf '   Basic-Auth PASSWORD (not echoed): '
    read -rs APASS < /dev/tty; echo
    EPIK_STAGING_BASIC_AUTH="$AUSER:$APASS"
  fi
  AUSER="${EPIK_STAGING_BASIC_AUTH%%:*}"
  APASS="${EPIK_STAGING_BASIC_AUTH#*:}"
  [ -n "$AUSER" ] && [ -n "$APASS" ] || die "credential must be user:password"
  # APR1 (MD5-crypt), the same format build-epik.cjs generates. NOT {SHA}.
  # MEASURED on the box 2026-08-12: LiteSpeed does not accept {SHA} htpasswd
  # entries and gives no format error — it answers 401 on every request, which is
  # indistinguishable from a wrong password and costs an hour of chasing modes
  # and paths. openssl is the tool here; this host has no htpasswd binary.
  # -stdin keeps the password out of `ps` and out of shell history.
  printf '%s:%s\n' "$AUSER" "$(printf '%s\n' "$APASS" | openssl passwd -apr1 -stdin)" \
    > "$ROOT/secrets/.htpasswd"
  # 644, matching what the SFTP tree shipped. The server reads this as `nobody`,
  # not as the owner, so 600 is a guaranteed 401. Measured on the box, not assumed.
  chmod 644 "$ROOT/secrets/.htpasswd"
  info "wrote secrets/.htpasswd for user '$AUSER' (mode 644)"
fi

# ── 3. the puller ───────────────────────────────────────────────────────────
say "Fetching epik-pull.sh from $REF"
PULL_ERR="$(mktemp "${TMPDIR:-/tmp}/prb-curl.XXXXXX")" || die "cannot create a temp file in ${TMPDIR:-/tmp}"
RC=0
curl -fsSL --connect-timeout 10 --max-time 60 "$RAW" -o "$ROOT/bin/epik-pull.sh" 2>"$PULL_ERR" || RC=$?
if [ "$RC" -ne 0 ]; then
  printf '\n!! could not fetch %s\n' "$RAW" >&2
  printf '   curl exit %s — %s\n' "$RC" "$(curl_why "$RC")" >&2
  [ "$RC" = 22 ] && printf '   (exit 22 with -f usually means 404: is deploy/epik-pull.sh on ref %s?)\n' "$REF" >&2
  if [ -s "$PULL_ERR" ]; then sed 's/^/   curl: /' "$PULL_ERR" >&2; fi
  rm -f "$PULL_ERR"
  die "aborting — nothing has been changed on this host."
fi
rm -f "$PULL_ERR"
[ -s "$ROOT/bin/epik-pull.sh" ] || die "$RAW fetched as an EMPTY file — refusing to install it"
bash -n "$ROOT/bin/epik-pull.sh" || die "fetched epik-pull.sh does not parse — refusing to install it"
chmod +x "$ROOT/bin/epik-pull.sh"
info "installed and parsed clean ($(wc -c < "$ROOT/bin/epik-pull.sh") bytes)"

# ── 3b. the lock reaper — the cron line runs it BEFORE flock every tick ──────
# Same verify-before-install discipline as the puller: a truncated or error-page
# download must never end up on the crontab path. Without it the new cron line
# would name a script that is not there and every tick would fail at the reaper.
say "Fetching lock-reaper.sh from $REF"
REAPER_ERR="$(mktemp "${TMPDIR:-/tmp}/prb-curl.XXXXXX")" || die "cannot create a temp file in ${TMPDIR:-/tmp}"
RC=0
curl -fsSL --connect-timeout 10 --max-time 60 "$RAW_REAPER" -o "$ROOT/bin/lock-reaper.sh" 2>"$REAPER_ERR" || RC=$?
if [ "$RC" -ne 0 ]; then
  printf '\n!! could not fetch %s\n' "$RAW_REAPER" >&2
  printf '   curl exit %s — %s\n' "$RC" "$(curl_why "$RC")" >&2
  [ "$RC" = 22 ] && printf '   (exit 22 with -f usually means 404: is deploy/lock-reaper.sh on ref %s?)\n' "$REF" >&2
  if [ -s "$REAPER_ERR" ]; then sed 's/^/   curl: /' "$REAPER_ERR" >&2; fi
  rm -f "$REAPER_ERR"
  die "aborting — the cron tick names lock-reaper.sh, so it must be installed."
fi
rm -f "$REAPER_ERR"
[ -s "$ROOT/bin/lock-reaper.sh" ] || die "$RAW_REAPER fetched as an EMPTY file — refusing to install it"
bash -n "$ROOT/bin/lock-reaper.sh" || die "fetched lock-reaper.sh does not parse — refusing to install it"
chmod +x "$ROOT/bin/lock-reaper.sh"
info "installed and parsed clean ($(wc -c < "$ROOT/bin/lock-reaper.sh") bytes)"

# ── 4. config — the ONLY difference between the staging and prod installs ────
# Production is unauthenticated, so the credential is forced empty here no matter
# what happens to be exported in the calling shell.
if [ "$TARGET" = production ]; then
  CFG_BASIC_AUTH=""
else
  CFG_BASIC_AUTH="${EPIK_STAGING_BASIC_AUTH:-}"
fi
say "Writing config"
if [ -s "$ROOT/config" ]; then
  info "config already exists — keeping it"
  # An already-installed box (one that predates the node-resolution fix) keeps its
  # config, so ENSURE NODE= is present and points at a working interpreter — this
  # is what repairs an existing box on a re-curl without rewriting anything else.
  EXISTING_NODE="$(sed -n 's/^NODE=//p' "$ROOT/config" | tail -1)"
  if [ -z "$EXISTING_NODE" ]; then
    printf 'NODE=%s\n' "$NODE_BIN" >> "$ROOT/config"
    info "added NODE=$NODE_BIN to existing config"
  elif [ -x "$EXISTING_NODE" ]; then
    info "config already records a working NODE=$EXISTING_NODE"
  else
    info "config NODE=$EXISTING_NODE is not executable (nvm upgrade?) — updating to $NODE_BIN"
    grep -v '^NODE=' "$ROOT/config" > "$ROOT/config.tmp"
    printf 'NODE=%s\n' "$NODE_BIN" >> "$ROOT/config.tmp"
    chmod 600 "$ROOT/config.tmp"
    mv -f "$ROOT/config.tmp" "$ROOT/config"
  fi
else
  # BASIC_AUTH is written EMPTY on production, not omitted — epik-pull.sh reads
  # `${BASIC_AUTH:-}` and sends no -u for an empty value, and an explicit empty
  # line documents that the omission is intended rather than lost.
  cat > "$ROOT/config" <<CFG
REPO=$REPO
BRANCH=$BRANCH
SITE_URL=$SITE_URL
DOCROOT=$DOCROOT
BASIC_AUTH=$CFG_BASIC_AUTH
EXPECT_GUARD=$EXPECT_GUARD
ORIGIN_IP=$ORIGIN_IP
ORIGIN_INSECURE=$ORIGIN_INSECURE
RETAIN=10
NODE=$NODE_BIN
CFG
  chmod 600 "$ROOT/config"
  info "wrote $ROOT/config (mode 600, EXPECT_GUARD=$EXPECT_GUARD)"
fi
# Written or not, say what the healthcheck will actually talk to. An empty
# ORIGIN_IP is legitimate — it just means "follow DNS", which is only correct
# once DNS points here.
CFG_ORIGIN="$(sed -n 's/^ORIGIN_IP=//p' "$ROOT/config" 2>/dev/null | head -1)"
if [ -n "$CFG_ORIGIN" ]; then
  info "healthchecks pinned to origin $CFG_ORIGIN (curl --resolve $SITE_URL -> $CFG_ORIGIN)"
  if [ -n "${SSH_CONNECTION:-}" ] && [ "$CFG_ORIGIN" = "$(printf '%s' "$SSH_CONNECTION" | awk '{print $3}')" ]; then
    info "  (that is the address this SSH session reached the box on)"
  fi
else
  info "NO ORIGIN_IP in $ROOT/config — healthchecks will follow DNS for $SITE_URL."
  info "  Correct only if that name already resolves to this box. If it does not,"
  info "  the check measures the other stack and reports the difference as a fault here."
  # An existing config is kept, not rewritten — but a config written before this
  # option existed is exactly the case that produced a false "unhealthy". Offer
  # the one line rather than editing someone's file behind their back.
  if [ -n "$ORIGIN_IP" ]; then
    info "  This session reached the box on $ORIGIN_IP."
    if ask "Add ORIGIN_IP=$ORIGIN_IP to $ROOT/config?" PIN; then
      printf 'ORIGIN_IP=%s\n' "$ORIGIN_IP" >> "$ROOT/config"
      info "appended ORIGIN_IP=$ORIGIN_IP — healthchecks are now pinned to this box"
    else
      info "skipped. Add it later with: echo ORIGIN_IP=$ORIGIN_IP >> $ROOT/config"
    fi
  else
    info "  Add it with: echo ORIGIN_IP=<this box's public IP> >> $ROOT/config"
  fi
fi

# ── 5. the pull ─────────────────────────────────────────────────────────────
# Both paths run the FULL verification — per-file manifest hashes, manifest_sha256,
# required files, guard present, no .htpasswd. What differs is what happens after it.
if [ "$ALREADY_FLIPPED" = 1 ]; then
  # The docroot already points at $ROOT/current, so moving `current` IS a live
  # deploy. --bootstrap exists for the case where nothing serves the tree yet, and
  # on that premise it skips the docroot assertion, the healthcheck AND the
  # rollback. Running it here would swap the live site with none of the three.
  # The routine path asserts the docroot, healthchecks at T+15s and T+45s, and
  # rolls back on failure — and exits silently if the live sha already matches.
  say "Pull (routine path — the docroot is live, so this is a real deploy)"
  info "no-op and silent if the published sha is already what is live"
  "$ROOT/bin/epik-pull.sh"
else
  say "Bootstrap pull (full verification, nothing goes live)"
  "$ROOT/bin/epik-pull.sh" --bootstrap
fi

# ── 6. look at what landed ──────────────────────────────────────────────────
say "What landed"
info "current -> $(readlink "$ROOT/current")"
node -e 'const o=require(process.argv[1]);console.log("   release "+o.source_sha.slice(0,12)+"  files="+o.file_count+"  htaccess_changed="+o.htaccess_changed)' \
  "$ROOT/current/RELEASE.json" 2>/dev/null || info "(RELEASE.json unreadable)"
# Asserted in BOTH directions, matching epik-pull.sh's EXPECT_GUARD branch. A
# staging artifact that lost its guard is publicly crawlable; a production
# artifact that CARRIES one 401s the live site the moment the docroot flips.
if [ "$EXPECT_GUARD" = 1 ]; then
  if grep -q 'PRB-STAGING-GUARD' "$ROOT/current/.htaccess"; then
    info "staging Basic-Auth guard present in .htaccess (required)"
  else
    die "the pulled artifact has NO staging guard — it would be publicly crawlable. Stopping."
  fi
else
  if grep -q 'PRB-STAGING-GUARD' "$ROOT/current/.htaccess"; then
    die "the pulled artifact CARRIES the staging guard sentinel, on a production install.
   Flipping this docroot would 401 the live site. Stopping."
  fi
  # The sentinel is only a comment marker. Assert on the directives themselves so
  # a hand-edited or re-generated .htaccess cannot smuggle auth in without it.
  if grep -Eqi '^[[:space:]]*(AuthType|AuthName|AuthUserFile|Require[[:space:]]+valid-user)\b' "$ROOT/current/.htaccess"; then
    die "the pulled production artifact contains Basic-Auth directives without the sentinel.
   Stopping — this would 401 the live site."
  fi
  info "production artifact verified guard-free (no sentinel, no Auth* directives)"
fi
STRAY="$(find "$ROOT/releases" -name .htpasswd 2>/dev/null | head -1 || true)"
[ -n "$STRAY" ] && die "a .htpasswd is inside a release tree ($STRAY) — that must never ship. Stopping."
info "no .htpasswd inside any release tree"

# ── 7. the docroot flip — the one step that changes what the site serves ────
say "Docroot flip"
info "This renames $DOCROOT to $DOCROOT.pre-pull and puts a symlink in its place."
info "Nothing is deleted. Undo with: bash $0 --uninstall"
if [ "$DO_FLIP" = never ]; then
  info "NOT FLIPPING — bootstrap only (no --flip given)."
  info "$DOCROOT is untouched and still serves whatever it served before."
  info "The verified tree is staged at $ROOT/current, serving nothing."
  info "When you intend to change what production serves: bash $0 --production --flip"
elif [ "$ALREADY_FLIPPED" = 1 ]; then
  info "already flipped — skipping the flip"
  # Do not take the operator's word for it on a resume. Step 5 exits silently when
  # the published sha is already live, so without this a resumed run would install
  # the crontab entry having proved nothing about the site it is about to automate.
  say "Healthcheck of the already-live release"
  HC_RC=0
  "$ROOT/bin/epik-pull.sh" --check || HC_RC=$?
  if [ "$HC_RC" -eq 0 ]; then
    info "healthcheck PASSED — safe to proceed to the crontab step"
  elif [ "$HC_RC" -eq 3 ]; then
    # exit 3 is "could not verify", not "unhealthy" — but a cron entry that cannot
    # verify what it deploys is still not something to install on that basis.
    die "the healthcheck COULD NOT VERIFY this box (exit 3) — see the reason above. It has
   NOT reported a fault. Not installing a cron entry on an unverified site: pin the
   origin (ORIGIN_IP=<box ip> in $ROOT/config) and re-run this script."
  else
    die "the already-flipped docroot is UNHEALTHY. Not installing a cron entry that would
   deploy onto a broken site every 5 minutes. Fix it, or run: bash $0 --uninstall"
  fi
elif ask "Flip the $TARGET docroot ($DOCROOT) to the pull tree?" FLIP; then
  # Preflight already refused this combination. Re-checked immediately before the
  # one irreversible rename in the script, because the cost of being wrong here is
  # the original docroot buried under a directory of the same name.
  [ -e "$DOCROOT.pre-pull" ] && die "$DOCROOT.pre-pull appeared after preflight — refusing to rename onto it."
  mv "$DOCROOT" "$DOCROOT.pre-pull"
  ln -s "$ROOT/current" "$DOCROOT"
  info "flipped: $DOCROOT -> $(readlink "$DOCROOT")"
  info "previous tree preserved at $DOCROOT.pre-pull"

  say "Healthcheck against the live $TARGET site"
  HC_RC=0
  "$ROOT/bin/epik-pull.sh" --check || HC_RC=$?
  if [ "$HC_RC" -eq 0 ]; then
    info "healthcheck PASSED"
  elif [ "$HC_RC" -eq 3 ]; then
    # The flip is a local rename of a symlink; its success is observable ON THE BOX
    # and does not depend on where a hostname points. Offering a rollback here —
    # or calling the site unhealthy — asserts a fault on evidence that shows none.
    printf '\n== Healthcheck could NOT VERIFY the site — and did not report a fault.\n'
    info "$SITE_URL is a DNS name. Nothing in the check proves it points at this box,"
    info "and before cutover it deliberately does not — it answers from the old stack."
    info "The flip itself is local and did succeed; verify it on the box, not over DNS:"
    info "  readlink $DOCROOT                 # -> $ROOT/current"
    info "  cat $ROOT/current/RELEASE.json"
    info "and verify what this box SERVES by pinning the origin:"
    info "  ORIGIN_IP=<this box's public IP> $ROOT/bin/epik-pull.sh --check"
    info "NOT offering a rollback: there is no evidence of anything to roll back from."
  else
    printf '\n!! Healthcheck FAILED after the flip.\n' >&2
    if ask "Roll the docroot back to the previous tree now?" ROLLBACK; then
      rm -f "$DOCROOT"; mv "$DOCROOT.pre-pull" "$DOCROOT"
      info "docroot rolled back. $TARGET is on the SFTP tree again."
      die "flip rolled back — investigate before retrying"
    fi
    die "left flipped and unhealthy at your instruction — fix or run --uninstall"
  fi
else
  info "skipped. $TARGET still serves the SFTP tree; the pull tree is staged but not live."
  info "Re-run this script when ready, or flip by hand (see PHASE-A-INSTALL.md §5)."
fi

# ── 8. crontab ──────────────────────────────────────────────────────────────
# Only stdout is redirected. The script is silent on stdout for routine no-op
# ticks and writes to stderr ONLY on failure, so cron mails you exactly when
# something broke and never otherwise. The absence of 2>&1 is deliberate.
say "Crontab"
if [ "$DO_CRON" = never ]; then
  # A */5 cron against an UNFLIPPED docroot is not harmless: the routine path
  # asserts the docroot and fails, so it would mail a failure every five minutes
  # and train the alarm to be ignored before it ever matters.
  info "NOT installing a cron entry — bootstrap only (no --cron given)."
  info "Deploy by hand while bootstrapping: $ROOT/bin/epik-pull.sh"
elif crontab -l 2>/dev/null | grep -qF "$CRON_LINE"; then
  info "entry already installed and current"
elif crontab -l 2>/dev/null | grep -qF "$ROOT/bin/epik-pull.sh"; then
  # An epik line exists but is not the current one — an OLDER install (e.g. the
  # bare `flock -n ... epik-pull.sh` line with no reaper and no run ceiling). That
  # exact line is what let a wedged tick hold the lock for 9.5h, so REPLACE it in
  # place rather than leaving it. Idempotent: it swaps the one epik line and keeps
  # everything else (MAILTO, other jobs) untouched.
  info "found an OLDER epik cron line — upgrading it to the reaper + run-ceiling line"
  { crontab -l 2>/dev/null | grep -vF "$ROOT/bin/epik-pull.sh"; \
    echo "$CRON_LINE"; } | crontab -
  info "upgraded: $CRON_LINE"
elif ask "Install the */5 cron entry (reaper + flock + run ceiling; mails you only on failure)?" YES; then
  { crontab -l 2>/dev/null || true; \
    grep -q '^MAILTO=' <(crontab -l 2>/dev/null || true) || echo "MAILTO=coby@tiereduptech.com"; \
    echo "$CRON_LINE"; } | crontab -
  info "installed: $CRON_LINE"
else
  info "skipped — no automatic pulls. Run $ROOT/bin/epik-pull.sh by hand to deploy."
fi

# ── done ────────────────────────────────────────────────────────────────────
if [ "$TARGET" = production ]; then
  say "Production bootstrap complete — nothing is serving this tree yet"
  info "docroot:   $DOCROOT  ($([ -L "$DOCROOT" ] && echo "symlink -> $(readlink "$DOCROOT")" || echo "real directory, UNTOUCHED"))"
  info "staged:    $ROOT/current -> $(readlink "$ROOT/current" 2>/dev/null || echo '?')"
  info "config:    EXPECT_GUARD=0, BASIC_AUTH empty, secrets/ $SECRETS_MODE and empty"
  echo
  # $SITE_URL still answers from Railway until the edge is repointed, so any curl
  # against it right now describes Railway, not this box. Saying so beats printing
  # a check that returns a confusing 200 from the wrong origin.
  info "NOTE: $SITE_URL still resolves to Railway via Cloudflare. Do not read a 200"
  info "      there as evidence about this box — it is not serving production traffic."
  info "      Verify the staged tree on the box instead:"
  info "        cat $ROOT/current/RELEASE.json"
  info "        ls -la $DOCROOT"
  echo
  info "reverse:   bash $0 --production --uninstall DOCROOT=$DOCROOT"
  info "Next (a SEPARATE, deliberate step): bash $0 --production --flip"
else
  say "Phase A install complete"
  info "status:    curl -u USER:PASS $SITE_URL/_deploy-status.json"
  info "invariant: curl -u USER:PASS $SITE_URL/_env.php"
  info "ops denied: curl -u USER:PASS -I $SITE_URL/_ops/epik-fixture.json   (expect 403)"
  info "reverse:   bash $0 --uninstall"
  echo
  info "Next: set repo variable EPIK_WATCH_STAGING=true to arm the 30-minute watchdog,"
  info "then publish again with confirm ON to prove the full loop end to end."
fi
