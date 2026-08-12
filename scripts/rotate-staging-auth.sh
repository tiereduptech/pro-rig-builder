#!/usr/bin/env bash
# =============================================================================
#  Rotate the staging Basic-Auth credential, in all three places, in one pass.
#
#  Run this ON THE BOX. It is safe to fetch over plain curl from the PUBLIC repo
#  because it contains NO SECRET: the new password is generated here, on the
#  host, from /dev/urandom. That is deliberate and load-bearing —
#  publish-epik.yml's own header states the invariant this preserves:
#  "the staging Basic-Auth hash lives on the box, not in the artifact."
#  Never add a password to this file. Never pass one on the command line either
#  (it would be visible in `ps` and land in shell history); if you must supply
#  your own, export NEWPASS in the environment first.
#
#  Lives in scripts/ and NOT deploy/ on purpose: deploy/** on main triggers both
#  publish-epik.yml and deploy-epik.yml, which would publish and SFTP-deploy the
#  site as a side effect of committing an ops script.
#
#  Everything it prints is also tee'd to ~/prb-staging/rotate-<stamp>.log (0600)
#  and the new credential is written to secrets/ROTATED-<stamp>.txt (0600), so
#  losing the terminal costs nothing.
#
#  Reverse: the previous .htpasswd and config are copied to *.bak.<stamp> beside
#  the originals before anything is written.
# =============================================================================
set -u
umask 077   # every file this script creates is 0600/0700 from birth, incl. the log

ROOT="${1:-$HOME/prb-staging}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$ROOT/rotate-$STAMP.log"

[ -d "$ROOT" ] || { printf '!! no such root: %s\n' "$ROOT" >&2; exit 2; }
exec > >(tee -a "$LOG") 2>&1

printf '== staging Basic-Auth rotation  %s\n' "$STAMP"
printf '   root: %s\n   log:  %s\n' "$ROOT" "$LOG"

CFG="$ROOT/config"
HTP="$ROOT/secrets/.htpasswd"
OLDAUTH="$(sed -n 's/^BASIC_AUTH=//p' "$CFG" 2>/dev/null | head -1)"
DOCROOT="$(sed -n 's/^DOCROOT=//p' "$CFG" 2>/dev/null | head -1)"
DOCROOT="${DOCROOT:-$HOME/staging.prorigbuilder.com}"
SITE_URL="$(sed -n 's/^SITE_URL=//p' "$CFG" 2>/dev/null | head -1)"
SITE_URL="${SITE_URL:-https://staging.prorigbuilder.com}"

# ── 1. did the flip actually take? ───────────────────────────────────────────
# A 401 cannot answer this: it is emitted before any content is served, and the
# old SFTP tree carried a byte-identical guard (same AuthName "prb-staging").
# readlink is the only real test.
printf '\n== 1. docroot / flip state\n'
ls -ld "$DOCROOT" "$DOCROOT.pre-pull" 2>&1 | sed 's/^/   /'
printf '   current -> %s\n' "$(readlink "$ROOT/current" 2>&1)"

# ── 2. where the auth db is, and whether it is reachable ─────────────────────
printf '\n== 2. .htpasswd files under the root (expect ONLY secrets/.htpasswd)\n'
find "$ROOT" -name '.htpasswd*' -exec ls -l {} \; 2>&1 | sed 's/^/   /'
printf '   -- path traversal to the secrets dir (web server must be able to x-into each) --\n'
ls -ld "$HOME" "$ROOT" "$ROOT/secrets" 2>&1 | sed 's/^/   /'

# ── 3. what Apache is actually reading ───────────────────────────────────────
printf '\n== 3. live guard directives (via the docroot, symlink resolved)\n'
grep -n 'AuthType\|AuthName\|AuthUserFile\|Require' "$DOCROOT/.htaccess" 2>&1 | sed 's/^/   /'

# ── 4. does the stored hash match the credential the healthcheck uses? ───────
# This is what separates cause 1 (path/permissions) from cause 2 (stale file).
printf '\n== 4. stored hash vs config credential\n'
CAUSE="undetermined"
if [ -z "${OLDAUTH:-}" ]; then
  printf '   !! config has no BASIC_AUTH line\n'
  CAUSE="config never written"
