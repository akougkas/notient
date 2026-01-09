# Next Coding Session: Agentic Sidebar v2.0 - Phase 1

**Goal**: Begin transformation of sidebar into context-aware, AI-powered note assistant

**Context**: We're building an intelligent sidebar that proactively surfaces 2-3 relevant actions based on note content using embedding similarity, rendered with Preact for dynamic UI, with a simplified minimal design system.

---

## Session Objectives

1. **Set up Preact infrastructure** - Add Preact, configure build, create component directory
2. **Migrate first component** - Convert NoteCard from imperative DOM to Preact JSX
3. **Verify bundle impact** - Ensure <5KB increase
4. **Plan embedding architecture** - Design action archetype system

---

## Key Decisions from Interview

### Vision
- **Agent Role**: Balanced hybrid - context-aware prompting, not fully autonomous
- **Smart Filtering**: Show only 2-3 relevant Intelligence Actions via embedding similarity
- **Layout**: Single adaptive view (remove Note/Agents toggle)
- **Design**: Simplify from 3000 lines CSS to ~1000 lines (function over form)

### Architecture
- **Rendering**: Preact (3KB, declarative components)
- **Filtering**: Hybrid approach
  - Instant: Rule-based heuristics (word count, URLs, tasks)
  - Background: Embedding similarity to action archetypes
- **Storage**: Obsidian MetadataCache (ephemeral, regenerate on open)
- **Learning**: Hybrid archetypes (seed manually, refine from user behavior)

### Scope
- **In Scope**: Sidebar only - note-centric AI assistant
- **Out of Scope**: Dashboard (future web app), migrations (no users yet)

---

## Implementation Plan

### Phase 1: Preact Foundation ← **START HERE**

**Tasks**:
1. Install Preact + types
   ```bash
   bun add preact
   bun add -d @types/preact
   ```

2. Update build config (`scripts/build.ts` or `esbuild.config.js`)
   ```typescript
   jsxFactory: 'h',
   jsxFragment: 'Fragment',
   ```

3. Create component directory structure
   ```
   src/views/sidebar/preact/
   ├── components/
   │   ├── NoteCard.tsx
   │   ├── QuickActions.tsx
   │   ├── SuggestedActions.tsx
   │   └── InsightStream.tsx
   ├── layouts/
   │   ├── NoteFocusLayout.tsx
   │   ├── WorkflowProgressLayout.tsx
   │   └── ActionReviewLayout.tsx
   ├── App.tsx
   └── index.tsx
   ```

4. Migrate NoteCard component
   ```tsx
   // Before (sidebar/components/NoteCard.ts)
   export class NoteCard {
     render(container: HTMLElement) {
       const card = container.createDiv({ cls: "nv2-note-card" })
       card.createDiv({ text: this.noteVitals.title })
     }
   }

   // After (sidebar/preact/components/NoteCard.tsx)
   import { h } from 'preact'

   interface Props {
     noteVitals: NoteVitals
     backlinkPreview: string
   }

   export function NoteCard({ noteVitals, backlinkPreview }: Props) {
     return (
       <div class="nv2-note-card">
         <div class="nv2-note-card-title">{noteVitals.title}</div>
         <div class="nv2-note-card-tags">
           {noteVitals.tags.slice(0, 5).map(tag => (
             <span class="nv2-tag">{tag}</span>
           ))}
         </div>
       </div>
     )
   }
   ```

5. Mount Preact app in sidebar.ts
   ```typescript
   import { render, h } from 'preact'
   import { App } from './preact/App'

   async onOpen() {
     const container = this.containerEl.children[1]
     container.empty()

     // Mount Preact app
     render(h(App, { kernel: this.kernel }), container)
   }
   ```

6. Build and verify
   ```bash
   bun run build
   # Check main.js size - should be ~327KB (current 324KB + 3KB Preact)
   ```

---

## Phase 2 Preview: Embedding Architecture

