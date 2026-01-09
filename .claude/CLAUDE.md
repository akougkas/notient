# Notient - Project Context

> AI-powered vault management for Obsidian using local LLMs only.

## Quick Reference

```bash
# Development
bun run dev              # Dev build + copy to test vault
bun run dev:watch        # Watch mode with auto-copy
bun run dev:clean        # Wipe all plugin data + fresh build

# Production
bun run build            # Typecheck + production build (minified)
bun run analyze          # Bundle size analysis

# Quality
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code
```

**Test Vault:** `/mnt/c/Users/akougk/Projects/vaultex`

---

###  Deferred Features

Use `ROADMAP.md` for features that were designed or partially implemented but deferred for future work. Cool ideas from user can be placed in the `Ideas` section.

**ROADMAP.md Structure:**
- **High Priority**: Valuable but blocked by current work
- **Medium Priority**: Nice-to-have but not critical
- **Low Priority**: Need more research or unclear value
- **Ideas**: Interesting but require significant design work
- **Archive**: Implemented or superseded approaches

Each entry includes: Title, Description, Rationale, Why Deferred, Blockers, Effort Estimate, Priority, Related Links

---

### Data Files

Stored in `.obsidian/plugins/notient/`:

```
data.json                      # Plugin settings
idx_*_{modelKey}_Xd.json       # Vector index (new format)
state-{modelKey}.json          # Index state per model
intelligence-{modelKey}.json   # Note intelligence data
conversations.json             # Chat history
action-history.json            # Applied actions for undo
profile.json                   # User profile (identity system)
cache/                         # Search result cache
locks/                         # Multi-window safety
```

---

### Key Flows (Summary)

| Flow | Entry Point | Key Services |
|------|-------------|--------------|
| **Initialization** | `main.ts` onload | HealthMonitor → IndexManager → Services |
| **Note Vitals** | `active-leaf-change` | useNoteVitals → NoteIntelligenceService |
| **Search** | Omnibar input | OllamaService → VectorStore → SearchPipeline |
| **Indexing** | Command / wizard | SimpleIndexer → VectorStore → IntelligenceDb |
| **Chat** | Chat tab | AgentTaskQueue → LLMProvider → ConversationStore |
| **Actions** | Agent response | TrustLevelManager → ActionApplier → ActionHistory |

**State Machine:**
```
UNINITIALIZED → CHECKING_PROVIDERS → LOADING_INDEX → WARMING → READY
                        ↓                 ↓              ↓
                     FAILED           CRASHED        DEGRADED
```

> **Detailed flows:** See `planning/coding_tasks/CONTINUE.md` PART 9 for 40+ canonical scenarios.

---

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Bun
- **Build:** esbuild (see `scripts/build.ts`)
- **Lint:** Biome
- **UI Framework:** Preact + @preact/signals
- **LLM (Reasoning):** LM Studio (OpenAI-compatible)
- **LLM (Embeddings):** Ollama
- **Vector Store:** Custom brute-force cosine similarity (zero deps)

---

## Development Notes

### Sidebar Design Principles

1. **Locked Layout, Dynamic Content** - Structure never changes, only content
2. **No Layout Tricks** - No expanding/collapsing based on context
3. **Three Views** - Note Vitals | Agent Streams | Chat
4. **Sentient Note** - Note Vitals gives notes a living embodiment
5. **Footer Status Bar** - Always shows Providers | Index | Agents


### Core Principles

1. **Local-only** - No cloud APIs ever
2. **Human-in-steering-wheel** - Trust levels, universal undo
3. **Theme-aware** - Respects Obsidian themes
4. **Simplicity** - Clean abstractions, no debug cruft
5. **Sentient Note** - Notes have identity, vitals, and a living presence

---

## Build Health

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript | PASS | `bun run typecheck` |
| ESBuild | PASS | <1mb minified |
| Biome Lint | WARN | Complexity warnings (expected) |


---

## Version

- **Current:** 0.2.0 working towards 0.3.0
- **Min Obsidian:** 1.4.0
