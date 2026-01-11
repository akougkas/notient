---
phase: 01-agent-architecture
plan: 03
subsystem: ui
tags: [quick-actions, contextual, vitals, preact]

# Dependency graph
requires:
  - phase: 01-agent-architecture
    provides: ConnectionAgent as canonical name, agent types in types.ts
provides:
  - 3 pinned + 3 contextual Quick Actions model
  - NoteVitals.content (wordCount, hasCheckboxes) for contextual filtering
  - AgenticTaskType using agent names instead of task names
affects: [phase-2-insights, phase-3-agent-streams]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Contextual UI: Actions adapt to note state (word count, links, checkboxes)"
    - "Condition-based filtering with fallback actions"

key-files:
  created: []
  modified:
    - src/ui/sidebar/components/QuickActions.tsx
    - src/ui/sidebar/state/appHandlers.ts
    - src/services/noteVitalsCalculator.ts
    - src/ui/sidebar/App.tsx

key-decisions:
  - "3 pinned (Enhance, Classify, Connect) + 3 contextual Quick Actions"
  - "Contextual actions prioritize by matching conditions, fallback to defaults"
  - "NoteVitals extended with content.wordCount and content.hasCheckboxes"

patterns-established:
  - "Condition-matching filter pattern for contextual UI elements"
  - "Separate matching vs fallback actions, combine after sorting"

issues-created:
  - "ISSUE-001: IndexManager fails to save large indices (RangeError: Invalid string length)"
  - "ISSUE-002: IntelligenceDb.getTopicForNote null reference error"

# Metrics
duration: 45min
completed: 2026-01-11
---

# Phase 1 Plan 03: Quick Actions Rewire Summary

**Implemented 3 pinned + 3 contextual Quick Actions model with note-state-based filtering**

## Performance

- **Duration:** 45 min (including debugging contextual logic)
- **Started:** 2026-01-11
- **Completed:** 2026-01-11
- **Tasks:** 3 (including bug fix for contextual selection logic)
- **Files modified:** 4

## Accomplishments

- Updated AgenticTaskType to use agent names (note-editor, classifier, connection)
- Created PINNED_ACTIONS constant with Enhance, Classify, Connect
- Implemented getContextualActions() with condition-based filtering
- Extended NoteVitals interface with content.wordCount and content.hasCheckboxes
- Added countWords() and detectCheckboxes() methods to NoteVitalsCalculator
- Fixed contextual action selection bug (conditional actions only shown when conditions match)

## Task Commits

1. **Task 1: Update AgenticTaskType to use agent types** - Types updated in appHandlers.ts
2. **Task 2: Implement pinned + contextual Quick Actions structure** - QuickActions.tsx refactored
3. **Bug fix: Contextual selection logic** - Fixed sorting to only include matching conditionals

## Files Created/Modified

- `src/ui/sidebar/components/QuickActions.tsx` - PINNED_ACTIONS, CONTEXTUAL_ACTIONS pool, getContextualActions() with fixed filter logic
- `src/ui/sidebar/state/appHandlers.ts` - AgenticTaskType now uses agent names
- `src/services/noteVitalsCalculator.ts` - Added content.wordCount and content.hasCheckboxes to NoteVitals
- `src/ui/sidebar/App.tsx` - Wired real noteState from vitals.content

## Decisions Made

- **Pinned actions always visible:** Enhance, Classify, Connect (route to expert agents)
- **Contextual priority system:** Conditions with priority < 10 are conditional, >= 10 are fallbacks
- **Word counting:** Excludes frontmatter, splits on whitespace
- **Checkbox detection:** Uses Obsidian's metadata.listItems with task property

## Deviations from Plan

- **Bug discovered during testing:** Original sorting logic showed conditional actions even when conditions didn't match
- **Fix applied:** Separated matching vs fallback actions, only include conditionals when conditions match

## Issues Encountered

1. **Contextual actions not changing:** Initial implementation had sorting bug that showed lowest-priority-number actions regardless of condition match
2. **IndexManager save failure:** Unrelated but observed - large index exceeds JSON.stringify string limit
3. **IntelligenceDb null reference:** Unrelated but observed - getTopicForNote called with null path

## Verified Behavior

Tested with multiple notes:
- `words=14, links=0` → Shows: Related, Expand, Summary (2 matched)
- `words=1625, links=5` → Shows: Summary, Link, Ideas (0 matched, fallbacks only)
- `words=1455, links=0` → Shows: Related, Summary, Link (1 matched)
- `checkboxes=true` → Shows: Tasks action prioritized

## Next Phase Readiness

- Quick Actions now route to expert agents via ChiefOfStaff
- Contextual filtering infrastructure ready for more sophisticated conditions
- Ready for Phase 2 (Insights Stream wiring)

---
*Phase: 01-agent-architecture*
*Completed: 2026-01-11*
