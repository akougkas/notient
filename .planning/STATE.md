# Notient v1.0 Project State

**Current phase:** Phase 1 (Foundation) — COMPLETE (code-side)
**Tag:** `v1.0.0-foundation` (on branch `implementer/p1-foundation`, awaiting orchestrator merge to `beta-spec`)
**Date completed:** 2026-04-25
**Next phase:** Phase 2 (Graph)

## What works (verified by unit tests)
- Plugin scaffold + manifest 1.0.0-foundation + build pipeline
- Typed event bus with handler-error isolation
- Settings service + Obsidian SettingsTab (defaults point at dynamo + mini)
- Atomic writes (Windows EPERM/EBUSY retry)
- Vault lock (single-instance, stale-takeover, heartbeat)
- SQLite database + v1 schema (notes, chunks, embeddings, graph_nodes, graph_edges, history)
- Graph store CRUD with typed nodes/edges
- Frontmatter writer with Notient-block round-trip
- ObsidianFacade wrapping vault.adapter
- LMStudioProvider (OpenAI-compatible: chat / chatStream SSE / embed / isAvailable)
- Health monitor (periodic probe, emits llm:health events)
- Kernel + DI with fail-loud seal
- Sidebar shell + status footer
- on-save SHA → notes table

## Open verification (user must do in test vault)
- Plugin loads cleanly in Obsidian on `/mnt/c/Users/akougk/Projects/vaultex/`
- Settings panel saves endpoint changes; persists across reload
- Health dots show green when dynamo + mini reachable
- Editing a note → row appears in `notient.db` `notes` table with SHA + word count

## Open infrastructure work (caught by user smoke test)
- `sql-wasm.wasm` deployment to plugin dir on clean install (currently inherited from old build)
- Scripted in Phase 2 alongside the indexer

## What does not exist yet
- Chunker, embedder, extractor (Phase 2)
- Vector index (Phase 2)
- Awaken Vault onboarding modal (Phase 2)
- Agents Linker / Synthesizer / Contradiction Hunter / Maturity Advancer (Phase 3)
- Continuous Co-author panel (Phase 3)
- Stream UI, decorations, Vitals panel, Graph view (Phase 4)
- Chat MVP (Phase 4)
- Multi-strategy search MVP (Phase 4)
- Hardening + landing site (Phase 5)

## Files of note
- Spec: `docs/superpowers/specs/2026-04-25-notient-v1-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-04-25-phase-1-foundation.md`
- Phase 1 source: all of `src/`

## How to resume in next session
1. Read `.planning/STATE.md` (this file)
2. Read `docs/superpowers/specs/2026-04-25-notient-v1-design.md` §13 for Phase 2 (Graph) scope
3. Invoke `superpowers:writing-plans` to draft the Phase 2 plan
4. Phase 2 deliverables: senses pipeline (chunker, embedder, extractor, vector index, debounced save pipeline <100 ms) + Awaken Vault modal with live graph
