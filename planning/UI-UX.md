# Notient UI/UX Architecture - Target State v2.0

> Design specification for the context-aware, AI-powered note assistant

**Status**: Design Complete, Implementation Pending
**Version**: 0.2.0-alpha

---

## Design Philosophy

### Core Principle: Agentic Intelligence

Notient is **software that talks back**. Rather than a passive control panel waiting for commands, the sidebar is an intelligent collaborator that:

- **Observes** what note you're working on
- **Analyzes** content via embeddings in real-time
- **Surfaces** the 2-3 most relevant actions
- **Proposes** changes in a rolling insight stream
- **Waits** for human confirmation before acting

### The Balanced Hybrid Model

```
NOT THIS                          THIS                           NOT THIS
─────────────────────────────────────────────────────────────────────────
Reactive Assistant         →    Balanced Hybrid      ←    Autonomous Agent
(waits for commands)            (context-aware)           (acts independently)
```

The agent monitors context and proactively suggests, but **never applies changes without explicit user approval**.

---

## Architecture Overview

### Single Adaptive Sidebar

**Gone**: The dual-view toggle (Note/Agents). Users shouldn't manage view states.

**New**: One intelligent view that adapts to context automatically.

```
┌─────────────────────────────────┐
│  Notient                    ⚙️  │  ← Fixed header
├─────────────────────────────────┤
│  ┌───────────────────────────┐  │
│  │  📄 Current Note          │  │  ← Note Card (always visible)
│  │  Tags: #research #hpc     │  │
│  │  Links: 5 ← 12 →          │  │
│  └───────────────────────────┘  │
├─────────────────────────────────┤
│  Suggested for this note:       │  ← Smart-filtered actions
│  ┌─────┐ ┌─────┐ ┌─────┐       │     (2-3 based on embeddings)
│  │ 🔗  │ │ ✂️  │ │ ✨  │       │
│  │Link │ │Split│ │Enrich│      │
│  └─────┘ └─────┘ └─────┘       │
│           [Show all 7 ▾]        │  ← Expandable for power users
├─────────────────────────────────┤
│  Quick Actions                  │  ← Always visible (3 buttons)
│  [Enrich] [Link] [Move]         │
├─────────────────────────────────┤
│  💡 Insight Stream              │  ← Rolling feed
│  ┌───────────────────────────┐  │
│  │ ● Agent suggests: Add 3   │  │  ← Proposed actions
│  │   tags to this note       │  │
│  │   [Apply] [Dismiss]       │  │
│  ├───────────────────────────┤  │
│  │ ○ This note has 0 links   │  │  ← Insights
│  │   Consider connecting...   │  │
│  └───────────────────────────┘  │
├─────────────────────────────────┤
│  🔍 Search notes...             │  ← Omnibar
└─────────────────────────────────┘
```

### Context-Driven Layout Switching

The sidebar automatically reconfigures when context changes:

| Context | Layout | Trigger |
|---------|--------|---------|
| **Note Focus** | Note Card + Suggested Actions + Insight Stream | Default (note open) |
| **Workflow Running** | Progress bar + current note + cancel | `workflowRunner.isActive` |
| **Actions Pending** | Review queue (batch apply/dismiss) | `reviewQueue.length > 0` |
| **No Note** | Welcome + recent notes | No active file |

---

## Component Architecture

### Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Rendering** | Preact (3KB) | Declarative components, minimal overhead |
| **State** | Preact Signals (local) | Fine-grained reactivity without Redux complexity |
| **Styling** | CSS Variables | Obsidian theme integration |
| **Storage** | MetadataCache | Ephemeral suggestions, regenerate on demand |

### Component Hierarchy

```
src/views/sidebar/preact/
├── App.tsx                    # Root component, context providers
├── components/
│   ├── NoteCard.tsx           # Current note metadata display
│   ├── SuggestedActions.tsx   # Smart-filtered 2-3 actions
│   ├── QuickActions.tsx       # Fixed 3-button row
│   ├── InsightStream.tsx      # Rolling feed of insights + proposals
│   ├── ProposedActionCard.tsx # Individual action with apply/dismiss
│   ├── SearchOmnibar.tsx      # Search + slash commands
│   └── WorkflowProgress.tsx   # Active workflow indicator
├── layouts/
│   ├── NoteFocusLayout.tsx    # Default note-centric view
│   ├── WorkflowLayout.tsx     # Workflow in progress
│   └── ReviewLayout.tsx       # Batch action review
├── hooks/
│   ├── useSidebarContext.ts   # Determines current context
│   ├── useNoteVitals.ts       # Current note analysis
│   ├── useSuggestedActions.ts # Embedding-based filtering
│   └── useInsightStream.ts    # Feed management
└── index.tsx                  # Mount point
```

---

## Intelligence Layer

### Embedding-Based Action Filtering

Instead of showing all 7 Intelligence 2.0 actions, the agent determines which 2-3 are relevant.

**Two-Phase Detection**:

