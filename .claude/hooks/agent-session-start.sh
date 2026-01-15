#!/bin/bash
# Role SessionStart Hook (Role-Based v3)
# Injects role identity as additionalContext when role session starts.
#
# Detection: Uses NOTIENT_ROLE env var set by mprocs.yaml
# If not set, script exits silently (vanilla Claude mode).
#
# Input (JSON via stdin): session_id, transcript_path, cwd, hook_event_name, source
# Output (JSON to stdout): {"continue": true, "hookSpecificOutput": {...}}

set -euo pipefail

# Only run if this is a role session (mprocs sets NOTIENT_ROLE)
ROLE="${NOTIENT_ROLE:-}"
if [[ -z "$ROLE" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

# Main repo path
MAIN_REPO="/home/akougkas/projects/notient"

# Determine category from environment or guess
CATEGORY="${NOTIENT_CATEGORY:-}"
if [[ -z "$CATEGORY" ]]; then
  case "$ROLE" in
    implementer|simplifier|validator|tester|architect|advisor)
      CATEGORY="coder"
      ;;
    docs-fetcher|codebase-navigator|world-knowledge)
      CATEGORY="researcher"
      ;;
    *)
      CATEGORY="unknown"
      ;;
  esac
fi

# Update role state to "running"
STATE_FILE="${MAIN_REPO}/.claude/orchestration/state/agents.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [[ -f "$STATE_FILE" ]]; then
  # Update state using jq based on category
  if [[ "$CATEGORY" == "coder" ]]; then
    jq --arg role "$ROLE" \
       --arg state "running" \
       --arg ts "$TIMESTAMP" \
       --arg sid "$SESSION_ID" \
       '.coders[$role].state = $state | .coders[$role].last_activity = $ts | .coders[$role].session_id = $sid' \
       "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  elif [[ "$CATEGORY" == "researcher" ]]; then
    jq --arg role "$ROLE" \
       --arg state "running" \
       --arg ts "$TIMESTAMP" \
       --arg sid "$SESSION_ID" \
       '.researchers[$role].state = $state | .researchers[$role].last_activity = $ts | .researchers[$role].session_id = $sid' \
       "$STATE_FILE" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
fi

# Only inject context on fresh startup, not resume
if [[ "$SOURCE" != "startup" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Identity file paths
if [[ "$CATEGORY" == "coder" ]]; then
  CORE_IDENTITY="${MAIN_REPO}/.claude/orchestration/core/CODER.md"
elif [[ "$CATEGORY" == "researcher" ]]; then
  CORE_IDENTITY="${MAIN_REPO}/.claude/orchestration/core/RESEARCHER.md"
else
  CORE_IDENTITY=""
fi
ROLE_IDENTITY="${MAIN_REPO}/.claude/orchestration/${ROLE}/ROLE.md"

# Build context to inject
CONTEXT=""
CONTEXT+="## Role: ${ROLE^^} (${CATEGORY})\n\n"

if [[ -f "$CORE_IDENTITY" ]]; then
  CONTEXT+="Read your identity files:\n"
  CONTEXT+="1. .claude/orchestration/core/${CATEGORY^^}.md (core identity)\n"
  CONTEXT+="2. .claude/orchestration/${ROLE}/ROLE.md (role specialization)\n\n"
else
  CONTEXT+="Read your role identity: .claude/orchestration/${ROLE}/ROLE.md\n\n"
fi

CONTEXT+="Then check your queue for pending tasks.\n"

# Log for debugging
LOG_DIR="/home/akougkas/projects/notient/.claude/orchestration/logs"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "[${TIMESTAMP}] SessionStart: ${ROLE} (category: ${CATEGORY}, source: ${SOURCE})" >> "${LOG_DIR}/hooks.log"

# Output with context injection
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
