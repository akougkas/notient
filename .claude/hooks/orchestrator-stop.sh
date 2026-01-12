#!/bin/bash
# Orchestrator Stop Hook (Queue-Based v2)
# Checks for pending agent responses after each orchestrator turn.
# Injects a reminder if responses are waiting.
#
# Detection: Uses NOTIENT_ORCHESTRATOR env var set by mprocs.yaml
# If not set, script exits silently (vanilla Claude mode).
#
# Input (JSON via stdin): session_id, hook_event_name, stop_hook_active
# Output (JSON to stdout): {"continue": true} or with systemMessage

set -euo pipefail

# Only run if this is orchestrator (mprocs sets NOTIENT_ORCHESTRATOR)
if [[ "${NOTIENT_ORCHESTRATOR:-}" != "1" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input
INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')

# Don't run if already ran this turn (prevent loops)
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Paths
ORCH_DIR="/home/akougkas/projects/notient/.claude/orchestration"

# Count pending responses and queued tasks
RESPONSE_COUNT=0
QUEUE_COUNT=0
AGENTS_WITH_RESPONSES=""
AGENTS_WITH_QUEUE=""

for agent in archie sage faye; do
  response_dir="$ORCH_DIR/$agent/responses"
  queue_dir="$ORCH_DIR/$agent/queue"

  if [[ -d "$response_dir" ]]; then
    count=$(find "$response_dir" -name "*.response" -type f 2>/dev/null | wc -l)
    if [[ "$count" -gt 0 ]]; then
      RESPONSE_COUNT=$((RESPONSE_COUNT + count))
      AGENTS_WITH_RESPONSES+="$agent($count) "
    fi
  fi

  if [[ -d "$queue_dir" ]]; then
    count=$(find "$queue_dir" -name "*.task" -type f 2>/dev/null | wc -l)
    if [[ "$count" -gt 0 ]]; then
      QUEUE_COUNT=$((QUEUE_COUNT + count))
      AGENTS_WITH_QUEUE+="$agent($count) "
    fi
  fi
done

# Build message if there's anything pending
MESSAGE=""

if [[ "$RESPONSE_COUNT" -gt 0 ]]; then
  MESSAGE+="📬 ${RESPONSE_COUNT} response(s): ${AGENTS_WITH_RESPONSES}"
fi

if [[ "$QUEUE_COUNT" -gt 0 ]]; then
  if [[ -n "$MESSAGE" ]]; then
    MESSAGE+=" | "
  fi
  MESSAGE+="⏳ ${QUEUE_COUNT} queued: ${AGENTS_WITH_QUEUE}"
fi

if [[ -n "$MESSAGE" ]]; then
  cat << EOF
{
  "continue": true,
  "systemMessage": "$MESSAGE"
}
EOF
else
  echo '{"continue": true}'
fi
