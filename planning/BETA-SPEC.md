# Notient Beta Specification

> **Version**: 0.4.0-beta
> **Generated**: 2026-01-11
> **Status**: Interview-validated, implementation-aligned
> **Supersedes**: ALPHA-SPEC.md

---

## Executive Summary

**Notient = Note + Sentient**

Notient is a **Sentient Notes Platform** delivered as an Obsidian plugin. It transforms notes from passive files into living entities with pulse, intelligence, and agency—all powered by local LLMs. No cloud, no data leaving your machine, ever.

### The Process (Not Just a Tagline)

```
Vaults that breathe  →  Notes that think  →  Knowledge that evolves
     (awareness)           (intelligence)          (growth)
```

This is **sequential**, not parallel:
1. **Vault awareness** (holistic health, pulse, structure) **enables**
2. **Note intelligence** (individual agency, suggestions) which **produces**
3. **Knowledge evolution** (learning, connecting, growing over time)

### Identity Model (Layered)

```
┌─────────────────────────────────────────────────────────────┐
│  SENTIENT NOTES PLATFORM                                    │
│  The core abstraction. Notes as living entities.            │
├─────────────────────────────────────────────────────────────┤
│  OBSIDIAN PLUGIN                                            │
│  The delivery vehicle. Easy install, universal, lightweight.│
├─────────────────────────────────────────────────────────────┤
│  RESEARCH CHIEF OF STAFF                                    │
│  The user-facing value. What users experience and benefit.  │
└─────────────────────────────────────────────────────────────┘
```

**Chief of Staff IS Notient** — The orchestrator is the product identity, not just a component.

---

## Part 1: Core Architecture

### 1.1 The White House Model

```
                    ┌─────────────────────────────┐
                    │    YOU (The President)      │
                    │  Decision maker. Commander. │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │     CHIEF OF STAFF          │
                    │   (Notient's Identity)      │
                    │                             │
                    │  • Routes to capabilities   │
                    │  • Builds context           │
                    │  • Orchestrates agents      │
                    └─────────────┬───────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  CORE AGENTS  │       │ WORKFLOW AGENTS │       │ SUPPORT AGENTS  │
│               │       │                 │       │                 │
│ Chat Advisor  │       │ /enhance        │       │ Context Builder │
│ Note Editor   │       │ /connect        │       │ Link Finder     │
│ Classifier    │       │ /atomize        │       │                 │
│               │       │ /synthesize     │       │                 │
│               │       │ /tasks          │       │                 │
│               │       │ /brand          │       │                 │
│               │       │ /clipping       │       │                 │
│               │       │ /challenge      │       │                 │
└───────────────┘       └─────────────────┘       └─────────────────┘
```

**Key clarification**: Agents are **capabilities**, not personas. They have expertise and specialization, not voice or personality. The user triggers them or the orchestrator uses them.

### 1.2 Obsidian Boundary

**Clear separation:**

| Layer | Owner | Responsibility |
|-------|-------|----------------|
| **File System** | Obsidian | Stores, syncs, manages files |
| **Editor** | Obsidian | Text editing, markdown rendering |
| **Intelligence** | Notient | Thinking, understanding, suggesting |

Notient is a **sidecar** to Obsidian. It doesn't duplicate native features (search, graph view, quick switcher). It enhances with intelligence.

### 1.3 Input Routing (Omnibar)

