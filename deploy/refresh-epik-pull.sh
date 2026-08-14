#!/bin/bash
# =============================================================================
#  refresh-epik-pull.sh — put the CURRENT epik-pull.sh on every install root,
#  prove it took, and seed the status field the watchdog now requires.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  WHY THIS EXISTS. `<root>/bin/epik-pull.sh` is a COPY, curl'd once at install
#  time. Fixing the script in the repo does NOT fix the box: it silently keeps
#  running the old one with the old diagnostics, and every check you run after
#  that grades a script you did not think was there. That has cost real time
#  more than once, so the re-curl gets a file of its own rather than living in
#  a terminal block that scrolls away half-executed.
#
#  WHAT IT DOES, per root:
#    1. fetch the current script to <bin>/epik-pull.sh.new
#    2. VERIFY the download BEFORE anything is swapped — shebang, plausible
#       size, and the markers that prove it is the post-heartbeat version. A
#       truncated or redirected download must never replace a working script.
#       Same order as epik-pull.sh itself: verify everything, then swap.
#    3. swap it in atomically and chmod +x
#    4. re-grep the INSTALLED file. "curl exited 0" is not "the file on disk is
#       the new one", and that gap is the entire bug this script exists for.
#    5. run --check. This is what first writes `verified_at` into the status
#       file: touch_status() never adds that field, only a real verdict does,
#       so until this runs epik-watchdog.yml fails on its absence BY DESIGN.
#    6. read checked_at / verified_at back and print their ages, which is the
#       split working end to end rather than a claim that it should.
#
#  Safe to re-run. Idempotent. Touches no release, no docroot, no config, and
#  never deletes anything — a failed fetch leaves the old script exactly as it
#  was.
#
#  EXIT 0 only if every root that exists ended with the new script installed
#  AND a status file carrying verified_at. Anything else is non-zero: a check
#  that cannot run counts as a failure, never as a pass.
#
#  Roots default to staging + production. Override:
#    ROOTS="$HOME/prb-staging" bash ~/refresh-epik-pull.sh
# =============================================================================
set -u
umask 022
export PATH=/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}

REPO="${REPO:-tiereduptech/pro-rig-builder}"
REF="${REF:-main}"
RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy/epik-pull.sh"
RAW_REAPER="https://raw.githubusercontent.com/$REPO/$REF/deploy/lock-reaper.sh"
ROOTS="${ROOTS:-$HOME/prb-staging $HOME/prb}"

# The markers that distinguish the post-2026-08-12 script from the one that
# wrote nothing on a quiet tick. All three must be present: the heartbeat's
# definition, its call on the short-circuit path, and the field write_status
# now emits. Any one alone could survive a partial file.
MARK_DEF='touch_status() {'
MARK_CALL='touch_status; exit 0'
MARK_FIELD='verified_at'

# Markers that prove a lock-reaper.sh download is the real thing and not a
# truncated file or an error page: its pure decision function and the ghost case
# it exists for. Both must be present.
MARK_REAP_FN='lock_action() {'
MARK_REAP_GHOST='ghost'

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
note() {                   printf '  note  %s\n' "$*"; }

command -v node >/dev/null 2>&1 || { printf '\n!! node not found on PATH — needed to read the status file.\n' >&2; exit 2; }

printf '=============================================================\n'
printf ' refresh-epik-pull.sh\n'
printf '   source  %s\n' "$RAW"
printf '   roots   %s\n' "$ROOTS"
printf '   when    %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '=============================================================\n'

