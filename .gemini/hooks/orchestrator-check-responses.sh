#!/usr/bin/env bash
# Check all agent response queues and report pending responses (Gemini CLI)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORCH_DIR="$REPO_ROOT/.gemini/orchestration"

has_responses=false
output=""

for agent in archie sage faye; do
    response_dir="$ORCH_DIR/$agent/responses"

    if [[ -d "$response_dir" ]]; then
        count=$(find "$response_dir" -name "*.response" -type f 2>/dev/null | wc -l)

        if [[ "$count" -gt 0 ]]; then
            has_responses=true
            output+="📬 $agent: $count response(s) pending\n"

            # Show brief summary of each response
            for resp in "$response_dir"/*.response; do
                [[ -f "$resp" ]] || continue
                task_id=$(basename "$resp" .response)
                status=$(jq -r '.status // "unknown"' "$resp")
                elapsed=$(jq -r '.elapsed_seconds // 0' "$resp")
                output+="  - $task_id: $status (${elapsed}s)\n"
            done
        fi
    fi
done

if [ "$has_responses" = true ]; then
    echo -e "\n--- PENDING RESPONSES ---"
    echo -e "$output"
    echo "-------------------------"
    echo "Check responses: uv run .gemini/agents/dispatch.py --responses <agent>"
fi

echo '{"continue": true}'
