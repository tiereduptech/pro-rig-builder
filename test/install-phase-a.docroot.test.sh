#!/bin/bash
# =============================================================================
#  Truth table for install-phase-a.sh's docroot_verdict().
#
#  This is the one decision in the installer whose failure mode is destructive:
#  say "pre-flip" when a .pre-pull backup already exists and the flip renames a
#  live docroot onto that name, burying the tree under it. On production that
#  tree is the live site's.
#
#  It cannot be exercised end-to-end from a Windows dev box — git-bash has no
#  symlink privilege, so `ln -s` silently produces a copy and every case
#  collapses to "real directory". That is exactly how a guard gets declared
#  "confirmed" on evidence that never reached it. So the decision is a pure
#  function, and this drives all 8 input combinations directly.
#
#  Run:  bash test/install-phase-a.docroot.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$HERE/../deploy/install-phase-a.sh"

[ -r "$INSTALLER" ] || { echo "cannot read $INSTALLER"; exit 1; }

# Source for the function only — the guard in the installer returns before any
# of the install work, so nothing is fetched, written, or changed.
INSTALL_PHASE_A_LIB_ONLY=1
export INSTALL_PHASE_A_LIB_ONLY
# shellcheck disable=SC1090
. "$INSTALLER"

if ! declare -f docroot_verdict >/dev/null; then
  echo "FAIL: sourcing the installer did not define docroot_verdict"
  echo "      (did the INSTALL_PHASE_A_LIB_ONLY early-return move or break?)"
  exit 1
fi

EXPECTED_TARGET="/home/u/prb/current"
PASS=0; FAIL=0
RESULTS=()

check() { # check <desc> <is_link> <target> <backup> <want>
  local desc="$1" is_link="$2" target="$3" backup="$4" want="$5" got
  got="$(docroot_verdict "$is_link" "$target" "$EXPECTED_TARGET" "$backup")"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); RESULTS+=("  ok    $desc -> $got")
  else
    FAIL=$((FAIL + 1)); RESULTS+=("  FAIL  $desc -> got '$got', want '$want'")
  fi
}

# ── all 8 combinations of (is_symlink x which target x backup) ──────────────
check "real dir,          no backup " 0 ""                     0 pre-flip
check "real dir,          BACKUP    " 0 ""                     1 refuse-buried
check "link -> ours,      no backup " 1 "$EXPECTED_TARGET"     0 resume
check "link -> ours,      BACKUP    " 1 "$EXPECTED_TARGET"     1 resume
check "link -> elsewhere, no backup " 1 "/home/u/other"        0 foreign-link
check "link -> elsewhere, BACKUP    " 1 "/home/u/other"        1 refuse-foreign
# The near-miss pair: a path that merely CONTAINS the expected target, and the
# staging root on a box where both installs exist. Both must refuse, not resume.
check "link -> ours+suffix, BACKUP  " 1 "$EXPECTED_TARGET.old" 1 refuse-foreign
check "link -> staging cur, BACKUP  " 1 "/home/u/prb-staging/current" 1 refuse-foreign

printf '\ndocroot_verdict truth table\n'
printf '%s\n' "==========================================================="
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed (8 combinations)\n' "$PASS" "$FAIL"

# The two verdicts that must NEVER be reachable from a state where a flip is
# still ahead and a backup exists. Stated as an invariant, not just cases.
printf '\ninvariant: any state with backup=1 and no link to ours must refuse\n'
INV_FAIL=0
for is_link in 0 1; do
  for target in "" "/home/u/other" "$EXPECTED_TARGET.old"; do
    [ "$is_link" = 0 ] && [ -n "$target" ] && continue
    got="$(docroot_verdict "$is_link" "$target" "$EXPECTED_TARGET" 1)"
    case "$got" in
      refuse-*) printf '  ok    is_link=%s target=%-22s -> %s\n' "$is_link" "'${target:-}'" "$got" ;;
      *)        printf '  FAIL  is_link=%s target=%-22s -> %s (must refuse)\n' "$is_link" "'${target:-}'" "$got"; INV_FAIL=$((INV_FAIL + 1)) ;;
    esac
  done
done

TOTAL_FAIL=$((FAIL + INV_FAIL))
printf '\n'
if [ "$TOTAL_FAIL" -ne 0 ]; then
  printf 'FAIL — %d problem(s)\n' "$TOTAL_FAIL"
  exit 1
fi
printf 'PASS — 8/8 combinations + the refuse invariant\n'
