# Phase Galaxy Debug: Wire the Skeleton

**Status**: PLANNING
**Created**: 2026-01-16 (Session 13)
**Prerequisite**: Phase Galaxy G1-G6 complete (skeleton built)
**Goal**: Connect all the pieces so the plugin actually WORKS

---

## Problem Statement

Phase Galaxy built a **skeleton** — files exist, types defined, UI renders. But nothing is connected:

| Component | Current State | Expected State |
|-----------|---------------|----------------|
| VitalsTab | Shows "--" always | Shows active note vitals |
| Enhance button | Disabled, never enables | Enabled when note open |
| Status footer | "Offline", "0 notes" | Connected, actual count |
| Settings tab | Not appearing in Obsidian | Appears in plugin settings |
| Active note detection | None | Workspace event listener |
| LLM provider | Stub returns empty | Calls LM Studio/Ollama |
| Pipeline | Exists but never runs | Triggered by Enhance button |
| ObsidianFacade | Empty file (TODO) | Full Obsidian API wrapper |

---

## Debug Waves

### Wave D1: Obsidian Integration (Foundation)

**Goal**: Connect sidebar to Obsidian workspace events

| Task | File | Description |
|------|------|-------------|
| D1.1 | `src/adapters/obsidian.ts` | Implement ObsidianFacade (getActiveFile, readNote, writeNote, subscribe to workspace) |
| D1.2 | `src/core/kernel.ts` | Register ObsidianFacade in kernel |
| D1.3 | `src/ui/sidebar/SidebarView.tsx` | Wire workspace.on('active-leaf-change') to update active note |
| D1.4 | `src/ui/sidebar/App.tsx` | Add signal for active file, pass to VitalsTab |
| D1.5 | `src/ui/sidebar/components/VitalsTab.tsx` | Accept activeFile prop, calculate and display vitals |

**Success**: VitalsTab shows real data for current note, updates on note switch.

---

### Wave D2: Header & Navigation Redesign

**Goal**: Merge tabs into header per CEO feedback

| Task | File | Description |
|------|------|-------------|
| D2.1 | `src/ui/sidebar/App.tsx` | Redesign header: Brand + inline tab toggles |
| D2.2 | `src/ui/sidebar/components/NavDeck.tsx` | Convert to inline toggle buttons (not separate row) |
| D2.3 | `src/styles.css` | Update header styling: brand color, tab toggle states |

**Target Layout**:
```
┌─────────────────────────────────────────┐
│ NOTIENT   [Vitals] [Suggestions] [Activity] │
├─────────────────────────────────────────┤
│ Tab content...                          │
└─────────────────────────────────────────┘
```

**Success**: Header has brand + toggleable tabs in one row.

---

### Wave D3: Enhance Button & Pipeline Wiring

**Goal**: Make Enhance button functional

| Task | File | Description |
|------|------|-------------|
| D3.1 | `src/ui/sidebar/components/VitalsTab.tsx` | Enable button when note open, wire onClick to trigger enhance |
| D3.2 | `src/core/pipeline/enhancePipeline.ts` | Remove stubs, wire to actual agents |
| D3.3 | `src/ui/sidebar/App.tsx` | Subscribe to enhance:* events, update UI state |
| D3.4 | `src/ui/sidebar/components/SuggestionsTab.tsx` | Display suggestions from pipeline output |
| D3.5 | `src/ui/sidebar/components/ActivityTab.tsx` | Show pipeline progress, recent actions |

**Success**: Click Enhance → Pipeline runs → Suggestions appear in Suggestions tab.

---

### Wave D4: LLM Provider Connection

**Goal**: Connect to actual LM Studio and Ollama

| Task | File | Description |
|------|------|-------------|
| D4.1 | `src/core/llm/provider.ts` | Create LLMProvider interface |
| D4.2 | `src/core/llm/lmstudio.ts` | LM Studio implementation (OpenAI-compatible) |
| D4.3 | `src/core/llm/ollama.ts` | Ollama implementation |
| D4.4 | `src/core/kernel.ts` | Register LLMProvider based on settings |
| D4.5 | `src/core/agents/analyst.ts` | Replace stub with actual LLM call |
| D4.6 | Health check | Ping LLM on startup, update status footer |

**Config to use**:
- LM Studio: `http://localhost:1234/v1` (OpenAI-compatible)
- Ollama: `http://localhost:11434` (native API)

**Success**: Analyst agent returns real suggestions from LLM.

---

### Wave D5: Status Footer & Settings

**Goal**: Fix footer and settings tab

| Task | File | Description |
|------|------|-------------|
| D5.1 | `src/ui/sidebar/components/StatusFooter.tsx` | Wire to EventBus (index:complete updates note count) |
| D5.2 | `src/ui/sidebar/components/StatusFooter.tsx` | Make clickable → open health modal or settings |
| D5.3 | `src/main.ts` | Debug settings tab registration (addSettingTab) |
| D5.4 | LLM health check | Periodic ping, update "Offline"/"Ready" status |

