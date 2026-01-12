#!/bin/bash
# Orchestrator SessionStart Hook (Queue-Based v2)
# Checks for pending agent responses and injects them as context.
#
# Detection: Uses NOTIENT_ORCHESTRATOR env var set by mprocs.yaml
# If not set, script exits silently (vanilla Claude mode).
#
# Input (JSON via stdin): session_id, transcript_path, cwd, hook_event_name, source
# Output (JSON to stdout): {"continue": true, "hookSpecificOutput": {...}}

set -euo pipefail

# Only run if this is orchestrator (mprocs sets NOTIENT_ORCHESTRATOR)
if [[ "${NOTIENT_ORCHESTRATOR:-}" != "1" ]]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

# Paths
REPO_ROOT="/home/akougkas/projects/notient"
ORCH_DIR="$REPO_ROOT/.claude/orchestration"
LOG_DIR="$ORCH_DIR/logs"

mkdir -p "$LOG_DIR"

# Collect pending responses
RESPONSES=()
RESPONSE_SUMMARY=""

for agent in archie sage faye; do
  response_dir="$ORCH_DIR/$agent/responses"

  if [[ -d "$response_dir" ]]; then
    shopt -s nullglob
    for resp in "$response_dir"/*.response; do
      [[ -f "$resp" ]] || continue

      task_id=$(basename "$resp" .response)
      status=$(jq -r '.status // "unknown"' "$resp")
      output=$(jq -r '.output // ""' "$resp" | head -c 500)
      elapsed=$(jq -r '.elapsed_seconds // 0' "$resp")
      error=$(jq -r '.error // null' "$resp")

      RESPONSES+=("$agent:$task_id")

      if [[ "$status" == "complete" ]]; then
        RESPONSE_SUMMARY+="### ✓ $agent/$task_id (${elapsed}s)\n"
        RESPONSE_SUMMARY+="\`\`\`\n${output}\n\`\`\`\n\n"
      else
        RESPONSE_SUMMARY+="### ✗ $agent/$task_id (FAILED)\n"
        if [[ "$error" != "null" ]]; then
          RESPONSE_SUMMARY+="Error: $error\n\n"
        fi
      fi
    done
  fi
done

# Build context
CONTEXT=""

if [[ ${#RESPONSES[@]} -gt 0 ]]; then
  CONTEXT="## 📬 Pending Agent Responses\n\n"
  CONTEXT+="The following tasks completed:\n\n"
  CONTEXT+="$RESPONSE_SUMMARY"
  CONTEXT+="**Actions:**\n"
  CONTEXT+="- Review outputs above\n"
  CONTEXT+="- Clear processed: \`rm .claude/orchestration/<agent>/responses/<task_id>.response\`\n"
  CONTEXT+="- Dispatch new: \`uv run .claude/agents/dispatch.py <agent> \"prompt\"\`\n"
else
  # Fresh start
  CONTEXT="## Orchestrator Ready\n\n"
  CONTEXT+="No pending responses. All agents idle.\n\n"
  CONTEXT+="**Dispatch tasks:**\n"
  CONTEXT+="\`\`\`bash\n"
  CONTEXT+="uv run .claude/agents/dispatch.py archie \"Your task here\"\n"
  CONTEXT+="uv run .claude/agents/dispatch.py --check archie\n"
  CONTEXT+="\`\`\`\n"
fi

# Log
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESPONSE_COUNT=${#RESPONSES[@]}
echo "[${TIMESTAMP}] SessionStart: orchestrator (source: ${SOURCE}, pending_responses: ${RESPONSE_COUNT})" >> "${LOG_DIR}/hooks.log"

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
