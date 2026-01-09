# Agentic Sidebar v2.0 - Implementation Specification

> Note-centric, AI-powered sidebar with contextual intelligence

**Version**: 0.2.0-alpha
**Status**: Development
**Scope**: Sidebar only (Dashboard out of scope)
**Date**: 2026-01-08

---

## Vision

Transform Notient's sidebar from a manual control panel into an **intelligent, context-aware assistant** that:
- Proactively suggests relevant actions based on note content
- Surfaces insights in a rolling stream
- Adapts UI dynamically to current note context
- Minimizes decision fatigue through smart filtering

### Core Paradigm: Balanced Hybrid Agency

**Not reactive** (wait for user commands) ← **BALANCED HYBRID** → **Not fully autonomous** (agent runs everything)

The agent is a **context-aware collaborator** that:
- Monitors current note context
- Suggests 2-3 relevant actions based on semantic understanding
- Surfaces insights and proposed changes proactively
- Waits for user confirmation before applying changes

---

## Interview Results Summary

### Round 1: Vision & Goals
- **Agent Role**: Balanced hybrid (context-aware prompting)
- **Action Model**: Auto-detect + suggest (smart filtering) - show only 2-3 relevant actions
- **Layout Model**: Fixed chrome, dynamic content
- **Persistence**: Contextual (note-attached metadata via Obsidian cache)

### Round 2: Technical Architecture
- **Detection Timing**: Hybrid (instant heuristics + background deep analysis)
- **Storage**: Obsidian metadata cache (ephemeral)
- **Filter Logic**: Embedding similarity (vector-based)
- **Rendering**: Lightweight virtual DOM (Preact)

### Round 3: User Experience
- **Action Display**: Inline buttons (always visible, 2-3 smart-filtered)
- **Review UI**: Dual surface - Insight Stream (contextual feed) + Dashboard (batch review queue)
- **Search + AI**: Two-stage (search first, then suggest actions on selected result)
- **Transparency**: On-demand explanation (tooltip/expand for reasoning)

### Round 4: Simplification
- **Sidebar Consolidation**: Keep Quick Actions + Intelligence Actions, but hide Intelligence by default (expandable)
- **Dashboard**: Out of scope - simple primitive version for now (workflows + actions + history)
- **Sidebar Views**: Remove dual-view (Note/Agents) → Single adaptive view
- **Visual Design**: Simplify to minimal (function over form) - reduce 3000 lines CSS

### Round 5: Implementation Strategy
- **Phasing**: Focus on sidebar only; Dashboard is external web app (future work)
- **Archetypes**: Hybrid (seed with manual embeddings, learn from user behavior)
- **Migration**: No users, no migration - development mode 0.1 → 0.2
- **Primary Risk**: Technical complexity (Preact + embeddings + adaptive UI)

---

## Technical Architecture

### 1. Preact Component Migration

**Rationale**: Current imperative DOM manipulation is verbose and error-prone for dynamic UI.

**Approach**:
```typescript
// Before (imperative)
const card = container.createDiv({ cls: "nv2-note-card" })
card.createDiv({ cls: "nv2-note-card-title", text: noteVitals.title })

// After (declarative with Preact)
import { h } from 'preact'

function NoteCard({ noteVitals }: Props) {
  return (
    <div class="nv2-note-card">
      <div class="nv2-note-card-title">{noteVitals.title}</div>
    </div>
  )
}
```

**Bundle Impact**: +3KB (Preact is 3KB gzipped)

**Migration Strategy**:
1. Add Preact to bundle (`bun add preact`)
2. Create component library in `src/views/sidebar/preact/`
3. Mount Preact app in `sidebar.ts` via `render(h(App), container)`
4. Migrate components incrementally (NoteCard → QuickActions → etc.)

---

### 2. Embedding-Based Action Filtering

**Goal**: Show only 2-3 relevant Intelligence 2.0 actions instead of all 7.

**Architecture**:

