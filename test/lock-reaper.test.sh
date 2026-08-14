#!/bin/bash
# =============================================================================
#  Truth table for lock-reaper.sh's lock_action().
#
#  The failure this exists to prevent is a deploy.lock that is held but going
#  nowhere silently freezing the whole */5 loop — either a wedged tick (a live
#  holder past the run ceiling) or a GHOST lock held by no live process at all,
#  the "held by nothing" case that on 2026-08-14 needed a manual `rm -f`.
#
#  The decision is a pure function of four facts, and this drives it:
#    held     1 when flock -n could not take the lock right now
#    live     1 when a live epik-pull process holds it
#    age      youngest live holder's age in seconds, or '-' if none / unknown
#    ceiling  the run ceiling; a live holder older than this is wedged
#
#  Rules:
#    not held                         -> free   (nothing to do)
#    held, live, age <= ceiling       -> yield  (a normal overlapping tick)
#    held, live, age  > ceiling       -> reap   (kill the wedged tick, clear)
#    held, no live holder             -> ghost  (orphaned fd; rotate the file)
#    held, live, age unknown ('-')    -> yield  (never reap what we cannot age)
#
#  Run:  bash test/lock-reaper.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REAPER="$HERE/../deploy/lock-reaper.sh"

[ -r "$REAPER" ] || { echo "cannot read $REAPER"; exit 1; }

# Source for the function only. The LIB_ONLY early return sits ABOVE all I/O, so
# sourcing touches no lock, no process and no file.
LOCK_REAPER_LIB_ONLY=1
export LOCK_REAPER_LIB_ONLY
# shellcheck disable=SC1090
. "$REAPER"

if ! declare -f lock_action >/dev/null; then
  echo "FAIL: sourcing lock-reaper.sh did not define lock_action"
  echo "      (did the LOCK_REAPER_LIB_ONLY early-return move below the I/O?)"
  exit 1
fi

PASS=0; FAIL=0
RESULTS=()

check() { # check <desc> <held> <live> <age> <ceiling> <want>
  local desc="$1" held="$2" live="$3" age="$4" ceiling="$5" want="$6" got
  got="$(lock_action "$held" "$live" "$age" "$ceiling")"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); RESULTS+=("  ok    $desc -> $got")
  else
    FAIL=$((FAIL + 1)); RESULTS+=("  FAIL  $desc -> got '$got', want '$want'")
  fi
}

# ── not held: always free, regardless of the other facts ────────────────────
check "free, no holder              " 0 0 -    900 free
check "free, stale value ignored    " 0 1 5000 900 free

# ── held by a LIVE, young holder: a normal overlapping tick, leave it ────────
check "held, live, brand new        " 1 1 1    900 yield
check "held, live, just under ceil  " 1 1 899  900 yield
check "held, live, exactly at ceil  " 1 1 900  900 yield

# ── held by a LIVE holder PAST the ceiling: wedged, reap it ──────────────────
check "held, live, one past ceiling " 1 1 901  900 reap
check "held, live, 9.5h wedge       " 1 1 34200 900 reap

# ── the GHOST: held, but no live epik-pull process owns it ──────────────────
# The 2026-08-14 "held by nothing" case. Anything but ghost here is the bug.
check "held, GHOST (no live holder) " 1 0 -    900 ghost
check "held, GHOST, age irrelevant  " 1 0 -    60  ghost

# ── age we could not read: never reap what we cannot prove is stale ─────────
# A live holder whose etimes was unreadable ('-') must yield, not be killed on a
# guess — killing a healthy in-progress deploy is worse than waiting one tick.
check "held, live, age unknown      " 1 1 -    900 yield

printf '\nlock_action truth table\n'
printf '%s\n' "==========================================================="
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"

# ── invariants, stated rather than sampled ──────────────────────────────────
INV=0

printf '\ninvariant 1: a lock that is NOT held is ALWAYS free\n'
I1=0
for live in 0 1; do
  for age in - 0 500 9999; do
    got="$(lock_action 0 "$live" "$age" 900)"
    if [ "$got" != free ]; then
      printf '  FAIL  held=0 live=%s age=%s -> %s\n' "$live" "$age" "$got"; I1=$((I1+1))
    fi
  done
done
[ "$I1" -eq 0 ] && printf '  ok    8 combinations, all free\n'
INV=$((INV+I1))

printf '\ninvariant 2: held with NO live holder is ALWAYS ghost (the rm -f case)\n'
I2=0
for age in - 0 60 9999; do
  got="$(lock_action 1 0 "$age" 900)"
  if [ "$got" != ghost ]; then
    printf '  FAIL  held=1 live=0 age=%s -> %s\n' "$age" "$got"; I2=$((I2+1))
  fi
done
[ "$I2" -eq 0 ] && printf '  ok    4 combinations, all ghost\n'
INV=$((INV+I2))

printf '\ninvariant 3: reap requires a KNOWN age strictly greater than the ceiling\n'
printf '  (a live holder we cannot age, or one at/under the ceiling, never reaps)\n'
I3=0
for age in - 0 1 899 900; do
  got="$(lock_action 1 1 "$age" 900)"
  if [ "$got" = reap ]; then
    printf '  FAIL  held=1 live=1 age=%s ceiling=900 -> reap (should not)\n' "$age"; I3=$((I3+1))
  fi
done
# ...and the boundary the other way: one second past is a reap.
got="$(lock_action 1 1 901 900)"
[ "$got" = reap ] || { printf '  FAIL  age=901 ceiling=900 -> %s, want reap\n' "$got"; I3=$((I3+1)); }
[ "$I3" -eq 0 ] && printf '  ok    boundary holds at the ceiling\n'
INV=$((INV+I3))

TOTAL_FAIL=$((FAIL + INV))
printf '\n'
if [ "$TOTAL_FAIL" -ne 0 ]; then
  printf 'FAIL — %d problem(s)\n' "$TOTAL_FAIL"
  exit 1
fi
printf 'PASS — %d cases + 3 invariants\n' "$PASS"
