# Agent Coordination File

> **CRITICAL: Read this before making ANY changes.**

This file coordinates parallel development between AI agents working on separate git branches.

---

## Active Session: 2026-01-09

| Agent | Branch | Worktree | Focus |
|-------|--------|----------|-------|
| **Claude** | `fix/critical-bugs` | `/home/akougkas/projects/notient` | Bug fixes, core issues |
| **Gemini** | `feat/sidebar-v2-ui` | `/home/akougkas/projects/_worktrees/notient-gemini` | UI/UX implementation |

**Base commit:** `879424e` (both branches stem from here)

---

## File Ownership Rules

### Claude EXCLUSIVELY owns:

```
src/core/**/*                           # All core logic
src/services/**/*                       # All services
src/ui/modals/TaskModal.ts              # Chat modal fixes
src/core/intelligence/noteIntelligence.ts  # Service key fix
src/core/agent/profileManager.ts        # Async fix
```

### Gemini EXCLUSIVELY owns:

```
src/ui/sidebar/components/*.tsx         # New UI components
src/ui/styles/components/*.css          # Component CSS
src/ui/sidebar/views/*.tsx              # New view components (create)
```

### SHARED (coordinate before editing):

```
src/ui/sidebar/App.tsx                  # Both need to touch this
```

**App.tsx Coordination:**
- **Claude**: Fix line 91 (add `services:initialized` event subscription) - DO THIS FIRST
- **Gemini**: After Claude's fix is committed, restructure for tabs/views

---

## Communication Protocol

### Before editing a shared file:

1. Check this file for ownership
2. If shared, add a note below in "Active Edits" section
3. Commit your changes with clear message
4. Update "Completed" section

### Commit message format:

```
[claude] fix: description
[gemini] feat: description
```

---

## Active Edits

<!-- Add entries here when working on shared files -->

| Agent | File | What | Status |
|-------|------|------|--------|
| Claude | `App.tsx` | Adding services:initialized subscription | PENDING |

---

## Completed Edits

<!-- Move entries here when committed -->

| Agent | File | Commit | Description |
|-------|------|--------|-------------|
| - | - | - | - |

---

## Merge Order

When both agents complete their work:

```bash
git checkout main
git merge fix/critical-bugs      # Claude's fixes FIRST
git merge feat/sidebar-v2-ui     # Gemini's UI SECOND
```

**Why this order:** Fixes establish correct foundations, then UI builds on top.

---

## Key Specs (Both Agents Should Read)

| Document | Purpose |
|----------|---------|
| `.claude/CLAUDE.md` | Project context, architecture, current state |
| `.claude/specs/sidebar-v2-architecture.md` | UI spec for three-view tabbed sidebar |
| `.claude/audit/MASTER-TODO.md` | Full list of issues from 6-agent audit |

---

## Quick Reference: What We're Building

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (locked) - Gemini                                       │
│  [Notient]                    [📝 Note] [🤖 Agents] [💬 Chat]    │
├─────────────────────────────────────────────────────────────────┤
│  CONTENT - Gemini                                               │
│  • Note Vitals: Identity → Vitals → Quick Actions → Insights    │
│  • Agent Streams: Active → Pending Review → Recent Activity     │
│  • Chat: Context → Messages → Input                             │
├─────────────────────────────────────────────────────────────────┤
│  FOOTER (locked) - Gemini                                       │
│  [Providers]      │      [Index]       │     [Agents]           │
└─────────────────────────────────────────────────────────────────┘

Core/Services Bug Fixes - Claude
• App.tsx:91 - services:initialized subscription
• noteIntelligence.ts:503 - service key mismatch
• profileManager.ts:129 - async/await fix
• TaskModal.ts:296 - chatHistory truncation
```

---

## Emergency Contact

If you encounter a merge conflict or need to coordinate:
1. STOP making changes
2. Document the conflict in "Active Edits" above
3. Wait for human to coordinate

---

**Last updated:** 2026-01-09 by Claude