```
┌─────────────────────────────────────────────────────────────┐
│  OMNIBAR - Unified Command Center                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  (no prefix)  ──→  PROGRESSIVE SEARCH                       │
│                    ├─ Instant (<200ms): Native vault search │
│                    ├─ Evolving (1-2s): AI enriches, reorder │
│                    └─ Deep (button): Async → Insights Stream│
│                                                             │
│  /command     ──→  NOTE-SPECIFIC WORKFLOW                   │
│                    Triggers specific capability on note     │
│                                                             │
│  @agent       ──→  FIRE-AND-FORGET                          │
│                    Natural language → Chief routes          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 2: Current State Reality

### 2.1 What Works

| Component | Status | Notes |
|-----------|--------|-------|
| **Kernel & Services** | ✅ Solid | Initialization state machine, service registry |
| **LLM Providers** | ✅ Working | Ollama (embeddings), LM Studio (reasoning) |
| **Vector Store** | 🔄 Upgrading | SimpleVectorStore → WASM HNSW (CODE RED) |
| **Search Pipeline** | ✅ Working | Quick/Balanced/Deep strategies |
| **Progressive Search** | ✅ Working | Orchestrator wired to Omnibar |
| **Chat Service** | ✅ Working | Streaming, thinking parser, conversation store |
| **Trust Levels** | ✅ Implemented | 3-tier system (low/medium/high risk) |
| **User Profile** | ✅ Sufficient | Domain, PARA mappings, preferences |
| **UI Components** | ✅ Functional | Sidebar, Vitals, Quick Actions |

### 2.2 What's Broken

| Component | Issue | Priority |
|-----------|-------|----------|
| **Insights Stream** | Nothing appears, wiring wrong or missing | P0 (Phase 3) |
| **Error Boundaries** | Missing, one error crashes sidebar | P0 (CODE RED) |
| **App.tsx** | 1300 lines, unmaintainable | P0 (CODE RED) |
| **SimpleVectorStore** | O(N), freezes on large vaults | P0 (CODE RED) |
| **ChatAgent delegation** | Over-delegates based on keywords | P1 |
| **Quick Actions** | 2/6 use wrong API (sendToChat vs triggerAgent) | P1 |
| **JSON parsing** | Classifier/NoteEditor agents fail on bad JSON | P1 |
| **Reranker** | Returns garbage ("isyes", "documentno") | P1 |

### 2.3 CODE RED Status (In Progress)

| Engineer | Task | Status |
|----------|------|--------|
| **Archie** | WASM HNSW Vector Store | 🏃 Running |
| **Faye** | Error Boundaries + App.tsx refactor | 🏃 Running |
| **Sage** | Review after both complete | ⏳ Waiting |

---

## Part 3: Beta Scope

### 3.1 All 13 Agents Ship

No MVP stripping. Full capability roster:

| Agent | Type | Capability |
|-------|------|------------|
| **Chat Advisor** | Core | Conversational interface, vault Q&A |
| **Note Editor** | Core | Structural improvements, frontmatter |
| **Classifier** | Core | PARA classification, tagging |
| **Link Finder** | Support | Semantic relationship discovery |
| **Context Builder** | Support | Builds briefings for other agents |
| **Enhance** | Workflow | `/enhance` - Polish and structure |
| **Atomic** | Workflow | `/atomize` - Split to concepts |
| **Synthesis** | Workflow | `/synthesize` - Merge to narratives |
| **Task** | Workflow | `/tasks` - Extract action items |
| **Brand** | Workflow | `/brand` - Voice consistency audit |
| **Connection** | Workflow | `/connect` - Semantic links |
| **Antagonist** | Workflow | `/challenge` - Devil's advocate |
| **Clipping** | Workflow | `/clipping` - Web content cleanup |

### 3.2 Scale Target

**10,000 - 100,000 notes**

- WASM HNSW vector store (mandatory)
- Efficient chunking strategy (TSI v2)
- Background indexing (non-blocking)
- Memory-conscious design

### 3.3 Quality Bar

**Delightful UX** — Not just functional, but premium feel:

- Smooth animations
- Instant feedback
- Actionable results
- No crashes, clear errors

### 3.4 UX Identity

**Warm & Alive** — The sentient feel:

- **Shimmer effects**: AI processing visible as subtle shimmer
- **Pulse timeline**: Heartbeat visualization of note activity
- **Emotional states**: Cards reflect note state (energized, peaceful, stressed, dormant)
- **Progressive reveal**: Content arrives, doesn't just appear

---

## Part 4: Priority Stack

### Stack Order (Sequential)

```
┌─────────────────────────────────────────────────────────────┐
│  1. RELIABILITY                               ← CODE RED    │
│     Rock-solid stability. No crashes. Clear errors.         │
│     Actions complete or fail gracefully.                    │
├─────────────────────────────────────────────────────────────┤
│  2. CONTEXT AWARENESS                         ← NEXT        │
│     Tag taxonomy understanding.                             │
│     Vault-personalized AI responses.                        │
├─────────────────────────────────────────────────────────────┤
│  3. PERSONAL TRANSFORMATION                   ← SUCCESS GATE│
│     CEO uses on real vault (not test vault).                │
│     Vault self-organizes. Workflow is faster.               │
├─────────────────────────────────────────────────────────────┤
│  4. COMMUNITY + RESEARCH                      ← AFTER       │
│     GitHub release. Paper. Grant proposal.                  │
│     Only after personal validation.                         │
└─────────────────────────────────────────────────────────────┘
```

### Success Metric

**CEO's personal trust**: Willing to use Notient on real vault (not test vault).

Indicators:
- Vault self-organizes
- Tasks complete reliably
- AI is context-aware (understands tags, structure)
- No crashes, clear error messages

---

## Part 5: Progressive Search (Unchanged from ALPHA)

### 5.1 Flow

```
User types query
       │
       ▼
