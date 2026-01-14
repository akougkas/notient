#!/usr/bin/env bash
#
# git-prepare.sh - Prepare agent worktree for a new task
#
# Usage:
#   ./git-prepare.sh <agent> <branch> [base]
#
# Examples:
#   ./git-prepare.sh archie archie/swarm-phase-3
#   ./git-prepare.sh sage sage/swarm-phase-4 beta-spec
#   ./git-prepare.sh faye faye/swarm-phase-5
#
# What it does:
#   1. Navigates to agent's worktree
#   2. Stashes any uncommitted changes (safety)
#   3. Creates/resets branch from base (default: beta-spec)
#   4. Cleans untracked files
#   5. Reports final state
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
WORKTREE_BASE="$HOME/projects/_worktrees"
MAIN_REPO="$HOME/projects/notient"

# Arguments
AGENT="${1:-}"
BRANCH="${2:-}"
BASE="${3:-beta-spec}"

# Validation
if [[ -z "$AGENT" ]] || [[ -z "$BRANCH" ]]; then
    echo -e "${RED}Usage: $0 <agent> <branch> [base]${NC}"
    echo ""
    echo "Arguments:"
    echo "  agent   Agent name: archie, sage, or faye"
    echo "  branch  Target branch name (e.g., archie/swarm-phase-3)"
    echo "  base    Base branch to create from (default: beta-spec)"
    echo ""
    echo "Examples:"
    echo "  $0 archie archie/swarm-phase-3"
    echo "  $0 sage sage/swarm-phase-4 beta-spec"
    exit 1
fi

# Validate agent
WORKTREE_PATH="$WORKTREE_BASE/notient-$AGENT"
if [[ ! -d "$WORKTREE_PATH" ]]; then
    echo -e "${RED}Error: Worktree not found: $WORKTREE_PATH${NC}"
    echo "Valid agents: archie, sage, faye"
    exit 1
fi

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Git Prepare: $AGENT${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Step 1: Enter worktree
echo -e "${YELLOW}[1/5] Entering worktree...${NC}"
cd "$WORKTREE_PATH"
echo "  Path: $WORKTREE_PATH"
echo "  Current branch: $(git branch --show-current)"
echo ""

# Step 2: Check for uncommitted changes
echo -e "${YELLOW}[2/5] Checking for uncommitted changes...${NC}"
if [[ -n "$(git status --porcelain)" ]]; then
    echo "  Found uncommitted changes, stashing..."
    STASH_MSG="git-prepare auto-stash $(date +%Y%m%d-%H%M%S)"
    git stash push -m "$STASH_MSG" --include-untracked
    echo -e "  ${GREEN}Stashed as: $STASH_MSG${NC}"
else
    echo "  No uncommitted changes"
fi
echo ""

# Step 3: Fetch latest from main repo (to ensure beta-spec is current)
echo -e "${YELLOW}[3/5] Syncing with main repo...${NC}"
# Fetch from the main repo to get latest beta-spec
git fetch "$MAIN_REPO" "$BASE:$BASE" --force 2>/dev/null || {
    echo "  Note: Could not fetch $BASE, using local version"
}
echo "  Base branch: $BASE @ $(git rev-parse --short $BASE)"
echo ""

# Step 4: Create/reset branch from base
echo -e "${YELLOW}[4/5] Creating branch from $BASE...${NC}"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "  Branch exists, resetting to $BASE..."
    git checkout "$BRANCH"
    git reset --hard "$BASE"
else
    echo "  Creating new branch..."
    git checkout -B "$BRANCH" "$BASE"
fi
echo -e "  ${GREEN}Now on: $BRANCH${NC}"
echo ""

# Step 5: Clean untracked files
echo -e "${YELLOW}[5/5] Cleaning untracked files...${NC}"
UNTRACKED=$(git clean -fdn)
if [[ -n "$UNTRACKED" ]]; then
    echo "  Removing untracked files..."
    git clean -fd
    echo -e "  ${GREEN}Cleaned${NC}"
else
    echo "  No untracked files"
fi
echo ""

# Final status
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Preparation Complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Agent:    $AGENT"
echo "  Worktree: $WORKTREE_PATH"
echo "  Branch:   $(git branch --show-current)"
echo "  HEAD:     $(git rev-parse --short HEAD)"
echo "  Base:     $BASE"
echo ""
echo -e "  ${BLUE}Ready for task dispatch!${NC}"
echo ""

# Show recent commits for verification
echo "Recent commits on this branch:"
git log --oneline -3
