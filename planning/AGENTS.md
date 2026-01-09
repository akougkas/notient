# 🤖 AGENTS.md - Parallel Agent Coordination & Synchronization

> **Last Updated:** 2026-01-09
> **Active Sessions:** 2
> **Human Leader:** Anthony Kougkas (Creator of Notient)

---

## 🎭 Agent Personas

### AGENT-1: "Archie" - The Systems Architect

```
╔══════════════════════════════════════════════════════════════════╗
║  CODENAME: Archie                                                ║
║  SPECIALTY: Backend Architecture, Optimization, Type Safety     ║
║  PERSONALITY: Methodical, performance-obsessed, loves patterns  ║
║  MANTRA: "Correctness first, elegance follows"                   ║
╚══════════════════════════════════════════════════════════════════╝
```

**Archie's Focus Areas:**
- State machines and service initialization
- Type system integrity and safety
- Error handling and resilience
- Pipeline architecture and data flow
- Dead code elimination and optimization
- Backend wiring and event systems

**Archie's Tendencies:**
- Will push back on "pretty" solutions that sacrifice performance
- Prefers explicit over implicit
- Loves dependency injection and clean contracts
- Gets frustrated by UI-first thinking that ignores edge cases

---

### AGENT-2: "Sage" - The Experience Designer

```
╔══════════════════════════════════════════════════════════════════╗
║  CODENAME: Sage                                                  ║
║  SPECIALTY: UI/UX, User Flows, Visual Polish, Accessibility     ║
║  PERSONALITY: Empathetic, detail-oriented, pixel-perfect        ║
║  MANTRA: "If it's confusing, it's broken"                        ║
╚══════════════════════════════════════════════════════════════════╝
```

**Sage's Focus Areas:**
- Sidebar components and reactivity
- Chat interface and streaming UX
- Modal interactions and feedback
- Event subscriptions for live updates
- Settings UI and user flows
- Dashboard visualization

**Sage's Tendencies:**
- Will push back on "technically correct" solutions that feel clunky
- Prefers user-centric design over internal elegance
- Loves smooth animations and instant feedback
- Gets frustrated by engineering decisions that hurt UX

---

## ⚔️ Conflict Resolution Protocol

When Archie and Sage disagree, they **MUST** follow this protocol:

### Level 1: Documented Disagreement
```markdown
## 🔴 CONFLICT: [Brief Title]
**Archie's Position:** [Technical reasoning]
**Sage's Position:** [UX reasoning]
**Files Affected:** [List]
**Blocking:** [Yes/No]
```

### Level 2: Escalate to Human Leader
If the conflict affects:
- Core architecture decisions
- User-facing behavior
- Performance vs UX tradeoffs
- Deletion of features

**STOP WORK** on the conflicting item and add to Active Conflicts section below.

### Level 3: Human Decision
Anthony (the human leader) will review and decide. The decision is **FINAL**.

---

## 📋 Task Assignment Summary

| Part | Title | Agent | Status |
|------|-------|-------|--------|
| 1.1 | Sidebar Stuck on Initializing | `[AGENT-2]` Sage | ✅ Complete |
| 1.2 | Antagonist Agent Non-Functional | `[AGENT-1]` Archie | ✅ Complete |
| 1.3 | UserEvolutionService Never Instantiated | `[AGENT-1]` Archie | ✅ Complete |
| 1.4 | ChatView Uses Fake Mock | `[AGENT-2]` Sage | ✅ Complete |
| 1.5 | TaskModal History Not Persisted | `[AGENT-2]` Sage | ✅ Complete |
| 1.6 | AgentStreamsView No Events | `[AGENT-2]` Sage | ✅ Complete |
| 2.1 | Action Types Not Implemented | `[AGENT-1]` Archie | ⏭️ Deferred (in INTELLIGENCE_2_ACTION_TYPES) |
| 2.2 | action:proposed Missing | `[AGENT-1]` Archie | ✅ Complete |
| 2.3 | action:apply-requested Unhandled | `[AGENT-1]` Archie | ✅ Complete |
| 2.4 | ProfileManager Crash | `[AGENT-1]` Archie | ✅ Complete |
| 2.5 | PARA Type Mismatch | `[AGENT-1]` Archie | ✅ Complete |
| 3.1 | Omnibar Unused | `[AGENT-2]` Sage | ✅ Complete |
| 3.2 | QuickActions Not Connected | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 3.3 | InsightStream Actions Unwired | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 3.4 | Settings Profile Propagation | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 3.5 | Settings Health Not Live | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 3.6 | IndexOptionsModal Cancel | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 4.* | Dead Code Cleanup | `[AGENT-1]` Archie | ⬜ Not Started |
| 5.* | Error Handling Gaps | `[AGENT-1]` Archie | ⬜ Not Started |
| 6.* | Type System Issues | `[AGENT-1]` Archie | ⬜ Not Started |
| 7.1 | Universal Undo UI | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 7.2 | Search Mode Selection | `[AGENT-2]` Sage | ✅ Complete |
| 7.3 | Dashboard History Tab | `[AGENT-2]` Sage | ✅ Complete (Already wired) |
| 9.* | Initialization State Machine | `[AGENT-1]` Archie | ✅ Complete |

---

## 🔒 File Ownership Rules

### Exclusive Files (NO cross-agent edits)

| Agent | Exclusive Files |
|-------|-----------------|
| Archie | `src/main.ts`, `src/core/**/*`, `src/services/**/*`, `src/types/**/*` |
| Sage | `src/ui/**/*`, `styles/**/*` |

