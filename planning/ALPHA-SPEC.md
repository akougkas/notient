# Notient Alpha Specification

> **Version**: 0.3.0-alpha
> **Generated**: 2026-01-10
> **Status**: Interview-validated, implementation-ready

---

## Executive Summary

Notient transforms Obsidian notes into **sentient entities** with identity, health, and agency. This specification defines the complete Alpha release based on 20 rounds of user interviews, synthesized with deep codebase analysis.

### Core Philosophy

```
Notes that think. Vaults that breathe. Knowledge that evolves.
```

**Three Pillars**:
1. **Progressive Enhancement** - Start fast, enrich over time
2. **Sentient Notes** - Notes have pulse, vitality, and voice
3. **Human-in-Steering-Wheel** - User controls, Notient amplifies

---

## Part 1: Architecture Model

### 1.1 Input Routing (Omnibar)

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
│  /command     ──→  NOTE-SPECIFIC LLM WORKFLOW               │
│                    ├─ /enhance   - Add structure & polish   │
│                    ├─ /connect   - Find semantic links      │
│                    ├─ /atomize   - Split into concepts      │
│                    ├─ /synthesize - Create synthesis note   │
│                    ├─ /tasks     - Extract actions          │
│                    ├─ /brand     - Check voice alignment    │
│                    ├─ /clipping  - Process web clipping     │
│                    └─ /challenge - Get counterpoints        │
│                                                             │
│  @Notient     ──→  FIRE-AND-FORGET TO AGENT                 │
│                    ├─ Single agent: Research Chief of Staff │
│                    ├─ Can invoke /commands at discretion    │
│                    ├─ Can handle bulk operations via NL     │
│                    └─ Results → Insights Stream             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key Distinction**:
- `@Notient` = Terminal-like command shell for agentic tasks
- `/command` = Predetermined, reusable LLM workflows
- `Chat tab` = Sentient note conversation ("chat with the note")

### 1.2 View Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  HEADER (Locked Chrome)                                     │
│  ┌──────────┬──────────┬──────────┐                        │
│  │ Vitals   │ Agents   │  Chat    │  ← 3 Tabs (immutable)  │
│  └──────────┴──────────┴──────────┘                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  VIEW: Note Vitals (default)                                │
│  ├─ Omnibar (unified input)                                 │
│  ├─ NoteCard (identity + pulse)                             │
│  ├─ VitalsCards (health metrics)                            │
│  ├─ QuickActions (context-aware buttons)                    │
│  └─ InsightsStream (per-note, persistent)                   │
│                                                             │
│  VIEW: Agent Streams                                        │
│  ├─ CapabilityCards (service health)                        │
│  ├─ Active Agents (with progress)                           │
│  ├─ Pending Review (risk-colored)                           │
│  └─ Recent Activity (with undo)                             │
│                                                             │
│  VIEW: Chat                                                 │
│  ├─ Context Bar (note or vault toggle)                      │
│  ├─ Message Stream (sentient conversation)                  │
│  └─ Input (minimal empty state)                             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  FOOTER (Locked Chrome - 4 Zones)                           │
│  ┌─────────────┬───────────┬───────────┬────────┐          │
│  │ Providers   │   Index   │  Agents   │Settings│          │
│  │ LM● Ollama● │ 1,247     │ 2 active  │   ⚙    │          │
│  └─────────────┴───────────┴───────────┴────────┘          │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 2: Progressive Search

### 2.1 Flow

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

**Motto**: "Amplify, not opinionated and slow"

### 2.2 Results Display

- **Format**: Rich cards (title, snippet, relevance score, tags)
- **AI Working Indicator**: Shimmer effect on results being re-evaluated
- **Deep Mode Button**: Action button with icon, visible in dropdown

### 2.3 Implementation Mapping

| Phase | Current Code | Change Required |
|-------|--------------|-----------------|
| Instant | `NativeSearchStrategy` | Already exists, wire to UI first |
| Evolving | `BalancedSearchStrategy` | Add shimmer state, animated reordering |
| Deep | `DeepSearchStrategy` | Make async, route results to Insights |

---

## Part 3: Insights Stream

### 3.1 Purpose

Per-note persistent stream of AI insights, async results, and proactive suggestions.

### 3.2 Content Types

| Type | Source | Behavior |
|------|--------|----------|
| Agent responses | @Notient fire-and-forget | Appear when complete |
| Deep search results | Async deep search | Append as found |
| Proactive suggestions | Notient intelligence | "This note could use /connect" |

### 3.3 Insight Modes