```
Phase 1: Instant Heuristics (0ms)
─────────────────────────────────
Rules applied immediately on note open:
• Word count > 1000 → suggest "atomic" (split)
• No tags → suggest "enhance"
• source_url in frontmatter → suggest "clipping"
• Contains TODO/dates → suggest "task"
• Zero links → suggest "connection"

Phase 2: Embedding Analysis (background)
────────────────────────────────────────
Compare note embedding to action archetypes:
• Find cosine similarity to each action type
• Rank by relevance score
• Filter by threshold (>0.7 confidence)
• Return top 3
```

**Action Archetypes**:

| Action | Archetype Description |
|--------|----------------------|
| `enhance` | Notes with incomplete metadata, sparse frontmatter, missing context |
| `connection` | Isolated notes with potential semantic links to other content |
| `atomic` | Long-form notes containing multiple distinct concepts |
| `synthesis` | Scattered notes on related topics needing consolidation |
| `task` | Notes containing TODO items, deadlines, action items |
| `clipping` | Web clippings, bookmarks, saved articles with source URLs |
| `brand` | Public-facing content for brand voice alignment review |

**Archetype Learning**:
```typescript
// When user applies an action, update archetype
onActionApplied(actionType, noteEmbedding) {
  const currentArchetype = archetypes[actionType]
  archetypes[actionType] = blend(currentArchetype, noteEmbedding, 0.1)
  // 10% influence from new data, 90% existing pattern
}
```

---

## Insight Stream

### Unified Feed Architecture

The Insight Stream is a **rolling feed** combining:
- Agent-proposed actions (with Apply/Dismiss)
- Passive insights (information, no action)
- Workflow updates (progress, completion)

```typescript
type StreamItem =
  | ProposedAction   // "Add these 3 tags" [Apply] [Dismiss]
  | Insight          // "This note has 0 backlinks"
  | WorkflowUpdate   // "Workflow 50% complete"
```

### Interaction Model

**Proposed Actions**:
```
┌─────────────────────────────────────┐
│ ● Agent suggests: Create synthesis  │
│   note from 5 related notes         │
│                                     │
│   📄 note-1.md                      │
│   📄 note-2.md                      │
│   📄 note-3.md (+2 more)            │
│                                     │
│   [ℹ️ Why?] [Apply] [Dismiss]       │
└─────────────────────────────────────┘
```

**On-Demand Explanation** (click "Why?"):
```
┌─────────────────────────────────────┐
│ Why this suggestion?                │
│                                     │
│ These 5 notes share concepts:       │
│ • distributed systems               │
│ • fault tolerance                   │
│ • consensus protocols               │
│                                     │
│ Synthesis would create a unified    │
│ overview connecting these ideas.    │
│                                     │
│ Confidence: 87%                     │
└─────────────────────────────────────┘
```

---

## Dashboard (Deferred)

### Current Scope: Primitive Version

The Dashboard is **out of scope** for the sidebar redesign. A minimal version remains for essential functions only:

```
┌─────────────────────────────────────┐
│  Notient Dashboard                  │
├─────────────────────────────────────┤
│  Active Workflows                   │
│  └─ /enrich folder:inbox [Cancel]   │
│     ████████░░ 80% (8/10)           │
├─────────────────────────────────────┤
│  Review Queue (3 pending)           │
│  └─ [Review All →]                  │
├─────────────────────────────────────┤
│  Recent Actions                     │
│  └─ Added tags to note.md [Undo]    │
│  └─ Created synthesis.md [Undo]     │
└─────────────────────────────────────┘
```

### Future: External Web App

The full Dashboard will be developed as a **separate web app** rendered inside Obsidian's `<iframe>` or custom view. This allows:
- Modern web stack (React/Vue/Svelte)
- Richer visualizations
- Independent deployment
- Vault-wide analytics

**Timeline**: Post v0.3.0

---

## Design System

### Philosophy: Function Over Form

The current 3000-line CSS is reduced to ~1000 lines focused on clarity and usability.

**Removed**:
- Glassmorphism effects (backdrop-filter, complex shadows)
- Multiple button variants (5 → 2: default + primary)
- PARA-specific styling (Dashboard concern)
- Elaborate animations

**Kept**:
- CSS variables for Obsidian theme integration
- Spacing scale (xs/sm/md/lg)
- Essential component classes
- Risk badge colors (3 levels)

### CSS Variables (Minimal Set)

```css
:root {
  /* Obsidian integration */
  --nv2-bg-primary: var(--background-primary);
  --nv2-bg-secondary: var(--background-secondary);
  --nv2-text-primary: var(--text-normal);
  --nv2-text-muted: var(--text-muted);
  --nv2-border: var(--background-modifier-border);

  /* Accent */
  --nv2-accent: var(--interactive-accent);

  /* Spacing */
  --nv2-space-xs: 4px;
  --nv2-space-sm: 8px;
  --nv2-space-md: 12px;
  --nv2-space-lg: 16px;

  /* Status */
  --nv2-status-success: #4caf50;
  --nv2-status-warning: #ff9800;
  --nv2-status-error: #f44336;
}
```