```typescript
// Action archetypes (seed embeddings)
const ACTION_ARCHETYPES: Record<IntelligenceActionType, Float32Array> = {
  enhance: computeArchetype("notes needing metadata enrichment, incomplete frontmatter"),
  connection: computeArchetype("isolated notes with potential semantic links"),
  atomic: computeArchetype("long-form notes with multiple distinct concepts"),
  synthesis: computeArchetype("scattered notes on related topics needing synthesis"),
  task: computeArchetype("notes containing tasks, deadlines, action items"),
  clipping: computeArchetype("web clippings, bookmarks, saved articles"),
  brand: computeArchetype("public-facing content for brand alignment review")
}

// Fast heuristic filter (instant)
function quickFilter(note: NoteVitals): IntelligenceActionType[] {
  const candidates: IntelligenceActionType[] = []

  // Rule-based quick wins
  if (note.wordCount > 1000) candidates.push("atomic")
  if (note.outlinks.length === 0 && note.backlinks.length === 0) candidates.push("connection")
  if (note.frontmatter.source_url) candidates.push("clipping")
  if (note.content.match(/TODO|DEADLINE|@\d{4}-\d{2}-\d{2}/)) candidates.push("task")

  return candidates.slice(0, 3) // Max 3
}

// Deep embedding filter (background)
async function deepFilter(
  noteEmbedding: Float32Array,
  archetypes: typeof ACTION_ARCHETYPES
): Promise<Array<{ action: IntelligenceActionType; score: number }>> {
  const scores = Object.entries(archetypes).map(([action, archetype]) => ({
    action: action as IntelligenceActionType,
    score: cosineSimilarity(noteEmbedding, archetype)
  }))

  return scores
    .sort((a, b) => b.score - a.score)
    .filter(s => s.score > 0.7) // Confidence threshold
    .slice(0, 3)
}

// Usage in sidebar
useEffect(() => {
  // Instant heuristic suggestions
  const instant = quickFilter(noteVitals)
  setSuggestedActions(instant)

  // Upgrade to embedding-based in background
  getNoteEmbedding(noteVitals.path).then(embedding => {
    const deep = deepFilter(embedding, ACTION_ARCHETYPES)
    setSuggestedActions(deep.map(d => d.action))
  })
}, [noteVitals])
```

**Archetype Learning** (future enhancement):
- When user applies an action, update archetype: `archetype = 0.9 * archetype + 0.1 * noteEmbedding`
- Gradually personalizes to user's vault patterns

---

### 3. Single Adaptive Sidebar (Remove Dual-View)

**Current**: Sidebar has "Note" view and "Agents" view - user toggles manually.

**New**: Single view that adapts based on context.

```typescript
// Before (dual view)
type SidebarView = "note" | "agents"
const [view, setView] = useState<SidebarView>("note")

// After (adaptive)
type SidebarContext = "note_focus" | "workflow_running" | "action_review"

function determineSidebarContext(): SidebarContext {
  if (workflowRunner.hasActiveWorkflow()) return "workflow_running"
  if (reviewQueue.length > 0) return "action_review"
  return "note_focus"
}

// Render different layouts based on context
function Sidebar() {
  const context = useSidebarContext()

  switch (context) {
    case "note_focus":
      return <NoteFocusLayout />
    case "workflow_running":
      return <WorkflowProgressLayout />
    case "action_review":
      return <ActionReviewLayout />
  }
}
```

**Layout Variations**:

**NoteFocusLayout** (default):
```
┌─ Note Card ─────────────┐
├─ Suggested Actions (2-3)┤  ← Smart-filtered Intelligence Actions
├─ Quick Actions (3)      ┤  ← Always visible: Enrich, Link, Move
├─ Insight Stream         ┤  ← Rolling feed of insights + proposed actions
└─ Search/Omnibar         ┘
```

**WorkflowProgressLayout** (when workflow running):
```
┌─ Workflow Progress ─────┐
│ /enrich folder:inbox    │
│ █████░░░░░ 50% (5/10)   │
├─ Current Note           ┤
│ Processing: note.md     │
└─ Cancel Workflow        ┘
```

**ActionReviewLayout** (when actions pending):
```
┌─ Pending Actions (8) ───┐
│ ▸ Add tags: #research   │ [Apply] [Dismiss]
│ ▸ Create synthesis note │ [Apply] [Dismiss]
│ ▸ Link to 3 notes       │ [Apply] [Dismiss]
└─ Apply All | Dismiss All┘
```

---

### 4. Insight Stream as Action Feed

**Current**: Insight Stream shows static insights (orphan detection, etc.)

**New**: Rolling feed of agent-generated insights AND proposed actions.

```typescript
type InsightStreamItem =
  | { type: "insight"; text: string; linkPath?: string }
  | { type: "proposed_action"; action: ProposedAction; source: "intelligence" | "workflow" }
  | { type: "workflow_update"; workflow: WorkflowRun }

function InsightStream({ items }: { items: InsightStreamItem[] }) {
  return (
    <div class="nv2-insight-stream">
      {items.map(item => {
        switch (item.type) {
          case "insight":
            return <InsightItem {...item} />
          case "proposed_action":
            return <ProposedActionCard action={item.action} onApply={...} onDismiss={...} />
          case "workflow_update":
            return <WorkflowUpdateCard workflow={item.workflow} />
        }
      })}
    </div>
  )
}
```

**Storage**: Ephemeral in Obsidian MetadataCache
```typescript
// Store in note's cached metadata
app.metadataCache.getCache(file.path) // Get cached metadata
// Add custom field (doesn't persist to disk)
cache.notient = {
  suggestedActions: [action1, action2],
  insights: [insight1, insight2],
  lastAnalyzed: Date.now()
}
```

---

### 5. Simplified CSS Design System

**Current**: 3000 lines of CSS with extensive polish (glassmorphism, shadows, animations)

**Target**: ~1000 lines focused on function over form

