# Notient Project State

**Version:** 0.2.0
**Current phase:** Phase 2 (Graph) — COMPLETE
**Date completed:** 2026-04-25
**Next phase:** Phase 3 (Swarm)
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes, PARA structure)

## What works (verified by tests + Awaken run)

- Everything from Phase 1, plus:
- Frontmatter writer is merge-only — preserves arbitrary user YAML
- `Database.transaction(fn)` with rollback
- EchoGuard (path@sha) — wired into vault.modify, ready for Phase 3 producers
- HealthMonitor probes carry an AbortSignal (timeout = intervalMs/2)
- `LLMProvider.chatJson<T>()` interface + LMStudio impl using `response_format: json_schema`
- Senses pipeline:
  - `chunkNote` (paragraph-merge with stable IDs)
  - `Embedder` (batched, single retry)
  - `VectorIndex` interface + `InMemoryVectorIndex` (tests) + `HnswVectorIndex` (runtime, persisted to `.obsidian/plugins/notient/vectors.bin`)
  - `Extractor` (chatJson via fast model, dedupes case-insensitively)
  - `indexNote` orchestrator (single DB transaction, idempotent on unchanged SHA)
  - `IndexerQueue` (debounced 500 ms, serial drain, error-isolated)
- Awaken Vault modal — first-run auto-trigger + command palette entry; canvas renders growing graph in real time
- Per-save indexing wired into `vault.on("modify")`

## DoD (spec §13 row 2)

- [ ] Awaken Vault completes 894 notes in <10 min on dynamo+mini
- [ ] Graph populated and queryable: notes/chunks/embeddings/graph_nodes/graph_edges all carry rows
- [ ] Modal renders animated growth (verified by hand)

(Tick during the Phase 2 close-out smoke run.)

## Tech debt to address opportunistically

- Web Worker offload for embedder + extractor (currently main thread with `setTimeout(0)` yields). Phase 2.5 / optimization session.
- Schema version bump path for future migrations (right now it's still v1; Phase 3 will need v2 for staging tables).
- HNSW persistence currently writes the full index to disk after every note. Add debounced persist (e.g., flush every 30s of inactivity).
- Cleanup biome.json overrides — they reference legacy paths that no longer exist.

## What does not exist yet

- Coordinator + 4 agents: Linker / Synthesizer / Contradiction Hunter / Maturity Advancer (Phase 3)
- Continuous Co-author panel (Phase 3)
- Stream feed + editor decorations + Vitals panel + Graph view overlay (Phase 4)
- Chat MVP (Phase 4)
- Multi-strategy search (Quick + Balanced) (Phase 4)
- Trust gate UI / approvals UI / universal undo (Phase 4)
- Hardening + telemetry + docs site + notient.com landing (Phase 5)

## Files of note (Phase 2 additions)

- Tech-debt: `src/core/graph/frontmatterWriter.ts`, `src/core/db/database.ts`, `src/core/services/echoGuard.ts`, `src/core/services/healthMonitor.ts`, `src/core/llm/{provider,lmStudioProvider}.ts`
- Indexer: `src/core/indexer/*` (10 new files)
- Onboarding: `src/ui/onboarding/{AwakenVaultModal,awakenRunner,graphCanvas}.ts`
- Wiring: `src/main.ts`, `src/core/kernel.ts`, `src/core/settings/types.ts`, `src/core/events/types.ts`

## How to resume in next session (Phase 3 — Swarm)

1. Read this file + spec §13 row 3 (Phase 3 Swarm)
2. Phase 3 deliverables (per spec §6 + §13 row 3):
   - 4 agents: Linker, Synthesizer, Contradiction Hunter, Maturity Advancer
   - Coordinator (50-line scheduler)
   - Continuous Co-author panel (the (c) experience)
   - Provenance/confidence + staging tables + accept/reject flow
3. Producer-side `EchoGuard.mark()` lands here when agents start writing back to frontmatter
4. Schema v2 migration: add `staging_edges` table + `agent_runs` log
5. Same workflow: `superpowers:writing-plans` → `superpowers:subagent-driven-development` (Opus 4.7 implementers only)
