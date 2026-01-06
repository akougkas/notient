# Notient UI/UX Design System - Production Ready

> **Mission:** Transform Notient from a functional prototype into a visually stunning, productized experience that defeats competition on aesthetics alone.

## Brand Identity

**Notient** = Note + Sentient  
*"Sentient organization for your notes"*

- **Domain:** notient.org
- **Tagline options:**
  - "Your vault, awakened"
  - "Intelligence that lives in your notes"
  - "Where knowledge becomes aware"

### Design Philosophy

**The Millimeter Paper Aesthetic**
- Subtle grid patterns evoking engineering paper, graph notebooks
- Precision and intentionality in every element
- Dashboard-like control panels for human steering
- Clean lines, measured spacing, mathematical harmony
- The feeling of a well-organized research station

**Core Principles:**
1. **Minimal but not empty** - Every pixel earns its place
2. **Grid-aligned** - Elements snap to invisible guides
3. **Paper-inspired** - Warm, tactile, academic feel
4. **Control surfaces** - User always feels in command
5. **Local-first visual** - No cloud iconography, emphasize privacy

---

## Current State (Post Phase 1.5)

### What We Built

**Setup Wizard:**
- Dual service cards (Ollama + LM Studio)
- Local/Network toggle per service
- Model selection with dimension badges
- Chunk size slider with performance tooltip
- Disk-based index detection with compatibility checking
- Interactive index action selection (use/sync/rebuild)

**Sidebar (Dual-Panel):**
- Search panel (always visible, top)
- Open Note Context panel (shows when note active)
  - PARA type badge
  - Staleness indicator
  - Tags, backlinks, outlinks
  - Suggested actions
- Chat panel (bottom, expandable)
  - Streaming responses
  - Citation links
  - Copy buttons everywhere
- Selectable text throughout
- Clickable search results

**Settings Page:**
- Service status indicators
- Model configuration
- Index management section
- PARA folder mapping

### Lessons Learned

1. **Index detection must be model-agnostic** - Don't assume settings = reality
2. **Dimension compatibility is critical** - Show it visually (badges, colors)
3. **Copy buttons everywhere** - Users expect to extract any text
4. **Open note context is essential** - The vault revolves around what's open
5. **Status indicators need visual hierarchy** - Connected ≠ Ready ≠ Error
6. **Actions should have clear consequences** - "Sync" vs "Rebuild" must be obvious

---

## Design System Specification

### Color Tokens

```css
/* Notient Brand Colors */
--notient-primary: #2D5A27;        /* Deep forest green - intelligence */
--notient-primary-light: #4A8B42;  /* Lighter green for hover */
--notient-accent: #D4A574;         /* Warm paper/cork accent */
--notient-grid: rgba(0,0,0,0.04);  /* Subtle grid lines (light mode) */
--notient-grid-dark: rgba(255,255,255,0.03); /* Grid lines (dark mode) */

/* Status Colors (use Obsidian variables) */
--status-healthy: var(--color-green);
--status-warning: var(--color-yellow);  
--status-error: var(--color-red);
--status-unknown: var(--text-muted);

/* Surface Hierarchy */
--surface-0: var(--background-primary);     /* Base */
--surface-1: var(--background-secondary);   /* Elevated cards */
--surface-2: var(--background-modifier-hover); /* Interactive hover */
```

### Typography Scale

```css
/* Headings */
--notient-h1: 1.25rem;   /* Panel titles */
--notient-h2: 1rem;      /* Section headers */
--notient-h3: 0.875rem;  /* Card titles */

/* Body */
--notient-body: 0.8125rem;  /* 13px - Main text */
--notient-small: 0.75rem;   /* 12px - Secondary info */
--notient-tiny: 0.6875rem;  /* 11px - Badges, metadata */

/* Monospace (for technical info) */
--notient-mono: 'SF Mono', 'Fira Code', monospace;
```

### Spacing System (4px base)

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
```

### Grid Pattern (The Millimeter Paper Effect)

```css
.notient-grid-bg {
  background-image: 
    linear-gradient(var(--notient-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--notient-grid) 1px, transparent 1px);
  background-size: 8px 8px;
}

