#!/bin/bash
# =============================================================================
#  lock-reaper.sh — clear a stuck or GHOST deploy.lock before the flock tick.
#  Copyright © 2026 TieredUp Tech, Inc.
#
#  WHY THIS EXISTS. The */5 cron line takes the single-writer lock with
#  `flock -n deploy.lock`. `flock -n` no-ops when the lock is held — which is
#  correct for an overlapping tick, and CATASTROPHIC for a lock that is held
#  but going nowhere, because the wrapped command never runs, so nothing in the
#  puller can ever recover it. Recovery has to happen HERE, before flock, in a
#  command that runs whether or not the lock can be taken.
#
#  Two failure modes on 2026-08-14, both of which bare `flock -n` turned into a
#  PERMANENT silent no-op — every subsequent tick found the lock held and exited
#  1 without a word:
#    1. a deploy tick WEDGED (blocked with no wall-clock ceiling, in the
#       post-swap healthcheck) and held deploy.lock for 9.5 hours.
#    2. after those processes were killed, `ps` showed NOTHING running yet
#       `flock` still could not acquire — an orphaned open file description held
#       the lock invisibly, and only `rm -f` on the lock file cleared it. A lock
#       held by nothing at all is worse than the wedge: undetectable by `ps`,
#       unrecoverable without deleting the file.
#
#  So this runs unconditionally at the top of each tick and decides WHY the lock
#  is held before yielding to it:
#    - not held                      -> nothing to do
#    - a LIVE epik-pull holder,
#      younger than the ceiling       -> a normal overlapping tick; leave it
#    - a LIVE epik-pull holder,
#      OLDER than the ceiling         -> wedged past the run ceiling (the cron
#                                        line's `timeout` should have killed it;
#                                        this is the backstop) -> kill it, clear
#    - NO live epik-pull holder, yet
#      the lock is still held         -> a GHOST (orphaned fd) -> rotate the file
#                                        out of the way onto a fresh inode. This
#                                        is exactly the manual `rm -f`, done only
#                                        when no live process owns the lock.
#
#  ROTATE, don't just delete: `mv` the file aside so any orphan still holding
#  the old inode's fd keeps a NAMELESS, harmless file while every new tick locks
#  the fresh inode under the real name. Same outcome the manual `rm -f` had.
#
#  Always exits 0: the cron line is `lock-reaper.sh ... ; flock -n ...`, and a
#  reaper that fails must never stop the flock tick that follows it. It is SILENT
#  on a normal tick (nothing to reap) and writes to STDERR only when it acts, so
#  cron mails you exactly when a lock was reaped and never otherwise — the same
#  discipline as epik-pull.sh.
#
#  Truth table for the pure decision (lock_action) is off-box, no lock and no
#  processes required: test/lock-reaper.test.sh.
# =============================================================================
set -u
export PATH=/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}

# ── the decision, as a pure function ────────────────────────────────────────
# lock_action <held 0|1> <live_holder 0|1> <holder_age|-> <ceiling>
#   -> free | yield | reap | ghost
# No I/O, no globals — so the whole truth table runs off-box. Defined above the
# I/O and the LIB_ONLY early return, exactly like epik-pull.sh's hc_verdict().
lock_action() {
  local held="$1" live="$2" age="$3" ceiling="$4"
  if [ "$held" = 0 ]; then echo free;  return 0; fi
  if [ "$live" = 1 ]; then
    # A live holder we can age is reaped only once it is CLEARLY past the run
    # ceiling; anything younger (or an age we could not read) is a normal tick.
    if [ "$age" != - ] && [ "$age" -gt "$ceiling" ]; then echo reap; return 0; fi
    echo yield; return 0
  fi
  echo ghost
}

# Sourced by the test harness to get the function without touching a lock.
[ -n "${LOCK_REAPER_LIB_ONLY:-}" ] && return 0 2>/dev/null

# ── I/O: gather the three facts, then act ───────────────────────────────────
LOCK="${1:-$HOME/prb/deploy.lock}"
ROOT="$(dirname "$LOCK")"
PULL="$ROOT/bin/epik-pull.sh"
# The reaper's ceiling sits ABOVE the cron line's `timeout` bound (600s): timeout
# is the primary run bound, this only fires as the backstop when timeout did not
# (an un-refreshed box, a hand run, or timeout absent). 900s = 15 min.
CEILING="${LOCK_STALE:-900}"
FLOCK="${FLOCK:-/usr/bin/flock}"
[ -x "$FLOCK" ] || FLOCK="$(command -v flock 2>/dev/null || echo flock)"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
note() { printf '%s lock-reaper: %s\n' "$(ts)" "$*" >&2; }

# held? — can a non-blocking flock be taken right now, on a throwaway fd?
held=0
if "$FLOCK" -n "$LOCK" true 2>/dev/null; then
  held=0
else
  held=1
fi

live=0
age='-'
if [ "$held" = 1 ]; then
  # Every live epik-pull process. pgrep -f matches the full command line, so it
  # finds the wedged bash tick; an orphaned `node .../verify-epik.cjs` grandchild
  # is NOT an epik-pull.sh process and so reads as "no live holder" — a ghost —
  # which is correct: rotating the file frees new ticks and leaves the orphan
  # holding a nameless inode.
  youngest=''
  for pid in $(pgrep -f "$PULL" 2>/dev/null || true); do
    e="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$e" in ''|*[!0-9]*) continue ;; esac
    live=1
    if [ -z "$youngest" ] || [ "$e" -lt "$youngest" ]; then youngest="$e"; fi
  done
  [ -n "$youngest" ] && age="$youngest"
fi

ACTION="$(lock_action "$held" "$live" "$age" "$CEILING")"

case "$ACTION" in
  free|yield)
    exit 0
    ;;
  reap)
    note "epik-pull has held deploy.lock for ${age}s (> ${CEILING}s) — the run ceiling did not fire; killing the wedged tick and its group, then clearing the lock."
    for pid in $(pgrep -f "$PULL" 2>/dev/null || true); do
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 5
    for pid in $(pgrep -f "$PULL" 2>/dev/null || true); do
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 1
    ;;
  ghost)
    note "deploy.lock is held but NO live epik-pull process owns it — a ghost lock (orphaned fd), the '$LOCK held by nothing' case. Rotating it onto a fresh inode (the automatic form of the manual 'rm -f')."
    ;;
esac

# reap and ghost both land here: rotate the file so the next flock takes a fresh
# inode. mv (not rm) keeps the old inode alive but nameless for any orphan fd.
STAMP="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo now)"
if mv -f "$LOCK" "$LOCK.reaped.$STAMP" 2>/dev/null; then
  note "rotated $LOCK -> $(basename "$LOCK").reaped.$STAMP"
else
  rm -f "$LOCK" 2>/dev/null || true
  note "could not rename $LOCK — removed it instead"
fi
# Keep only the few most recent reaped files for forensics; drop the rest.
# shellcheck disable=SC2012
ls -1t "$LOCK".reaped.* 2>/dev/null | tail -n +4 | while IFS= read -r old; do
  rm -f "$old" 2>/dev/null || true
done

# Prove the rotation worked, so a reap that DID NOT actually free the lock is
# loud rather than silent. Best-effort — never fail the tick over it.
if "$FLOCK" -n "$LOCK" true 2>/dev/null; then
  note "lock is now free — the next flock tick will run."
else
  note "WARNING: lock STILL held after rotation. A new holder may have taken it in the race window (harmless), or the file could not be rotated (investigate: ls -l $LOCK)."
fi
exit 0
