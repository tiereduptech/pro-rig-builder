#!/bin/bash
# =============================================================================
#  install-phase-a.sh — stand up the pull deploy on STAGING, on the Epik box.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  Production stays on Railway. DNS does not move. This script never touches
#  public_html or the production docroot, and it never deletes anything that was
#  here before it ran — the docroot flip RENAMES the existing tree to
#  <docroot>.pre-pull so it can be put straight back.
#
#  It stops and asks before each of the two steps that change live behaviour:
#  the docroot flip, and installing the crontab entry. Everything before those
#  is additive and reversible by deleting one directory.
#
#  Run it as:  curl -fsSL <raw url> -o ~/install-phase-a.sh && bash ~/install-phase-a.sh
#  Reverse it with:  bash ~/install-phase-a.sh --uninstall
#
#  Design + the measurements behind the numbers: deploy/DESIGN-pull-deploy.md
#  Manual equivalent of these steps:            deploy/PHASE-A-INSTALL.md
# =============================================================================
set -euo pipefail
umask 022

REPO="${REPO:-tiereduptech/pro-rig-builder}"
REF="${REF:-main}"
BRANCH="${BRANCH:-epik-release-staging}"
SITE_URL="${SITE_URL:-https://staging.prorigbuilder.com}"
DOCROOT="${DOCROOT:-/home/tier5415/staging.prorigbuilder.com}"
ROOT="${ROOT:-$HOME/prb-staging}"
RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy/epik-pull.sh"
CRON_LINE="*/5 * * * * /usr/bin/flock -n $ROOT/deploy.lock $ROOT/bin/epik-pull.sh >> $ROOT/log/deploy.log"

