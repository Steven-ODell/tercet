#!/usr/bin/env bash
# Acceptance run against the pristine upstream server (see sandbox.sh): seed a throwaway
# sandbox, drive the TUI in a private tmux, compare the screens with acceptance/*.txt, and
# tear everything down on exit, including after a failure.
#
#   acceptance.sh            run and compare
#   acceptance.sh --record   run and rewrite acceptance/*.txt
#   acceptance.sh --keep     leave the sandbox server up afterwards for manual poking
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
# shellcheck source=sandbox.sh
. "$root/scripts/sandbox.sh"

keep=0
record=0
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    --record) record=1 ;;
    *) echo 'usage: acceptance.sh [--keep] [--record]' >&2; exit 2 ;;
  esac
done

if sandbox_port_busy; then
  echo "Port $SANDBOX_PORT is occupied; stop that server before acceptance." >&2
  exit 1
fi

t3=$(sandbox_install)
dir=$(mktemp -d /tmp/tercet-sandbox.XXXXXX)
server_job="tercet-acceptance-server-$$"
run_job="tercet-acceptance-run-$$"
socket="tercet-acceptance-$$"
status=1

cleanup() {
  if bgrun_alive "$run_job"; then bgrun kill "$run_job" >/dev/null 2>&1 || true; fi
  # tmux daemonizes out of the bgrun session; its socket is private to this run.
  tmux -L "$socket" kill-server >/dev/null 2>&1 || true
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$socket"
  if [[ $keep == 1 && $status == 0 ]]; then
    cat <<EOF
Sandbox left up on $SANDBOX_URL (bgrun job $server_job, data $dir).
  TERCET_SANDBOX_DIR=$dir HOME=$dir bun $root/src/main.tsx --url $SANDBOX_URL --token-file $dir/token
  Stop it: TERCET_SANDBOX_DIR=$dir TERCET_SANDBOX_JOB=$server_job $root/scripts/sandbox.sh down && rm -rf $dir
EOF
    return
  fi
  sandbox_stop "$dir" "$server_job"
  if [[ $status == 0 ]]; then rm -rf "$dir"; else echo "Sandbox data kept for inspection: $dir" >&2; fi
}
trap 'status=$?; cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sandbox_seed "$dir" "$t3"
sandbox_start "$dir" "$t3" "$server_job" "$([[ $keep == 1 ]] && echo 4h || echo 15m)"
sandbox_token "$dir" "$t3"

out="$dir/screens"
[[ $record == 1 ]] && out="$root/acceptance"
bgrun -t 300s -C "$root" "$run_job" -- env TERCET_SANDBOX_DIR="$dir" TERCET_ACCEPTANCE_TMUX="$socket" \
  TERCET_ACCEPTANCE_OUT="$out" TERCET_ACCEPTANCE_RECORD="$record" HOME="$dir" \
  python3 "$root/scripts/acceptance.py" >/dev/null
record_dir=$(bgrun_record "$run_job")
for ((i = 0; i < 3000; i++)); do
  if [[ -f "$record_dir/exit" ]]; then
    cat "$record_dir/log"
    code=$(cat "$record_dir/exit")
    [[ $code =~ ^[0-9]+$ ]] || code=1
    exit "$code"
  fi
  if [[ -f "$dir/server.pid" ]] && ! kill -0 "$(cat "$dir/server.pid")" 2>/dev/null; then
    echo "Sandbox server exited during acceptance; log: $(bgrun_record "$server_job")/log" >&2
    exit 1
  fi
  sleep .1
done
echo "Acceptance timed out; $record_dir/log" >&2
exit 1