/* Major grid lines every 4 cells */
.notient-grid-bg-major {
  background-image: 
    linear-gradient(var(--notient-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--notient-grid) 1px, transparent 1px),
    linear-gradient(rgba(0,0,0,0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,0,0,0.08) 1px, transparent 1px);
  background-size: 8px 8px, 8px 8px, 32px 32px, 32px 32px;
}
```

---

## Component Specifications

### 1. Status Indicators

**Service Badge (Compact)**
```
┌─────────────────┐
│ ● Ollama  Ready │  ← Green dot, muted label
└─────────────────┘
```

**Full Status Card**
```
┌────────────────────────────────────┐
│ 🦙 Ollama                    ● ON  │
│ ─────────────────────────────────  │
│ Model: qwen3-embedding:0.6b        │
│ Dimensions: 1024                   │
│ Index: 13,776 chunks               │
└────────────────────────────────────┘
```

### 2. Search Results

```
┌────────────────────────────────────┐
│ 📁 Project Planning               │ ← PARA icon + Title
│ projects/2024/planning.md         │ ← Path (muted)
│ ─────────────────────────────────  │
│ "...discussed the architecture    │ ← Preview snippet
│ decisions for the new system..."  │
│ ─────────────────────────────────  │
│ 94% match  •  💡 Exact topic      │ ← Score + LLM reasoning
│                           [📋] [↗]│ ← Copy, Open buttons
└────────────────────────────────────┘
```

### 3. Open Note Context Panel

```
┌────────────────────────────────────┐
│ ▸ CURRENT NOTE                     │
├────────────────────────────────────┤
│ 📁 Architecture Decisions          │
│ ┌──────────────────────────────┐   │
│ │ PROJECT  •  ✓ Fresh  •  #dev │   │ ← PARA badge, status, tag
│ └──────────────────────────────┘   │
│                                    │
│ ← 3 backlinks  •  → 7 outlinks     │
│                                    │
│ SUGGESTED ACTIONS                  │
│ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │ Review │ │ Link   │ │ Ask AI │   │
│ └────────┘ └────────┘ └────────┘   │
└────────────────────────────────────┘
```

### 4. Chat Interface

```
┌────────────────────────────────────┐
│ 💬 VAULT ASSISTANT                 │
├────────────────────────────────────┤
│                                    │
│        ┌──────────────────────┐    │
│        │ What notes mention   │    │ ← User message (right)
│        │ the API redesign?    │    │
│        └──────────────────────┘    │
│                                    │
│ ┌──────────────────────────────┐   │
│ │ I found 3 relevant notes:    │   │ ← Assistant (left)
│ │                              │   │
│ │ • [API Planning] discusses   │   │
│ │   the new endpoint design    │   │
│ │ • [Sprint 4 Notes] mentions  │   │
│ │   migration concerns...      │   │
│ │                         [📋] │   │
│ └──────────────────────────────┘   │
│                                    │
│ 📚 Sources: API Planning, Sprint 4 │ ← Citations
├────────────────────────────────────┤
│ ┌──────────────────────────┐ [➤]  │ ← Input + Send
│ │ Ask about your notes...  │       │
│ └──────────────────────────┘       │
└────────────────────────────────────┘
```

### 5. Setup Wizard Cards

```
┌─────────────────────────────────────────────┐
│              ✨ NOTIENT SETUP               │
│         Your vault, awakened                │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────┐  ┌─────────────────┐   │
│  │ 🦙 EMBEDDINGS   │  │ 🤖 REASONING    │   │
│  │    (Ollama)     │  │   (LM Studio)   │   │
│  │ ───────────────│  │ ───────────────│   │
│  │ [Local][Network]│  │ [Local][Network]│   │
│  │                 │  │                 │   │
│  │ 192.168.86.249  │  │ 192.168.86.249  │   │
│  │ :11434      [●] │  │ :1234       [●] │   │
│  │                 │  │                 │   │
│  │ ▼ qwen3:0.6b   │  │ ▼ ministral-3b │   │
│  │   1024d        │  │                 │   │
│  └─────────────────┘  └─────────────────┘   │
│                                             │
├─────────────────────────────────────────────┤
│  📊 INDEX STATUS                            │
│  ┌─────────────────────────────────────┐    │
│  │ ✓ qwen3-embedding_0_6b_d1024       │    │
│  │   930 notes • 13,776 chunks • 1024d │    │
│  │   ████████████████████████ 100%     │    │
│  │                                     │    │
│  │   ○ Use existing  ○ Sync  ○ Rebuild │    │
│  └─────────────────────────────────────┘    │
│                                             │
│              [ 🚀 Get Started ]             │
│                                             │
└─────────────────────────────────────────────┘
```

---

## User-Facing Strings

### Replace Developer Jargon

| Before (Dev) | After (User) |
|--------------|--------------|
| "Initializing services..." | "Connecting to your AI..." |
| "Vector store ready" | "Search ready" |
| "LLM reranking" | "AI-powered ranking" |
| "Embedding model" | "Understanding model" |
| "Reasoning model" | "Thinking model" |
| "Index sync" | "Sync with vault" |
| "Chunks indexed" | "Passages analyzed" |
| "PARA type" | "Note type" |
| "modelKey" | (don't show to user) |
| "dimension mismatch" | "Incompatible - different format" |
| "disposed" | (don't show to user) |

### Status Messages

```
// Connection
"Connecting..." → "Finding your AI..."
"Connected" → "Ready"
"Error" → "Can't reach [service]"