**Action Archetypes** (to be implemented next):
```typescript
const ACTION_ARCHETYPES = {
  enhance: "notes with incomplete metadata, missing tags, sparse frontmatter",
  connection: "isolated notes with few links, potential for semantic connections",
  atomic: "long-form notes with multiple concepts that could be split",
  synthesis: "scattered notes on related topics needing consolidation",
  task: "notes containing TODO items, deadlines, action items, dates",
  clipping: "web clippings, bookmarks, saved articles with source URLs",
  brand: "public-facing content for brand voice alignment review"
}

// Generate embeddings for these descriptions
const archetypes = await Promise.all(
  Object.entries(ACTION_ARCHETYPES).map(async ([action, description]) => ({
    action,
    embedding: await ollama.embed(description)
  }))
)
```

**Quick Filter** (instant heuristics):
```typescript
function quickFilter(note: NoteVitals): IntelligenceActionType[] {
  const suggestions: IntelligenceActionType[] = []

  if (note.wordCount > 1000) suggestions.push("atomic")
  if (note.tags.length === 0) suggestions.push("enhance")
  if (note.frontmatter.source_url) suggestions.push("clipping")
  if (note.content.includes("TODO") || /\d{4}-\d{2}-\d{2}/.test(note.content)) {
    suggestions.push("task")
  }

  return suggestions.slice(0, 3)
}
```

---

## File Reference

| File | Purpose | Status |
|------|---------|--------|
| `planning/specs/agentic-sidebar-v2-spec.md` | Full specification | ✅ Complete |
| `planning/UI-UX.md` | Current architecture docs | ✅ Complete |
| `src/views/sidebar.ts` | Main sidebar view (to refactor) | Existing |
| `src/views/sidebar/components/` | Current imperative components | Existing |
| `src/views/sidebar/preact/` | New Preact components | 🚧 To create |
| `src/styles.css` | Design system (to simplify) | Existing (3000 lines) |

---

## Success Criteria for Phase 1

- [x] Preact installed and build configured
- [ ] NoteCard renders correctly in Preact
- [ ] No visual regressions
- [ ] Bundle size increase <5KB
- [ ] TypeScript compilation passes
- [ ] Hot reload works in dev mode

---

## Questions to Resolve

1. **JSX vs h() syntax**: Should we use JSX `<div>` or `h('div')`? (Recommend JSX for readability)
2. **State management**: Global state with Preact signals or local component state? (Start with local, upgrade if needed)
3. **Obsidian API calls**: How to access `app.vault` from Preact components? (Pass via props or context)
4. **CSS module strategy**: Keep global `.nv2-*` classes or switch to CSS modules? (Keep global for now)

---

## Getting Started

```bash
# 1. Install dependencies
bun add preact
bun add -d @types/preact

# 2. Create component directory
mkdir -p src/views/sidebar/preact/components
mkdir -p src/views/sidebar/preact/layouts

# 3. Create first component
touch src/views/sidebar/preact/components/NoteCard.tsx
touch src/views/sidebar/preact/App.tsx

# 4. Update build config
# Edit scripts/build.ts to add JSX support

# 5. Build and test
bun run dev
```

---

## Next Steps After Phase 1

1. **Phase 2**: Implement embedding-based action filtering
2. **Phase 3**: Build adaptive layout system (remove dual-view)
3. **Phase 4**: Upgrade Insight Stream to action feed
4. **Phase 5**: Simplify CSS to ~1000 lines
5. **Phase 6**: Polish and accessibility

---

## Reference Commands

```bash
# Development
bun run dev              # Watch mode with auto-copy
bun run build            # Production build
bun run typecheck        # TypeScript check
bun run lint             # Biome lint

# Bundle analysis
bun run build:analyze    # Check bundle composition
ls -lh main.js           # Verify file size
```

---

**Ready to code?** Start with Phase 1, Task 1: Install Preact and configure build.

See full spec at: `planning/specs/agentic-sidebar-v2-spec.md`
