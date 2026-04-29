# Phase 3 — Vault Enrichment Handoff

Date: 2026-04-29. Branch: `beta-spec`. Plan: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md`. Spec: `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`.

## What shipped

- Priority queue at `src/core/indexer/priorityQueue.ts`. Generic min-heap keyed by `(priority, enqueuedAt)`. FIFO tiebreak via a monotonic counter, not `Date.now()`. `IndexerQueue` drains lowest-priority first; legacy single-arg `enqueue(path)` callers default to priority 2.
- Hardcoded concurrency defaults at `src/core/indexer/concurrencyDefaults.ts`. `CONCURRENCY.embed = 4`, `CONCURRENCY.extract = 2`, `CHUNK.targetTokens = 400`, `CHUNK.maxTokens = 800`. Phase 4 replaces these with `<vault>/.notient/config.toml`.
- AST-aware chunker at `src/core/indexer/chunker.ts`. `chunkBlocks(blocks)` produces `ChunkSpec[]` anchored to heading sections. Sentence-bounded splits at `CHUNK.targetTokens`; whitespace hard-splits for sentences past `CHUNK.maxTokens`. Legacy `chunkNote` is no longer wired.
- `Embedder.embedAll` fans out per-text embeds at `CONCURRENCY.embed`. Output index-aligned; any rejection propagates and aborts the remaining workers.
- Tier 2/3 DAL in `src/core/db/surreal.ts`: `replaceChunks`, `markTier2Done`, `markTier3Done`, `linkerNeighbors`, `upsertConcept` (norm_label match), `upsertClaim` and `upsertQuestion` (sha match), `relateEdge` extended with `approved`, `lookupNoteByPath`, and `fetchChunksForTier3`. `linkerNeighbors` runs one multi-statement SurrealQL with the `<|K,EF|>` operator; it filters out the active note, requires `note.tier3_at != NONE`, and excludes notes already wikilinked from the active note in either direction.
- Tier 2 orchestrator at `src/core/indexer/tier2.ts`. `runTier2(db, { notePath, blocks, embedder })` resolves the note (throws if Tier 1 has not run), chunks the blocks, calls `embedAll`, then writes a single `BEGIN; DELETE chunk WHERE note; CREATE×N chunk; UPDATE tier2_at; COMMIT` script. `embedded_at` lands as `time::now()` server-side. Empty-blocks short-circuits the embedder. `EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe"`.
- Tier 3 orchestrator at `src/core/indexer/tier3.ts`. `runTier3(db, { notePath, chunks, extractor, linker })` runs extractor + linker concurrently via `Promise.all` (Tier 3 concurrency = 2 falls out of the two-call fan-out), then writes the extractor output and stamps `tier3_at`.
- Linker rewritten at `src/core/agents/linker.ts`. SurrealDB-native. Pulls active chunk vectors via `SELECT ord, text, vector FROM chunk WHERE note = $note AND vector != NONE`, calls `linkerNeighbors(... k=20, ef=40)`, prompts the LLM with the existing schema extended to all six edge types, validates each proposal against `ALLOWED_EDGE_TYPES`, resolves the target via `lookupNoteByPath`, and writes the edge with `source = "linker"`, `class = "INFERRED"`, `approved = false`.
- Extractor extended at `src/core/indexer/extractor.ts`. `Extractor.extract` and its prompt unchanged. `writeExtractionToSurreal(db, noteId, extraction)` upserts concept/claim/question rows and relates `mentions`/`asserts`/`asks` edges with `source = "extractor"`, `class = "INFERRED"`, `confidence = 0.7`, `approved = true`.
- `indexNote.ts` rewritten to call `runTier1` → `runTier2` → `runTier3` sequentially. Each tier's failure emits `indexer:error { phase }` and short-circuits the remaining tiers. New events `indexer:tier2-done { path, chunkCount }` and `indexer:tier3-done { path }` join the existing `indexer:tier1-done`.
- `hnswlib-wasm` removed entirely. `src/core/indexer/hnswVectorIndex.ts` and `src/core/indexer/hnswEnvShim.ts` deleted; `vectorIndex.test.ts` retained only the `InMemoryVectorIndex` coverage. The `vectorIndex` kernel slot stays so search consumers still compile, but bootstrap registers an inline no-op `EmptyVectorIndex` stub. `package.json` no longer lists `hnswlib-wasm`. `grep -rn "hnsw" src/` returns nothing.
- Phase 3 smoke harness at `src/daemon/__smoke__/tier23.smoke.test.ts`. Boots SurrealDB, applies the schema, seeds three notes through Tier 1 / Tier 2 / Tier 3 with mocked LLM and embedder, asserts the chunk rows, the kNN query, the extractor edges (`approved = true`), the linker edge (`approved = false`), and both wikilink-filter directions (forward and reverse).

