#!/bin/bash
# cron-diagnose.sh — why the */5 epik-pull entry never ticks.
#
# Part A is READ-ONLY. It answers: is cron enabled for this account, does the
# log dir exist and take writes, is there failure mail, is the frequency being
# rejected — plus the three failure modes that fit "runs by hand, never by cron"
# better than any of those: a held lock, CRLF line endings, and a spool file
# with no trailing newline.
#
# Part B only runs with PROBE=1. It installs a */1 probe entry, waits ~2 min,
# prints cron's ACTUAL environment, and restores the crontab it captured.
#
#   ROOT=$HOME/prb-staging bash cron-diagnose.sh
#   ROOT=$HOME/prb         bash cron-diagnose.sh
#   PROBE=1 ROOT=$HOME/prb-staging bash cron-diagnose.sh
#
ROOT="${ROOT:-$HOME/prb-staging}"
LOG="$ROOT/log/deploy.log"
LOCK="$ROOT/deploy.lock"
PULL="$ROOT/bin/epik-pull.sh"

h() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
now_epoch=$(date -u +%s)
age() { # age <file> -> human age of mtime, or "MISSING"
  [ -e "$1" ] || { echo MISSING; return; }
  local m; m=$(stat -c %Y "$1" 2>/dev/null) || { echo '?'; return; }
  echo "$(( (now_epoch - m) / 60 )) min ago  ($(date -u -d "@$m" '+%H:%M:%SZ'))"
}

echo "host=$(hostname)  user=$(whoami)  uid=$(id -u)  now=$(date -u '+%H:%M:%SZ')"
echo "ROOT=$ROOT"

# ── 1. Did cron invoke the LINE? ────────────────────────────────────────────
# The >> redirect is opened by cron's shell before flock runs. A recent mtime
# here means cron fired and something AFTER the redirect failed. A stale mtime
# means cron never ran the line at all — which splits the whole diagnosis.
h "1. did cron invoke the line at all?"
echo "deploy.log mtime : $(age "$LOG")"
echo "deploy.log size  : $(stat -c %s "$LOG" 2>/dev/null || echo MISSING)"
echo "log dir          : $([ -d "$ROOT/log" ] && echo exists || echo MISSING) / $([ -w "$ROOT/log" ] && echo writable || echo NOT-WRITABLE)"
echo "log dir perms    : $(stat -c '%A %U:%G' "$ROOT/log" 2>/dev/null || echo -)"
if [ -w "$ROOT/log" ]; then
  if echo "# cron-diagnose write test $(date -u +%FT%TZ)" >> "$LOG" 2>/dev/null; then
    echo "append test      : OK"
  else
    echo "append test      : FAILED — the >> in the cron line cannot open this file"
  fi
fi
echo "--- last 15 lines of deploy.log ---"
tail -n 15 "$LOG" 2>/dev/null || echo "(none)"

# ── 2. The lock. flock -n exits 1 and prints NOTHING if the lock is held. ───
h "2. is the flock being taken? (manual runs bypass flock entirely)"
echo "lock file        : $([ -e "$LOCK" ] && echo "exists, $(age "$LOCK")" || echo absent)"
if command -v fuser >/dev/null 2>&1; then
  echo -n "lock holder      : "; fuser "$LOCK" 2>&1 || echo "(none / fuser blind)"
fi
if command -v lsof >/dev/null 2>&1; then
  echo "lsof             : $(lsof "$LOCK" 2>/dev/null | tail -n +2 || echo '(none)')"
fi
echo "stray pulls      :"; pgrep -a -f 'epik-pull.sh' 2>/dev/null || echo "  (no epik-pull.sh running)"
echo "stray flocks     :"; pgrep -a -f "flock.*deploy.lock" 2>/dev/null || echo "  (no flock holding it)"
# Prove it empirically: can a non-blocking flock be taken right now?
if command -v flock >/dev/null 2>&1; then
  if flock -n "$LOCK" true 2>/dev/null; then
    echo "flock -n now     : ACQUIRED (lock is free — not the cause)"
  else
    echo "flock -n now     : *** REFUSED (rc=$?) — every */5 tick is a silent no-op ***"
  fi
fi

# ── 3. flock itself, at the ABSOLUTE path the crontab line names ───────────
h "3. flock, at the path the crontab line hardcodes"
echo "command -v flock : $(command -v flock || echo NOT-FOUND)"
echo "/usr/bin/flock   : $(ls -l /usr/bin/flock 2>&1)"
echo "  -x test        : $([ -x /usr/bin/flock ] && echo executable || echo 'NOT EXECUTABLE / ABSENT')"
crontab -l 2>/dev/null | grep -F 'epik-pull.sh' | grep -oE '^[^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+' \
  | awk '{print "cron line names  : "$6}'

