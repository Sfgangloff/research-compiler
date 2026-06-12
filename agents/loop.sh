#!/usr/bin/env bash
# One autonomous research agent: loops, each iteration runs `claude -p` to advance
# ONE step of reasoning stream <SLUG> in experiment repo <REPO_PATH>, then sleeps.
# Coordinates with other agents ONLY through the reasoning graph (via rc).
set -uo pipefail
SLUG="${1:?usage: loop.sh SLUG REPO_PATH RC_DIR [INTERVAL] [MODEL]}"
REPO="${2:?repo path}"
RC="${3:?research-compiler dir}"
INTERVAL="${4:-30}"
MODEL="${5:-}"

# The iteration prompt lives in a separate file (avoids in-script heredoc parsing
# fragility with the parens/backticks in the prompt body).
AG="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE=$(cat "$AG/iterate.md")
PROMPT="${TEMPLATE//\{\{SLUG\}\}/$SLUG}"
PROMPT="${PROMPT//\{\{REPO\}\}/$REPO}"
PROMPT="${PROMPT//\{\{RC\}\}/$RC}"

MODELFLAG=()
[ -n "$MODEL" ] && MODELFLAG=(--model "$MODEL")

echo "[agent $SLUG] loop start in $REPO (interval ${INTERVAL}s)  $(date)"
while true; do
  echo "[agent $SLUG] ---- iteration $(date) ----"
  ( cd "$REPO" && claude -p "$PROMPT" --dangerously-skip-permissions ${MODELFLAG[@]+"${MODELFLAG[@]}"} ) \
    || echo "[agent $SLUG] iteration errored; continuing"
  sleep "$INTERVAL"
done