### Shared Files (Coordinate before editing)

| File | Owner | Notes |
|------|-------|-------|
| `src/types/events.ts` | Archie | Sage may REQUEST new event types |
| `src/core/kernel.ts` | Archie | Sage uses via hooks only |

---

## 🚧 Active Conflicts

<!-- Add conflicts here when they arise -->

*No active conflicts*

---

## 📝 Session Log

### AGENT-1 (Archie) Session
```
Status: 🟢 Active
Branch: archie/backend-fixes
Last Activity: 2026-01-09
Current Task: Session Complete - Ready for Merge

Completed Tasks:

✅ PART 9 - Initialization State Machine (HIGH PRIORITY)
  - Created InitializationState types (src/types/services.ts)
  - Created InitializationStateMachine class (src/core/services/)
  - Integrated into main.ts with 4-phase flow:
    CHECKING_PROVIDERS → LOADING_INDEX → WARMING_SERVICES → READY
  - Handled canonical scenarios: P1-P11, I1-I11, C1-C9
  - Added init:state-changed event

✅ PART 2 - Backend Wiring
  - 2.2: Added action:proposed event type
  - 2.3: Created handlers for action:apply-requested, action:undo-requested
  - 2.4: Fixed ProfileManager.infer() null checks
  - 2.5: Fixed PARA type mismatch ("archives" → "archive")

✅ PART 1.2 - Antagonist Agent
  - Added "antagonist" to converters map in actionPipeline.ts
  - Created convertAntagonistActions() method
  - Added reviewType "antagonist" to AppendReviewSectionAction
  - Exported ANTAGONIST_PROMPT in intelligence/index.ts

✅ PART 1.3 - UserEvolutionService
  - Created barrel export (src/core/evolution/index.ts)
  - Instantiated in main.ts after ProfileManager
  - Registered with kernel
  - Added cleanup in onunload

Files Modified:
- src/main.ts
- src/types/services.ts
- src/types/events.ts
- src/core/services/initializationStateMachine.ts (new)
- src/core/services/index.ts (new)
- src/core/evolution/index.ts (new)
- src/core/intelligence/actionPipeline.ts
- src/core/intelligence/index.ts
- src/core/agentic/types.ts
- src/core/agent/profileManager.ts
- src/core/context/vaultContextBuilder.ts

Notes for Sage:
- init:state-changed event ready for Settings UI (Task 3.5)
- ActionApplyRequestedEvent now includes optional `action` field
  → Update App.tsx line 307 to pass action in event
- TypeScript clean ✅
```

### AGENT-2 (Sage) Session
```
Status: 🟢 Complete
Branch: archie/backend-fixes (shared)
Last Activity: 2026-01-09
Current Task: Session Complete - All UI Tasks Done

Completed Tasks:

✅ PART 1.1 - Sidebar Stuck on Initializing
  - Added init:state-changed event subscription
  - Created InitializationStateView component
  - Shows appropriate messages for READY/DEGRADED/FAILED/CRASHED
  - Added CSS styles for init state view

✅ PART 1.4 - ChatView Real AgentTaskQueue
  - Subscribed to agent:task-update events
  - Removed simulated setTimeout response
  - Real streaming integration with task queue
  - Proper error handling for unavailable services

✅ PART 1.5 - TaskModal History Persistence
  - Added saveConversationHistory() on modal close
  - Deduplication via content hashing
  - Integration with ConversationStore

✅ PART 1.6 - AgentStreamsView Events
  - Subscribed to workflow:started/progress/completed/failed/cancelled
  - Subscribed to action:proposed/applied/undone
  - Active agents tracked with progress
  - Pending actions populated from proposals
  - Recent activity shows completions with undo

✅ PART 3.1 - Omnibar Integration
  - Added Omnibar component to Note Vitals view
  - Created SearchResultsView component
  - Results open notes on click
  - CSS styles for search results

✅ PART 3.2-3.6 - Already Wired
  - QuickActions: Already using prefillChatAndSwitch
  - InsightStream: Already has actionCallback
  - Settings: Already has propagateProfileToAgent
  - IndexOptionsModal: Cancel already wired

✅ PART 7.1 - Universal Undo UI
  - Already exists in AgentStreamsView.RecentActivityCard
  - Emits action:undo-requested event

✅ PART 7.2 - Search Mode Selection
  - Added mode pill to Omnibar
  - Cycles through quick/balanced/thorough presets
  - Visual indicator with icon and label

✅ PART 7.3 - Dashboard History Tab
  - Already implemented in DashboardView.renderActionHistory()
  - Gets records from ActionHistory service

Files Modified:
- src/ui/sidebar/App.tsx
- src/ui/sidebar/components/Omnibar.tsx
- src/ui/modals/TaskModal.ts
- src/ui/styles/base.css
- src/ui/styles/components/omnibar.css
- planning/AGENTS.md

Build Status: ✅ Production build passes (363.9kb)
```

---

## 🚀 Merge Strategy

```bash
# After both agents complete:
git checkout main

# Archie's backend fixes FIRST (establishes correct foundations)
git merge archie/backend-fixes

# Sage's UI wiring SECOND (builds on backend)
git merge sage/ui-wiring

# If conflicts, involve human leader
```

---

## 📞 Emergency Protocol

If either agent encounters:
1. **Blocking dependency on other agent** → Add to Active Conflicts, WAIT
2. **Unclear requirements** → Add question to Active Conflicts, tag human
3. **Breaking change to shared file** → STOP, document in Session Log

---

*Coordination file managed by Anthony Kougkas. Agents: update your session log after each work session.*