for R in $ROOTS; do
  printf '\n############ %s ############\n' "$R"

  if [ ! -d "$R/bin" ]; then
    SKIP=$((SKIP+1))
    note "no $R/bin — not installed here, skipping (not a failure)"
    continue
  fi

  NEW="$R/bin/epik-pull.sh.new"
  CUR="$R/bin/epik-pull.sh"

  # ── 1. fetch ──────────────────────────────────────────────────────────────
  rm -f "$NEW"
  rc=0
  curl -fsSL --connect-timeout 10 --max-time 60 "$RAW" -o "$NEW" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$NEW"
    bad "download failed (curl exit $rc) — $CUR left exactly as it was"
    continue
  fi

  # ── 2. verify BEFORE swapping ─────────────────────────────────────────────
  SZ="$(wc -c < "$NEW" 2>/dev/null | tr -d ' ')"
  BADFETCH=''
  case "$(head -1 "$NEW")" in
    '#!/bin/bash') : ;;
    *) BADFETCH="first line is not a bash shebang" ;;
  esac
  [ -z "$BADFETCH" ] && [ "${SZ:-0}" -lt 5000 ] && BADFETCH="only ${SZ} bytes — truncated or an error page"
  [ -z "$BADFETCH" ] && ! grep -qF "$MARK_DEF"   "$NEW" && BADFETCH="no touch_status() definition — this is the OLD script"
  [ -z "$BADFETCH" ] && ! grep -qF "$MARK_CALL"  "$NEW" && BADFETCH="touch_status is defined but never called on the quiet path"
  [ -z "$BADFETCH" ] && ! grep -qF "$MARK_FIELD" "$NEW" && BADFETCH="write_status does not emit verified_at"
  if [ -n "$BADFETCH" ]; then
    rm -f "$NEW"
    bad "downloaded file rejected: $BADFETCH — $CUR left exactly as it was"
    continue
  fi

  # ── 3. swap ───────────────────────────────────────────────────────────────
  if ! mv -f "$NEW" "$CUR"; then
    rm -f "$NEW"
    bad "could not replace $CUR (permissions?) — old script still in place"
    continue
  fi
  chmod +x "$CUR" || true

  # ── 4. prove it took, by reading the INSTALLED file ───────────────────────
  if grep -qF "$MARK_DEF" "$CUR" && grep -qF "$MARK_CALL" "$CUR" && grep -qF "$MARK_FIELD" "$CUR"; then
    ok "installed — $CUR now carries the heartbeat ($(wc -c < "$CUR" | tr -d ' ') bytes)"
  else
    bad "swap reported success but $CUR does NOT carry the markers — investigate by hand"
    continue
  fi

  # ── 4b. lock-reaper.sh — the cron tick names it, so refresh must place it ──
  # Same verify-before-swap discipline as the puller. The updated cron line runs
  # $R/bin/lock-reaper.sh BEFORE flock every tick; if it is missing the tick fails
  # at the reaper, so a refresh that updates the script but not the reaper would
  # break the box. A failed reaper fetch leaves the OLD reaper (if any) in place.
  RNEW="$R/bin/lock-reaper.sh.new"
  RCUR="$R/bin/lock-reaper.sh"
  rm -f "$RNEW"
  rrc=0
  curl -fsSL --connect-timeout 10 --max-time 60 "$RAW_REAPER" -o "$RNEW" || rrc=$?
  if [ "$rrc" -ne 0 ]; then
    rm -f "$RNEW"
    bad "lock-reaper download failed (curl exit $rrc) — ${RCUR} left as it was"
    continue
  fi
  RBAD=''
  case "$(head -1 "$RNEW")" in
    '#!/bin/bash') : ;;
    *) RBAD="first line is not a bash shebang" ;;
  esac
  RSZ="$(wc -c < "$RNEW" 2>/dev/null | tr -d ' ')"
  [ -z "$RBAD" ] && [ "${RSZ:-0}" -lt 1500 ]              && RBAD="only ${RSZ} bytes — truncated or an error page"
  [ -z "$RBAD" ] && ! grep -qF "$MARK_REAP_FN"    "$RNEW" && RBAD="no lock_action() — not the reaper"
  [ -z "$RBAD" ] && ! grep -qF "$MARK_REAP_GHOST" "$RNEW" && RBAD="no ghost handling — truncated reaper"
  if [ -n "$RBAD" ]; then
    rm -f "$RNEW"
    bad "lock-reaper download rejected: $RBAD — ${RCUR} left as it was"
    continue
  fi
  if ! mv -f "$RNEW" "$RCUR"; then
    rm -f "$RNEW"
    bad "could not install $RCUR (permissions?) — old reaper still in place"
    continue
  fi
  chmod +x "$RCUR" || true
  ok "installed — $RCUR ($(wc -c < "$RCUR" | tr -d ' ') bytes)"

  # ── 5. seed verified_at ───────────────────────────────────────────────────
  # --check is a real health measurement, so it writes BOTH fields. Until it
  # runs, the status file has no verified_at and the watchdog fails on that.
  CRC=0
  "$CUR" --check > "$R/tmp/refresh.check.out" 2>&1 || CRC=$?
  case "$CRC" in
    0) ok "--check passed — health measured, verified_at written" ;;
    3) bad "--check could not verify (exit 3): the site did not answer from this box.
        Set ORIGIN_IP (and ORIGIN_INSECURE=1 while the origin carries the
        Cloudflare Origin CA cert) in $R/config. This is NOT a verdict on the release." ;;
    *) bad "--check FAILED (exit $CRC) — output below" ;;
  esac
  if [ "$CRC" -ne 0 ] && [ -s "$R/tmp/refresh.check.out" ]; then
    sed 's/^/        /' "$R/tmp/refresh.check.out" | tail -25
  fi

  # ── 6. read the two fields back ───────────────────────────────────────────
  SF="$R/current/_deploy-status.json"
  if [ ! -f "$SF" ]; then
    bad "no status file at $SF — nothing has deployed here yet"
    continue
  fi
  OUT="$(node -e '
    const fs=require("fs");
    let o; try { o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
    catch(e) { console.log("PARSE_ERROR " + e.message); process.exit(0); }
    const age=(t)=>{ const m=(Date.now()-Date.parse(t))/60000;
                     return Number.isFinite(m) ? (m<90 ? m.toFixed(0)+" min" : (m/60).toFixed(1)+" h") : "unparseable"; };
    if (o.verified_at === undefined) { console.log("NO_VERIFIED_AT"); process.exit(0); }
    console.log("OK|health=" + o.health
              + "|loop ran " + age(o.checked_at) + " ago"
              + "|health measured " + age(o.verified_at) + " ago");
  ' "$SF" 2>/dev/null)"
  case "$OUT" in
    OK\|*)
      ok "status file: $(printf '%s' "$OUT" | sed 's/^OK|//; s/|/, /g')" ;;
    NO_VERIFIED_AT)
      bad "status file still has NO verified_at — the watchdog will fail on it.
        --check did not write, or an older script re-wrote the file after it." ;;
    PARSE_ERROR*)
      bad "status file is not valid JSON: ${OUT#PARSE_ERROR }" ;;
    *)
      bad "could not read $SF" ;;
  esac

  # ── 7. bring the crontab tick up to date ──────────────────────────────────
  # Replacing bin/epik-pull.sh does NOT change how cron INVOKES it, and the old
  # invocation — bare `flock -n ... epik-pull.sh` with no reaper and no run
  # ceiling — is exactly what let a wedged tick hold the lock for 9.5h. So the
  # crontab is where the fix actually lands. Idempotent: swap only the one epik
  # line for THIS root, leave MAILTO and every other entry untouched, and do
  # nothing at all if the line is already current. Skips a root that has no epik
  # line yet (not automated here — that is install-phase-a's job).
  WANT_CRON="*/5 * * * * $R/bin/lock-reaper.sh $R/deploy.lock ; /usr/bin/flock -n $R/deploy.lock /usr/bin/timeout -s KILL 600 $R/bin/epik-pull.sh >> $R/log/deploy.log"
  CUR_CRON="$(crontab -l 2>/dev/null || true)"
  if ! printf '%s\n' "$CUR_CRON" | grep -qF "$R/bin/epik-pull.sh"; then
    note "no cron line for $R yet — not adding one (run install-phase-a to install the tick)"
  elif printf '%s\n' "$CUR_CRON" | grep -qF "$WANT_CRON"; then
    ok "cron tick already current for $R (reaper + flock + run ceiling)"
  else
    # Back up the exact text before touching it, then replace the one epik line.
    printf '%s\n' "$CUR_CRON" > "$R/tmp/crontab.before-refresh" 2>/dev/null || true
    if printf '%s\n' "$CUR_CRON" | grep -vF "$R/bin/epik-pull.sh" | { cat; printf '%s\n' "$WANT_CRON"; } | crontab -; then
      if crontab -l 2>/dev/null | grep -qF "$WANT_CRON"; then
        ok "cron tick UPGRADED for $R — now runs lock-reaper + flock + timeout 600 (backup: $R/tmp/crontab.before-refresh)"
      else
        bad "crontab reinstalled but the new line is NOT present — restore from $R/tmp/crontab.before-refresh and fix by hand"
      fi
    else
      bad "could not rewrite the crontab for $R — old tick still in place (backup: $R/tmp/crontab.before-refresh)"
    fi
  fi
done

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n=============================================================\n'
printf ' %s ok, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]; then
  printf ' ALL CLEAR — every installed root runs the current script and carries\n'
  printf ' verified_at. The watchdog can now tell a stopped cron from a quiet one.\n'
  printf '=============================================================\n'
  exit 0
fi
if [ "$PASS" -eq 0 ]; then
  printf ' NOTHING WAS UPDATED — no install root was found under: %s\n' "$ROOTS"
  printf ' Set ROOTS= if the install moved.\n'
fi
printf ' NOT CLEAR — read the FAIL lines above. Any root still on the old script\n'
printf ' keeps the old behaviour silently, which is the trap this script exists for.\n'
printf '=============================================================\n'
exit 1
