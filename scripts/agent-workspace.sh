#!/usr/bin/env bash
# Ephemeral agent workspace bootstrap.
#
# Nightly pipelines must never write to the primary repo checkout. Every run
# clones into disposable scratch, rebases the agent branch onto main FIRST,
# works there, and pushes back a single ref update. If a run dies at any
# point, its mess dies with the scratch directory: the primary repo never
# holds index.lock, worktree metadata, or half-finished rebases.
#
# Usage:
#   agent-workspace.sh setup   <scratch-dir>   # prints workspace path on success
#   agent-workspace.sh publish <scratch-dir>   # pushes agents/nightly back
#
# Exit codes: 0 ok · 2 rebase conflict (aborted, reported) · 1 anything else
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0

BRANCH="agents/nightly"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# SIGTERM (not SIGKILL) on overrun so git removes its own lock files.
g() { timeout --signal=TERM 60 git "$@"; }

cmd="${1:?usage: agent-workspace.sh setup|publish [scratch-dir]}"
scratch="${2:-$HOME/agent-scratch}"
ws="$scratch/nightly-workspace"

case "$cmd" in
  setup)
    # Git requires unlink for normal operation (lock files, temp objects).
    # Sandbox-mounted folders block unlink, which strands locks — the exact
    # disease this script exists to cure. Refuse a scratch dir that can't
    # delete its own files; sandbox-local paths like $HOME work.
    mkdir -p "$scratch"
    probe="$scratch/.unlink-probe.$$"
    if ! { touch "$probe" && rm "$probe"; } 2>/dev/null; then
      echo "SCRATCH UNSUITABLE: $scratch cannot unlink files (mounted folder?). Use a sandbox-local dir, e.g. \$HOME." >&2
      exit 1
    fi
    rm -rf "$ws"
    g clone --quiet "$REPO" "$ws"
    cd "$ws"
    if g rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
      g checkout --quiet -B "$BRANCH" "origin/$BRANCH"
    else
      g checkout --quiet -b "$BRANCH" origin/main
    fi
    # Rebase-first, like any developer: conflicts abort loudly and leave the
    # primary repo untouched. A conflict is a finding, never something to
    # resolve unattended.
    if ! g rebase --quiet origin/main; then
      g rebase --abort || true
      echo "REBASE CONFLICT: $BRANCH does not apply onto main; aborted." >&2
      exit 2
    fi
    echo "$ws"
    ;;
  publish)
    cd "$ws"
    if ! g diff --quiet || ! g diff --cached --quiet; then
      echo "PUBLISH REFUSED: uncommitted changes in workspace; commit or drop them first." >&2
      exit 1
    fi
    # Rebase rewrites history, so the agent branch is force-pushed by design.
    # --force-with-lease still refuses if someone else moved the ref.
    g push --quiet --force-with-lease origin "$BRANCH"
    echo "published $BRANCH -> $REPO"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
