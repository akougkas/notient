#!/usr/bin/env bash
# Check all role response queues and report pending responses
# Used by orchestrator hooks to inject response context

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORCH_DIR="$REPO_ROOT/.claude/orchestration"

# Role definitions
CODER_ROLES="implementer simplifier validator tester architect advisor"
RESEARCHER_ROLES="docs-fetcher codebase-navigator world-knowledge"
ALL_ROLES="$CODER_ROLES $RESEARCHER_ROLES"

has_responses=false
output=""

for role in $ALL_ROLES; do
    response_dir="$ORCH_DIR/$role/responses"

    if [[ -d "$response_dir" ]]; then
        count=$(find "$response_dir" -name "*.response" -type f 2>/dev/null | wc -l)

        if [[ "$count" -gt 0 ]]; then
            has_responses=true
            output+="📬 $role: $count response(s) pending\n"

            # Show brief summary of each response
            for resp in "$response_dir"/*.response; do
                [[ -f "$resp" ]] || continue
                task_id=$(basename "$resp" .response)
                status=$(grep -o '"status": *"[^"]*"' "$resp" | cut -d'"' -f4)
                elapsed=$(grep -o '"elapsed_seconds": *[0-9.]*' "$resp" | grep -o '[0-9.]*')
                cli=$(grep -o '"cli": *"[^"]*"' "$resp" | cut -d'"' -f4)

                if [[ "$status" == "complete" ]]; then
                    output+="   ✓ $task_id (${elapsed}s via $cli)\n"
                else
                    output+="   ✗ $task_id (failed via $cli)\n"
                fi
            done
        fi
    fi
done

if $has_responses; then
    echo -e "$output"
    echo ""
    echo "Read responses: uv run .claude/agents/dispatch.py --responses <role>"
    echo "Clear response: rm .claude/orchestration/<role>/responses/<task_id>.response"
else
    echo "No pending responses"
fi
