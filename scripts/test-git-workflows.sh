#!/usr/bin/env bash
# Opt-in POSIX real-server branch rig. All data is disposable; never uses daily T3.
set -euo pipefail
export TERCET_SANDBOX_PORT=3776
source "$(dirname "$0")/sandbox.sh"
export TERCET_SANDBOX_DIR
TERCET_SANDBOX_DIR=$(mktemp -d /tmp/tercet-git-rig.XXXXXX)
job=tercet-git-branches
trap 'sandbox_stop "$TERCET_SANDBOX_DIR" "$job"' EXIT
t3=$(sandbox_install)
sandbox_seed "$TERCET_SANDBOX_DIR" "$t3"
sandbox_start "$TERCET_SANDBOX_DIR" "$t3" "$job" 5m
# Explicit source-control scopes are required by the pinned server; no daily token involved.
HOME="$TERCET_SANDBOX_DIR" "$t3" auth session issue --base-dir "$TERCET_SANDBOX_DIR/.t3" --token-only \
  --scope orchestration:read --scope orchestration:operate \
  --scope source-control:write --label tercet-git-rig > "$TERCET_SANDBOX_DIR/token"
TERCET_GIT_LIVE=1 bun test src/client/git-workflows.test.tsx