**Success**: Footer shows actual note count, connection status, clicks open settings.

---

### Wave D6: Index Integration

**Goal**: Connect indexer to UI

| Task | File | Description |
|------|------|-------------|
| D6.1 | `src/core/indexer/` | Ensure indexer runs on startup after wizard |
| D6.2 | EventBus | Emit index:progress during indexing |
| D6.3 | Status footer | Show indexing progress if running |
| D6.4 | Database | Verify notes table populated |

**Success**: Console "895 files indexed" matches UI "895 notes".

---

## Agent Dispatch Strategy

### Parallel Wave D1 (3 agents)

```
implementer: D1.1 + D1.2 (ObsidianFacade + kernel registration)
implementer-gemini: D1.3 + D1.4 (SidebarView + App signals)
simplifier: D1.5 (VitalsTab reactive update)
```

### Parallel Wave D2 (2 agents)

```
implementer: D2.1 + D2.2 (Header + NavDeck redesign)
simplifier: D2.3 (CSS styling)
```

### Parallel Wave D3 (3 agents)

```
implementer: D3.1 + D3.2 (Button wiring + pipeline integration)
implementer-gemini: D3.3 + D3.4 (Event subscriptions + Suggestions display)
simplifier: D3.5 (Activity tab polish)
```

### Parallel Wave D4 (2 agents)

```
implementer: D4.1 + D4.2 + D4.3 (LLM provider implementations)
validator: D4.5 + D4.6 (Integration testing with actual LLM)
```

### Parallel Wave D5 + D6 (2 agents)

```
implementer: D5.1-D5.4 (Status footer + settings fixes)
simplifier: D6.1-D6.4 (Index integration cleanup)
```

---

## Success Criteria (from Phase Galaxy)

After Debug phase, these MUST work:

- [ ] Plugin loads < 1 second
- [ ] **VitalsTab shows actual note health when note is open**
- [ ] **VitalsTab updates when switching notes**
- [ ] **Enhance button enabled when note open**
- [ ] **Enhance button triggers full pipeline**
- [ ] **Suggestions appear as checklist in Suggestions tab**
- [ ] Apply modifies note correctly
- [ ] Undo reverses changes
- [ ] Cancel aborts pipeline cleanly
- [ ] **Status footer shows actual note count**
- [ ] **Status footer shows Online/Offline correctly**
- [ ] **Settings tab appears in Obsidian settings**
- [ ] Offline mode degrades gracefully
- [ ] Index builds in background

---

## Files Changed Per Wave

### D1 (Obsidian Integration)
- `src/adapters/obsidian.ts` — NEW implementation
- `src/core/kernel.ts` — add ObsidianFacade
- `src/ui/sidebar/SidebarView.tsx` — workspace events
- `src/ui/sidebar/App.tsx` — activeFile signal
- `src/ui/sidebar/components/VitalsTab.tsx` — reactive props

### D2 (Header Redesign)
- `src/ui/sidebar/App.tsx` — header layout
- `src/ui/sidebar/components/NavDeck.tsx` — inline toggles
- `src/styles.css` — header CSS

### D3 (Pipeline Wiring)
- `src/ui/sidebar/components/VitalsTab.tsx` — button onClick
- `src/core/pipeline/enhancePipeline.ts` — agent integration
- `src/ui/sidebar/App.tsx` — event subscriptions
- `src/ui/sidebar/components/SuggestionsTab.tsx` — display logic
- `src/ui/sidebar/components/ActivityTab.tsx` — activity feed

### D4 (LLM Provider)
- `src/core/llm/provider.ts` — NEW
- `src/core/llm/lmstudio.ts` — NEW
- `src/core/llm/ollama.ts` — NEW
- `src/core/kernel.ts` — register provider
- `src/core/agents/analyst.ts` — use provider

### D5 (Status & Settings)
- `src/ui/sidebar/components/StatusFooter.tsx` — event wiring
- `src/main.ts` — settings debug
- `src/core/llm/healthCheck.ts` — NEW

### D6 (Index Integration)
- `src/core/indexer/` — startup integration
- Event emissions

---

## Order of Execution

```
D1 (Foundation) ─────────────────────────────────────────────┐
                                                             │
                          D2 (Header) ─────────────┐         │
                                                   │         │
                                    D3 (Pipeline) ─┼─────────┼──┐
                                                   │         │  │
                                         D4 (LLM) ─┼─────────┘  │
                                                   │            │
                                    D5 + D6 ───────┴────────────┘
```

D1 must complete first. D2-D4 can run in parallel. D5-D6 after D4.

---

## Verification

After each wave:
1. `bun run typecheck && bun run build && bun run lint`
2. Copy to test vault
3. Visual inspection in Obsidian
4. Console check for errors

---

*Phase Galaxy Debug: Make the skeleton come alive.*