```
INFORMATIVE                        ACTIONABLE
┌─────────────────────┐           ┌─────────────────────┐
│ Action completed    │           │ [Apply] [Dismiss]   │
│ Just a notification │           │ Click → Agent Streams│
└─────────────────────┘           │ for details + UNDO   │
                                  └─────────────────────┘
```

### 3.4 Persistence

- Stored in IntelligenceDB per-note
- Survives note switches and Obsidian restarts
- No badge/notification on arrival (user checks when ready)

---

## Part 4: Note Vitals & Staleness

### 4.1 Vitals Card Content

Full dashboard with:
- Health score (composite)
- PARA classification
- Backlinks/outlinks count
- Word count
- Tags
- Recent actions

### 4.2 Quick Actions

**Context-aware buttons** (1-3 based on note state):
- Stale note → "Refresh"
- No links → "Connect"
- Long note → "Atomize"

### 4.3 Staleness Detection

**AI-inferred, not rule-based**. Considers:
- Age (days since edit)
- Knowledge freshness (new related notes exist)
- Action items from meetings
- Vault context
- User evolution state

This is why LLM-based assessment is required.

---

## Part 5: Chat Page

### 5.1 Model

```
@Notient (Omnibar)              Chat Tab
━━━━━━━━━━━━━━━━━━━━            ━━━━━━━━━━━━━━━
Terminal-like command           "Chat with the
interface for agentic           sentient note"
commands

Fire-and-forget                 Back-and-forth
Results → Insights Stream       dialogue with history
```

### 5.2 Scope Toggle

- **Note-scoped**: Chat about current note (default)
- **Vault-wide**: Toggle to ask about entire vault

### 5.3 Empty State

**Minimal** - Remove avatar/title, just show input with placeholder.

### 5.4 Implementation

Current `ChatView.tsx` needs:
- Vault mode toggle in context bar
- Simplified empty state
- Per-note conversation persistence (already exists via ConversationStore)

---

## Part 6: Footer Enhancements

### 6.1 Zone Interactions

| Zone | Click Action |
|------|--------------|
| Providers (LM/Ollama) | Popup modal to select **chat models only** (not embedding - would mismatch index) |
| Index (note count) | Quick stats popup: indexed, chunks, last sync, rebuild option |
| Agents | Navigate to Agent Streams tab |
| Settings | Open Notient settings |

### 6.2 Degraded State

**Subtle indicator**: Yellow/orange tint on affected zone, hover shows reason.

### 6.3 Reconnection UX

**Visible countdown**: "Reconnecting in 3s..." in footer during auto-retry.

---

## Part 7: Error Recovery

### 7.1 Patterns

| Scenario | Behavior |
|----------|----------|
| Provider disconnect | Visible countdown retry in footer |
| Mid-action failure | Full abort, error toast, let user retry |
| Recovery to READY | Subtle toast "Services restored" (3s auto-dismiss) |
| Empty search results | AI explanation: "Your vault doesn't contain notes about X" |
| Action failure | Silent rollback + error added to Insights Stream |

### 7.2 Degradation Flow

```
READY
  │
  ├─ LM Studio down ──→ DEGRADED (chat disabled, search works)
  │
  └─ Ollama down ──→ FAILED (critical, all disabled)
```

### 7.3 Toast System

- Use Obsidian's native `Notice` system
- Types: Success, Error, Info only
- Duration: 3s success/info, 5s errors, click to dismiss

---

## Part 8: Theme & UI

### 8.1 Visual Identity

**Distinctive but harmonious** - Custom card styles, animations, visual language that COMPLEMENTS Obsidian themes.

### 8.2 Animation Philosophy

**Purposeful only** - Animations communicate state (loading, streaming). No decorative animations.

### 8.3 Card Design

**Glassmorphism lite** - Slight transparency + blur. Modern but subtle.

### 8.4 Loading States

**Progressive reveal** - Content fades/slides in as it arrives. No skeleton placeholders.

### 8.5 Micro-interactions

**Subtle transform** - Slight scale (1.02x) or translateY(-1px) on hover. Snappy click feedback.

### 8.6 Theme Handling

**Variables only** - Trust Obsidian themes. Current CSS variable mapping is sufficient.

---

## Part 9: Settings Restructure

### 9.1 New Structure

```
SETTINGS
├─ PROFILE
│  ├─ Domain expertise (primary, secondary, keywords)
│  ├─ PARA folder mappings
│  ├─ Formality preference
│  └─ Exceptions
│
└─ SYSTEM
   ├─ Providers (Ollama, LM Studio hosts)
   ├─ Models (chat model selection)
   ├─ Index (inventory, management)
   └─ Danger Zone (destructive actions)
```

