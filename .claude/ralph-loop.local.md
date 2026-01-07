---
active: true
iteration: 1
max_iterations: 100
completion_promise: "NOTIENT_COMPLETE"
started_at: "2026-01-07T22:37:08Z"
---


  # NOTIENT COMPLETE IMPLEMENTATION - QUALITY-DRIVEN LOOP

  ## MISSION
  Build Notient to 100% completion. No hacks. No mocks. No partial implementations. Loop until the QUALITY SCORE reaches 100%.

  ## CONTEXT FILES (Read FIRST every iteration)
  - planning/FINDINGS.md - 142 issues (your defect backlog)
  - planning/PRD.md - Product vision
  - planning/prompts/bootstrap.md - Architecture spec

  ## QUALITY SCORE DEFINITION

  Your goal is to reach **QUALITY_SCORE = 100%** across these dimensions:

  | Dimension | Weight | Metric | Target |
  |-----------|--------|--------|--------|
  | Build Health | 20% | bun run build exits 0 | Pass |
  | Type Safety | 15% | bun run typecheck exits 0 | Pass |
  | Critical Bugs | 25% | FINDINGS.md CRITICAL issues resolved | 31/31 |
  | High Bugs | 15% | FINDINGS.md HIGH issues resolved | 47/47 |
  | LLM Pipeline | 10% | Reranking returns reasoning (not fallback) | Working |
  | User Flows | 10% | All 6 core flows complete without error | 6/6 |
  | CSS Coverage | 5% | Missing classes defined | 149/149 |

  **Current score estimate: ~35%**

  ## ITERATION PROTOCOL

  Each iteration:
  1. Run  - if fails, fix before anything else
  2. Run  - zero errors required
  3. Pick highest-impact unresolved issue from FINDINGS.md
  4. Implement fix with proper error handling
  5. Verify fix doesn't break existing functionality
  6. Update mental tally of QUALITY_SCORE
  7. If score < 100%, continue to next iteration

  ## PHASE GUIDANCE (Not strict boundaries)

  **Backend Stability (Score 35% → 60%)**
  - Fix all CRITICAL issues from FINDINGS.md Section 1-6
  - Race conditions in WorkflowRunner, TaskQueue, IndexManager
  - Memory leaks from event listeners
  - Fire-and-forget saves → proper error handling
  - Lock acquisition with retries

  **LLM Intelligence (Score 60% → 80%)**
  - Reranking uses actual LLM reasoning (not vector fallback)
  - Action plans produce valid JSON consistently
  - reasoning_content extraction from thinking models
  - Context window management (sliding 10-message window)
  - Vault context injection per query
  - Citation format: [[Note Name#Heading]]

  **Agentic Operations (Score 80% → 90%)**
  - TrustLevelManager risk categorization
  - ActionApplier auto-executes low-risk
  - ActionHistory with undo data
  - WorkflowRunner bulk operations
  - Review queue populated in Dashboard

  **UI/UX Polish (Score 90% → 100%)**
  - All 149 missing CSS classes defined
  - Remove 58 dead CSS classes
  - ARIA labels for accessibility
  - Sidebar renders live vitals
  - TaskModal streaming chat
  - Agent Dashboard status cards

  ## THE 6 USER FLOWS (Must all work)

  1. **Fresh Install Flow**
     Setup Wizard → Service connection → Model selection → Index creation → Search returns results

  2. **Note Intelligence Flow**
     Open note → Vitals render (health/links/freshness) → Quick Action fires → Task completes → Action appears in history

  3. **Search Flow**
     Omnibar query → Vector search → LLM reranking → Results with reasoning displayed → Click opens note

  4. **Chat Flow**
     Open TaskModal → Send message → Streaming response → Citations as [[links]] → Click citation opens note

  5. **Workflow Flow**
     Run '/enrich folder' → Progress updates → Tasks complete → Review queue populated → Apply/Reject works → Undo works

  6. **Reinit Flow**
     Change LLM settings → Services reinitialize → No memory leaks → Previous index preserved

  ## SELF-CORRECTION

  - If same issue fails 3 consecutive iterations → try fundamentally different approach
  - If blocked by unclear requirement → make reasonable decision, document in code comment
  - If fix causes regression → revert and find alternative
  - Never leave broken state between iterations

  ## PROGRESS TRACKING

  At end of each iteration, mentally update:
  - CRITICAL resolved: X/31
  - HIGH resolved: X/47
  - User flows working: X/6
  - Estimated QUALITY_SCORE: X%

  ## COMPLETION

  Output <promise>NOTIENT_COMPLETE</promise> ONLY when:

  QUALITY_SCORE = 100%:
  - [x] bun run build passes
  - [x] bun run typecheck passes  
  - [x] 31/31 CRITICAL issues resolved
  - [x] 47/47 HIGH issues resolved
  - [x] LLM reranking returns actual reasoning
  - [x] All 6 user flows work without console errors
  - [x] All CSS classes defined (no unstyled elements)
  - [x] No memory leaks on service reinit

  When all boxes checked, output:

  <promise>NOTIENT_COMPLETE</promise>
  