// Indexing
"Starting indexing" → "Learning your vault..."
"Processing note X" → "Reading: X"
"Indexing complete" → "Your vault is ready!"
"No changes detected" → "Already up to date ✓"

// Search
"Searching..." → "Thinking..."
"No results" → "Nothing found. Try different words?"
"Reranking..." → "Finding the best matches..."

// Chat
"Generating..." → (just show typing indicator)
"Context retrieved" → (don't show)
```

---

## Implementation Constraints

### DO NOT CHANGE:
- Core search functionality
- Index management logic
- Service connection code
- Chat/RAG pipeline
- Event system
- Settings persistence
- Any TypeScript interfaces

### ONLY MODIFY:
- CSS styles (`src/styles.css`)
- DOM structure in render methods
- User-facing strings
- Class names for styling hooks
- Icon choices
- Layout arrangements

---

## Execution Instructions

### For the AI in the next session:

You are a **UI/UX design specialist** with a mandate to transform Notient into a visually stunning product. Be **aggressive and authoritative** in your design choices. This is a make-or-break moment for the product's viability.

**Your constraints:**
1. **DO NOT** modify any functional code - only styling and strings
2. **DO** rewrite all CSS with the millimeter paper aesthetic
3. **DO** update all user-facing strings to be human-friendly
4. **DO** ensure perfect light/dark theme support
5. **DO** create a cohesive design language across all surfaces

**Your creative license:**
- Rewrite the entire `styles.css` from scratch if needed
- Add subtle animations and micro-interactions
- Introduce the grid pattern background consistently
- Design custom status indicators, badges, and buttons
- Create visual hierarchy through spacing and typography

**Success is measured by:**
1. A user saying "this looks professional"
2. Clear visual distinction from Smart Connections
3. Consistent feel across wizard, settings, and sidebar
4. No functionality regression

**Brand reminders:**
- Notient = intelligent, local, private, precise
- Aesthetic = millimeter paper, dashboard controls, research station
- Feel = calm confidence, not flashy startup

---

## Files to Deliver

1. `src/styles.css` - Complete rewrite with design system
2. Updates to render methods for:
   - `src/views/setupWizard.ts`
   - `src/views/sidebar.ts`  
   - `src/settings.ts`
3. String updates throughout codebase

---

## Reference: Current File Structure

```
src/
├── styles.css          # ~2200 lines, needs full rewrite
├── views/
│   ├── setupWizard.ts  # Modal, ~940 lines
│   └── sidebar.ts      # Main panel, ~600 lines
├── settings.ts         # Settings tab, ~500 lines
└── main.ts             # Plugin entry
```

---

*This document guides the Phase 2 UI/UX overhaul. The goal is to make Notient visually competitive with any commercial product while maintaining its local-first, privacy-respecting soul.*