### 9.2 Search Presets

**Rename** from "quick/balanced/thorough" to **enrichment speed**:
- **Fast** - Less AI, faster results
- **Normal** - Balanced (default)
- **Deep** - More AI, comprehensive

### 9.3 Trust Default

**Auto-apply low-risk** by default. Medium/high still require confirmation.

---

## Part 10: Refactors Required

### 10.1 Code Changes

| Change | Files | Priority |
|--------|-------|----------|
| Rename prompts → actions | `src/core/intelligence/prompts/` → `actions/` | Medium |
| Remove bulk slash commands | `src/core/agentic/commandParser.ts` | High |
| Update trust default | `src/types/settings.ts` | Low |
| Add vault-wide chat toggle | `src/ui/sidebar/components/ChatView.tsx` | High |
| Implement progressive search | `src/core/search/pipeline.ts`, `Omnibar.tsx` | High |
| Footer reconnect countdown | `src/ui/sidebar/components/Footer.tsx` | Medium |
| Glassmorphism cards | `src/ui/styles/components/*.css` | Low |

### 10.2 Bulk Commands Migration

Current bulk commands (`/enrich vault`, `/classify vault`) should be:
1. Removed from `commandParser.ts`
2. Handled naturally by `@Notient` when user types "enrich all notes in inbox"
3. Agent decides scope based on query context

---

## Part 11: Implementation Phases

### Phase 1: Foundation (Make It Work)

**Goal**: Fix broken functionality, establish baseline

1. Fix button click handlers not firing
2. Fix app crashes under load
3. Verify event handler propagation
4. Test with `bun run dev`

**Verification**: All existing features work without errors

### Phase 2: Progressive Search

**Goal**: Implement the progressive enhancement model

1. Wire instant native results to Omnibar dropdown
2. Add shimmer effect for AI evaluation
3. Implement animated reordering
4. Add Deep mode action button
5. Route deep results to Insights Stream

**Verification**: Search shows instant → evolving → deep flow

### Phase 3: Insights Stream

**Goal**: Per-note persistent insights

1. Implement persistence layer in IntelligenceDB
2. Route @Notient results to stream
3. Route deep search results to stream
4. Add proactive suggestion generation
5. Implement actionable vs informative styling

**Verification**: Insights persist across note switches

### Phase 4: Chat Refinement

**Goal**: Sentient note conversation

1. Add vault-wide toggle
2. Simplify empty state
3. Verify per-note conversation persistence
4. Connect to correct agent context

**Verification**: Chat works in both note and vault mode

### Phase 5: Footer & Recovery

**Goal**: Status communication and graceful recovery

1. Implement provider click → model selection modal
2. Implement index click → stats popup
3. Add reconnection countdown
4. Add degraded state tinting
5. Implement recovery toast

**Verification**: Footer reflects real-time status, recovery works

### Phase 6: UI Polish

**Goal**: Distinctive but harmonious design

1. Implement glassmorphism card style
2. Add progressive reveal animations
3. Polish micro-interactions
4. Ensure theme compatibility

**Verification**: UI feels alive, works with all Obsidian themes

### Phase 7: Settings & Config

**Goal**: Restructured settings

1. Create Profile section
2. Create System section
3. Rename search presets
4. Update trust defaults
5. Remove bulk command suggestions

**Verification**: Settings are intuitive and complete

---

## Part 12: Current Architecture Reference

### 12.1 Component Hierarchy

```
notient-sidebar--v2
├─ KernelProvider (Context)
│  └─ App (Preact root)
│     ├─ Header (3 tabs)
│     ├─ Content Area
│     │  ├─ Note Vitals View
│     │  │  ├─ Omnibar
│     │  │  ├─ NoteCard + PulseTimeline
│     │  │  ├─ VitalsCards (4 metrics)
│     │  │  ├─ QuickActions (6 buttons)
│     │  │  └─ InsightStream
│     │  ├─ Agent Streams View
│     │  │  ├─ CapabilityCards
│     │  │  ├─ Active Agents
│     │  │  ├─ Pending Review
│     │  │  └─ Recent Activity
│     │  └─ Chat View
│     │     ├─ Context Bar
│     │     ├─ Message Stream
│     │     └─ Input Area
│     └─ Footer (4 zones)
```

### 12.2 Service Dependencies