# ── 4. The script the line execs ───────────────────────────────────────────
h "4. the script itself"
echo "path             : $(ls -l "$PULL" 2>&1)"
echo "  -x test        : $([ -x "$PULL" ] && echo executable || echo 'NOT EXECUTABLE — flock exec fails, rc=126')"
if [ -f "$PULL" ]; then
  if head -c 200 "$PULL" | grep -q $'\r'; then
    echo "line endings     : *** CRLF FOUND — shebang is '#!/usr/bin/env bash\\r', exec fails."
    echo "                       'bash $PULL' works by hand; exec-by-cron does not.  Fix: sed -i 's/\\r$//' $PULL"
  else
    echo "line endings     : LF (clean)"
  fi
  echo "shebang          : $(head -n1 "$PULL" | cat -A)"
  # Resolve the shebang WITHOUT running the script — epik-pull.sh deploys, and a
  # diagnostic must not deploy. This answers the 126/127 question on its own.
  SHB="$(head -n1 "$PULL" | sed 's/^#!//; s/\r$//' | awk '{print $1}')"
  if [ -n "$SHB" ]; then
    echo "interpreter      : $SHB $([ -x "$SHB" ] && echo '(executable)' || echo '*** NOT EXECUTABLE / ABSENT -> exec rc=127 ***')"
    case "$SHB" in
      */env) INTERP="$(head -n1 "$PULL" | sed 's/\r$//' | awk '{print $2}')"
             echo "  env resolves   : $INTERP -> $(env -i PATH=/usr/bin:/bin command -v "$INTERP" 2>/dev/null || echo '*** NOT ON CRON PATH (/usr/bin:/bin) -> rc=127 ***')" ;;
    esac
  fi
  # Syntax-check only. -n parses the file and exits; it executes nothing.
  echo -n "bash -n parse    : "; bash -n "$PULL" 2>&1 && echo OK
fi

# ── 5. Is the entry actually IN the spool, and will crond read it? ─────────
h "5. the crontab as crond sees it"
echo "--- crontab -l ---"
crontab -l 2>&1
echo "--- end ---"
CRON_TXT="$(crontab -l 2>/dev/null || true)"
echo "entry present    : $(printf '%s' "$CRON_TXT" | grep -cF 'epik-pull.sh') line(s)"
echo "MAILTO present   : $(printf '%s' "$CRON_TXT" | grep -c '^MAILTO=')"
# The classic silent killer: no trailing newline => crond ignores the LAST line.
if [ -n "$CRON_TXT" ]; then
  LASTLINE="$(printf '%s' "$CRON_TXT" | tail -n1)"
  echo "last line        : $LASTLINE"
  case "$LASTLINE" in
    *epik-pull.sh*) echo "  NOTE: the epik entry is the LAST line — if the spool file has no trailing"
                    echo "        newline, crond silently ignores it. See the spool check below." ;;
  esac
fi
for SPOOL in /var/spool/cron/"$(whoami)" /var/spool/cron/crontabs/"$(whoami)"; do
  [ -r "$SPOOL" ] || continue
  echo "spool            : $SPOOL"
  echo "  stat           : $(stat -c '%A %U:%G %s bytes  mtime %y' "$SPOOL")"
  if [ "$(tail -c1 "$SPOOL" | xxd -p 2>/dev/null)" = "0a" ]; then
    echo "  trailing \\n    : yes"
  else
    echo "  trailing \\n    : *** MISSING — crond ignores the final line ***"
  fi
done
[ -r /var/spool/cron/"$(whoami)" ] || echo "spool            : not readable from here (CageFS) — use PROBE=1 to test empirically"

# ── 6. Is cron enabled for this account at all? ────────────────────────────
h "6. is cron enabled for this account / this frequency"
for f in /etc/cron.deny /etc/cron.allow; do
  if [ -r "$f" ]; then
    echo "$f : $(grep -cx "$(whoami)" "$f" 2>/dev/null) match(es) for $(whoami)"
    echo "  contents: $(tr '\n' ' ' < "$f")"
  else
    echo "$f : not readable"
  fi
done
echo -n "crond running    : "; pgrep -x crond >/dev/null 2>&1 && echo yes || echo "not visible (normal under CageFS)"
# CloudLinux/cPanel frequency throttles announce themselves here.
for f in /var/cpanel/cpanel.config /usr/local/cpanel/version; do
  [ -r "$f" ] && echo "$f readable: $(grep -iE 'cron|throttle' "$f" 2>/dev/null | head -5)"
