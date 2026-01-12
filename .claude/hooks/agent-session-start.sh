#!/bin/bash
# Agent SessionStart Hook
# Injects TASK.md content as additionalContext when agent session starts.
#
# Detection: Uses NOTIENT_AGENT env var set by mprocs.yaml
# If not set, script exits silently (vanilla Claude mode).
#
# Input (JSON via stdin): session_id, transcript_path, cwd, hook_event_name, source
# Output (JSON to stdout): {"continue": true, "hookSpecificOutput": {...}}

set -euo pipefail

# Only run if this is an agent session (mprocs sets NOTIENT_AGENT)
AGENT="${NOTIENT_AGENT:-}"
if [[ -z "$AGENT" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Main repo path
MAIN_REPO="/home/akougkas/projects/notient"

# Update agent state to "running"
STATE_FILE="${MAIN_REPO}/.claude/orchestration/state/agents.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [[ -f "$STATE_FILE" ]]; then
  # Update state using jq
  jq --arg agent "$AGENT" \
     --arg state "running" \
     --arg ts "$TIMESTAMP" \
     --arg sid "$SESSION_ID" \
     '.[$agent].state = $state | .[$agent].last_activity = $ts | .[$agent].session_id = $sid' \
     "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
fi

# Only inject task context on fresh startup, not resume
if [[ "$SOURCE" != "startup" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Task file path (in main repo, not worktree)
TASK_FILE="${MAIN_REPO}/.claude/orchestration/${AGENT}/TASK.md"

# Build context to inject
CONTEXT=""

if [[ -f "$TASK_FILE" ]]; then
  TASK_CONTENT=$(cat "$TASK_FILE")
  CONTEXT="## Active Task\n\n${TASK_CONTENT}"
else
  CONTEXT="## No Active Task\n\nNo TASK.md found. Waiting for orchestrator assignment."
fi

# Log for debugging
LOG_DIR="/home/akougkas/projects/notient/.claude/orchestration/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[${TIMESTAMP}] SessionStart: ${AGENT} (source: ${SOURCE})" >> "${LOG_DIR}/hooks.log"

# Output with context injection
# Escape newlines and quotes for JSON
ESCAPED_CONTEXT=$(echo -e "$CONTEXT" | jq -Rs '.')

cat << EOF
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ${ESCAPED_CONTEXT}
  }
}
EOF
