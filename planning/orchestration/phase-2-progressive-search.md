# Phase 2: Progressive Search - Specification

**Generated**: 2026-01-10T20:40:00Z
**Interview Session**: interview-notient-wiring-ux-1768077411
**Rounds**: 5-7 (12 questions answered)
**Status**: Ready for implementation

---

## Executive Summary

Phase 2 transforms Notient's search from discrete modes (Quick/Balanced/Thorough) into a **progressive enhancement** experience. Users see instant results that refine over time as AI evaluates relevance. Deep search is opt-in and delivers results to the Insights Stream.

**Key changes**:
1. Results appear in dropdown below Omnibar (not modal/panel)
2. Three-tier progressive flow: INSTANT → EVOLVING → DEEP
3. Shimmer effect with animated reordering during AI evaluation
4. Deep search via button or Shift+Enter, results to Insights Stream

---

## 1. User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         OMNIBAR                                  │
│  [🔍 Search your vault...                              ] [DEEP] │
└─────────────────────────────────────────────────────────────────┘
                              │
                    User types query
                    (300ms debounce)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  INSTANT (<200ms)                                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 📄 Note Title 1                                    [shimmer]││
│  │    Path/to/note.md • 2 days ago                             ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ 📄 Note Title 2                                    [shimmer]││
│  │    Path/to/other.md • 1 week ago                            ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ 📄 Note Title 3                                    [shimmer]││
│  │    Path/to/another.md • 3 weeks ago                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│  [🔍 Go Deeper]                              ⌨️ Shift+Enter     │
└─────────────────────────────────────────────────────────────────┘
                              │
                    AI evaluates (1-2s)
                    Shimmer effect active
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVOLVING (1-2s)                                                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 📄 Note Title 2  ← (moved up, animation)           ✓ 0.92  ││
│  │    Path/to/other.md • 1 week ago                            ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ 📄 Note Title 1                                    ✓ 0.78  ││
│  │    Path/to/note.md • 2 days ago                             ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ 📄 Note Title 3                                    ✓ 0.45  ││
│  │    Path/to/another.md • 3 weeks ago                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│  [🔍 Go Deeper]                              ⌨️ Shift+Enter     │
└─────────────────────────────────────────────────────────────────┘
                              │
              User clicks "Go Deeper" or Shift+Enter
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  DEEP (async, 5-10s)                                            │
│                                                                  │
│  Omnibar shows: [🔍 Deep searching...                      ✕ ] │
│                                                                  │
│  Toast: "Deep search queued - results will appear in Insights"  │
│                                                                  │
│  On complete:                                                    │
│  Toast: "Deep search found 12 results" [View]                   │
│                                                                  │
│  Results appear in Insights Stream (mixed chronologically)       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Specifications

### 2.1 Timing

| Phase | Target Latency | Timeout | Fallback |
|-------|---------------|---------|----------|
| INSTANT | <200ms | 500ms | Show "No results" |
| EVOLVING | 1-2s | 3s | Keep INSTANT order + warning |
| DEEP | 5-10s | 15s | Partial results + warning |

### 2.2 Debounce & Throttling

```typescript
const SEARCH_CONFIG = {
  debounceMs: 300,           // Wait after last keystroke
  minQueryLength: 2,         // Don't search for 1 char
  instantTimeoutMs: 500,     // Max wait for native results
  evolvingTimeoutMs: 3000,   // Max wait for AI reranking
  deepTimeoutMs: 15000,      // Max wait for deep search
  maxDropdownResults: 10,    // Limit dropdown items
  deepConcurrency: 1,        // One deep search at a time
};
```

### 2.3 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Navigate to first result |
| `Shift+Enter` | Trigger DEEP search |
| `↑` / `↓` | Navigate results |
| `ESC` | Dismiss dropdown, clear search |
| `Tab` | Focus "Go Deeper" button |

### 2.4 Result Item Structure

```typescript
interface SearchResultItem {
  noteId: string;
  path: string;
  title: string;
  snippet?: string;           // First match context
  score: number;              // 0-1 relevance
  tier: "instant" | "evolving" | "deep";
  isLoading: boolean;         // Shimmer state
  paraType?: "projects" | "areas" | "resources" | "archive" | "inbox";
  lastModified: number;       // For recency display
}
```

---

## 3. Component Architecture

### 3.1 New Components

```
src/ui/sidebar/components/
├── search/
│   ├── SearchDropdown.tsx      # Main dropdown container
│   ├── SearchResultItem.tsx    # Individual result with shimmer
│   ├── SearchFooter.tsx        # "Go Deeper" button + keyboard hint
│   └── DeepSearchIndicator.tsx # Omnibar inline progress
```

### 3.2 Modified Components

| Component | Changes |
|-----------|---------|
| `Omnibar.tsx` | Add dropdown trigger, Shift+Enter handler, deep search state |
| `App.tsx` | Add deep search event handlers, toast notifications |
| `InsightStream.tsx` | Accept deep search results as insight type |

### 3.3 State Management

```typescript
// In App.tsx or dedicated search context
const searchState = signal<{
  query: string;
  isOpen: boolean;
  phase: "idle" | "instant" | "evolving" | "deep";
  results: SearchResultItem[];
  deepSearchId: string | null;  // For cancellation
  error: string | null;
}>({
  query: "",
  isOpen: false,
  phase: "idle",
  results: [],
  deepSearchId: null,
  error: null,
});
```

---

## 4. Backend Changes

### 4.1 Progressive Search Orchestrator

New class that coordinates the three tiers:

```typescript
// src/core/search/progressiveSearch.ts
export class ProgressiveSearchOrchestrator {
  constructor(
    private pipeline: SearchPipeline,
    private eventBus: EventBus,
  ) {}

  /**
   * Execute progressive search with streaming results
   */
  async *search(
    query: string,
    signal?: AbortSignal,
  ): AsyncIterable<ProgressiveSearchEvent> {
    // Phase 1: INSTANT (native search)
    yield { phase: "instant", status: "started" };
    const instantResults = await this.pipeline.search(query, {
      preset: "quick",
      topK: 20,
    });
    yield { phase: "instant", status: "complete", results: instantResults };

    // Phase 2: EVOLVING (AI reranking)
    yield { phase: "evolving", status: "started" };
    try {
      const evolvedResults = await this.pipeline.search(query, {
        preset: "balanced",
        topK: 20,
      });
      yield { phase: "evolving", status: "complete", results: evolvedResults };
    } catch (error) {
      yield { phase: "evolving", status: "failed", error: error.message };
    }
  }

  /**
   * Execute deep search (separate, cancellable)
   */
  async deepSearch(
    query: string,
    signal?: AbortSignal,
  ): Promise<DeepSearchResult> {
    return this.pipeline.search(query, {
      preset: "thorough",
      topK: 50,
      signal,
    });
  }
}
```

### 4.2 Event Types

```typescript
// src/core/events/types.ts
interface ProgressiveSearchEvent {
  phase: "instant" | "evolving" | "deep";
  status: "started" | "complete" | "failed";
  results?: SearchResult[];
  error?: string;
}

// New events
"search:progressive-instant": { query: string; results: SearchResult[] }
"search:progressive-evolving": { query: string; results: SearchResult[] }
"search:deep-started": { searchId: string; query: string }
"search:deep-complete": { searchId: string; results: SearchResult[] }
"search:deep-cancelled": { searchId: string }
```

### 4.3 Settings Integration

Keep existing presets as fallback:

```typescript
// src/types/settings.ts
interface SearchSettings {
  // Existing presets (kept as override)
  preset: "quick" | "balanced" | "thorough" | "progressive";

  // Progressive-specific
  progressive: {
    enabled: boolean;           // Default: true
    showScores: boolean;        // Show AI scores in results
    autoDeep: boolean;          // Auto-trigger deep for complex queries
  };

  // Existing thresholds
  custom: { topK: number; minScore: number; enableReranking: boolean };
}
```

---

## 5. UI/UX Details

### 5.1 Shimmer Animation

```css
.nv2-search-result--loading {
  position: relative;
  overflow: hidden;
}

.nv2-search-result--loading::after {
  content: "";
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.1),
    transparent
  );
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  100% { left: 100%; }
}
```

### 5.2 Reorder Animation

Use FLIP technique for smooth reordering:

```typescript
// Preact/React approach
function animateReorder(items: HTMLElement[]) {
  // First: Record initial positions
  const firstPositions = items.map(el => el.getBoundingClientRect());

  // Last: Let DOM update (new order)
  // Invert: Calculate deltas and apply transform
  // Play: Animate to final position

  items.forEach((el, i) => {
    const delta = firstPositions[i].top - el.getBoundingClientRect().top;
    el.style.transform = `translateY(${delta}px)`;
    el.style.transition = "none";

    requestAnimationFrame(() => {
      el.style.transition = "transform 300ms ease-out";
      el.style.transform = "";
    });
  });
}
```

### 5.3 Dropdown Positioning

