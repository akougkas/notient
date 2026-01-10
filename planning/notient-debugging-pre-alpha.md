# Notient Pre-Alpha Debugging & Architecture Session

> **Priority**: Fix broken search/embedding pipeline, then implement the correct UI/UX architecture.
> **Status**: Interview in progress (Round 2/20 complete)

---

## Immediate Context

**What's broken:**
- Button clicks not firing - event handlers or state issues
- App crashes under load


**What was discovered:**
- Model capability discovery works: `granite-embedding:30m` → `arch=bert, ctx=512, dim=384, maxChars=1024`
- User has a fundamentally different vision than what was implemented

---

## Resume Interview

**Interview files location:**
```
~/.claude/interviews/interview-notient-search-ui-1736456400/
├── metadata.json      # Session state
├── round-1.json       # Page Architecture decisions
└── round-2.json       # Omnibar & Progressive Enhancement (CRITICAL)
```

**To resume:**
```
/interview-conductor resume interview-notient-search-ui-1736456400
```

Or manually continue from Round 3.

---

## Critical Discoveries from Interview (Rounds 1-2)

### 1. Page Architecture (Round 1)

| Decision | Choice | Implication |
|----------|--------|-------------|
| Agent focus | Stay on Vitals | Agents run in background, results appear in Insights Stream |
| Insight scope | Current note only | Stream changes when switching notes |
| Detail view | Inline expand | Agent Stream items expand in-place |
| Follow-up | Chat handoff | Quick reply opens Chat with context pre-loaded |

### 2. Search is PROGRESSIVE ENHANCEMENT, Not 3 Modes (Round 2) ⚠️

**THIS CHANGES EVERYTHING:**

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
│  "techno-natural"│  Results visually update/reorder
└────────┬─────────┘
         │ (user can grab result anytime)
         ▼
┌──────────────────┐
│  DEEP (opt-in)   │  Button in results dropdown
│  Async expansion │  Results surface later in Insights Stream
└──────────────────┘
```

**Motto: "Amplify, not opinionated and slow"**

- User can grab first result FAST
- OR wait and watch results evolve
- Deep mode is EXPLICIT opt-in button, spawns async task

### 3. Input Routing

| Prefix | Behavior |
|--------|----------|
| (none) | Progressive search |
| `/` | Slash command with preview + confirm |
| `@agent` | Dropdown of specialized agents |

### 4. The specialized Agents

Need to discover in Round 3:
- What are the agents?
- What are their missions/expertise?
- How are they configured?

---

## Remaining Interview Topics (Rounds 3-20)

### Round 3: Agent Personas
- What are the agents and their specialties?
- How are custom prompts configured?
- What actions can each agent take?

### Round 4: Progressive Enhancement UX
- How do results visually "evolve"? Animation? Reordering?
- What indicates AI is still working?
- How does the Deep mode button appear?

### Round 5: Insights Stream
- What types of insights appear?
- How are they prioritized/ordered?
- Dismissible? Actionable?

### Round 6: Note Card / Vitals
- What metadata is shown?
- What stats from Obsidian?
- What AI-generated insights inline?

### Round 7: Technical - Embedding Pipeline
- Chunking strategy correctness
- Embedding dimension validation
- Reranking quality

### Round 8: Technical - Resource Management
- Search vs indexing priority
- Queue management
- Graceful degradation

### Rounds 9-20: Edge cases, error handling, performance, polish

---

## Codebase Reference

**Key files to understand:**
```
src/
├── ui/sidebar/
│   ├── App.tsx                    # Main sidebar with tabs
│   ├── components/
│   │   └── Omnibar.tsx            # Search input (needs progressive enhancement)
│   └── context/KernelContext.tsx  # React context for kernel
├── core/
│   ├── search/
│   │   ├── pipeline.ts            # SearchPipeline (refactored to strategies)
│   │   └── strategies/            # Quick/Balanced/Deep strategies
│   ├── indexer/
│   │   ├── simpleIndexer.ts       # Indexing orchestration
│   │   └── tieredSemanticChunker.ts # Chunk creation
│   └── agentic/                   # Agent system (7 personas?)
├── services/
│   ├── ollama.ts                  # Embedding service (has discovery)
│   └── lmstudio.ts                # Reasoning/reranking
└── types/
    ├── search.ts                  # Search types
    └── settings.ts                # SEARCH_PRESETS (needs rethinking)
```

**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex`

**Commands:**
```bash
bun run dev          # Build + deploy to test vault (USE THIS!)
bun run dev:watch    # Watch mode
bun run typecheck    # Type check only
```

---

## Implementation Priorities

### Phase 1: Make It Work (MVP)
1. Fix embedding timeout during indexing (resource coordination)
2. Verify button click handlers fire


### Phase 2: Progressive Enhancement
1. Implement instant native results
2. Add progressive AI enrichment with visual feedback
3. Add Deep mode button that spawns async task
4. Results appear in Insights Stream

### Phase 3: Agent System
1. Understand the persona agents
2. Implement @agent dropdown
3. Connect to Insights Stream output

### Phase 4: Polish
1. Animations for "evolving" results
2. Error states and fallbacks
3. Performance optimization

---

## Anti-Patterns to Avoid

- ❌ Hardcoding model specs (use runtime discovery)
- ❌ Throwing errors that crash search (graceful degradation)
- ❌ Treating search modes as discrete (progressive enhancement!)
- ❌ Blocking UI during AI processing (async with visual feedback)
- ❌ Running `bun run build` without `bun run dev` (won't deploy!)

---

## Session Start Checklist

1. [ ] Read interview rounds 1-2: `cat ~/.claude/interviews/interview-notient-search-ui-1736456400/round-*.json`
2. [ ] Resume interview from Round 3: `/interview-conductor` or manual questions
3. [ ] After interview: Generate spec to `planning/notient-search-spec.md`
4. [ ] Implement fixes based on spec
5. [ ] Test with `bun run dev` and reload Obsidian

---

## Quick Start Command

```bash
# Read existing interview data
cat ~/.claude/interviews/interview-notient-search-ui-1736456400/metadata.json
cat ~/.claude/interviews/interview-notient-search-ui-1736456400/round-1.json
cat ~/.claude/interviews/interview-notient-search-ui-1736456400/round-2.json

# Then continue interview from Round 3 focusing on:
# - The persona agents
# - Progressive enhancement UX details
# - Technical implementation of evolving results
```

---

*Generated: 2026-01-09 | Interview Session: interview-notient-search-ui-1736456400 | Rounds Complete: 2/20*