say()  { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n!! %s\n' "$*" >&2; exit 1; }
ask()  { # ask <prompt> <required-word>
  local reply
  printf '\n?? %s\n   Type %s to proceed, anything else to skip: ' "$1" "$2"
  read -r reply < /dev/tty || reply=""
  [ "$reply" = "$2" ]
}

# ── uninstall ───────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  say "Reversing Phase A"
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
  say "Phase A reversed. Staging is back on the SFTP-deployed tree."
  exit 0
fi

# ── 0. preflight ────────────────────────────────────────────────────────────
say "Preflight"
for c in curl tar sha256sum flock node php openssl crontab; do
  command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
done
info "required commands present"

mv --help 2>&1 | grep -q -- '-T' || die "this mv has no -T. Atomic swap is the whole design; stopping."
info "mv -T available"

[ -e "$DOCROOT" ] || die "docroot $DOCROOT does not exist. Set DOCROOT= and re-run."
if [ -L "$DOCROOT" ]; then
  info "NOTE: $DOCROOT is already a symlink -> $(readlink "$DOCROOT")"
else
  info "docroot $DOCROOT is a real directory (expected, pre-flip)"
fi
[ -e "$DOCROOT.pre-pull" ] && die "$DOCROOT.pre-pull already exists — a previous run left a backup. Resolve by hand."

# The release branch must exist, or --bootstrap has nothing to pull.
if ! curl -fsSL --max-time 20 "https://raw.githubusercontent.com/$REPO/$BRANCH/RELEASE.json" -o /tmp/prb-rel.$$ 2>/dev/null; then
  rm -f /tmp/prb-rel.$$
  die "branch '$BRANCH' has no RELEASE.json yet.
   Run the 'Publish Epik release artifact' workflow first (target: staging), then re-run this."
fi
info "published release: $(node -e 'const o=require("/tmp/prb-rel.'"$$"'");console.log(o.source_sha.slice(0,12)+" built "+o.built_at)' 2>/dev/null || echo '(unparseable)')"
rm -f /tmp/prb-rel.$$

echo
info "REVERSE ANY TIME:  bash $0 --uninstall"

# ── 1. tree ─────────────────────────────────────────────────────────────────
say "Creating $ROOT"
mkdir -p "$ROOT"/{bin,releases,state,tmp,log,secrets}
chmod 700 "$ROOT/secrets"
info "done"

# ── 2. the credential the artifact deliberately does not carry ──────────────
# The release branch is PUBLIC — that is what lets the box pull with no
# credential — so the Basic-Auth hash lives here, never in the artifact.
say "Staging Basic-Auth credential"
if [ -s "$ROOT/secrets/.htpasswd" ]; then
  info "secrets/.htpasswd already present — keeping it"
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
  # {SHA} entry, byte-identical to what build-epik.cjs generates.
  printf '%s:{SHA}%s\n' "$AUSER" "$(printf '%s' "$APASS" | openssl sha1 -binary | openssl base64)" \
    > "$ROOT/secrets/.htpasswd"
  chmod 600 "$ROOT/secrets/.htpasswd"
  info "wrote secrets/.htpasswd for user '$AUSER'"
fi

# ── 3. the puller ───────────────────────────────────────────────────────────
say "Fetching epik-pull.sh from $REF"
curl -fsSL "$RAW" -o "$ROOT/bin/epik-pull.sh" || die "could not fetch $RAW"
bash -n "$ROOT/bin/epik-pull.sh" || die "fetched epik-pull.sh does not parse — refusing to install it"
chmod +x "$ROOT/bin/epik-pull.sh"
info "installed and parsed clean ($(wc -c < "$ROOT/bin/epik-pull.sh") bytes)"

# ── 4. config — the ONLY difference between the staging and prod installs ────
say "Writing config"
if [ -s "$ROOT/config" ]; then
  info "config already exists — keeping it"
else
  cat > "$ROOT/config" <<CFG
REPO=$REPO
BRANCH=$BRANCH
SITE_URL=$SITE_URL
DOCROOT=$DOCROOT
BASIC_AUTH=$EPIK_STAGING_BASIC_AUTH
EXPECT_GUARD=1
RETAIN=10
CFG
  chmod 600 "$ROOT/config"
  info "wrote $ROOT/config (mode 600)"
fi

# ── 5. first pull, before anything is live ──────────────────────────────────
# --bootstrap skips the docroot assertion and the healthcheck (nothing is
# serving the tree yet) but still does the FULL verification: per-file manifest
# hashes, manifest_sha256, required files, guard present, no .htpasswd.
say "Bootstrap pull (full verification, nothing goes live)"
"$ROOT/bin/epik-pull.sh" --bootstrap

# ── 6. look at what landed ──────────────────────────────────────────────────
say "What landed"
info "current -> $(readlink "$ROOT/current")"
node -e 'const o=require(process.argv[1]);console.log("   release "+o.source_sha.slice(0,12)+"  files="+o.file_count+"  htaccess_changed="+o.htaccess_changed)' \
  "$ROOT/current/RELEASE.json" 2>/dev/null || info "(RELEASE.json unreadable)"
if grep -q 'PRB-STAGING-GUARD' "$ROOT/current/.htaccess"; then
  info "staging Basic-Auth guard present in .htaccess (required)"
else
  die "the pulled artifact has NO staging guard — it would be publicly crawlable. Stopping."
fi
STRAY="$(find "$ROOT/releases" -name .htpasswd 2>/dev/null | head -1 || true)"
[ -n "$STRAY" ] && die "a .htpasswd is inside a release tree ($STRAY) — that must never ship. Stopping."
info "no .htpasswd inside any release tree"

# ── 7. the docroot flip — the one step that changes what staging serves ─────
say "Docroot flip"
info "This renames $DOCROOT to $DOCROOT.pre-pull and puts a symlink in its place."
info "Nothing is deleted. Undo with: bash $0 --uninstall"
if [ -L "$DOCROOT" ] && [ "$(readlink "$DOCROOT")" = "$ROOT/current" ]; then
  info "already flipped — skipping"
elif ask "Flip the STAGING docroot to the pull tree?" FLIP; then
  mv "$DOCROOT" "$DOCROOT.pre-pull"
  ln -s "$ROOT/current" "$DOCROOT"
  info "flipped: $DOCROOT -> $(readlink "$DOCROOT")"
  info "previous tree preserved at $DOCROOT.pre-pull"

  say "Healthcheck against the live staging site"
  if "$ROOT/bin/epik-pull.sh" --check; then
    info "healthcheck PASSED"
  else
    printf '\n!! Healthcheck FAILED after the flip.\n' >&2
    if ask "Roll the docroot back to the previous tree now?" ROLLBACK; then
      rm -f "$DOCROOT"; mv "$DOCROOT.pre-pull" "$DOCROOT"
      info "docroot rolled back. Staging is on the SFTP tree again."
      die "flip rolled back — investigate before retrying"
    fi
    die "left flipped and unhealthy at your instruction — fix or run --uninstall"
  fi
else
  info "skipped. Staging still serves the SFTP tree; the pull tree is staged but not live."
  info "Re-run this script when ready, or flip by hand (see PHASE-A-INSTALL.md §5)."
fi

# ── 8. crontab ──────────────────────────────────────────────────────────────
# Only stdout is redirected. The script is silent on stdout for routine no-op
# ticks and writes to stderr ONLY on failure, so cron mails you exactly when
# something broke and never otherwise. The absence of 2>&1 is deliberate.
say "Crontab"
if crontab -l 2>/dev/null | grep -qF "$ROOT/bin/epik-pull.sh"; then
  info "entry already installed"
elif ask "Install the */5 cron entry (flock-guarded, mails you only on failure)?" YES; then
  { crontab -l 2>/dev/null || true; \
    grep -q '^MAILTO=' <(crontab -l 2>/dev/null || true) || echo "MAILTO=coby@tiereduptech.com"; \
    echo "$CRON_LINE"; } | crontab -
  info "installed: $CRON_LINE"
else
  info "skipped — no automatic pulls. Run $ROOT/bin/epik-pull.sh by hand to deploy."
fi

# ── done ────────────────────────────────────────────────────────────────────
say "Phase A install complete"
info "status:    curl -u USER:PASS $SITE_URL/_deploy-status.json"
info "invariant: curl -u USER:PASS $SITE_URL/_env.php"
info "ops denied: curl -u USER:PASS -I $SITE_URL/_ops/epik-fixture.json   (expect 403)"
info "reverse:   bash $0 --uninstall"
echo
info "Next: set repo variable EPIK_WATCH_STAGING=true to arm the 30-minute watchdog,"
info "then publish again with confirm ON to prove the full loop end to end."