┌──────────────────┐
│  INSTANT (<200ms)│  Native vault search results appear
└────────┬─────────┘
         │ (results start appearing)
         ▼
┌──────────────────┐
│  EVOLVING (1-2s) │  AI enriches results in real-time
│                  │  Results visually shimmer during evaluation
│                  │  Live reordering with animation
└────────┬─────────┘
         │ (user can grab result anytime)
         ▼
┌──────────────────┐
│  DEEP (opt-in)   │  Action button in results dropdown
│                  │  Toast: "Deep search queued"
│                  │  Results surface later in Insights Stream
└──────────────────┘
```

**Status**: ✅ Implemented (Phase 2/2.5 complete)

### 5.2 What's Missing

- Shimmer effect polish (visual)
- Deep results routing to Insights Stream (blocked by broken stream)

---

## Part 6: Insights Stream (Broken - P0 Fix)

### 6.1 Purpose

Per-note persistent stream of AI insights, async results, and proactive suggestions.

### 6.2 Content Types

| Type | Source | Behavior |
|------|--------|----------|
| Agent responses | @agent fire-and-forget | Appear when complete |
| Deep search results | Async deep search | Append as found |
| Proactive suggestions | Notient intelligence | "This note could use /connect" |

### 6.3 Current State

**BROKEN**: Nothing appears. Wiring wrong or implementation missing.

### 6.4 Fix Required

- Verify event emission from agents
- Wire InsightStream component to receive events
- Implement persistence (survives note switch)
- Add proactive suggestion generation

### 6.5 Suggestion Level

**Very active, frequent** — The vault talks back. High-confidence, actionable insights surface regularly.

---

## Part 7: Note Vitals & Quick Actions

### 7.1 Vitals Dashboard

Full dashboard with:
- Health score (composite)
- PARA classification
- Backlinks/outlinks count
- Word count
- Tags from frontmatter
- Recent actions

### 7.2 Quick Actions (6 Buttons)

**Fixed (3):**
- Format → Fix frontmatter
- Improve → Enhance content
- Related → Find connections

**Context-aware (3):**
- Stale note → "Refresh"
- No links → "Connect"
- Long note → "Atomize"

### 7.3 Current Issues

- 2/6 Quick Actions use `sendToChat()` instead of `triggerAgent()`
- Need to verify all 6 route correctly through ChiefOfStaff

---

## Part 8: Chat Experience

### 8.1 Model

```
@agent (Omnibar)              Chat Tab
━━━━━━━━━━━━━━━━━━━━            ━━━━━━━━━━━━━━━
Terminal-like command           "Chat with the
interface for agentic           sentient note"
commands