else
  OU="${OLDAUTH%%:*}"; OP="${OLDAUTH#*:}"
  WANT="$OU:{SHA}$(printf '%s' "$OP" | openssl sha1 -binary | openssl base64)"
  printf '   config user:    %s\n' "$OU"
  printf '   expected entry: %s\n' "$WANT"
  if [ -r "$HTP" ]; then
    HAVE="$(cat "$HTP")"
    printf '   stored entry:   %s\n' "$HAVE"
    if [ "$WANT" = "$HAVE" ]; then
      CAUSE="CAUSE 1 — credential is self-consistent, so the 401 is path/permissions (see 2 and 3)"
    else
      CAUSE="CAUSE 2 — stale .htpasswd, almost certainly kept by an earlier run (install-phase-a.sh:175)"
    fi
  else
    CAUSE="CAUSE 1 — secrets/.htpasswd is MISSING or UNREADABLE"
  fi
fi
printf '   => %s\n' "$CAUSE"

# ── 5. rotate ────────────────────────────────────────────────────────────────
printf '\n== 5. rotating\n'
NEWUSER="${OLDAUTH%%:*}"; NEWUSER="${NEWUSER:-coby}"
# Alphanumeric only, on purpose: config is `.`-sourced by epik-pull.sh (line 69)
# with BASIC_AUTH unquoted, so a $, backtick, quote or space would break the
# puller at parse time on every cron tick.
NEWPASS="${NEWPASS:-$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)}"
[ "${#NEWPASS}" -ge 16 ] || { printf '!! generated password too short — aborting\n' >&2; exit 3; }

mkdir -p "$ROOT/secrets"
[ -f "$HTP" ] && { cp -p "$HTP" "$HTP.bak.$STAMP"; printf '   backed up %s\n' "$HTP.bak.$STAMP"; }
[ -f "$CFG" ] && { cp -p "$CFG" "$CFG.bak.$STAMP"; printf '   backed up %s\n' "$CFG.bak.$STAMP"; }

# byte-identical to install-phase-a.sh:193 and build-epik.cjs:129
printf '%s:{SHA}%s\n' "$NEWUSER" "$(printf '%s' "$NEWPASS" | openssl sha1 -binary | openssl base64)" > "$HTP"
chmod 600 "$HTP"
printf '   wrote %s for user %s\n' "$HTP" "$NEWUSER"

if grep -q '^BASIC_AUTH=' "$CFG" 2>/dev/null; then
  sed -i "s|^BASIC_AUTH=.*|BASIC_AUTH=$NEWUSER:$NEWPASS|" "$CFG"
else
  printf 'BASIC_AUTH=%s:%s\n' "$NEWUSER" "$NEWPASS" >> "$CFG"
fi
chmod 600 "$CFG"
printf '   updated BASIC_AUTH in %s\n' "$CFG"

CREDFILE="$ROOT/secrets/ROTATED-$STAMP.txt"
printf '%s:%s\n' "$NEWUSER" "$NEWPASS" > "$CREDFILE"
chmod 600 "$CREDFILE"

# ── 6. proof ─────────────────────────────────────────────────────────────────
printf '\n== 6. proof\n'
printf '   HTTP: %s\n' "$(curl -u "$NEWUSER:$NEWPASS" -sI -o /dev/null -w '%{http_code}' "$SITE_URL/" 2>&1)"
if [ -x "$ROOT/bin/epik-pull.sh" ]; then
  if "$ROOT/bin/epik-pull.sh" --check; then
    printf '   healthcheck PASSED\n'
  else
    printf '   healthcheck STILL FAILING — do NOT dismiss the installer prompt\n'
  fi
else
  printf '   (no bin/epik-pull.sh yet — skipping healthcheck)\n'
fi

# ── 7. the one thing that still needs a human ────────────────────────────────
printf '\n== 7. diagnosis: %s\n' "$CAUSE"
printf '\n   PASTE THIS AS THE EPIK_STAGING_BASIC_AUTH REPO SECRET:\n\n'
printf '       %s:%s\n\n' "$NEWUSER" "$NEWPASS"
printf '   Also saved to %s (0600)\n' "$CREDFILE"
printf '   Full log:     %s (0600)\n' "$LOG"
printf '   Until the repo secret matches, the next publish healthcheck will 401.\n'
