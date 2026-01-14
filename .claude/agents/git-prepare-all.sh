#!/usr/bin/env bash
#
# git-prepare-all.sh - Prepare all agent worktrees for a new session
#
# Usage:
#   ./git-prepare-all.sh [base]
#
# This script prepares all three agents with their swarm phase branches:
#   - archie → archie/swarm-phase-3
#   - sage   → sage/swarm-phase-4
#   - faye   → faye/swarm-phase-5
#
# Override branches by setting environment variables:
#   ARCHIE_BRANCH=archie/custom-task ./git-prepare-all.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-beta-spec}"

# Default branches (can be overridden via environment)
ARCHIE_BRANCH="${ARCHIE_BRANCH:-archie/swarm-phase-3}"
SAGE_BRANCH="${SAGE_BRANCH:-sage/swarm-phase-4}"
FAYE_BRANCH="${FAYE_BRANCH:-faye/swarm-phase-5}"

echo "════════════════════════════════════════════════════════════════"
echo "  Preparing All Agent Worktrees"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  Base:   $BASE"
echo "  Archie: $ARCHIE_BRANCH"
echo "  Sage:   $SAGE_BRANCH"
echo "  Faye:   $FAYE_BRANCH"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""

# Prepare each agent
"$SCRIPT_DIR/git-prepare.sh" archie "$ARCHIE_BRANCH" "$BASE"
echo ""
echo ""

"$SCRIPT_DIR/git-prepare.sh" sage "$SAGE_BRANCH" "$BASE"
echo ""
echo ""

"$SCRIPT_DIR/git-prepare.sh" faye "$FAYE_BRANCH" "$BASE"
echo ""
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "  All Agents Prepared"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  Worktree Summary:"
echo ""
echo "  notient-archie → $ARCHIE_BRANCH"
echo "  notient-sage   → $SAGE_BRANCH"
echo "  notient-faye   → $FAYE_BRANCH"
echo ""
echo "  All branched from: $BASE"
echo ""
echo "  Next: Dispatch tasks to agents"
echo ""
