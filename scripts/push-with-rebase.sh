#!/usr/bin/env bash
#
# scripts/push-with-rebase.sh — push a writer job's commit, and survive main
# moving underneath it.
#
# ── WHY ──────────────────────────────────────────────────────────────────────
# The SFTP ingest ended in a naked `git push`. On 2026-08-18 run 32136198527
# parsed the feeds, matched the catalog, and committed:
#
#     [main f93cf32e] chore(sftp): newegg catalog ingest - 16935 updated, 3171688 exclusives
#      16 files changed, 15786 insertions(+), 7067 deletions(-)
#     ! [rejected]  main -> main (fetch first)
#
# A pull request had merged during the ~48 minutes the job was running. The
# commit was real and correct; it was thrown away because the push had no
# recovery, and the whole run — an hour of SFTP transfer and parsing — had to be
# redone from scratch.
#
# The `main-writer` concurrency group does NOT prevent this. It serialises the
# workflows that write to main against each other; it has no opinion about a
# person clicking Merge. Any long-running writer is therefore racing every human
# in the repo, and losing that race currently costs the entire run.
#
# ── WHAT IT DOES ─────────────────────────────────────────────────────────────
# On rejection: fetch the branch, rebase this run's commit onto it, push again.
# Up to MAX attempts with linear backoff. The commit is replayed, not remade, so
# the ingest is never re-run.
#
# ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
# It does not resolve conflicts. A conflict means something else changed the
# same generated files, and the safe answer is a loud failure — the catalog is
# reproducible by re-running the ingest, and a silently auto-resolved catalog is
# not. `-X ours` here would quietly discard whatever the other writer did.
#
# Shallow clones are handled: actions/checkout defaults to fetch-depth 1, which
# leaves no merge base to rebase against, so the fetch deepens first.
#
# ── USAGE ────────────────────────────────────────────────────────────────────
#   scripts/push-with-rebase.sh [branch] [max_attempts]
#
# PUSH_RETRY_SLEEP overrides the backoff base in seconds (tests set it to 0).

set -uo pipefail

BRANCH="${1:-main}"
MAX="${2:-5}"
SLEEP_BASE="${PUSH_RETRY_SLEEP:-5}"
DEEPEN="${PUSH_RETRY_DEEPEN:-100}"

# Explicit refspec: `git fetch origin <branch>` updates FETCH_HEAD, and we need
# refs/remotes/origin/<branch> to be the thing that moves, because that is what
# the rebase targets.
REFSPEC="+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"

fetch_branch() {
  if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
    # A depth-1 checkout shares no history with the moved branch, so a plain
    # fetch leaves the rebase with no merge base to work from.
    git fetch --deepen="$DEEPEN" origin "$REFSPEC" && return 0
    echo "::warning::deepen failed; retrying as a full unshallow"
    git fetch --unshallow origin "$REFSPEC" && return 0
    return 1
  fi
  git fetch origin "$REFSPEC"
}

for attempt in $(seq 1 "$MAX"); do
  if git push origin "HEAD:${BRANCH}"; then
    if [ "$attempt" -gt 1 ]; then
      echo "Pushed on attempt ${attempt} — recovered from a concurrent write to ${BRANCH}."
    else
      echo "Pushed on attempt 1."
    fi
    exit 0
  fi

  # The final attempt has already failed; there is nothing left to rebase for.
  if [ "$attempt" -eq "$MAX" ]; then
    break
  fi

  echo "::warning::push to ${BRANCH} rejected (attempt ${attempt}/${MAX}) — the branch moved during this run. Rebasing onto it and retrying."

  if ! fetch_branch; then
    echo "::error::could not fetch ${BRANCH} to rebase onto — refusing to discard this run's commit"
    exit 1
  fi

  if ! git rebase "origin/${BRANCH}"; then
    git rebase --abort >/dev/null 2>&1 || true
    echo "::error::rebasing onto origin/${BRANCH} conflicted — another writer changed the same generated files. Not resolving automatically; re-run the job once the conflict is understood."
    exit 1
  fi

  sleep $(( SLEEP_BASE * attempt ))
done

echo "::error::could not push to ${BRANCH} after ${MAX} attempts — this run's commit was not saved"
exit 1
