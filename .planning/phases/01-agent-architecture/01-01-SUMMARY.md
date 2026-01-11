---
phase: 01-agent-architecture
plan: 01
subsystem: agents
tags: [typescript, agents, architecture, routing]

# Dependency graph
requires:
  - phase: none
    provides: N/A (first plan)
provides:
  - UIAgentType and ExpertAgentType type distinction
  - isUI property on AgentConfig interface
  - isUIRequest() helper for routing
  - Chat identity as "Conversational Interface"
affects: [02-connection-rename, 03-quick-actions, phase-2-insights]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-tier agent model: UI agents (chat) vs Expert agents (specialists)"
    - "Intent-based delegation: signal WHAT (edit/classify/link) not WHO"
    - "Preflight optimization: skip context-builder for simple conversational queries"

key-files:
  created: []
  modified:
    - src/core/agents/types.ts
    - src/core/agents/chiefOfStaff.ts
    - src/core/agents/agentIdentity.ts

key-decisions:
  - "Chat is UI layer, not 13th agent — explicitly modeled with isUI: true"
  - "Delegation signals intent (edit/classify/link) not agent type"
  - "Simple UI requests skip context-builder preflight for efficiency"

patterns-established:
  - "UIAgentType vs ExpertAgentType distinction for future agent additions"
  - "isUI property on AgentConfig for programmatic UI/Expert detection"

issues-created: []

# Metrics
duration: 4min
completed: 2026-01-11
---

# Phase 1 Plan 1: Chat as UI Layer Summary

**Established two-tier agent model with Chat as UI layer (isUI: true) and experts as routable specialists (isUI: false), with intent-based delegation protocol**

## Performance

- **Duration:** 4 min
- **Started:** 2026-01-11T14:47:31Z
- **Completed:** 2026-01-11T14:51:08Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Established UIAgentType and ExpertAgentType as distinct type categories
- Added isUI property to AgentConfig for programmatic detection
- Created isUIRequest() and isSimpleUIRequest() helpers for efficient routing
- Updated Chat identity from "Senior Advisor & Liaison" to "Conversational Interface"
- Simplified delegation protocol to signal INTENT (edit/classify/link) not agent type

## Task Commits

Each task was committed atomically:

1. **Task 1: Add UI vs Expert agent distinction to type system** - `22651c9` (feat)
2. **Task 2: Update ChiefOfStaff to bypass routing for UI agents** - `83f811e` (feat)
3. **Task 3: Update agentIdentity to clarify Chat's UI role** - `8d243fd` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `src/core/agents/types.ts` - Added UIAgentType, ExpertAgentType, isUI property on AgentConfig
- `src/core/agents/chiefOfStaff.ts` - Added isUIRequest(), isSimpleUIRequest() helpers, updated routing
- `src/core/agents/agentIdentity.ts` - Updated Chat role/mission, simplified delegation protocol

## Decisions Made

- **Chat is UI, not 13th agent:** Explicitly modeled with `isUI: true` to formalize the architectural decision
- **Intent-based delegation:** Changed from `[DELEGATE:note-editor]` to `[DELEGATE:edit]` — signals WHAT not WHO
- **Preflight optimization:** Simple conversational queries skip context-builder for efficiency

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- Type system ready for Phase 1 Plan 2 (Connection Rename — deprecate link-finder type)
- Routing logic ready to be extended with new agent types
- Identity system documented for future agent additions

---
*Phase: 01-agent-architecture*
*Completed: 2026-01-11*
