#!/bin/bash
# Orchestrator SessionStart Hook (Role-Based v3)
# Checks for pending role responses and injects them as context.
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

# Role definitions
CODER_ROLES="implementer simplifier validator tester architect advisor"
RESEARCHER_ROLES="docs-fetcher codebase-navigator world-knowledge"
ALL_ROLES="$CODER_ROLES $RESEARCHER_ROLES"

# Collect pending responses
RESPONSES=()
RESPONSE_SUMMARY=""

for role in $ALL_ROLES; do
  response_dir="$ORCH_DIR/$role/responses"

  if [[ -d "$response_dir" ]]; then
    shopt -s nullglob
    for resp in "$response_dir"/*.response; do
      [[ -f "$resp" ]] || continue

      task_id=$(jq -r '.task_id // "unknown"' "$resp")
      status=$(jq -r '.status // "unknown"' "$resp")
      output=$(jq -r '.output // ""' "$resp" | head -c 500)
      elapsed=$(jq -r '.elapsed_seconds // 0' "$resp")
      cli=$(jq -r '.cli // "claude"' "$resp")
      error=$(jq -r '.error // null' "$resp")

      RESPONSES+=("$role:$task_id")

      if [[ "$status" == "complete" ]]; then
        RESPONSE_SUMMARY+="### ✓ $role/$task_id (${elapsed}s via $cli)\n"
        RESPONSE_SUMMARY+="\`\`\`\n${output}\n\`\`\`\n\n"
      else
        RESPONSE_SUMMARY+="### ✗ $role/$task_id (FAILED via $cli)\n"
        if [[ "$error" != "null" ]]; then
          RESPONSE_SUMMARY+="Error: $error\n\n"
        fi
      fi
    done
  fi
done

# Check for session handoff
HANDOFF_FILE="$ORCH_DIR/state/SESSION-HANDOFF.md"
HANDOFF_CONTENT=""
HAS_HANDOFF=false

if [[ -f "$HANDOFF_FILE" ]]; then
  # Check if handoff has actual data (not just template)
  if grep -q "^### Current Phase$" "$HANDOFF_FILE" && ! grep -q "^(none)$" "$HANDOFF_FILE"; then
    HAS_HANDOFF=true
    HANDOFF_CONTENT=$(cat "$HANDOFF_FILE")
  fi
fi

# Check project state
STATE_FILE="$REPO_ROOT/.planning/STATE.md"
STATE_SUMMARY=""
if [[ -f "$STATE_FILE" ]]; then
  # Extract current phase and status
  CURRENT_PHASE=$(grep -A1 "^## Current Position" "$STATE_FILE" | tail -1 | sed 's/\*\*//g' || echo "Unknown")
  STATE_SUMMARY="**Project State**: $CURRENT_PHASE"
fi

# Build context
CONTEXT=""

# Priority 1: Session handoff (resuming previous work)
if [[ "$HAS_HANDOFF" == "true" ]]; then
  CONTEXT="## 🔄 SESSION RESUME - Previous Work Detected\n\n"
  CONTEXT+="A previous session left a handoff. Read carefully:\n\n"
  CONTEXT+="\`\`\`markdown\n"
  CONTEXT+="$HANDOFF_CONTENT"
  CONTEXT+="\`\`\`\n\n"
  CONTEXT+="**IMPORTANT**: Acknowledge this to CEO and ask if they want to continue.\n\n"
fi

# Priority 2: Pending agent responses
if [[ ${#RESPONSES[@]} -gt 0 ]]; then
  CONTEXT+="## 📬 Pending Role Responses\n\n"
  CONTEXT+="The following tasks completed:\n\n"
  CONTEXT+="$RESPONSE_SUMMARY"
  CONTEXT+="**Actions:**\n"
  CONTEXT+="- Review outputs above\n"
  CONTEXT+="- Clear processed: \`rm .claude/orchestration/<role>/responses/<task_id>.response\`\n"
  CONTEXT+="- Dispatch new: \`uv run .claude/agents/dispatch.py task <role> \"prompt\" --cli <platform>\`\n\n"
fi

# Priority 3: Project state reminder
if [[ -n "$STATE_SUMMARY" ]]; then
  CONTEXT+="## 📊 Project State\n\n"
  CONTEXT+="$STATE_SUMMARY\n\n"
  CONTEXT+="**Key files**: \`.planning/STATE.md\`, \`.planning/PHASE-GALAXY.md\`\n\n"
fi

# If nothing else, show ready state
if [[ -z "$CONTEXT" ]]; then
  CONTEXT="## Orchestrator Ready\n\n"
  CONTEXT+="No handoff, no pending responses. Fresh session.\n\n"
  CONTEXT+="$STATE_SUMMARY\n\n"
  CONTEXT+="**Available Roles:**\n"
  CONTEXT+="- CODERS: implementer, simplifier, validator, tester, architect, advisor\n"
  CONTEXT+="- RESEARCHERS: docs-fetcher, codebase-navigator, world-knowledge\n\n"
  CONTEXT+="**Dispatch tasks:**\n"
  CONTEXT+="\`\`\`bash\n"
  CONTEXT+="uv run .claude/agents/dispatch.py task implementer \"Your task here\" --cli claude\n"
  CONTEXT+="uv run .claude/agents/dispatch.py task docs-fetcher \"Get docs for X\" --cli gemini\n"
  CONTEXT+="uv run .claude/agents/dispatch.py status\n"
  CONTEXT+="\`\`\`\n"
fi

# Log
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESPONSE_COUNT=${#RESPONSES[@]}
echo "[${TIMESTAMP}] SessionStart: orchestrator (source: ${SOURCE}, pending_responses: ${RESPONSE_COUNT}, has_handoff: ${HAS_HANDOFF})" >> "${LOG_DIR}/hooks.log"

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