Test posture: 945 pass / 0 fail / 58 skip across 132 files under `bun test`. `bun run test:smoke` runs all three smoke files (15 pass / 0 fail).

## Known short-term gaps (Phase 4 owns these)

- **Search consumers still read SQLite (per locked decision 7).** `searchPipeline.ts`, `strategies/balanced.ts`, and `strategies/deep.ts` query the SQLite `embeddings` and `chunks` tables, which `indexNote` no longer writes to. Search returns BM25-only results during Phase 3 because `vectorIndex` is the no-op stub; the SQLite tables freeze at their Phase-2 state until Phase 4 migrates the readers to SurrealDB.
- **`ContradictionHunter` produces zero contradictions** for the same reason. The bootstrap callback now returns `[]`; the agent runs but proposes nothing.
- **`Synthesizer` is unaffected.** It clusters embeddings via SQL directly and never touches `vectorIndex`.
- **Body-rooted wikilinks bypass the linker filter.** Tier 1 emits `block -> wikilink -> note` for in-body wikilinks. `linkerNeighbors` only excludes via `note -> wikilink -> note` and `note <- wikilink <- note` traversals from the active note, so candidates connected only by a body wikilink slip through. Phase 4 should either widen the exclusion subquery to traverse via blocks of `$active`, or fold body-rooted wikilinks into a note-level shadow edge during Tier 1.
- **Tier 3 is not atomic.** `runTier3` runs extractor + linker via `Promise.all`, then writes extraction and stamps `tier3_at`. A linker-then-extractor-failure leaves linker proposals in place without a `tier3_at` stamp; a retry will duplicate the linker edges. Phase 4's atomic Tier 3 closes this.
- **`upsertConcept` race.** Check-then-create is not atomic at the SurrealDB level. Single-worker per-note serialization prevents collisions today; Phase 4 cross-note parallelism will need `UPSERT WHERE` semantics or per-norm-label ordering.
- **Orphan vector files.** `<vault>/.notient/vectors.bin` is no longer written or read. Existing files are harmless and can be deleted.

## Footguns inherited (carry forward)

- HNSW is in-memory and rebuilt on startup; cap is `SURREAL_HNSW_CACHE_SIZE` (default 256 MiB). Bump for vaults beyond ~50k chunks.
- `<|k,ef|>` operator form is required for kNN against a cosine HNSW index; bare `<|k|>` errors.
- DAL writes that touch `option<...>` fields must omit them when undefined; never pass `null`. `replaceChunks`, `relateEdge`, and the new helpers follow this.
- SurrealDB 3.0.5 SCHEMAFULL hard-rejects unknown fields. Only schema-declared keys may be written.

## Phase 4 entry point

Phase 4 migrates the search and agent consumers off SQLite, lights up the `daemon_write` provenance table and the AST-aware writer, deletes the `EchoGuard` shim and the SQLite-backed `relatedSection.ts` / `frontmatterWriter.ts` / `nativeGraphBridge.ts`, and ships the awaken control plane (`awaken --pause/--resume/--cancel/--status`, the `awaken_run` lifecycle, `--background`). The `vectorIndex` kernel slot can be removed in this phase once search no longer consumes it.
