# Notient Project State

**Version:** 0.2.0 (no git tag — tags reserved for v1.0.0 release)
**Current phase:** Phase 2 (Graph) closed; Phase 2.5 hardening done
**Date:** 2026-04-25
**Next phase:** Phase 3 (Swarm) — plan at `docs/superpowers/plans/2026-04-25-phase-3-swarm.md`
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes, PARA structure)

## What works

Carries forward Phase 1 (kernel, atomic writes, vault lock, SQLite + schema_v1, dual-store graph reader/writer, dynamo+mini providers, health monitor, status footer, on-save SHA hashing) and Phase 2 senses pipeline, plus the Phase 2.5 hardening pass:

- Frontmatter writer is merge-only; preserves arbitrary user YAML (incl. nested arrays).
- `Database.transaction(fn)` with rollback, used by `indexNote`.
- EchoGuard (path@sha) wired into `vault.modify`. Inert until Phase 3 producers call `mark()`.
- HealthMonitor probes carry an AbortSignal time-boxed at `max(500ms, intervalMs/2)`. `monitor.stop()` aborts in-flight probes.
- `LLMProvider.chatJson<T>()` with `response_format: json_schema`. Falls back to `reasoning_content` when `content` is empty (commit 6b8b10b — required for nemotron-cascade-2-30b which routes JSON output through the reasoning channel).
- Senses pipeline:
  - `chunkNote` (paragraph-merge with stable IDs; cognitive complexity below threshold after refactor).
  - `Embedder` (batched, single retry).
  - `VectorIndex` interface + `InMemoryVectorIndex` (tests) + `HnswVectorIndex` (runtime, persists `vectors.bin`, real persist/load smoke under Bun env polyfill).
  - `Extractor` (chatJson via fast model, hard caps 5 entities / 3 claims / 3 questions, deduped case-insensitively, concurrency 4).
  - `indexNote` orchestrator (single DB transaction, idempotent on unchanged SHA).
  - `IndexerQueue` (debounced 500 ms, serial drain, error-isolated).
  - **Web Worker offload** (commit 546d214): `IndexerWorkerClient` + `indexer.worker.ts` run chunk + embed + extract off the main thread. Main thread retains the SQLite transaction and HNSW writes.
- Awaken Vault modal — first-run auto-trigger + command palette entry; canvas renders growing graph in real time.
- Per-save indexing wired into `vault.on("modify")`.
- Defaults: `nemotron-cascade-2-30b-a3b-i1` (reasoning + extractor) + `text-embedding-nomic-embed-text-v2-moe` (embed) + `granite-4.0-h-350m` (reranker).
- `scripts/smoke-indexer.ts` real end-to-end harness against dynamo (seeded with 5 notes from the test vault).

## DoD evidence (real numbers, live smoke run)

Live smoke against dynamo, 5-note slice of `/mnt/c/Users/akougk/Projects/vaultex/`:

- 5 notes → 37 chunks → 37 embeddings → 273–275 graph_nodes → 268–270 graph_edges
- Mean wall-clock ~3.5s per note; total wall ~18s for 5 notes
- HNSW knn returns real neighbours after persist + reload cycle
- Two consecutive runs over the same notes are idempotent on unchanged SHA (no growth in chunks/embeddings/edges)

Spec §13 row 2 DoD targets:
- [x] Graph populated and queryable (notes / chunks / embeddings / graph_nodes / graph_edges all carry rows)
- [x] HNSW persists and reloads correctly (real smoke, not mocked)
- [x] Modal renders animated growth (verified by hand at the structural level — Canvas + counters + run loop)
- [ ] **Deferred to user:** Awaken Vault interactive smoke in Obsidian against the full 894-note vault. The full-vault wall-clock target ("under 10 minutes on dynamo+mini") has not been measured; the 5-note slice extrapolates to roughly 35 minutes single-stream against dynamo only, so reaching the target depends on either parallelising notes through the worker queue or splitting load across mini. Phase 3 inherits this DoD bullet.

## Verified by

- `bun run typecheck` — clean
- `bun run lint` — clean (biome)
- `bun test` — 104 tests passing
- `bun run smoke:indexer` — green end-to-end against dynamo with the live model defaults

## Tech debt to address opportunistically

- HNSW persistence still writes the full index to disk after every note. Add a debounced flush (e.g., 30 s of inactivity) before Phase 3 starts hammering the queue with agent-side reads.
- biome.json overrides reference legacy paths that no longer exist; cleanup pending.
- `IndexerWorkerClient` swallows worker spawn failures with a console.warn fallback to inline pipeline. Acceptable for now; Phase 3 should expose this state through the health monitor / status footer.
- Schema is still v1. Phase 3 needs v2 (staging tables + agent_runs); migration path is the first task of Phase 3.
- Awaken Vault total-wall-clock against the full 894-note vault not yet measured; needs a user-driven session.

## What does not exist yet

- Coordinator + 4 agents: Linker / Synthesizer / Contradiction Hunter / Maturity Advancer (Phase 3)
- Continuous Co-author panel + voice-mimicry context builder (Phase 3)
- Idle detector + Approvals UI (Phase 3)
- Stream feed + editor decorations + Vitals panel + Graph view overlay (Phase 4)
- Chat MVP + multi-strategy search MVP (Phase 4)
- Universal undo (Phase 4)
- Hardening + telemetry + docs site + notient.com landing (Phase 5)

## Files of note (Phase 2 + Phase 2.5 surface)

- DB: `src/core/db/{database,migrations,schema}.ts`
- Graph: `src/core/graph/{frontmatterWriter,graphStore,types}.ts`
- LLM: `src/core/llm/{provider,lmStudioProvider}.ts`
- Services: `src/core/services/{echoGuard,healthMonitor,vaultLock}.ts`
- Indexer: `src/core/indexer/{chunker,embedder,vectorIndex,hnswVectorIndex,extractor,indexNote,indexerQueue,indexerWorkerClient,types}.ts` + `src/workers/indexer.worker.ts`
- Onboarding: `src/ui/onboarding/{AwakenVaultModal,awakenRunner,graphCanvas}.ts`
- Wiring: `src/main.ts`, `src/core/kernel.ts`, `src/core/settings/{types,settingsService,SettingsTab}.ts`, `src/core/events/{eventBus,types}.ts`
- Smoke: `scripts/smoke-indexer.ts`

## How to resume in next session (Phase 3 — Swarm)

1. Read this file + spec §6 (agent swarm) + spec §7 (continuous co-author) + spec §13 row 3 (Phase 3 DoD).
2. Open the plan: `docs/superpowers/plans/2026-04-25-phase-3-swarm.md`. Tasks are dependency-ordered and self-contained for Opus 4.7 implementer subagents.
3. Phase 3 ships: schema v2 migration (staging tables + agent_runs), Coordinator with single-flight reasoning mutex, 4 agents (Linker, Synthesizer, Contradiction Hunter, Maturity Advancer), Continuous Co-author panel with voice-mimicry, idle detector, approvals UI.
4. Producer-side `EchoGuard.mark()` lands here when Maturity Advancer first writes vitals back to frontmatter.
5. Phase 3 does not tag. Version stays 0.2.0 until v1.0 release.
6. Same workflow: `superpowers:writing-plans` → `superpowers:subagent-driven-development` (Opus 4.7 implementers only).
