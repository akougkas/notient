#!/bin/bash
# Orchestrator Signal Checker
# Called to check for agent completion signals
#
# Usage: orchestrator-check-signals.sh
# Output: JSON array of signals found

set -e

SIGNAL_DIR="/home/akougkas/projects/notient/.claude/orchestration/signals"
mkdir -p "$SIGNAL_DIR"

# Find all signal files
SIGNALS=()
for f in "$SIGNAL_DIR"/*.signal; do
  [[ -f "$f" ]] || continue
  SIGNALS+=("$(cat "$f")")
done

# Output as JSON array
if [[ ${#SIGNALS[@]} -eq 0 ]]; then
  echo "[]"
else
  printf '%s\n' "${SIGNALS[@]}" | jq -s '.'
fi