### Component Styles (Examples)

**Action Button**:
```css
.nv2-action-btn {
  padding: var(--nv2-space-sm) var(--nv2-space-md);
  background: var(--nv2-bg-secondary);
  border: 1px solid var(--nv2-border);
  border-radius: 4px;
  cursor: pointer;
}

.nv2-action-btn:hover {
  background: var(--background-modifier-hover);
}

.nv2-action-btn--primary {
  background: var(--nv2-accent);
  color: white;
  border-color: var(--nv2-accent);
}
```

**Risk Badge**:
```css
.nv2-risk-badge {
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  border-radius: 4px;
}

.nv2-risk-badge--low { background: rgba(76, 175, 80, 0.15); color: #4caf50; }
.nv2-risk-badge--medium { background: rgba(255, 152, 0, 0.15); color: #ff9800; }
.nv2-risk-badge--high { background: rgba(244, 67, 54, 0.15); color: #f44336; }
```

---

## Interaction Patterns

### Search + Suggest (Two-Stage)

1. User types in omnibar
2. Search results appear
3. User selects a result
4. **Agent surfaces**: "You might want to: [Link to current note] [Compare notes]"

```
┌─────────────────────────────────────┐
│ 🔍 distributed systems              │
├─────────────────────────────────────┤
│ 📄 consensus-protocols.md           │
│ 📄 raft-algorithm.md                │
│ 📄 paxos-notes.md                   │
├─────────────────────────────────────┤
│ 💡 For "raft-algorithm.md":         │
│    [Link to current] [Synthesize]   │
└─────────────────────────────────────┘
```

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `↑/↓` | Navigate search results / stream items |
| `Enter` | Open selected / Apply action |
| `Esc` | Clear search / Dismiss action |
| `Tab` | Cycle through action buttons |
| `?` | Show "Why?" explanation |

### Apply Flow

```
User clicks [Apply]
    ↓
Action executes (streaming feedback in UI)
    ↓
Success → Item slides out of stream
    ↓
Toast: "Applied: Add 3 tags" [Undo]
    ↓
Action added to history (Dashboard)
```

---

## Data Flow

### On Note Open

```
1. activeFileChanged event
    ↓
2. useNoteVitals() → compute note metadata
    ↓
3. useSuggestedActions():
   a. quickFilter() → instant 2-3 suggestions
   b. render immediately
   c. deepFilter() (background) → upgrade suggestions
    ↓
4. useInsightStream() → load cached insights or generate
    ↓
5. Render NoteFocusLayout
```

### On Action Apply

```
1. User clicks [Apply]
    ↓
2. actionApplier.applyConfirmed(action)
    ↓
3. Action executes → vault modified
    ↓
4. actionHistory.record(action)
    ↓
5. eventBus.emit("action:applied")
    ↓
6. Insight Stream removes item
    ↓
7. Toast notification with [Undo]
```

### On Workflow Start

```
1. User types "/enrich folder:inbox"
    ↓
2. parseSlashCommand() → validate
    ↓
3. workflowRunner.start(spec)
    ↓
4. useSidebarContext() detects workflow
    ↓
5. Layout switches to WorkflowLayout
    ↓
6. Progress updates stream via eventBus
    ↓
7. Completion → switch back to NoteFocusLayout
    ↓
8. Medium/high-risk actions → ReviewLayout
```

---

## Implementation Phases

| Phase | Focus | Deliverable |
|-------|-------|-------------|
| **1** | Preact Foundation | Components render, no regressions |
| **2** | Embedding Filtering | 2-3 smart-filtered actions |
| **3** | Adaptive Layout | Context-driven view switching |
| **4** | Insight Stream | Rolling feed with apply/dismiss |
| **5** | CSS Simplification | 3000 → 1000 lines |
| **6** | Polish | Keyboard nav, accessibility |

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Actions shown per note | 7 (all) | 2-3 (relevant) |
| Sidebar layouts | 2 (manual toggle) | 3 (auto-switch) |
| CSS lines | 3000 | ~1000 |
| Bundle size increase | - | <5KB (Preact) |
| Time to relevant action | N/A | <500ms |

---

## Non-Goals (Out of Scope)

- **Dashboard redesign** - Deferred to separate web app project
- **PARA visualization** - Dashboard concern
- **Vault-wide analytics** - Dashboard concern
- **User migration** - No existing users (dev mode)
- **Backward compatibility** - Clean break for v0.2

---

## References

- **Implementation Spec**: `planning/specs/agentic-sidebar-v2-spec.md`
- **Next Session Guide**: `planning/NEXT_SESSION_PROMPT.md`
- **Identity System**: `docs/IDENTITY_AND_PROMPTS.md`

---

*Target State v2.0 - Designed 2026-01-08*
