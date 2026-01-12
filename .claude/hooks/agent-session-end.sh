#!/bin/bash
# Agent SessionEnd Hook
# Writes signal file to orchestrator's signals directory when agent session ends.
#
# Detection: Uses NOTIENT_AGENT env var set by mprocs.yaml
# If not set, script exits silently (vanilla Claude mode).
#
# Input (JSON via stdin): session_id, transcript_path, cwd, hook_event_name, reason
# Output (JSON to stdout): {"continue": true}

set -euo pipefail

# Only run if this is an agent session (mprocs sets NOTIENT_AGENT)
AGENT="${NOTIENT_AGENT:-}"
if [[ -z "$AGENT" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"')

# Signal directory (in main repo)
SIGNAL_DIR="/home/akougkas/projects/notient/.claude/orchestration/signals"
mkdir -p "$SIGNAL_DIR"

# Worktree path
WORKTREE="/home/akougkas/projects/_worktrees/notient-${AGENT}"

# Read agent's status.json if it exists
STATUS_FILE="${WORKTREE}/.claude/orchestration/${AGENT}/status.json"
if [[ -f "$STATUS_FILE" ]]; then
  STATUS_JSON=$(cat "$STATUS_FILE")
  AGENT_STATUS=$(echo "$STATUS_JSON" | jq -r '.status // "complete"')
  COMMIT=$(echo "$STATUS_JSON" | jq '.commit // null')
  TASK=$(echo "$STATUS_JSON" | jq '.task // null')
  NEEDS=$(echo "$STATUS_JSON" | jq '.needs // null')
else
  # Default: assume complete if no status.json
  AGENT_STATUS="complete"
  COMMIT="null"
  TASK="null"
  NEEDS="null"
fi

# Write signal file
SIGNAL_FILE="${SIGNAL_DIR}/${AGENT}.signal"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$SIGNAL_FILE" << EOF
{
  "agent": "$AGENT",
  "status": "$AGENT_STATUS",
  "timestamp": "$TIMESTAMP",
  "session_id": "$SESSION_ID",
  "reason": "$REASON",
  "commit": $COMMIT,
  "task": $TASK,
  "needs": $NEEDS
}
EOF

# Update agent state to "stopped"
MAIN_REPO="/home/akougkas/projects/notient"
STATE_FILE="${MAIN_REPO}/.claude/orchestration/state/agents.json"
if [[ -f "$STATE_FILE" ]]; then
  jq --arg agent "$AGENT" \
     --arg state "stopped" \
     --arg status "$AGENT_STATUS" \
     --arg ts "$TIMESTAMP" \
     '.[$agent].state = $state | .[$agent].last_status = $status | .[$agent].last_activity = $ts | .[$agent].session_id = null' \
     "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Log for debugging
LOG_DIR="${MAIN_REPO}/.claude/orchestration/logs"
mkdir -p "$LOG_DIR"
echo "[${TIMESTAMP}] SessionEnd: ${AGENT} -> ${AGENT_STATUS} (reason: ${REASON})" >> "${LOG_DIR}/hooks.log"

# Output success
echo '{"continue": true}'
