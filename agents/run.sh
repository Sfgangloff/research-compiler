#!/usr/bin/env bash
# Orchestrator: launch one autonomous research agent per (stream -> experiment repo).
#
#   bash agents/run.sh                 # one agent for EVERY stream that has a repo
#   bash agents/run.sh slug1 slug2     # only these streams
#   INTERVAL=60 MODEL=claude-sonnet-4-6 bash agents/run.sh
#   DRY=1 bash agents/run.sh           # just print the (stream -> repo) pairs, launch nothing
#
# Extensible: any stream whose experiments point at a registered repo gets an agent
# automatically. Stop with: bash agents/stop.sh
set -uo pipefail   # NOT -e: one stream's hiccup must not abort the whole sweep
RC="$(cd "$(dirname "$0")/.." && pwd)"
AG="$RC/agents"; TSX="$RC/node_modules/.bin/tsx"
INTERVAL="${INTERVAL:-30}"; MODEL="${MODEL:-}"
mkdir -p "$AG/logs"
rc_(){ "$TSX" "$RC/src/cli/rc.ts" "$@"; }

if [ "$#" -gt 0 ]; then
  STREAMS="$*"
else
  STREAMS=$(rc_ stream list 2>/dev/null | python3 -c "import sys,json;print(' '.join(json.load(sys.stdin)))")
fi

: > "$AG/run.pids.tmp"
launched=0
for SLUG in $STREAMS; do
  # Repo name from the stream's experiment files (small, robust; avoids the huge
  # `rc stream show` output). Read-only discovery; graph is still mutated via rc.
  REPO=$(python3 -c "
import json,glob
for f in sorted(glob.glob('$RC/streams/$SLUG/experiments/*.json')):
    try: cp=json.load(open(f)).get('code_pointer') or {}
    except Exception: continue
    r=cp.get('repo')
    if r: print(r); break" 2>/dev/null)
  if [ -z "$REPO" ]; then echo "skip $SLUG  (no experiment repo in its graph)"; continue; fi
  RPATH=$(rc_ repo resolve --name "$REPO" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('path',''))" 2>/dev/null)
  if [ -z "$RPATH" ] || [ ! -d "$RPATH" ]; then echo "skip $SLUG  (repo '$REPO' not resolvable)"; continue; fi

  if [ "${DRY:-}" = "1" ]; then
    echo "would launch: $SLUG  ->  $REPO  ($RPATH)"
    continue
  fi
  LOG="$AG/logs/$SLUG.log"
  nohup bash "$AG/loop.sh" "$SLUG" "$RPATH" "$RC" "$INTERVAL" "$MODEL" >> "$LOG" 2>&1 &
  PID=$!
  echo "$PID $SLUG $REPO" >> "$AG/run.pids.tmp"
  echo "launched: $SLUG  ->  $REPO   (pid $PID, log agents/logs/$SLUG.log)"
  launched=$((launched+1))
done

if [ "${DRY:-}" = "1" ]; then rm -f "$AG/run.pids.tmp"; exit 0; fi
mv "$AG/run.pids.tmp" "$AG/run.pids"
echo "$launched agent(s) running.  Tail: tail -f agents/logs/<slug>.log   Stop: bash agents/stop.sh"
