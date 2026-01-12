#!/bin/bash
# Notient Multi-Agent Workspace Manager
# Usage: .claude/dev-workspace.sh [start|stop|restart|status|clean]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MPROCS_CONFIG="$SCRIPT_DIR/mprocs.yaml"
SIGNALS_DIR="$SCRIPT_DIR/orchestration/signals"
STATE_FILE="$SCRIPT_DIR/orchestration/state/agents.json"
LOGS_DIR="$SCRIPT_DIR/orchestration/logs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Kill all Claude processes in agent worktrees
kill_agent_claudes() {
    log_info "Killing agent Claude processes..."

    # Find claude processes in worktrees
    local pids=$(pgrep -f "claude.*notient-(archie|sage|faye)" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
        sleep 1
        # Force kill if still running
        echo "$pids" | xargs -r kill -9 2>/dev/null || true
        log_success "Killed agent Claude processes"
    else
        log_info "No agent Claude processes found"
    fi
}

# Kill orchestrator Claude process
kill_orchestrator_claude() {
    log_info "Killing orchestrator Claude process..."

    local pids=$(pgrep -f "claude.*NOTIENT_ORCHESTRATOR" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
        echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
        sleep 1
        echo "$pids" | xargs -r kill -9 2>/dev/null || true
        log_success "Killed orchestrator Claude process"
    else
        log_info "No orchestrator Claude process found"
    fi
}

# Kill mprocs
kill_mprocs() {
    log_info "Killing mprocs..."

    pkill -f "mprocs.*mprocs.yaml" 2>/dev/null || true
    sleep 1
    pkill -9 -f "mprocs.*mprocs.yaml" 2>/dev/null || true

    log_success "mprocs killed"
}

# Reset agent states
reset_state() {
    log_info "Resetting agent states..."

    mkdir -p "$(dirname "$STATE_FILE")"
    cat > "$STATE_FILE" << 'EOF'
{
  "archie": {"state": "stopped", "last_status": null, "last_activity": null, "session_id": null},
  "sage": {"state": "stopped", "last_status": null, "last_activity": null, "session_id": null},
  "faye": {"state": "stopped", "last_status": null, "last_activity": null, "session_id": null}
}
EOF
    log_success "Agent states reset"
}

# Clear signals
clear_signals() {
    log_info "Clearing pending signals..."

    mkdir -p "$SIGNALS_DIR"
    rm -f "$SIGNALS_DIR"/*.signal 2>/dev/null || true

    log_success "Signals cleared"
}

# Clear logs
clear_logs() {
    log_info "Clearing hook logs..."

    mkdir -p "$LOGS_DIR"
    rm -f "$LOGS_DIR"/*.log 2>/dev/null || true

    log_success "Logs cleared"
}

# Show status
show_status() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "              NOTIENT WORKSPACE STATUS"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    # Check mprocs
    if pgrep -f "mprocs.*mprocs.yaml" > /dev/null 2>&1; then
        log_success "mprocs: RUNNING"
    else
        log_warn "mprocs: STOPPED"
    fi

    # Check orchestrator
    if pgrep -f "claude.*NOTIENT_ORCHESTRATOR" > /dev/null 2>&1; then
        log_success "orchestrator: RUNNING"
    else
        log_warn "orchestrator: STOPPED"
    fi

    # Check agents
    for agent in archie sage faye; do
        if pgrep -f "claude.*notient-${agent}" > /dev/null 2>&1; then
            log_success "${agent}: RUNNING"
        else
            log_info "${agent}: stopped"
        fi
    done

    echo ""

    # Show agent states from file
    if [[ -f "$STATE_FILE" ]]; then
        echo "Agent States (from hooks):"
        "$SCRIPT_DIR/hooks/orchestrator-agent-states.sh" 2>/dev/null || echo "  (unable to read)"
    fi

    echo ""

    # Show pending signals
    local signal_count=$(find "$SIGNALS_DIR" -name "*.signal" -type f 2>/dev/null | wc -l)
    if [[ "$signal_count" -gt 0 ]]; then
        log_warn "Pending signals: $signal_count"
        for f in "$SIGNALS_DIR"/*.signal; do
            [[ -f "$f" ]] || continue
            local agent=$(jq -r '.agent' < "$f")
            local status=$(jq -r '.status' < "$f")
            echo "  - $agent: $status"
        done
    else
        log_info "No pending signals"
    fi

    echo ""
}

# Start workspace
start_workspace() {
    log_info "Starting Notient workspace..."

    # Check if already running
    if pgrep -f "mprocs.*mprocs.yaml" > /dev/null 2>&1; then
        log_warn "mprocs already running. Use 'restart' to restart."
        return 1
    fi

    # Ensure directories exist
    mkdir -p "$SIGNALS_DIR" "$LOGS_DIR" "$(dirname "$STATE_FILE")"

    # Start mprocs
    cd "$PROJECT_DIR"
    log_info "Launching mprocs..."
    mprocs -c "$MPROCS_CONFIG"
}

# Stop workspace
stop_workspace() {
    log_info "Stopping Notient workspace..."

    kill_agent_claudes
    kill_orchestrator_claude
    kill_mprocs

    log_success "Workspace stopped"
}

# Full clean restart
clean_restart() {
    log_info "Performing clean restart..."

    stop_workspace
    reset_state
    clear_signals
    clear_logs

    sleep 1

    start_workspace
}

# Show help
show_help() {
    echo "Notient Multi-Agent Workspace Manager"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  start     Start mprocs workspace"
    echo "  stop      Stop all Claude processes and mprocs"
    echo "  restart   Stop and start"
    echo "  clean     Full clean: stop, reset states, clear signals, start"
    echo "  status    Show running processes and pending signals"
    echo "  kill      Kill all Claude/mprocs processes without restart"
    echo "  reset     Reset agent states and clear signals (no restart)"
    echo ""
    echo "Examples:"
    echo "  $0 clean    # Fresh start, no stale state"
    echo "  $0 status   # Check what's running"
    echo "  $0 kill     # Emergency stop everything"
}

# Main
case "${1:-start}" in
    start)
        start_workspace
        ;;
    stop)
        stop_workspace
        ;;
    restart)
        stop_workspace
        sleep 1
        start_workspace
        ;;
    clean)
        clean_restart
        ;;
    status)
        show_status
        ;;
    kill)
        kill_agent_claudes
        kill_orchestrator_claude
        kill_mprocs
        log_success "All processes killed"
        ;;
    reset)
        reset_state
        clear_signals
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac
