# Notient Roadmap - Deferred Features

> **Purpose:** Track features that were considered, designed, or partially implemented but deferred due to priority, complexity, or unclear value proposition.
>
> **Template Fields:**
> - **Title:** Feature name
> - **Description:** What the feature does
> - **Rationale:** Why this feature was designed/considered
> - **Why Deferred:** Specific reasons for deferring (blockers, priority, unclear value)
> - **Blockers:** What needs to happen before implementation
> - **Effort Estimate:** S (Small <1 day), M (Medium 1-3 days), L (Large 3+ days)
> - **Priority:** High / Medium / Low (for future consideration)
> - **Related:** Links to issues, CONTINUE.md sections, or other docs

---

## High Priority (Future)

*Features that are valuable but blocked by current priorities*

---

## Medium Priority (Future)

*Features that would be nice-to-have but not critical*

### Extract Dates to Calendar

**Description:** Action type that extracts dates, deadlines, and time-bound information from notes and creates calendar entries or task notes with due dates.

**Rationale:** Helps users capture time-sensitive information from meeting notes, project plans, or reference materials into actionable calendar items.

**Why Deferred:**
- Calendar integration strategy undefined (native calendar API vs Obsidian plugins vs external tools)
- Unclear UX: Should it create task notes with frontmatter dates, or integrate with external calendars?
- `extract_to_calendar` action type defined but never implemented (stub in actionApplier.ts)

**Blockers:**
- Define calendar integration approach
- Decide on date parsing strategy (natural language vs frontmatter)
- Research Obsidian calendar plugin compatibility

**Effort:** M (Medium) - 2-3 days
**Priority:** Medium
**Related:** CONTINUE.md Section 2.1, CONTINUE-GEMINI.md verification results

---

## Low Priority (Future Research)

*Features that need more research or have unclear value propositions*

### User Evolution Tracking Service

**Description:** Service that tracks user's current focus, sentiment, evolutionary stage (gathering/synthesizing/polishing), and recent topics based on vault activity patterns. Provides adaptive context for prompts and UI suggestions.

**Rationale:**
- Enables adaptive UI that matches user's current working mode
- Could personalize suggestions based on detected focus and sentiment
- Part of "sentient vault" vision where system adapts to user state

**Why Deferred:**
- **Unclear Value Proposition:** No concrete use cases where evolution state meaningfully changes UX
- **Service Never Used:** Implemented but never instantiated in main.ts (always returns null)
- **Stub Implementation:** Only handles 2 task types (synthesis, clipping) with trivial heuristics
- **No Persistence:** State resets on every plugin load
- **Placeholder Logic:** Topic extraction algorithm undefined (line 59 comment)
- **Missing Event Cleanup:** Subscriptions never cleaned up in unload()

**Blockers:**
1. **Define Concrete Use Cases:**
   - How would "synthesizing" stage change the UI differently than "gathering"?
   - What suggestions would differ based on sentiment?
   - How would recent topics influence prompt personalization beyond current profile system?

2. **Design Topic Extraction:**
   - Embeddings-based clustering of recent notes?
   - Frequency analysis of note titles/tags?
   - LLM-based theme detection?
   - What's the accuracy/latency tradeoff?

3. **Implement Persistence:**
   - Save to `evolution.json` or extend `profile.json`?
   - How often to persist (on every state change or debounced)?
   - Migration strategy for schema changes?

4. **Expand Event Subscriptions:**
   - Currently only `agent:task-update` (1 event type)
   - Need: `workflow:started`, `workflow:complete`, `action:applied`, `file:modified`, `search:complete`, `intelligence:updated` (6+ event types)
   - Each event needs custom analysis logic

**Effort:** L (Large) - 3+ days of focused work
**Priority:** Low
**Related:**
- CONTINUE.md Part 7 (Missing Features per README Vision)
- CONTINUE-GEMINI.md verification results
- `.claude/interviews/audit-decisions-20260109.md`
- Original implementation: `src/core/evolution/userEvolutionService.ts` (DELETED)
- Usage attempt: `src/core/context/vaultContextBuilder.ts:46` (now uses hardcoded defaults)

**Original Code Location (for reference):**
- File deleted in audit cleanup
- Git history: Check commit before deletion for implementation details
- 62 lines, minimal implementation

---

## Ideas / Research Needed

*Features that are interesting but need significant design work before commitment*

### Advanced Highlight Syntax with Metadata Tracking

**Description:** Custom syntax for inline issue highlights (e.g., `==issue:id==`) with frontmatter metadata for issue tracking, click-to-dismiss functionality, and persistent issue IDs.

**Rationale:** More sophisticated than inline comments, enables issue tracking across edits and provides better UX for dismissing resolved issues.

**Why Deferred:**
- Current implementation uses moderate approach (inline comments + callout)
- Custom syntax requires parser, metadata management, and UI integration
- Click-to-dismiss needs event handlers and DOM manipulation
- Issue IDs need generation and persistence strategy

**Blockers:**
- Prove that moderate approach (inline comments) is insufficient
- Design metadata schema for frontmatter issue tracking
- Build parser for custom syntax
- Implement DOM event handlers for click-to-dismiss

**Effort:** L (Large) - 4+ days
**Priority:** Low (research phase)
**Related:**
- CONTINUE-GEMINI.md verification (highlight_text_issues implementation)
- `.claude/interviews/audit-decisions-20260109.md` (decision to use moderate approach)

---

### Incremental main.ts Refactoring (Phased Approach)

**Description:** Alternative to comprehensive initialization refactoring. Extract ServiceRegistry incrementally: Phase 1 (extract current logic), Phase 2 (add error handling), Phase 3 (handle edge cases).

**Rationale:** Lower risk than comprehensive refactor, allows testing at each phase, faster initial delivery.

**Why Deferred:**
- **User Decision:** Chose comprehensive refactoring over phased approach
- Current initialization is "fragmented and messy and broken" - requires holistic fix
- Phased approach risks leaving tech debt in intermediate states
- Comprehensive refactoring preferred for correctness (2-3 days acceptable)

**Blockers:**
- User explicitly chose comprehensive approach
- No longer considering incremental path

**Effort:** M (Medium) - 3 days across phases (superseded)
**Priority:** Not Applicable (approach rejected)
**Related:** `.claude/interviews/audit-decisions-20260109.md` (Question 5 decision)

---

## Removed / Won't Implement

*Features that were explicitly removed or decided against*

*(Empty - no features in this category yet)*

---

## Archive

*Features that were implemented or superseded*

### main.ts Service Extraction (Code Organization)

**Status:** ✅ SUPERSEDED by comprehensive initialization rearchitecting

**Original Proposal (Gemini):** "Extract service initialization into a ServiceRegistry or ServiceInitializer class."

**Why Superseded:** User identified that the problem isn't just code length (962 lines) but fundamental initialization logic issues:
- No state machine for initialization stages
- Poor error handling for provider failures
- Missing edge case handlers (empty vaults, large vaults, corrupt indices)
- Settings page and initialization misaligned

**New Approach:** Comprehensive initialization rearchitecting with formal state machine (see active work)

**Related:** CONTINUE-GEMINI.md, `.claude/interviews/audit-decisions-20260109.md` Question 5

---

*Last Updated: 2026-01-09*
*Maintained by: Claude Code with user approval*
