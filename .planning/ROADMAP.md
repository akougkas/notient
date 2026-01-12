# Roadmap: Notient Beta

## Overview

Transform Notient from a functional prototype into a reliable, ambient intelligence platform that the CEO trusts to use on their real vault. The journey focuses on wiring existing infrastructure, consolidating the agent model, and hardening reliability across all autonomous actions.

## Domain Expertise

None (internal Obsidian plugin patterns)

## Phases

**Phase Numbering:**
- Integer phases (0, 1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 0: Foundation Repair** — Fix 4 critical issues from code audit — **IN PROGRESS**
- [ ] **Phase 1: Agent Architecture** — TBD (re-scope after Phase 0)
- [ ] **Phase 2: Insights Stream** — Wire agent results + proactive suggestions
- [ ] **Phase 3: Agent Command Center** — Connect AgentStreamsView to services
- [ ] **Phase 4: Chat Enhancement** — Contextual chips, inline agent results
- [ ] **Phase 5: Search Enhancement** — Confidence badges and AI justification
- [ ] **Phase 6: Reliability Hardening** — JSON robustness, timeout handling, validation
- [ ] **Phase 7: Settings Refactor** — Extract SettingsTab into panel components
- [ ] **Phase 8: Personal Validation** — Daily use on real vault for 1 week

## Phase Details

### Phase 0: Foundation Repair
**Goal**: Fix 4 critical issues identified in code audit (2026-01-12). Must pass validation before feature work.
**Depends on**: Nothing (prerequisite for all phases)
**Plan**: `.planning/phases/00-foundation-repair/PLAN.md`

**Critical Issues (from audit):**

| # | Issue | Severity | Est. |
|---|-------|----------|------|
| 1 | Sequential embeddings — indexing 8x slower | CRITICAL | 2h |
| 2 | Action ID mismatch — Quick Actions broken | CRITICAL | 4h |
| 3 | Reranker JSON parsing — silent search failures | HIGH | 3h |
| 4 | FS.syncfs race — console noise | LOW | 1h |

**Previous Work (Fixed):**
- ✓ Infinite loop in `taskQueue.processNext()` (commit `eff6f21`)
- ✓ HNSW batching for faster load
- ✓ Native HNSW caching via IDBFS

**Validation Checklist:**
- [ ] Indexing <2 minutes for 895 notes
- [ ] Quick Actions produce applicable results
- [ ] Search reranking returns ranked results
- [ ] No FS.syncfs warnings during indexing
- [ ] CPU <20% at idle

### Phase 1: Agent Architecture
**Goal**: Consolidate from 13 agents to 12-agent model (Chat as UI, not agent). Rewire Quick Actions to call expert agents via ChiefOfStaff. Implement 3 pinned + 3 contextual model.
**Depends on**: Nothing (first phase)
**Research**: Unlikely (internal refactoring, existing patterns)
**Plans**: 3 (01-Chat as UI, 02-Connection Rename, 03-Quick Actions)

Key work:
- Deprecate ChatAgent as standalone agent
- Update ChiefOfStaff routing to treat Chat as UI layer
- Deprecate LinkFinder → Connection agent handles links
- Rewire Quick Actions from task types to expert agents
- Implement dynamic contextual Quick Actions (3 based on note state)

### Phase 2: Insights Stream
**Goal**: Wire InsightStream to receive agent results (1-liner + expand) and proactive AI suggestions from IntelligenceRecord. All suggestions shown, user can dismiss.
**Depends on**: Phase 1
**Research**: Unlikely (wiring existing services)
**Plans**: TBD

Key work:
- Wire agent completion events to InsightStream
- Create 1-liner summary + expand UI pattern
- Wire IntelligenceRecord suggestions to stream
- Implement suggestion dismissal
- Remove confidence filtering (show all)

### Phase 3: Agent Command Center
**Goal**: Connect AgentStreamsView UI to ActionHistory, AgentTaskQueue, and TrustLevelManager. Enable full control (pause, cancel, modify, re-run).
**Depends on**: Phase 1
**Research**: Unlikely (connecting existing components)
**Plans**: TBD

Key work:
- Wire Active Agents section to AgentTaskQueue
- Wire Recent Activity to ActionHistory
- Wire Pending Review to TrustLevelManager
- Implement pause/resume for running agents
- Implement cancel for queued agents
- Implement re-run for completed agents

### Phase 4: Chat Enhancement
**Goal**: Implement contextual suggestion chips based on note type/state. Pre-build prompts with metadata arguments. Stream agent results inline in Chat.
**Depends on**: Phase 1, Phase 2
**Research**: Unlikely (internal UI patterns)
**Plans**: TBD

Key work:
- Generate contextual chips from note frontmatter/type
- Build prompts with metadata arguments (time, tags, etc.)
- Stream agent execution inline when Chat delegates
- Maintain chat context across agent calls

### Phase 5: Search Enhancement
**Goal**: Add confidence badges (High/Medium/Low) to search results. Show AI justification text on hover/expand.
**Depends on**: Nothing (independent)
**Research**: Unlikely (UI enhancement)
**Plans**: TBD

Key work:
- Map relevance scores to confidence levels
- Add badge component to SearchResultItem
- Store justification from reranker in results
- Add hover/expand UI for justification text

### Phase 6: Reliability Hardening
**Goal**: Harden JSON parsing for agent outputs. Add timeout handling with user feedback. Implement input/output validation for LLM calls. Improve agent failure handling.
**Depends on**: Phase 1, Phase 3
**Research**: Unlikely (internal error handling)
**Plans**: TBD

Key work:
- Wrap all agent JSON parsing in try/catch with fallbacks
- Add configurable timeouts with progress feedback
- Validate LLM request/response schemas
- Surface agent failures to UI with clear messages
- Implement retry logic for transient failures

### Phase 7: Settings Refactor
**Goal**: Extract SettingsTab (1384 lines) into separate panel components following existing IndexManagementPanel pattern.
**Depends on**: Nothing (independent)
**Research**: Unlikely (extracting existing code)
**Plans**: TBD

Key work:
- Extract ServiceSettingsPanel (Ollama/LMStudio config)
- Extract IndexingSettingsPanel (chunk size, exclusions)
- Extract PARASettingsPanel (folder mappings)
- Extract SearchSettingsPanel (presets)
- Extract AgentSettingsPanel (trust policy)
- Keep SettingsTab as orchestrator (<200 lines)

### Phase 8: Personal Validation
**Goal**: Deploy to real vault. Daily use for 1 week. Document issues. Iterate fixes. Success = no crashes, clear errors, actions complete reliably.
**Depends on**: All previous phases
**Research**: Unlikely (testing, not implementation)
**Plans**: TBD

Key work:
- Deploy build to real vault
- Daily usage capturing issues
- Prioritize and fix blockers
- Verify reliability criteria met
- Sign-off for Beta release

## Progress

**Execution Order:**
Phases execute in numeric order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

| Phase | Status | Completed |
|-------|--------|-----------|
| 0. Foundation Repair | **IN PROGRESS** (0/8 issues) | - |
| 1. Agent Architecture | **TBD** (re-scope after Phase 0) | - |
| 2. Insights Stream | Blocked by Phase 0 | - |
| 3. Agent Command Center | Blocked by Phase 0 | - |
| 4. Chat Enhancement | Blocked by Phase 0 | - |
| 5. Search Enhancement | Blocked by Phase 0 | - |
| 6. Reliability Hardening | Blocked by Phase 0 | - |
| 7. Settings Refactor | Blocked by Phase 0 | - |
| 8. Personal Validation | Blocked by Phase 0 | - |

**Phase 0 Issues:**
1. [ ] Reranker JSON parsing (3h) — NEXT
2. [ ] action:proposed event (1h)
3. [ ] Action applier wiring (2h)
4. [ ] Action ID mismatch (4h)
5. [ ] Sequential embeddings (2h)
6. [ ] Dead ChatAgent (30m)
7. [ ] FS.syncfs race (1h)
8. [ ] Capability cards (1h)

**Total estimated**: ~14.5 hours
