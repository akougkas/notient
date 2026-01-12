#!/bin/bash
# Clear a processed signal file
#
# Usage: orchestrator-clear-signal.sh <agent>
# Example: orchestrator-clear-signal.sh archie

set -e

AGENT="${1:?Usage: $0 <agent>}"
SIGNAL_DIR="/home/akougkas/projects/notient/.claude/orchestration/signals"
SIGNAL_FILE="$SIGNAL_DIR/${AGENT}.signal"

if [[ -f "$SIGNAL_FILE" ]]; then
  # Archive to logs before deleting
  LOG_DIR="/home/akougkas/projects/notient/.claude/orchestration/logs"
  mkdir -p "$LOG_DIR"
  TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
  cp "$SIGNAL_FILE" "$LOG_DIR/${AGENT}-${TIMESTAMP}.signal"
  rm "$SIGNAL_FILE"
  echo "Cleared signal for $AGENT (archived to logs)"
else
  echo "No signal file for $AGENT"
fi
