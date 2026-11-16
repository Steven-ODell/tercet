#!/usr/bin/env bash
# Vanilla upstream T3 server sandbox: the pinned npm `t3` release, a throwaway HOME and data
# dir, a made-up project and only the free OpenCode model. Never touches port 3773 or ~/.t3.
#
#   sandbox.sh up      seed (first time) and start; prints `export TERCET_SANDBOX_DIR=...`
#   sandbox.sh token   issue a bearer token into $TERCET_SANDBOX_DIR/token and print it
#   sandbox.sh down    stop the server job (data stays for the next `up`)
#
# TERCET_SANDBOX_DIR picks the sandbox (default .t3/sandbox in the repo, where connect.ts looks).
# TERCET_SANDBOX_JOB names the bgrun job (default tercet-sandbox). acceptance.sh sources this file.
set -euo pipefail

T3_VERSION=0.1.9
SANDBOX_PORT=${TERCET_SANDBOX_PORT:-3775}
case "$SANDBOX_PORT" in
  3775|3776) ;;
  *) echo "Sandbox port must be 3775 or 3776 (never the daily server)." >&2; exit 2 ;;
esac
SANDBOX_URL="http://127.0.0.1:$SANDBOX_PORT"
SANDBOX_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tercet/server"
SANDBOX_MODEL=opencode/flint-40b-free
SANDBOX_SCRIPTS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The npm package is a launcher that downloads the release binary into $T3CODE_HOME/runtime and
# checks it against the release's SHA256SUMS. Point that at our cache, never at ~/.t3.
sandbox_install() {
  local bin="$SANDBOX_CACHE/home/runtime/versions/$T3_VERSION/t3"
  local marker="$SANDBOX_CACHE/home/runtime/versions/$T3_VERSION/.install-complete"
  if [[ "$(cat "$marker" 2>/dev/null)" != "$T3_VERSION" ]]; then
    npm i --prefix "$SANDBOX_CACHE/npm-$T3_VERSION" --no-audit --no-fund --silent "t3@$T3_VERSION" >&2
    T3CODE_HOME="$SANDBOX_CACHE/home" "$SANDBOX_CACHE/npm-$T3_VERSION/node_modules/.bin/t3" --version >&2
  fi
  printf '%s\n' "$bin"
}

sandbox_port_busy() { ss -H -ltn "sport = :$SANDBOX_PORT" | grep -q .; }

# The sandbox dir is HOME for the server and the TUI; data lives in $dir/.t3.
sandbox_seed() {
  local dir=$1 t3=$2 project="$1/work/demo-app"
  local git=(git -C "$project" -c user.name=tercet -c user.email=tercet@example.invalid)
  mkdir -p "$project/src"
  printf '# demo-app\n\nA made-up project for tercet acceptance runs.\n' > "$project/README.md"
  printf 'export const accent = "purple";\n' > "$project/src/colors.ts"
  "${git[@]}" init -q -b main
  "${git[@]}" add -A
  "${git[@]}" commit -qm "Initial demo app"
  HOME=$dir "$t3" project add --base-dir "$dir/.t3" --title demo-app "$project" >/dev/null
  # Keep test turns on the explicitly authorized free provider only.
  cat > "$dir/.t3/userdata/settings.json" <<'JSON'
{
  "providerInstances": {
    "codex": { "driver": "codex", "enabled": false },
    "claudeAgent": { "driver": "claudeAgent", "enabled": false },
    "opencode": { "driver": "opencode", "enabled": true, "config": {} }
  }
}
JSON
}

# Starts the server as a named bgrun job under reaper.py, which writes $dir/server.pid and
# $dir/reaper.pid. Without XDG_RUNTIME_DIR the server turns agent systemd scopes off, so its
# agents stay descendants of the reaper (OpenCode calls setsid, so bgrun's session kill alone
# would miss it).
sandbox_start() {
  local dir=$1 t3=$2 job=$3 limit=${4:-15m}
  if sandbox_port_busy; then echo "Port $SANDBOX_PORT is occupied; refusing to start." >&2; return 1; fi
  rm -f "$dir/server.pid" "$dir/reaper.pid"
  bgrun -t "$limit" "$job" -- env -u XDG_RUNTIME_DIR HOME="$dir" \
    python3 -I "$SANDBOX_SCRIPTS/reaper.py" "$dir" -- "$t3" serve --base-dir "$dir/.t3" \
    --host 127.0.0.1 --port "$SANDBOX_PORT" --no-browser "$dir/work/demo-app" >/dev/null
  local i
  for ((i = 0; i < 600; i++)); do
    if curl --max-time 1 -fsS "$SANDBOX_URL/.well-known/t3/environment" >/dev/null 2>&1; then return 0; fi
    if [[ -f "$dir/server.pid" ]] && ! kill -0 "$(cat "$dir/server.pid")" 2>/dev/null; then break; fi
    sleep .1
  done
  echo "Sandbox server did not become ready; log: $(bgrun_record "$job")/log" >&2
  return 1
}

sandbox_token() {
  local dir=$1 t3=$2
  (umask 077
   HOME=$dir "$t3" auth session issue --base-dir "$dir/.t3" --token-only \
     --scope orchestration:read --scope orchestration:operate --scope filesystem:read \
     --scope terminal:read --scope terminal:operate --label tercet-sandbox > "$dir/token.tmp"
   mv "$dir/token.tmp" "$dir/token")
}

bgrun_record() { printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}/bgrun/$1"; }
bgrun_alive() { [[ -d "$(bgrun_record "$1")" && ! -f "$(bgrun_record "$1")/exit" ]]; }

# A PID file could be stale; only trust it while the command line still names our dir.
ours() {
  local pid=$1 dir=$2
  [[ -n "$pid" ]] && { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null | grep -qF -- "$dir"
}

# Stops only what we started: the reaper (which stops the server and every agent under it),
# then the named job, then the server PID if it somehow outlived both.
sandbox_stop() {
  local dir=$1 job=$2 reaper server i
  reaper=$(cat "$dir/reaper.pid" 2>/dev/null || true)
  server=$(cat "$dir/server.pid" 2>/dev/null || true)
  if ours "$reaper" "$dir"; then
    kill -TERM "$reaper" 2>/dev/null || true
    for ((i = 0; i < 100; i++)); do ours "$reaper" "$dir" || break; sleep .1; done
  fi
  if bgrun_alive "$job"; then bgrun kill "$job" >/dev/null 2>&1 || true; fi
  if ours "$server" "$dir/.t3"; then kill -KILL "$server" 2>/dev/null || true; fi
  rm -f "$dir/server.pid" "$dir/reaper.pid"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  job=${TERCET_SANDBOX_JOB:-tercet-sandbox}
  dir=${TERCET_SANDBOX_DIR:-$(git -C "$SANDBOX_SCRIPTS" rev-parse --show-toplevel)/.t3/sandbox}
  case "${1:-}" in
    up)
      t3=$(sandbox_install)
      mkdir -p "$dir"
      if [[ ! -f "$dir/.t3/userdata/statev2.sqlite" ]]; then sandbox_seed "$dir" "$t3"; fi
      sandbox_start "$dir" "$t3" "$job" 0
      echo "export TERCET_SANDBOX_DIR=$dir"
      ;;
    token)
      sandbox_token "$dir" "$(sandbox_install)"
      cat "$dir/token"
      ;;
    down)
      sandbox_stop "$dir" "$job"
      ;;
    *) echo 'usage: sandbox.sh up|token|down' >&2; exit 2 ;;
  esac
fi
