#!/bin/bash
# Notient Agent Dispatch Script
# Usage: ./dispatch.sh <command> [args...]
#
# Commands:
#   task <agent> <prompt>  - Write TASK.md and start agent
#   start <agent>          - Start an agent
#   stop <agent>           - Send /terminate then stop agent
#   status <agent>         - Send /status to agent
#   ping <agent>           - Send /ping to agent
#   stop-all               - Stop all agents
#
# Examples:
#   ./dispatch.sh task archie "Implement the TSI chunker"
#   ./dispatch.sh start sage
#   ./dispatch.sh stop archie
#   ./dispatch.sh status faye

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATION_DIR="$SCRIPT_DIR/orchestration"
MPROCS_SERVER="127.0.0.1:4050"

# Helper: send mprocs command
mprocs_ctl() {
  mprocs --ctl "$1" 2>/dev/null || echo "Warning: mprocs command failed"
}

# Helper: validate agent name
validate_agent() {
  case $1 in
    archie|sage|faye|orchestrator) return 0 ;;
    *) echo "Invalid agent: $1 (must be archie, sage, faye, or orchestrator)"; exit 1 ;;
  esac
}

# Command: task
cmd_task() {
  local agent=$1
  local prompt=$2
  validate_agent "$agent"

  if [ -z "$prompt" ]; then
    echo "Error: prompt required"
    echo "Usage: $0 task <agent> <prompt>"
    exit 1
  fi

  # Write TASK.md
  cat > "$ORCHESTRATION_DIR/$agent/TASK.md" << EOF
# $agent Task
status: ready
timestamp: $(date -Iseconds)

## task
$prompt

## verify
- bun run typecheck
- bun run build

## git
msg: "feat($agent): from dispatch"
EOF

  echo "Wrote TASK.md for $agent"

  # Start the agent
  mprocs_ctl "{\"c\": \"start-proc\", \"name\": \"$agent\"}"
  echo "Started $agent"
}

# Command: start
cmd_start() {
  local agent=$1
  validate_agent "$agent"
  mprocs_ctl "{\"c\": \"start-proc\", \"name\": \"$agent\"}"
  echo "Started $agent"
}

# Command: stop (clean termination)
cmd_stop() {
  local agent=$1
  validate_agent "$agent"

  # Send /terminate first
  echo "Sending /terminate to $agent..."
  mprocs_ctl "{\"c\": \"send-key\", \"key\": \"/terminate\\n\"}"

  # Wait a moment for clean shutdown
  sleep 2

  # Force stop if still running
  mprocs_ctl "{\"c\": \"stop-proc\", \"name\": \"$agent\"}"
  echo "Stopped $agent"
}

# Command: status
cmd_status() {
  local agent=$1
  validate_agent "$agent"
  mprocs_ctl "{\"c\": \"send-key\", \"key\": \"/status\\n\"}"
  echo "Sent /status to $agent"
}

# Command: ping
cmd_ping() {
  local agent=$1
  validate_agent "$agent"
  mprocs_ctl "{\"c\": \"send-key\", \"key\": \"/ping\\n\"}"
  echo "Sent /ping to $agent"
}

# Command: stop-all
cmd_stop_all() {
  for agent in archie sage faye orchestrator; do
    echo "Stopping $agent..."
    mprocs_ctl "{\"c\": \"send-key\", \"key\": \"/terminate\\n\"}" || true
  done
  sleep 2
  for agent in archie sage faye orchestrator; do
    mprocs_ctl "{\"c\": \"stop-proc\", \"name\": \"$agent\"}" || true
  done
  echo "All agents stopped"
}

# Main
case $1 in
  task)   cmd_task "$2" "$3" ;;
  start)  cmd_start "$2" ;;
  stop)   cmd_stop "$2" ;;
  status) cmd_status "$2" ;;
  ping)   cmd_ping "$2" ;;
  stop-all) cmd_stop_all ;;
  *)
    echo "Notient Agent Dispatch"
    echo ""
    echo "Usage: $0 <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  task <agent> <prompt>  Write TASK.md and start agent"
    echo "  start <agent>          Start an agent"
    echo "  stop <agent>           Send /terminate then stop"
    echo "  status <agent>         Send /status to agent"
    echo "  ping <agent>           Send /ping to agent"
    echo "  stop-all               Stop all agents"
    echo ""
    echo "Agents: archie, sage, faye, orchestrator"
    exit 1
    ;;
esac