Fire-and-forget                 Back-and-forth
Results → Insights Stream       dialogue with history
```

### 8.2 Scope Toggle

- **Note-scoped**: Chat about current note (default)
- **Vault-wide**: Toggle to ask about entire vault

### 8.3 Status

✅ Working — Streaming, thinking blocks, conversation persistence

---

## Part 9: Trust & Autonomy

### 9.1 Three-Tier System (Implemented)

| Risk Level | Actions | Behavior |
|------------|---------|----------|
| **Low** | Add tags, update frontmatter | Auto-apply, log to history |
| **Medium** | Move notes, create links | Show confirmation, one-click |
| **High** | Merge notes, archive, delete | Warning dialog, explicit confirm |

### 9.2 Default

**Balanced**: Low-risk auto-applies, medium/high need confirmation.

### 9.3 Universal Undo

Every action is reversible. Full action history in Agent Streams view.

---

## Part 10: Context Awareness Gap

### 10.1 Current State

AI responses are generic. Don't understand:
- Tag taxonomy (what tags mean semantically)
- Vault structure patterns
- Project context

### 10.2 Priority Enhancement

**Tag taxonomy understanding**:
- Parse tag hierarchy
- Infer semantic meaning from usage
- Include in agent context

### 10.3 User Profile

Current profile is **sufficient** for Beta:
- Domain expertise (primary, secondary, keywords)
- PARA folder mappings
- Formality preference

No expansion needed for this version.

---

## Part 11: Implementation Phases

### Phase 0: CODE RED (Active)

**Goal**: Architectural fixes before features

| Task | Owner | Status |
|------|-------|--------|
| WASM Vector Store | Archie | 🏃 Running |
| Error Boundaries | Faye | 🏃 Running |
| App.tsx refactor (<200 lines) | Faye | 🏃 Running |
| Sage review | Sage | ⏳ Waiting |

**Exit Criteria**: `bun run dev` passes, no crashes, UI stable

### Phase 3: Insights Stream (Next)

**Goal**: Fix the broken insights pipeline

1. Audit event emission from all agents
2. Wire InsightStream to EventBus
3. Implement persistence layer
4. Add proactive suggestion generation
5. Style actionable vs informative cards

**Exit Criteria**: Insights appear, persist across note switches

### Phase 4: Context Awareness

**Goal**: Vault-personalized AI

1. Implement tag taxonomy parser
2. Include tag semantics in agent context
3. Test with real vault content
4. Measure response quality improvement

**Exit Criteria**: AI responses reference tags meaningfully

### Phase 5: Wiring Fixes

**Goal**: Fix P1 bugs from Stage 3 audit

1. ChatAgent delegation logic
2. Quick Actions API usage
3. JSON parsing robustness
4. Reranker output quality

**Exit Criteria**: All 13 agents work reliably

### Phase 6: Polish

**Goal**: Delightful UX

1. Shimmer effect refinement
2. Animation timing
3. Error message clarity
4. Loading states

**Exit Criteria**: Premium feel achieved

### Phase 7: Personal Validation

**Goal**: CEO uses on real vault

1. Deploy to real vault
2. Daily usage for 1 week
3. Document issues
4. Iterate fixes

**Exit Criteria**: Trust established

---

## Part 12: Research Vision (Parallel Track)

### 12.1 Core Insight

**Compositional architecture** — Not one technique, but the system:

```
Semantic Indexing (TSI v2, multi-tier chunks)
    + Idle-time Processing (Dreaming architecture)
    + Human-AI Trust Models (3-tier autonomy)
    + Local-first AI (privacy-preserving)
    = Novel Agentic File System
