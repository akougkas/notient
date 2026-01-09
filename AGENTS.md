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
| Claude | `Omnibar.tsx` | Created search component (Gemini's area) | NEEDS MERGE |
| Claude | `AgentStreamsView.tsx` | Created review queue view (Gemini's area) | NEEDS MERGE |
| Claude | `agent-streams.css` | Created styles (Gemini's area) | NEEDS MERGE |
| Gemini | `Header.tsx` | Created tab-based header | COMPLETE |
| Gemini | `Footer.tsx` | Created three-zone status footer | COMPLETE |
| Gemini | `VitalsCards.tsx` | Created 4-metric vitals cards | COMPLETE |
| Gemini | `AgentStreamsView.tsx` | Created agent streams view (3 sections) | CONFLICT with Claude |
| Gemini | `ChatView.tsx` | Created chat interface | COMPLETE |
| Gemini | `App.tsx` | Full restructure with tabs, views, signals | COMPLETE |
| Gemini | `agent-streams.css` | Created styles | CONFLICT with Claude |

**WARNING:** Both Claude and Gemini created AgentStreamsView.tsx and agent-streams.css independently. Manual merge required.

---

## Completed Edits

<!-- Move entries here when committed -->

| Agent | File | Commit | Description |
|-------|------|--------|-------------|
| Claude | `App.tsx` | `22e938e` | Added services:initialized event subscription |
| Claude | `noteIntelligence.ts` | `22e938e` | Fixed service key from 'searchPipeline' to 'search' |
| Claude | `profileManager.ts` | `22e938e` | Removed await on synchronous getIndexedCount() |
| Claude | `TaskModal.ts` | `22e938e` | Fixed chatHistory truncation (getMessages vs getMessagesForLLM) |
| Claude | `ChatView.tsx` | `07fc487` | Created sidebar chat view with streaming support |
| Claude | `App.tsx` (Footer) | `07fc487` | Wired up event subscriptions for providers/index/agents |
| Claude | `chat-view.css` | `07fc487` | Added styles for chat interface |
| Claude | `main.ts` | (pending) | Fixed early return flag reset + services:failed event |
| Claude | `actionApplier.ts` | (pending) | Fixed Phase 3 stubs to return error instead of fake success |
| Claude | `actionHistory.ts` | (pending) | Fixed batch undo partial failure handling |
| Claude | `profileManager.ts` | (pending) | Added profile:updated event emission |
| Claude | `events.ts` | (pending) | Added profile:updated and services:failed event types |
| Claude | `IndexManagementPanel.ts` | (pending) | Added try/catch error handling |
| Claude | `TaskModal.ts` | (pending) | Added ConversationStore history loading |
| Claude | `Omnibar.tsx` | (pending) | Created search input component |
| Claude | `AgentStreamsView.tsx` | (pending) | Created review queue view |
| Claude | `agent-streams.css` | (pending) | Created agent streams styles |
| Claude | `KernelContext.tsx` | (pending) | Added useServicesInitialized hook |
| Claude | `IntelligenceActions.ts` | (pending) | REMOVED dead code file |
| Claude | `openai-compatible.ts` | (pending) | Added 5-min timeout to LLM streaming |
| Claude | `pipeline.ts` | (pending) | Fixed cache key array mutation + disposal |
| Claude | `noteIntelligence.ts` | (pending) | Added queue bounding (max 1000) |
| Claude | `KernelContext.tsx` | (pending) | Fixed useCallback with useRef pattern |
| Claude | `SettingsTab.ts` | (pending) | Added chunk size change warning |
| Claude | `promptBuilder.ts` | (pending) | Added profile to action plan prompts |
| Claude | `pipeline.ts` | (pending) | Added search:progress events |
| Claude | `events.ts` | (pending) | Added SearchProgressEvent type |
| Claude | `actionPipeline.ts` | (pending) | Added executeBatchesInOrder + topological sort |
| Claude | `indexManager.ts` | (pending) | Added import dimension validation |
| Claude | `IndexManagementPanel.ts` | (pending) | Fixed button state management |
| Claude | `SettingsTab.ts` | (pending) | Added settings validation (URL, numbers, models) |
| Claude | `kernel.ts` | (pending) | Added ServiceRegistry for type-safe services |
| Claude | `pipeline.ts` | (pending) | Added search:error event emission |
| Claude | `events.ts` | (pending) | Added SearchErrorEvent type |
| Gemini | `Header.tsx` | (pending) | Created tab-based header with view switching |
| Gemini | `Footer.tsx` | (pending) | Created three-zone status footer |
| Gemini | `VitalsCards.tsx` | (pending) | Created 4-metric vitals cards component |
| Gemini | `ChatView.tsx` | (pending) | Created chat interface with context, messages, input |
| Gemini | `NoteCard.tsx` | (pending) | Enhanced with path, folder, PARA type |
| Gemini | `App.tsx` | (pending) | Full restructure: tabs, views, signals, event subscriptions |
| Gemini | `header.css` | (pending) | Tab navigation styles |
| Gemini | `footer.css` | (pending) | Three-zone footer styles |
| Gemini | `vitals-cards.css` | (pending) | Metric card styles |
| Gemini | `chat-view.css` | (pending) | Chat interface styles |
| Gemini | `note-card.css` | (pending) | Enhanced meta row styles |
| Gemini | `base.css` | (pending) | Placeholder component styles |
| Gemini | `index.css` | (pending) | Added new component imports |

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

**Last updated:** 2026-01-09 by Gemini (sidebar v2.0 complete)