```css
.nv2-search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  max-height: 400px;
  overflow-y: auto;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 0 0 8px 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
}
```

### 5.4 AI Fallback Warning

```tsx
{aiUnavailable && (
  <div class="nv2-search-warning">
    <span class="nv2-search-warning-icon">⚠️</span>
    <span>AI ranking unavailable - showing basic results</span>
  </div>
)}
```

---

## 6. Error Handling

| Scenario | User Experience |
|----------|-----------------|
| INSTANT fails | Show "Search unavailable" in dropdown |
| EVOLVING fails/times out | Keep INSTANT results + subtle warning |
| DEEP fails | Toast "Deep search failed" + partial results if any |
| Network error | "Connection lost - retrying..." with spinner |
| Empty results | "No notes match your search" + suggest Deep |

---

## 7. Accessibility

- Dropdown has `role="listbox"` with `aria-activedescendant`
- Results have `role="option"` with proper labels
- Keyboard navigation fully supported
- Shimmer respects `prefers-reduced-motion`
- Screen reader announces phase transitions

---

## 8. Implementation Phases

### Stage 1: Dropdown Infrastructure (Faye)
- Create SearchDropdown component
- Wire to Omnibar input events
- Implement keyboard navigation
- ESC/click-outside dismiss

### Stage 2: Progressive Orchestrator (Archie)
- Create ProgressiveSearchOrchestrator
- Add progressive event types
- Wire INSTANT → EVOLVING flow
- Add fallback handling

### Stage 3: Shimmer & Reorder (Faye)
- Implement shimmer CSS animation
- Add FLIP reorder animation
- Connect to EVOLVING phase events

### Stage 4: Deep Search (Archie + Faye)
- Archie: Deep search execution, cancellation
- Faye: "Go Deeper" button, Shift+Enter, progress indicator
- Faye: Insights Stream integration

### Stage 5: Polish (Faye)
- Toast notifications
- AI fallback warning
- Accessibility audit
- Responsive behavior

---

## 9. Testing Checklist

### Functional
- [ ] Type query → INSTANT results appear in <500ms
- [ ] Results shimmer during EVOLVING phase
- [ ] Results reorder smoothly when AI scores arrive
- [ ] "Go Deeper" button triggers DEEP search
- [ ] Shift+Enter triggers DEEP search
- [ ] ESC dismisses dropdown and clears search
- [ ] Click outside dismisses dropdown
- [ ] Click result navigates to note, sidebar stays open
- [ ] DEEP results appear in Insights Stream
- [ ] Toast shows when DEEP completes
- [ ] Cancel button aborts DEEP search

### Edge Cases
- [ ] AI unavailable → warning shown, INSTANT order kept
- [ ] Empty results → helpful message shown
- [ ] Very long query → handled gracefully
- [ ] Rapid typing → debounce prevents thrashing
- [ ] New search cancels previous DEEP

### Performance
- [ ] INSTANT < 200ms for warm cache
- [ ] EVOLVING < 2s typical
- [ ] No jank during reorder animation
- [ ] Memory stable after many searches

---

## 10. Files to Modify/Create

### New Files
```
src/ui/sidebar/components/search/
├── SearchDropdown.tsx
├── SearchResultItem.tsx
├── SearchFooter.tsx
└── DeepSearchIndicator.tsx

src/core/search/
└── progressiveSearch.ts

src/ui/styles/components/
└── search-dropdown.css
```

### Modified Files
```
src/ui/sidebar/components/Omnibar.tsx
src/ui/sidebar/App.tsx
src/ui/sidebar/components/InsightStream.tsx (or equivalent)
src/core/events/types.ts
src/types/settings.ts
```

---

## Appendix: Interview Decisions Reference

| Question | Answer | Round |
|----------|--------|-------|
| Results location | Dropdown below Omnibar | R5 |
| Loading UX | Shimmer + animated reorder | R5 |
| Deep trigger | Both button and Shift+Enter | R5 |
| Preset mapping | Keep as fallback | R5 |
| Debounce timing | 300ms | R6 |
| AI fallback | Subtle warning, keep results | R6 |
| Dismiss behavior | Immediate clear | R6 |
| Navigation | Open note, keep sidebar | R6 |
| Deep display | Mixed chronologically | R7 |
| Deep notification | Toast + inline update | R7 |
| Deep cancel | Via Omnibar X button | R7 |
| Deep concurrency | One at a time | R7 |

---

*Specification generated from interview session `interview-notient-wiring-ux-1768077411` (Rounds 5-7).*