```

### 12.2 Application Domains

- **Distributed file systems**: Apply to Lustre, GPFS, cloud storage
- **HPC / Science**: Research data management, provenance
- **Enterprise knowledge**: Corporate wikis, documentation systems

### 12.3 Dev Branch Priorities (Future)

When product is stable, prototype:

1. **Shadow Layers** — Metadata overlay without touching raw text. AI suggestions project onto notes like vellum.

2. **Vault Symbiosis** — Cross-note intelligence. "This note contradicts that note." Challenge mode.

### 12.4 Thesis Status

Not crystallized. Focus on product first. Thesis emerges from implementation learnings and validated patterns.

---

## Part 13: Anti-Patterns

1. ❌ **Don't strip features for MVP** — All 13 agents ship
2. ❌ **Don't rush timeline** — Quality when ready
3. ❌ **Don't over-engineer agent personalities** — They're capabilities
4. ❌ **Don't create branch splits** — One codebase for now
5. ❌ **Don't focus on team metrics** — CEO's personal trust is the gate
6. ❌ **Don't duplicate Obsidian features** — Notient is intelligence sidecar
7. ❌ **Don't add decorative animations** — Purposeful only (shimmer = AI working)
8. ❌ **Don't block UI during processing** — Async with visual feedback
9. ❌ **Don't ignore existing implementations** — Review code before designing

---

## Part 14: File Reference

### Key Implementation Files

| Purpose | File |
|---------|------|
| Main sidebar | `src/ui/sidebar/App.tsx` |
| Omnibar | `src/ui/sidebar/components/Omnibar.tsx` |
| Progressive Search | `src/core/search/progressiveSearchOrchestrator.ts` |
| Chief of Staff | `src/core/agents/chiefOfStaff.ts` |
| Agent definitions | `src/core/agents/agentIdentity.ts` |
| Chat service | `src/core/chat/chatService.ts` |
| Trust manager | `src/core/agentic/trustLevelManager.ts` |
| Vector store | `src/services/simpleVectorStore.ts` → `hnswVectorStore.ts` |
| Storage paths | `src/services/storagePaths.ts` |

### Planning Documents

| Document | Purpose |
|----------|---------|
| `planning/BETA-SPEC.md` | This file — product specification |
| `planning/ALPHA-SPEC.md` | Previous spec (superseded) |
| `planning/PRD.md` | Product requirements (to be updated) |
| `planning/gemini.review.md` | External architecture audit |
| `planning/orchestration/ORCHESTRATOR.md` | Implementation tracking |

---

## Appendix A: Interview Decisions Reference

This spec was generated from a 7-round interview session.

**Session**: `.claude/interviews/notient-beta-vision-1736617200/`
**Decisions**: `.claude/interviews/notient-beta-vision-1736617200/decisions.md`

Key decisions:
1. Layered identity (Platform → Plugin → Chief of Staff)
2. Tagline is sequential process, not parallel features
3. All 13 agents ship (no MVP stripping)
4. Priority: Reliability → Context → Personal Transformation → Community
5. Success = CEO's personal trust to use on real vault
6. Research vision = compositional architecture for agentic file systems

---

## Appendix B: Changelog from ALPHA-SPEC

| Section | Change |
|---------|--------|
| Executive Summary | Added layered identity model, clarified tagline as process |
| Core Architecture | Added "agents are capabilities, not personas" clarification |
| Current State | New section reflecting CODE RED and broken components |
| Scope | Clarified "all 13 agents ship" — no MVP stripping |
| Priority Stack | New section with CEO's personal trust as success metric |
| Context Awareness | New section identifying tag taxonomy as gap |
| Research Vision | Extracted to parallel track with compositional insight |
| Anti-Patterns | Updated based on interview learnings |

---

*Spec generated from 7-round interview on 2026-01-11*
*Evolution of ALPHA-SPEC.md with current code reality checks*
*Ready for implementation alignment*