done
echo -n "LVE / CageFS     : "; [ -e /usr/bin/lveps ] || [ -d /var/cagefs ] && echo "present" || echo "no marker found"
command -v lveinfo >/dev/null 2>&1 && lveinfo --period=1d 2>/dev/null | tail -5

# ── 7. Mail: cron's own failure reports ────────────────────────────────────
h "7. cron failure mail"
echo "MAILTO           : $(printf '%s' "$CRON_TXT" | grep '^MAILTO=' || echo '(none)')"
for M in /var/spool/mail/"$(whoami)" "$HOME/mail" "$HOME/Maildir"; do
  [ -e "$M" ] || continue
  echo "$M : $(stat -c '%s bytes  mtime %y' "$M" 2>/dev/null)"
done
echo "--- ~/mail tree (newest first) ---"
ls -lt "$HOME"/mail/ 2>/dev/null | head -10 || echo "(no ~/mail)"
find "$HOME"/mail -type f -newermt '-1 day' 2>/dev/null | head -20
echo "--- local mbox tail (cron errors land here if delivery is local) ---"
tail -n 30 /var/spool/mail/"$(whoami)" 2>/dev/null || echo "(no local mbox / not readable)"
[ -e "$HOME/.forward" ] && echo ".forward: $(cat "$HOME/.forward")"

# ── 8. Quota — a full quota silently kills cron AND its mail ───────────────
h "8. disk / quota"
df -h "$HOME" 2>/dev/null | tail -2
command -v quota >/dev/null 2>&1 && quota -s 2>/dev/null || echo "(quota cmd unavailable)"
echo "home perms       : $(stat -c '%A %U:%G' "$HOME")"

# ── PART B: make cron answer for itself ────────────────────────────────────
if [ "${PROBE:-0}" = "1" ]; then
  h "PROBE — installing a */1 entry and waiting ~2 min for cron to speak"
  PLOG="$ROOT/log/cron-probe.log"
  PSH="$ROOT/tmp/cron-probe.sh"
  mkdir -p "$ROOT/log" "$ROOT/tmp"
  cat > "$PSH" <<'PROBE_EOF'
#!/bin/sh
echo "=== TICK $(date -u '+%F %T Z') pid=$$ ==="
echo "id       : $(id)"
echo "shell    : $SHELL"
echo "PATH     : $PATH"
echo "HOME     : $HOME"
echo "pwd      : $(pwd)"
echo "flock    : $(command -v flock 2>/dev/null || echo NOT-IN-CRON-PATH)"
echo "/usr/bin/flock exists: $([ -x /usr/bin/flock ] && echo yes || echo NO)"
echo "--- full env as cron gives it ---"
env | sort
echo "=== END TICK ==="
PROBE_EOF
  chmod +x "$PSH"
  : > "$PLOG"

  # Capture the crontab ONCE and restore this exact text afterwards.
  CRON_BAK="$(crontab -l 2>/dev/null || true)"
  printf '%s\n' "$CRON_BAK" > "$ROOT/tmp/crontab.bak"
  echo "crontab backed up to $ROOT/tmp/crontab.bak ($(printf '%s' "$CRON_BAK" | wc -l) lines)"
  echo "NOTE: reinstalling the crontab normalises its trailing newline. If §5 reported"
  echo "      a MISSING trailing newline, THAT was the bug and this probe just fixed it."

  { printf '%s\n' "$CRON_BAK"; echo "* * * * * /bin/sh $PSH >> $PLOG 2>&1"; } | crontab -
  echo "probe installed. waiting 130s ..."
  sleep 130
  crontab - < "$ROOT/tmp/crontab.bak"
  echo "crontab restored. verifying:"
  crontab -l 2>/dev/null | grep -c . | xargs -I{} echo "  {} lines back in place"
  crontab -l 2>/dev/null | grep -F 'epik-pull.sh' || echo "  *** epik entry NOT back — restore from $ROOT/tmp/crontab.bak ***"

  h "PROBE RESULT"
  if [ -s "$PLOG" ]; then
    echo "*** CRON RAN. Cron works for this account. The fault is in the LINE ***"
    cat "$PLOG"
  else
    echo "*** CRON DID NOT RUN IN 2 MINUTES ***"
    echo "A */1 entry that never fires is not a flock/script problem — cron is"
    echo "disabled or throttled for this account. That is a host-side ticket:"
    echo "ask Epik whether cron is enabled for $(whoami) and what the minimum interval is."
  fi
  rm -f "$PSH"
fi

h "done"
