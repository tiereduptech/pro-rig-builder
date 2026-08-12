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

# Refuse to run against a production root. This script writes a WORLD-READABLE
# .htpasswd (see the chmod 644 below and why it has to be that), which is the
# right call for a staging gate and wrong everywhere else. Production carries no
# Basic-Auth guard at all, so there is nothing here for it to rotate.
GUARD="$(sed -n 's/^EXPECT_GUARD=//p' "$CFG" 2>/dev/null | head -1)"
if [ -n "${GUARD:-}" ] && [ "$GUARD" != 1 ]; then
  printf '!! %s has EXPECT_GUARD=%s — this root has no Basic-Auth guard.\n' "$CFG" "$GUARD" >&2
  printf '   Refusing to write a world-readable .htpasswd here.\n' >&2
  exit 4
fi

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
# Separates cause 0 (wrong hash FORMAT), cause 1 (path/permissions) and cause 2
# (stale file). APR1 is salted, so this cannot regenerate the entry and compare
# strings the way the old {SHA} version did — it has to re-hash the config
# password USING THE SALT ALREADY IN THE FILE and compare that.
#
# It also PROBES THE SITE FIRST rather than assuming a fault. This script is run
# to rotate a healthy box as often as to fix a broken one, and a verdict that
# says "so the 401 is path/permissions" when the site is answering 200 is just
# wrong — it invents a symptom to explain. Only claim a cause for a 401 that was
# actually observed.
printf '\n== 4. stored hash vs config credential\n'
CAUSE="undetermined"
PRE_CODE=''
if [ -n "${OLDAUTH:-}" ]; then
  PRE_CODE="$(curl -u "$OLDAUTH" -sI -o /dev/null -w '%{http_code}' \
              --connect-timeout 10 --max-time 30 "$SITE_URL/" 2>/dev/null || true)"
  printf '   live now:     HTTP %s  (with the CURRENT config credential)\n' "${PRE_CODE:-000}"
fi
if [ -z "${OLDAUTH:-}" ]; then
  printf '   !! config has no BASIC_AUTH line\n'
  CAUSE="config never written"
elif [ ! -r "$HTP" ]; then
  CAUSE="CAUSE 1 — secrets/.htpasswd is MISSING or UNREADABLE"
else
  OU="${OLDAUTH%%:*}"; OP="${OLDAUTH#*:}"
  HAVE="$(cat "$HTP")"
  STORED="${HAVE#*:}"
  printf '   config user:  %s\n' "$OU"
  printf '   stored entry: %s\n' "$HAVE"
  case "$STORED" in
    '{SHA}'*)
      # THE ONE THAT COST AN HOUR. LiteSpeed accepts APR1, not {SHA}; it emits no
      # format error, just a 401 that is indistinguishable from a bad password.
      CAUSE="CAUSE 0 — {SHA} hash. LiteSpeed does not accept it and 401s with NO format error. Rotating (step 5) rewrites it as APR1 and fixes this."
      ;;
    '$apr1$'*)
      SALT="$(printf '%s' "$STORED" | cut -d'$' -f3)"
      if [ -z "$SALT" ]; then
        CAUSE="CAUSE 2 — malformed APR1 entry (no salt field)"
      else
        WANT="$OU:$(printf '%s\n' "$OP" | openssl passwd -apr1 -salt "$SALT" -stdin)"
        printf '   re-hashed:    %s\n' "$WANT"
        if [ "$WANT" = "$HAVE" ]; then
          # Format right + credential matches. Whether that is a diagnosis or a
          # clean bill of health depends entirely on what the site just answered.
          case "${PRE_CODE:-000}" in
            200) CAUSE="NO FAULT — APR1 format correct, stored hash matches config, site answers 200. Nothing to diagnose; this is a routine rotation." ;;
            401) CAUSE="CAUSE 1 — format and credential are both right, so the observed 401 is path/permissions (see 2 and 3)" ;;
            000) CAUSE="format and credential are both right, but the site could not be reached at all — network/DNS/TLS, not auth (see the code above)" ;;
            *)   CAUSE="format and credential are both right, and the site answered HTTP ${PRE_CODE} — not an auth fault at all; look at the server, not this credential" ;;
          esac
        else
          CAUSE="CAUSE 2 — stale .htpasswd: the stored hash is not this config's password"
        fi
      fi
      ;;
    *)
      CAUSE="CAUSE 0 — unrecognised hash format. LiteSpeed needs APR1 (\$apr1\$...); anything else 401s silently."
      ;;
  esac
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
# 711 explicitly, because umask 077 above would otherwise make this 700 and the
# web server could not traverse in to read AuthUserFile. Unlistable on purpose —
# the backups and ROTATED-*.txt below live in this directory.
chmod 711 "$ROOT/secrets"
[ -f "$HTP" ] && { cp -p "$HTP" "$HTP.bak.$STAMP"; printf '   backed up %s\n' "$HTP.bak.$STAMP"; }
[ -f "$CFG" ] && { cp -p "$CFG" "$CFG.bak.$STAMP"; printf '   backed up %s\n' "$CFG.bak.$STAMP"; }

# ── APR1 (MD5-crypt), NOT {SHA}. MEASURED, NOT ASSUMED. ─────────────────────
# 2026-08-12 on the Epik box, same password, same file, same modes:
#     user:{SHA}1Owkl1srtSqntLaMo66IZP+by3c=   -> HTTP 401
#     user:$apr1$...  (openssl passwd -apr1)   -> HTTP 200
# LiteSpeed does not accept {SHA} htpasswd entries and does not say so — no
# format error, no log line, just 401 on every request. That is identical to the
# symptom of a wrong password, so it sends you auditing modes, paths and repo
# secrets while the credential was correct the whole time.
# openssl is the tool: this host has no htpasswd binary. -stdin keeps the
# password out of `ps` and out of shell history. Same format as
# deploy/install-phase-a.sh and build-epik.cjs — keep all three in step.
printf '%s:%s\n' "$NEWUSER" "$(printf '%s\n' "$NEWPASS" | openssl passwd -apr1 -stdin)" > "$HTP"
# ── DO NOT TIGHTEN THIS TO 600. MEASURED, NOT ASSUMED. ──────────────────────
# 2026-08-12 on the Epik box, hash byte-perfect, directory already 711:
#     .htpasswd 600 -> HTTP 401 on every request
#     .htpasswd 644 -> HTTP 200
# LiteSpeed reads AuthUserFile as `nobody`, not as the owner, so o+r is
# load-bearing. 600 fails silently: staging 401s forever with a credential that
# looks correct everywhere you would think to check it.
# Accepted trade-off: on a shared host the hash is readable by other local
# users. It is a salted APR1 (1000 MD5 rounds) of a 24-char random credential
# gating a staging site behind HTTPS, rotatable by re-running this script. If
# that stops being acceptable, switch to an IP allowlist — do NOT tighten the
# mode: 600 does not gain you security, it just 401s the site.
# Only this one file is loosened; the log and ROTATED-*.txt stay 600 via umask.
chmod 644 "$HTP"
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
