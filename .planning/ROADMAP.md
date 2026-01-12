# Roadmap: Notient Beta

## Overview

Transform Notient from a functional prototype into a reliable, ambient intelligence platform that the CEO trusts to use on their real vault. The journey focuses on wiring existing infrastructure, consolidating the agent model, and hardening reliability across all autonomous actions.

## Domain Expertise

None (internal Obsidian plugin patterns)

## Phases

**Phase Numbering:**
- Integer phases (0, 1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 0: Foundation Repair** — Fix critical performance blockers (EMERGENCY) — **BLOCKED**
- [x] **Phase 1: Agent Architecture** — Consolidate to 12-agent model, rewire Quick Actions (3/3 plans) — **COMPLETE**
- [ ] **Phase 2: Insights Stream** — Wire agent results + proactive suggestions
- [ ] **Phase 3: Agent Command Center** — Connect AgentStreamsView to services
- [ ] **Phase 4: Chat Enhancement** — Contextual chips, inline agent results
- [ ] **Phase 5: Search Enhancement** — Confidence badges and AI justification
- [ ] **Phase 6: Reliability Hardening** — JSON robustness, timeout handling, validation
- [ ] **Phase 7: Settings Refactor** — Extract SettingsTab into panel components
- [ ] **Phase 8: Personal Validation** — Daily use on real vault for 1 week

## Phase Details

### Phase 0: Foundation Repair (EMERGENCY)
**Goal**: Fix critical performance blockers causing CPU 100%, UI freeze, and 30+ second load times. Must pass validation checklist before ANY feature work continues.
**Depends on**: Nothing (prerequisite for all phases)
**Research**: Complete (Gemini audit + GPT fixes + internal verification)
**Plans**: TBD

**Root Causes (Verified):**
1. `hnswVectorStore.loadFromData()` - synchronous WASM, no yields (P0)
2. `chunkStore.loadAll()` - sequential await in loop, 542 files (P0)
3. `indexManager` - JSON.parse 300MB on main thread (P0)
4. `chiefOfStaff` - singleton session race condition (P1)
5. `chatAgent` - O(N²) regex on streaming (P1)
6. `RichChatView` - scroll yanking, no virtualization (P2)
7. `progressiveSearch` - no abort on timeout (P2)

**GPT Contribution (needs cleanup):**
- Native HNSW caching via IDBFS (good, keep)
- Debug fetch() calls throughout (remove)
- Global counter in useAppEvents (remove)

**Validation Checklist (MUST PASS):**
- [ ] Plugin loads in <3 seconds
- [ ] CPU stays <20% at idle
- [ ] Chat produces actual responses
- [ ] Search completes in <2 seconds
- [ ] No console errors

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

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Foundation Repair | 2/3 | **BLOCKED** (UAT-003) | - |
| 1. Agent Architecture | 3/3 | **COMPLETE** | 2026-01-11 |
| 2. Insights Stream | 0/TBD | Blocked by Phase 0 | - |
| 3. Agent Command Center | 0/TBD | Blocked by Phase 0 | - |
| 4. Chat Enhancement | 0/TBD | Blocked by Phase 0 | - |
| 5. Search Enhancement | 0/TBD | Blocked by Phase 0 | - |
| 6. Reliability Hardening | 0/TBD | Blocked by Phase 0 | - |
| 7. Settings Refactor | 0/TBD | Blocked by Phase 0 | - |
| 8. Personal Validation | 0/TBD | Blocked by Phase 0 | - |

**Phase 0 Detail:**
- 00-01-PLAN: Async loading ✓ COMPLETE
- 00-01-FIX-PLAN: HNSW batching ✓ EXECUTED (needs SUMMARY)
- 00-02-PLAN: Validation ❌ BLOCKED by UAT-003

**Blocker:** UAT-003 - UI crash after agent trigger. Decision: SDK migration.
