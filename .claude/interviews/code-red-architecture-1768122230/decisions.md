# Code Red Interview - Decisions
**Date**: 2026-01-11
**Participants**: CEO, Chief of Staff (Orchestrator)
**Source**: Gemini Consulting Review + CEO Direction

---

## Code Red Scope

### Priority Fixes (All in Parallel)
1. **Vector Store Migration** - O(N) → WASM HNSW
2. **Error Boundaries** - Wrap UI to prevent crashes
3. **App.tsx Breakup** - 1300 lines → modular

### NOT in Code Red (Deferred)
- Shadow Layers → Phase 3+
- Psychological Profiler → Future horizon
- SLM Router (regex → LLM) → Horizon 2
- Unit tests for agents → After Code Red

---

## Technical Decisions

### Vector Strategy
- **WASM only** - no Docker sidecar
- Keep single-process, no external dependencies
- Target: hnswlib-wasm or similar

### App.tsx Refactor (Chief's Approach)
```
App.tsx (thin shell, ~150 lines)
├── useAppEvents.ts (EventBus subscriptions, ~300 lines)
├── appState.ts (all signals, ~100 lines)
└── appHandlers.ts (action handlers, ~200 lines)
```

Rejected Gemini's class-based split (LayoutContainer/ViewController/EventManager) - hooks are more idiomatic for Preact.

### Profiler Scope (Future)
- Full symbiosis: notes + conversations
- Extract beliefs from what user writes
- Learn from interaction patterns

---

## Assignment

| Agent | Focus |
|-------|-------|
| **Archie** | Vector Store migration (WASM HNSW) |
| **Faye** | Error Boundaries + App.tsx refactor |
| **Sage** | Review all changes |

---

## Gemini Questions Answered

1. **Vector Strategy**: WASM only, no Docker
2. **Testing Culture**: Not priority for Code Red
3. **Event Safety**: Keep current pattern, not switching to discriminated unions now
