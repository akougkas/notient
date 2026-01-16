#!/bin/bash
# Orchestrator Stop Hook (Role-Based v3)
# Checks for pending role responses after each orchestrator turn.
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

# Role definitions (matching config.json)
CODER_ROLES="implementer simplifier validator tester architect advisor"
RESEARCHER_ROLES="docs-fetcher codebase-navigator world-knowledge"
ALL_ROLES="$CODER_ROLES $RESEARCHER_ROLES"

# Count pending responses and queued tasks
RESPONSE_COUNT=0
QUEUE_COUNT=0
ROLES_WITH_RESPONSES=""
ROLES_WITH_QUEUE=""

for role in $ALL_ROLES; do
  response_dir="$ORCH_DIR/$role/responses"
  queue_dir="$ORCH_DIR/$role/queue"

  if [[ -d "$response_dir" ]]; then
    count=$(find "$response_dir" -name "*.response" -type f 2>/dev/null | wc -l)
    if [[ "$count" -gt 0 ]]; then
      RESPONSE_COUNT=$((RESPONSE_COUNT + count))
      ROLES_WITH_RESPONSES+="$role($count) "
    fi
  fi

  if [[ -d "$queue_dir" ]]; then
    count=$(find "$queue_dir" -name "*.task" -type f 2>/dev/null | wc -l)
    if [[ "$count" -gt 0 ]]; then
      QUEUE_COUNT=$((QUEUE_COUNT + count))
      ROLES_WITH_QUEUE+="$role($count) "
    fi
  fi
done

# Build message if there's anything pending
MESSAGE=""

if [[ "$RESPONSE_COUNT" -gt 0 ]]; then
  MESSAGE+="📬 ${RESPONSE_COUNT} response(s): ${ROLES_WITH_RESPONSES}"
fi

if [[ "$QUEUE_COUNT" -gt 0 ]]; then
  if [[ -n "$MESSAGE" ]]; then
    MESSAGE+=" | "
  fi
  MESSAGE+="⏳ ${QUEUE_COUNT} queued: ${ROLES_WITH_QUEUE}"
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
