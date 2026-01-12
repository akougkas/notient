#!/bin/bash
# Check agent states from agents.json
#
# Usage: orchestrator-agent-states.sh
# Output: Formatted agent state summary

set -euo pipefail

STATE_FILE="/home/akougkas/projects/notient/.claude/orchestration/state/agents.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "No agent state file found"
  exit 0
fi

echo "=== Agent States ==="
echo ""

for agent in archie sage faye; do
  STATE=$(jq -r --arg a "$agent" '.[$a].state // "unknown"' "$STATE_FILE")
  LAST_STATUS=$(jq -r --arg a "$agent" '.[$a].last_status // "none"' "$STATE_FILE")
  LAST_ACTIVITY=$(jq -r --arg a "$agent" '.[$a].last_activity // "never"' "$STATE_FILE")

  # Format state with emoji
  case "$STATE" in
    running) EMOJI="🟢" ;;
    stopped) EMOJI="⚫" ;;
    *)       EMOJI="❓" ;;
  esac

  echo "${EMOJI} ${agent}: ${STATE} (last: ${LAST_STATUS}, activity: ${LAST_ACTIVITY})"
done

echo ""

# Check for pending signals
SIGNAL_DIR="/home/akougkas/projects/notient/.claude/orchestration/signals"
SIGNAL_COUNT=$(find "$SIGNAL_DIR" -name "*.signal" -type f 2>/dev/null | wc -l)
if [[ "$SIGNAL_COUNT" -gt 0 ]]; then
  echo "📬 ${SIGNAL_COUNT} pending signal(s)"
  for signal_file in "$SIGNAL_DIR"/*.signal; do
    [[ -f "$signal_file" ]] || continue
    AGENT=$(jq -r '.agent' < "$signal_file")
    STATUS=$(jq -r '.status' < "$signal_file")
    echo "   - ${AGENT}: ${STATUS}"
  done
fi