**Reduce**:
- Remove glassmorphism effects (backdrop-filter, complex shadows)
- Simplify to 2 button variants (primary + default) instead of 5
- Remove PARA-specific styling (we don't show PARA in note-centric view)
- Consolidate badge styles (3 risk levels instead of 8+ variants)

**Keep**:
- CSS variables for theming (Obsidian light/dark integration)
- Core spacing scale (xs/sm/md/lg)
- Essential component classes (nv2-* prefix)

**Example Simplification**:
```css
/* Before (polished) */
.nv2-quick-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--nv2-space-md);
  background: var(--nv2-bg-secondary);
  border: 1px solid var(--nv2-border-color);
  border-radius: var(--nv2-radius-md);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}
.nv2-quick-action:hover {
  background: color-mix(in srgb, var(--nv2-color-accent), transparent 92%);
  border-color: color-mix(in srgb, var(--nv2-color-accent), transparent 70%);
  transform: translateY(-1px);
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

/* After (minimal) */
.nv2-action-btn {
  padding: 8px 12px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  cursor: pointer;
}
.nv2-action-btn:hover {
  background: var(--background-modifier-hover);
}
.nv2-action-btn--primary {
  background: var(--interactive-accent);
  color: white;
}
```

---

## Implementation Phases

### Phase 1: Preact Foundation (Week 1)
- [x] Install Preact (`bun add preact`)
- [ ] Set up build config for JSX/TSX
- [ ] Create component directory structure
- [ ] Migrate NoteCard to Preact
- [ ] Migrate QuickActions to Preact
- [ ] Mount Preact app in sidebar
- [ ] Verify build size (~3KB increase)

### Phase 2: Embedding-Based Filtering (Week 2)
- [ ] Define action archetypes (manual embeddings)
- [ ] Implement `quickFilter()` heuristics
- [ ] Implement `deepFilter()` with cosine similarity
- [ ] Add metadata cache storage
- [ ] Wire to UI (show 2-3 actions)
- [ ] Test with real vault notes

### Phase 3: Adaptive Layout (Week 3)
- [ ] Remove dual-view state (Note/Agents toggle)
- [ ] Implement `determineSidebarContext()`
- [ ] Create NoteFocusLayout component
- [ ] Create WorkflowProgressLayout component
- [ ] Create ActionReviewLayout component
- [ ] Wire context switching

### Phase 4: Insight Stream Upgrade (Week 4)
- [ ] Refactor Insight Stream for mixed content types
- [ ] Add ProposedActionCard component
- [ ] Wire to Intelligence 2.0 pipeline
- [ ] Add workflow update cards
- [ ] Implement Apply/Dismiss in stream

### Phase 5: CSS Simplification (Week 5)
- [ ] Audit current styles (3000 lines)
- [ ] Remove glassmorphism effects
- [ ] Consolidate button variants (2 instead of 5)
- [ ] Simplify badge styles (3 risk levels)
- [ ] Remove PARA-specific styles
- [ ] Target: ~1000 lines

### Phase 6: Polish & Testing (Week 6)
- [ ] Keyboard navigation (tab through actions)
- [ ] ARIA labels for accessibility
- [ ] Performance testing (embedding lookups)
- [ ] Bundle size verification
- [ ] Documentation update

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Bundle size increase | <5KB | TBD |
| Actions shown per note | 2-3 | 7 |
| CSS lines | ~1000 | 3000 |
| Time to relevant action | <500ms | N/A |
| Sidebar layout switches | Automatic | Manual toggle |

---

## Technical Risks & Mitigations

### Risk 1: Preact Bundle Size
**Risk**: Bundle increases beyond acceptable limits
**Mitigation**: Preact is only 3KB gzipped; use tree-shaking; avoid preact/compat

### Risk 2: Embedding Lookup Performance
**Risk**: Cosine similarity on every note open feels sluggish
**Mitigation**:
- Use quick heuristics first (instant)
- Run deep filter in background
- Cache results in metadata cache
- Benchmark with 1000-note vault

### Risk 3: Metadata Cache Reliability
**Risk**: Obsidian cache is ephemeral, suggestions lost on restart
**Mitigation**:
- Acceptable for this use case (suggestions are regenerated)
- Fast regeneration via quick heuristics
- Consider persistent cache if needed later

### Risk 4: Action Archetype Accuracy
**Risk**: Manual embeddings don't match user's vault patterns
**Mitigation**:
- Start with broad archetypes
- Implement learning (update on user feedback)
- Allow manual override (expand to see all 7 actions)

---

## Out of Scope (Deferred)

- **Dashboard revamp**: Will be separate web app; keep primitive version for now
- **User migration**: No existing users; development mode only
- **PARA UI elements**: Dashboard concern, not sidebar
- **Advanced glassmorphism**: Simplifying to minimal design
- **Multi-pane layouts**: Single adaptive view only

---

## Open Questions

1. **Archetype Embeddings**: Should we generate archetypes via LLM analysis of sample notes, or use pre-defined text descriptions?
2. **Cache TTL**: How long should embedding filter results stay cached? 5 min? 1 hour? Until note changes?
3. **Expandability**: If user wants to see all 7 actions, should it be a dropdown, modal, or expanded inline section?
4. **Learning Rate**: When user applies an action, how aggressively should archetype update? 10%? 5%?

---

## References

- **Current Implementation**: See `planning/UI-UX.md` for full architecture docs
- **Intelligence 2.0 Spec**: `docs/IDENTITY_AND_PROMPTS.md`
- **Component Library**: `src/views/sidebar/components/`
- **CSS Design System**: `src/styles.css` (lines 10-3078)

---

*Specification Date: 2026-01-08*
*Interview Rounds: 5*
*Estimated Implementation: 6 weeks*
