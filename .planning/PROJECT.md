# Notient Beta

## What This Is

Notient is a Sentient Notes Platform delivered as an Obsidian plugin. Notes are living entities with maturity, vitality, and agency — powered by local LLMs. No cloud, no data leaving your machine.

**Core identity**: Research Chief of Staff — notes evolve through enhancement cycles.

## Current Phase: Galaxy (Fresh Implementation)

> **TOTAL ANNIHILATION APPROACH**
> All existing code deleted. Fresh build from PHASE-GALAXY.md spec.
> Version 0.1.0 (reset, not continuation).

### What We're Building

| Component | Specification |
|-----------|---------------|
| **Workflow** | ONE: Enhance (human-driven, suggestions-only) |
| **Agents** | FOUR: Planner → ContextBuilder → Analyst → Writer |
| **UI** | THREE tabs: Vitals \| Suggestions \| Activity |
| **Output** | Metadata + Structure (NO text rewriting) |
| **Suspended** | Chat, proactive enhancements, trust levels |

### Implementation Phases

| Phase | Scope | Status |
|-------|-------|--------|
| G1 | Foundation (SQLite, EventBus, Kernel) | ⏳ Next |
| G2 | Agents (Planner, ContextBuilder, Analyst, Writer) | ⏳ |
| G3 | Pipeline (orchestration, error handling) | ⏳ |
| G4 | UI (tabbed sidebar) | ⏳ |
| G5 | Indexing (chunker, embeddings, HNSW) | ⏳ |
| G6 | Settings (panel, wizard, dev mode) | ⏳ |

**Full spec**: `.planning/PHASE-GALAXY.md` (605 lines, 72 decisions)

---

## Core Philosophy

### Notes Are Living Entities

- **Maturity**: Raw capture → Adolescent → Mature → Synthesis-ready
- **Vitality**: Health score, connectivity, structure, freshness
- **I-PARA**: Inbox → Projects/Areas/Resources/Archives
- **Origin**: User-written, web-clipped, AI-generated

### Human-Driven Pipeline (MVP)

1. User clicks Enhance
2. Pipeline runs (seconds to minutes)
3. Suggestions returned as checklist
4. User selects which to apply
5. Changes made, undo available

**NO automatic application. NO trust levels yet.**

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict) |
| Runtime | Bun |
| Build | esbuild |
| Lint | Biome |
| UI | Preact + @preact/signals |
| Reasoning LLM | LM Studio (OpenAI-compatible) |
| Embedding LLM | Ollama |
| Vector Store | HNSW (WASM) |
| Database | SQLite (sql.js) |

---

## Commands

```bash
bun run dev              # Build + copy to test vault
bun run build            # Production build
bun run typecheck        # TypeScript check
bun run lint             # Biome lint
bun run test             # Run test suite
```

**Test Vault**: `/mnt/c/Users/akougk/Projects/vaultex`

---

## Key Decisions (Phase Galaxy)

| Decision | Choice |
|----------|--------|
| Approach | Fresh implementation, no preservation |
| Version | 0.1.0 |
| Agent names | Planner, ContextBuilder, Analyst, Writer |
| Communication | Direct calls (pipeline), events (UI) |
| Error handling | Abort entire pipeline |
| Cancel | Hard abort, no pause |
| Undo | SQLite (last 50 actions) |
| Context layers | 0-8, start minimal, add via testing |
| LLM prompts | Lean, no persona, zero-shot |
| Testing | Claude as judge + user feedback |

---

## Reference Documentation

| File | Purpose |
|------|---------|
| `.planning/PHASE-GALAXY.md` | **MASTER SPEC** — all implementation details |
| `.planning/STATE.md` | Current progress |

---

## Constraints

- **Local-only**: All LLM via Ollama/LM Studio
- **No preservation**: Old code deleted, use git history if needed
- **Obsidian-native**: Use metadataCache, processFrontMatter
- **Test vault**: `/mnt/c/Users/akougk/Projects/vaultex`

---

*Last updated: 2026-01-15 Session 9 — Phase Galaxy spec complete*