```
Kernel (Orchestrator)
├─ EventBus (pub/sub)
├─ StoragePaths, VaultLock
├─ HealthMonitor
├─ OllamaService (embeddings)
├─ LMStudioService (reasoning)
├─ VectorStore, IndexManager, SimpleIndexer
├─ SearchPipeline
│  ├─ QuickStrategy (native)
│  ├─ BalancedStrategy (vector + rerank)
│  └─ DeepStrategy (graph + expand)
├─ VaultContextBuilder
├─ NoteIntelligenceService
├─ NotientAgent, AgentTaskQueue
├─ ConversationStore
├─ ActionApplier, TrustLevelManager
├─ ActionHistory
├─ WorkflowRunner
└─ ProfileManager
```

### 12.3 Event Catalog

| Event | Emitter | Purpose |
|-------|---------|---------|
| `health:changed` | HealthMonitor | Provider status updates |
| `init:state-changed` | InitStateMachine | Lifecycle transitions |
| `index:progress/complete` | SimpleIndexer | Indexing status |
| `search:started/progress/complete` | SearchPipeline | Search lifecycle |
| `vitals:updated` | SimpleVaultVitals | Note vitals refresh |
| `agent:task-update` | AgentTaskQueue | Task status changes |
| `workflow:*` | WorkflowRunner | Workflow lifecycle |
| `action:*` | ActionApplier | Action lifecycle |
| `lock:lost` | VaultLock | Multi-window safety |

### 12.4 State Machine

```
UNINITIALIZED
     │
     ▼
CHECKING_PROVIDERS (30s timeout)
     │
     ├─ success ──→ LOADING_INDEX (60s timeout)
     │                   │
     │                   ├─ success ──→ WARMING_SERVICES (30s timeout)
     │                   │                   │
     │                   │                   └─ success ──→ READY
     │                   │
     │                   └─ crash ──→ CRASHED
     │
     ├─ partial ──→ DEGRADED
     │
     └─ fail ──→ FAILED

Recovery paths:
DEGRADED ──→ READY (when services recover)
FAILED ──→ CHECKING_PROVIDERS (user retry)
CRASHED ──→ UNINITIALIZED (restart)
```

---

## Part 13: File Reference

### Key Files for Implementation

| Purpose | File |
|---------|------|
| Main sidebar | `src/ui/sidebar/App.tsx` |
| Omnibar | `src/ui/sidebar/components/Omnibar.tsx` |
| Chat | `src/ui/sidebar/components/ChatView.tsx` |
| Footer | `src/ui/sidebar/components/Footer.tsx` |
| Search pipeline | `src/core/search/pipeline.ts` |
| Search strategies | `src/core/search/strategies/*.ts` |
| Agent loop | `src/core/agent/agentLoop.ts` |
| Task queue | `src/core/agent/taskQueue.ts` |
| Command parser | `src/core/agentic/commandParser.ts` |
| Trust manager | `src/core/agentic/trustLevelManager.ts` |
| Action applier | `src/core/agentic/actionApplier.ts` |
| State machine | `src/core/services/initializationStateMachine.ts` |
| Design tokens | `src/ui/styles/tokens.css` |
| Settings types | `src/types/settings.ts` |

---

## Appendix A: Interview Decisions Log

**Rounds 1-2**: Foundation
- Agent focus: Stay on Vitals (background execution)
- Insight scope: Current note only
- Detail view: Inline expand
- Follow-up: Chat handoff
- Search: Progressive enhancement (not 3 modes)
- Latency budget: <200ms instant

**Rounds 3-13**: Core Architecture
- ONE agent (@Notient), 8 actions (slash commands)
- Agent context: Note + semantically related
- Slash commands: Note-specific only (no bulk)
- Bulk operations: Via @Notient natural language

**Rounds 14-20**: UX Polish
- Chat = sentient note conversation
- Footer zones: Providers (model select), Index (stats), Agents, Settings
- Error recovery: Visible countdown, full abort, subtle toast
- Theme: Glassmorphism lite, purposeful animation, variables only

---

## Appendix B: Anti-Patterns

1. **Don't** hardcode model specs (use runtime discovery)
2. **Don't** throw errors that crash search (graceful degradation)
3. **Don't** treat search modes as discrete (progressive enhancement)
4. **Don't** block UI during AI processing (async with visual feedback)
5. **Don't** run `bun run build` without `bun run dev` (won't deploy)
6. **Don't** create bulk slash commands (use @Notient)
7. **Don't** add decorative animations (purposeful only)
8. **Don't** override Obsidian theme colors (use variables)

---

*Spec generated from 20 rounds of user interviews + comprehensive codebase analysis.*
*Ready for phased implementation using /code-simplifier agent.*
