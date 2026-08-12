#!/bin/bash
# =============================================================================
#  Truth table for epik-pull.sh's hc_verdict().
#
#  The failure this exists to prevent is not destructive, it is a LIE: reporting
#  "unhealthy" about a box that was never asked. It happened on the production
#  flip — the docroot flip succeeded, the origin served the right tree, and the
#  post-flip check curled https://prorigbuilder.com, which still resolves to
#  Railway. It got Railway's HTML back and called the flip unhealthy.
#
#  So the verdict is a pure function of four counts, and this drives it:
#
#    pinned   1 when the request was pinned to the origin with --resolve, so it
#             reached this box by construction
#    bad      responses that were not the expected release
#    mine     responses carrying a release field — shaped like our own _env.php,
#             therefore answered by a tree of ours
#    foreign  HTTP 200 web pages that are not an unexecuted copy of our _env.php
#
#  The single rule: "unverified" requires evidence that we were not measured —
#  unpinned AND nothing of ours answered AND something else did. Everything else
#  that fails is ours to own.
#
#  Run:  bash test/epik-pull.hcverdict.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PULL="$HERE/../deploy/epik-pull.sh"

[ -r "$PULL" ] || { echo "cannot read $PULL"; exit 1; }

# Source for the function only. The early return sits ABOVE the config read, so
# sourcing needs no config, no site and no box — and nothing is fetched, written
# or swapped.
EPIK_PULL_LIB_ONLY=1
export EPIK_PULL_LIB_ONLY
# shellcheck disable=SC1090
. "$PULL"

if ! declare -f hc_verdict >/dev/null; then
  echo "FAIL: sourcing epik-pull.sh did not define hc_verdict"
  echo "      (did the EPIK_PULL_LIB_ONLY early-return move below the config read?)"
  exit 1
fi

PASS=0; FAIL=0
RESULTS=()

check() { # check <desc> <pinned> <bad> <mine> <foreign> <want>
  local desc="$1" pinned="$2" bad="$3" mine="$4" foreign="$5" want="$6" got
  got="$(hc_verdict "$pinned" "$bad" "$mine" "$foreign")"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); RESULTS+=("  ok    $desc -> $got")
  else
    FAIL=$((FAIL + 1)); RESULTS+=("  FAIL  $desc -> got '$got', want '$want'")
  fi
}

# ── healthy: nothing bad, whatever else was counted ─────────────────────────
check "pinned,   all matched          " 1 0 10 0 ok
check "unpinned, all matched          " 0 0 10 0 ok

# ── pinned: the request reached this box, so every failure is this box's ────
check "pinned,   nothing of ours       " 1 10 0 10 unhealthy
check "pinned,   wrong release         " 1 10 10 0 unhealthy
check "pinned,   partial convergence   " 1 3  7  0 unhealthy

# ── unpinned: the one case where we genuinely cannot tell ───────────────────
# THE REGRESSION CASE. This is the production flip, exactly: DNS still points at
# Railway, all ten requests came back as Railway's HTML, nothing of ours in the
# sample. Anything but "unverified" here is the bug this file exists for.
check "unpinned, all foreign HTML      " 0 10 0 10 unverified

# ── unpinned, but the box demonstrably answered ────────────────────────────
# One response of ours is enough: our _env.php answered, so the name DOES reach
# this box, and a release mismatch is real. A pool mid-convergence looks like
# this, and it must still be able to fail.
check "unpinned, one of ours answered  " 0 10 1 9  unhealthy
check "unpinned, wrong release         " 0 10 10 0 unhealthy
check "unpinned, partial convergence   " 0 3  7  0 unhealthy

# ── unpinned, nothing of ours AND nothing foreign ──────────────────────────
# Timeouts, refused connections, 500s, 401s, empty bodies — no page from another
# stack, so there is nothing supporting "someone else answered". Own it.
check "unpinned, all timed out         " 0 10 0 0 unhealthy
check "unpinned, all 401               " 0 10 0 0 unhealthy

printf '\nhc_verdict truth table\n'
printf '%s\n' "==========================================================="
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"

# ── the two invariants, stated rather than sampled ─────────────────────────
INV_FAIL=0

printf '\ninvariant 1: a pinned check can NEVER return unverified\n'
for bad in 0 1 5 10; do
  for mine in 0 5 10; do
    for foreign in 0 5 10; do
      got="$(hc_verdict 1 "$bad" "$mine" "$foreign")"
      if [ "$got" = unverified ]; then
        printf '  FAIL  bad=%s mine=%s foreign=%s -> %s\n' "$bad" "$mine" "$foreign" "$got"
        INV_FAIL=$((INV_FAIL + 1))
      fi
    done
  done
done
[ "$INV_FAIL" -eq 0 ] && printf '  ok    36 combinations, none unverified\n'

printf '\ninvariant 2: mine>0 always means the box was reached — never unverified\n'
INV2=0
for pinned in 0 1; do
  for bad in 1 5 10; do
    for foreign in 0 5 10; do
      got="$(hc_verdict "$pinned" "$bad" 1 "$foreign")"
      if [ "$got" = unverified ]; then
        printf '  FAIL  pinned=%s bad=%s mine=1 foreign=%s -> %s\n' "$pinned" "$bad" "$foreign" "$got"
        INV2=$((INV2 + 1))
      fi
    done
  done
done
[ "$INV2" -eq 0 ] && printf '  ok    18 combinations, none unverified\n'
INV_FAIL=$((INV_FAIL + INV2))

TOTAL_FAIL=$((FAIL + INV_FAIL))
printf '\n'
if [ "$TOTAL_FAIL" -ne 0 ]; then
  printf 'FAIL — %d problem(s)\n' "$TOTAL_FAIL"
  exit 1
fi
printf 'PASS — %d cases + both invariants\n' "$PASS"
