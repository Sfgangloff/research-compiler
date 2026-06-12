#!/usr/bin/env bash
# Stop all running research agents launched by run.sh.
set -uo pipefail
AG="$(cd "$(dirname "$0")" && pwd)"
[ -f "$AG/run.pids" ] || { echo "no agents running (no run.pids)"; exit 0; }
while read -r pid slug rest; do
  [ -z "${pid:-}" ] && continue
  pkill -P "$pid" 2>/dev/null || true     # kill children (claude / sleep) first
  if kill "$pid" 2>/dev/null; then echo "stopped $slug (pid $pid)"; else echo "$slug (pid $pid) was not running"; fi
done < "$AG/run.pids"
: > "$AG/run.pids"
echo "all agents stopped."
