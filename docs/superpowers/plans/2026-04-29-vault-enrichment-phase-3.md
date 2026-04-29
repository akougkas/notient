# Notient Vault Enrichment — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Tier 2 (chunk + embed) and Tier 3 (extractor + linker) writes from SQLite + `hnswlib-wasm` to SurrealDB native HNSW + edge RELATIONs. Refactor `IndexerQueue` from FIFO to priority-heap so the cheap Tier 1 work always drains first. Retire the external HNSW library entirely. After this phase, the indexer writes ONLY to SurrealDB; SQLite reads still serve search/agent/history consumers but no longer receive new indexer data.

**Architecture:** Three substantive shifts in this phase. (1) `IndexerQueue` becomes a min-heap keyed by `(priority, enqueuedAt)`; the worker pulls the highest priority first. (2) The chunker rewrites against AST-derived blocks from Phase 2 (one chunk corresponds to one heading section bounded by `chunk_target_tokens`); embeddings land in SurrealDB's `chunk.vector` HNSW field via the native operator `<|K,EF|>`. (3) The extractor and linker are retargeted at the new schema: extractor inserts `concept`/`claim`/`question` records and `mentions`/`asserts`/`asks` RELATIONs; linker uses recursive SurrealQL to find vector-similar notes, filters out targets that already have a `wikilink` edge from/to the active note, and inserts `supports`/`extends`/etc. RELATIONs with `approved = false`. Search and agent code that still reads SQLite is left untouched in this phase; Phase 4/5 migrate those consumers.

**Tech Stack:** SurrealDB native HNSW + RELATE traversals via `surrealdb` JS SDK (no `hnswlib-wasm`). Existing Ollama embedding client and LM Studio reasoning client unchanged at the network layer. Existing `chunker`, `embedder`, `extractor`, `linker` modules survive but their DALs are rewritten.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §3.2 chunk schema, §3.4 semantic edge tables, §5.1 priority queue, §5.3 Tier 2, §5.4 Tier 3.
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md` — Tier 1 must be green and Tier 1 edges in SurrealDB are required for the linker's "skip-already-wikilinked" filter.

**Locked decisions (Phase 3, 2026-04-29):**

1. **`IndexerQueue` becomes a min-heap.** Single worker, three priorities (`0` Tier 1 sync-fast, `1` Tier 2 background, `2` Tier 3 idle). Enqueue API gains a `priority` parameter, default `2` (so legacy callers do not block tier-1 work). The data structure is a binary heap implemented in-house; we do not pull a heap library because Bun's stdlib has none and the implementation is ~40 lines.
2. **Chunks are AST-aware.** A chunk corresponds to one heading section (a sequence of blocks under the same H1/H2/H3 ancestor) capped at `chunk_target_tokens`. Sections longer than the cap split into sentence-bounded sub-chunks. Each `chunk` row has a `block` reference to the heading block (the H3-or-shallower ancestor) for traceability.
3. **Embeddings go directly into `chunk.vector`.** No separate vector index, no separate insert path. The HNSW index is defined in `schema.surql` (Phase 1) and is automatically maintained by SurrealDB on insert.
4. **Tier 2 concurrency: parallel embed calls per note.** Default 4 (configurable in Phase 4 via `vault/.notient/config.toml`). Embed calls are issued in parallel for the chunks of one note; chunks across notes are serialised at the queue level (one note in flight at a time, per the single-worker design).
5. **Tier 3 concurrency: 2 parallel LM Studio calls per note.** Same model: parallel within a note for extractor + linker, serialised across notes.
6. **`hnswlib-wasm` is DELETED in this phase.** Files: `src/core/indexer/hnswVectorIndex.ts`, `src/core/indexer/hnswEnvShim.ts`, `src/core/indexer/vectorIndex.test.ts`, plus the `hnswlib-wasm` dep in `package.json`. The kernel slot for the HNSW index is removed in the same commit. No deprecation, no compat shim.
7. **Search consumers stay on SQLite for now.** `src/core/search/searchPipeline.ts` and `src/core/search/strategies/*.ts` still query the old SQLite `embeddings` table. They will be migrated in Phase 4 once the new chunks exist for the full vault. During Phase 3, search returns slightly stale results (anything indexed before Phase 3); the Phase 3 handoff documents this as a known short-term gap.
8. **Linker's neighbor query is one SurrealQL.** Replaces the previous "HNSW search → join SQLite chunks → join notes → manual graph filter" pipeline. The new query: top-K candidate chunks via `vector <|K,EF|>`, group by note, filter out the active note, filter out notes that already share a `wikilink` with the active note, return top candidates with their max distance. Recursive traversal (`note:x.{..3}->wikilink->note`) is used in Phase 5 for graph queries; Tier 3's neighbor lookup is one-hop only.
9. **Extractor + linker prompts are unchanged.** Their input schemas (chunk text in, JSON out with `entities`/`claims`/`questions` for the extractor; `edges` array with `targetNotePath`/`type`/`confidence`/`evidenceChunkIds` for the linker) are unchanged. Only the DAL is rewritten — what they DO with the JSON response.
10. **Linker writes to live edge tables with `approved = false`.** No `staging_edges` table. Phase D1's approval flow promotes by `UPDATE supports SET approved = true WHERE id = $id`. The Phase D1 approval service gets its DAL update in Phase 4 along with the rest of the consumers.
11. **Embedded model name is read from existing config.** `EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe"` per the v0.1 spec. Phase 3 reads it from the existing `embedder` module's config; no new env var.
12. **No `concurrency` config file in this phase.** Hardcoded defaults (`indexer.concurrency.embed = 4`, `extract = 2`) live in `src/core/indexer/concurrencyDefaults.ts`. Phase 4 introduces the TOML config that overrides these.

---

## Hard rules (carry forward)

Same as Phase 1/2: TS strict, no `any`, no abbreviations, no dash-clause prose, no emojis, one commit per logical step, stage by name only, substrate tests stay green, kernel-only DAL slots.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/core/indexer/priorityQueue.ts` | Min-heap by `(priority, enqueuedAt)`; pluggable into `indexerQueue.ts` |
| `src/core/indexer/priorityQueue.test.ts` | Unit tests for ordering, ties, removal |
| `src/core/indexer/tier2.ts` | Tier 2 orchestrator: AST blocks → chunks → embeddings → SurrealDB |
| `src/core/indexer/tier2.test.ts` | Smoke against real SurrealDB + mocked Ollama client |
| `src/core/indexer/tier3.ts` | Tier 3 orchestrator: extractor + linker against SurrealDB schema |
| `src/core/indexer/tier3.test.ts` | Smoke against real SurrealDB + mocked LM Studio client |
| `src/core/indexer/concurrencyDefaults.ts` | Hardcoded concurrency constants (Phase 4 makes them configurable) |

### Files modified

| Path | Change |
|---|---|
| `src/core/indexer/indexerQueue.ts` | Replace FIFO array with priority heap; add `priority` parameter to `enqueue` |
| `src/core/indexer/indexerQueue.test.ts` | Cover priority ordering across tiers |
| `src/core/indexer/chunker.ts` | Rewrite to consume AST-derived blocks (from `MarkdownExtraction`) instead of regex paragraph split |
| `src/core/indexer/chunker.test.ts` | Cover heading-section chunk boundaries |
| `src/core/indexer/embedder.ts` | Add `embedAll(chunks: Chunk[]): Promise<EmbeddedChunk[]>` with bounded concurrency |
| `src/core/indexer/extractor.ts` | Replace SQLite inserts with SurrealDB inserts; same prompt + same JSON output schema |
| `src/core/agents/linker.ts` | Neighbor query becomes recursive SurrealQL; staging insert becomes RELATE with `approved = false` |
| `src/core/agents/linker.test.ts` | Update fakes; assert SurrealDB writes |
| `src/core/db/surreal.ts` | Add Tier 2/3 DAL: `createChunk`, `linkerNeighbors`, `relateMentions`, `upsertConcept`, `upsertClaim`, `upsertQuestion`, `relateProposedEdge` |
| `src/core/indexer/indexNote.ts` | Replace SQLite chunk/embed/extract path with calls to `runTier2` and `runTier3` |
| `src/core/kernel.ts` | Drop `hnswVectorIndex` slot |
| `src/daemon/bootstrap.ts` | Drop `HnswVectorIndex` instantiation; remove its `kernel.set` |
| `package.json` | Remove `hnswlib-wasm` |

### Files deleted

- `src/core/indexer/hnswVectorIndex.ts`
- `src/core/indexer/hnswEnvShim.ts`
- `src/core/indexer/vectorIndex.test.ts`

### Files NOT touched (deferred to Phase 4/5)

- `src/core/db/database.ts`, `schema.ts`, `migrations.ts` — Phase 5.
- `src/core/graph/graphStore.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts` — Phase 4 (write-back) and Phase 5 (DAL cutover).
- `src/core/services/echoGuard.ts` — still no-op shim from Phase 1; Phase 4.
- `src/core/search/*` — Phase 4 / Phase 5 migrate to SurrealDB.
- `src/core/approvals/approvalService.ts` — Phase 4 once `daemon_write` writeback lands.
- All Phase D1 handlers — Phase 4 / Phase 5 DAL migration.

---

## Tasks

### Task 1: Priority queue data structure

**Files:**
- Create: `src/core/indexer/priorityQueue.ts`
- Create: `src/core/indexer/priorityQueue.test.ts`

**Objective:** Implement a generic min-heap-backed priority queue used by `IndexerQueue` to order pending work by tier. The exported class `PriorityQueue<T>` exposes `enqueue(value, priority, enqueuedAt)`, `dequeue()` returning `T | null`, `size()`, `isEmpty()`, `countByPriority(priority)`, and `remove(predicate)` returning the count removed.

**Invariants:**
- Lower priority numbers dequeue first (`0` before `1` before `2`).
- Ties on priority break by FIFO via `enqueuedAt` (earlier first).
- `remove(predicate)` re-heapifies; subsequent dequeues remain in correct order.
- `dequeue()` on an empty queue returns `null`, not `undefined`.

**Acceptance:** `bun test src/core/indexer/priorityQueue.test.ts` passes. The test file must cover: priority ordering across tiers, FIFO tiebreak within a single priority, `size`/`isEmpty` transitions, `countByPriority` per-tier counts, and `remove` by predicate followed by ordered dequeues.

---

### Task 2: Refactor `IndexerQueue` to use the priority queue

**Files:**
- Modify: `src/core/indexer/indexerQueue.ts`
- Modify: `src/core/indexer/indexerQueue.test.ts`

**Objective:** Replace the existing FIFO `ready` array in `IndexerQueue` with a `PriorityQueue<string>`. Extend `enqueue(path)` to `enqueue(path, priority?)` with default priority `2` so legacy callers do not block Tier 1 work. Track per-path priority on the debounce-pending side as well so `pendingCount(priority)` reflects both the debouncing entries and the ready queue.

**Invariants:**
- Default priority is `2` for callers that do not pass one.
- A path that is re-enqueued while debouncing keeps the most recent priority.
- The worker drains in priority order; Tier 1 enqueued after Tier 2 still runs first.
- `pendingCount()` with no argument returns the total across debounce-pending and ready; `pendingCount(priority)` returns only the matching entries.
- Worker error handling continues to publish `indexer:error` on the event bus exactly as before.

**Acceptance:** `bun test src/core/indexer/indexerQueue.test.ts` passes, including new tests asserting that a priority-`0` enqueue drains before an earlier priority-`1` enqueue and that `pendingCount(priority)` reports per-tier backlog correctly. All previously green tests in this file remain green.

---

### Task 3: Concurrency defaults

**Files:**
- Create: `src/core/indexer/concurrencyDefaults.ts`

**Objective:** Define and export hardcoded constants used by the Tier 2/3 orchestrators and the chunker. Export `CONCURRENCY` with `embed = 4` and `extract = 2`, and `CHUNK` with `targetTokens = 400` and `maxTokens = 800`. Both objects are `as const`. Phase 4 will replace these with values loaded from `vault/.notient/config.toml`.

**Invariants:** Constants only. No runtime logic. No tests required.

**Acceptance:** File compiles under `bun run typecheck`. Imports from later tasks resolve.

---

### Task 4: AST-aware chunker

**Files:**
- Modify: `src/core/indexer/chunker.ts`
- Modify: `src/core/indexer/chunker.test.ts`

**Objective:** Rewrite the chunker to consume `BlockSpec[]` (from Phase 2's `MarkdownExtraction`) and produce `ChunkSpec[]`. `ChunkSpec` carries `ord`, `text`, `tokenEstimate`, `blockOrd` (the heading-block ancestor ord, or `null` if pre-heading), and start/end line numbers. Each chunk corresponds to one heading section (a heading block plus all following non-heading blocks until the next heading). Token estimation uses `Math.ceil(length / 4)`.

**Invariants:**
- Chunks correspond to heading sections; sections exceeding `CHUNK.targetTokens` split at sentence boundaries (`/(?<=[.!?])\s+/`).
- A single sentence exceeding `CHUNK.maxTokens` hard-splits on whitespace.
- Each chunk carries a `blockOrd` reference to its heading-block ancestor for traceability; pre-heading content has `blockOrd = null`.
- Sections shorter than the target may be emitted as-is; ordering is preserved across the document.
- `chunkBlocks([])` returns `[]`.

**Acceptance:** `bun test src/core/indexer/chunker.test.ts` passes. Tests cover: short heading section emits one chunk with the correct `blockOrd`; long section splits into multiple sentence-bounded chunks each retaining the same `blockOrd`; pre-heading content yields a `blockOrd = null` chunk; empty input yields no chunks.

---

### Task 5: Embedder helper for parallel calls

**Files:**
- Modify: `src/core/indexer/embedder.ts`

**Objective:** Add an `embedAll(texts: string[]): Promise<number[][]>` helper that fans out to the existing `embedOne` call with bounded concurrency equal to `CONCURRENCY.embed`. Output array is index-aligned with input.

**Invariants:**
- Concurrency cap is exactly `CONCURRENCY.embed` (default 4).
- Output ordering matches input ordering.
- A failure in any embed call propagates as a rejected promise; partial results are not returned.

**Acceptance:** `embedAll` is exported and callable from `tier2.ts`. Existing embedder tests stay green; no new dedicated test required for this wrapper at this phase.

---

### Task 6: Tier 2 / Tier 3 DAL extensions

**Files:**
- Modify: `src/core/db/surreal.ts`

**Objective:** Add the DAL helpers needed by Tier 2 and Tier 3:
- `replaceChunks(db, noteId, chunks)` — deletes existing chunks for the note, inserts the new set with `note`, `block`, `ord`, `text`, `token_estimate`, `vector`, `embed_model`, `embedded_at = time::now()`, returns the new chunk IDs in input order.
- `markTier2Done(db, noteId)` and `markTier3Done(db, noteId)` — set the corresponding timestamp on the note.
- `linkerNeighbors(db, { activeNoteId, activeChunkVectors, k, ef? })` — runs the SurrealQL kNN query against `chunk.vector` using `<|K|>` or `<|K,EF|>`, groups by note, returns `NeighborCandidate[]` with `noteId`, `notePath`, `bestDistance`, `evidenceChunkIds`. Returns `[]` when the input has no vectors. Phase 3 uses the first chunk's vector as the query; multi-chunk fan-out is Phase 5.
- `upsertConcept(db, label)` — looks up by normalized label (lowercase, NFKD, strip combining marks, trim); creates if missing.
- `upsertClaim(db, text)` and `upsertQuestion(db, text)` — look up by SHA-256 of text; create if missing.
- `relateEdge(db, table, params)` — RELATE wrapper writing `source`, `confidence_class`, `confidence`, `agent`, `approved` onto the edge.
- `lookupNoteByPath(db, path)` — returns `RecordId<"note"> | null`.

**Invariants:**
- Neighbor query MUST filter out the active note and any note that already shares a `wikilink` edge with the active note (in either direction).
- Neighbor query MUST require `note.tier3_at != NONE` so candidates have settled chunks.
- `replaceChunks` is destructive-then-insert; callers wrap it in a transaction (see Task 7).
- `upsertConcept` matches on `norm_label`, not raw `label`.
- `upsertClaim` / `upsertQuestion` match on the SHA of the exact input text.

**Acceptance:** `bun run typecheck` is clean for `src/core/db/surreal.ts`. Helpers are exported and importable from `tier2.ts`, `tier3.ts`, `extractor.ts`, and `linker.ts`.

---

### Task 7: Tier 2 orchestrator

**Files:**
- Create: `src/core/indexer/tier2.ts`
- Create: `src/core/indexer/tier2.test.ts`

**Objective:** Implement `runTier2(db, { notePath, blocks })` that resolves the note ID via `lookupNoteByPath` (throwing if Tier 1 has not landed), runs `chunkBlocks` over the AST blocks, calls `embedAll` over the chunk texts, and persists the results via `replaceChunks` + `markTier2Done` inside a single SurrealDB transaction. Returns `{ noteId, chunkCount }`. Uses `EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe"`.

**Invariants:**
- Throws if the note does not exist in SurrealDB at the given path (Tier 1 must run first).
- Empty chunk list short-circuits: still calls `markTier2Done`, returns `chunkCount = 0`, no embed calls.
- Chunk insertion and `tier2_at` update are atomic via `BEGIN` / `COMMIT` / `CANCEL`.
- `chunk.block` is set to `null` in Phase 3; Phase 4 wires the heading-block reference once the resolver has stable IDs.
- Vectors are aligned with chunks by `ord`.

**Acceptance:** `bun test src/core/indexer/tier2.test.ts` passes. The smoke test boots a real SurrealDB, applies the Phase 1 schema, seeds a note via Tier 1 DAL writes, runs `runTier2` with `embedAll` mocked to return deterministic vectors, and asserts: chunk rows exist with the expected `ord`/`text`/`vector`/`embed_model`, `note.tier2_at` is set, and a follow-up `runTier2` replaces (not duplicates) the chunks.

---

### Task 8: Tier 3 orchestrator

**Files:**
- Create: `src/core/indexer/tier3.ts`
- Create: `src/core/indexer/tier3.test.ts`
- Modify: `src/core/agents/linker.ts`
- Modify: `src/core/indexer/extractor.ts`

**Objective:** Retarget the extractor and linker at SurrealDB and add the Tier 3 orchestrator.
- Extractor: keep the prompt and `chatJson` flow unchanged. Add `writeExtractionToSurreal(db, noteId, extraction)` that, for each entity, claim, question in the LLM JSON, calls `upsertConcept` / `upsertClaim` / `upsertQuestion` and then `relateEdge` on `mentions` / `asserts` / `asks` with `source = "extractor"`, `confidenceClass = "INFERRED"`, `confidence = 0.7`, `agent = "extractor"`, `approved = true`.
- Linker: pull active chunk vectors (already present from Tier 2), call `linkerNeighbors(db, { activeNoteId, activeChunkVectors, k: 20, ef: 40 })`, send candidates plus the active note text to the LLM with the existing prompt, then for each proposed edge whose `type` is in the allowlist `["supports", "contradicts", "extends", "exemplifies", "synthesizes", "related_to"]`, resolve the target note via `lookupNoteByPath` and call `relateEdge` with `source = "linker"`, `confidenceClass = "INFERRED"`, `confidence = edge.confidence`, `agent = "linker"`, `approved = false`.
- Orchestrator: `runTier3(db, { notePath, chunks })` resolves the note ID, runs the extractor and linker concurrently (Tier 3 concurrency = 2 per locked decision 5), writes the extractor output, and calls `markTier3Done`.

**Invariants:**
- Extractor writes are `approved = true`; linker writes are `approved = false`.
- Linker neighbor query MUST filter out notes that already share a `wikilink` edge with the active note (in either direction); this filter lives in `linkerNeighbors` (Task 6) and the linker relies on it.
- Linker silently skips proposals with unknown edge types or unresolvable target paths.
- Extractor + linker prompts and JSON schemas are unchanged from the pre-Phase-3 implementation; only the DAL is rewritten.
- No `staging_edges` table; proposals land directly in the live edge tables.

**Acceptance:** `bun test src/core/indexer/extractor.test.ts src/core/indexer/tier3.test.ts src/core/agents/linker.test.ts` passes. The Tier 3 smoke asserts: `mentions`/`asserts`/`asks` rows exist with `approved = true` for a mocked extractor response; a `supports` row exists with `approved = false` for a mocked linker response; `note.tier3_at` is set.

---

### Task 9: Wire Tier 2 + Tier 3 into `indexNote.ts`

**Files:**
- Modify: `src/core/indexer/indexNote.ts`
- Modify: `src/core/db/surreal.ts` (add `fetchChunksForTier3`)

**Objective:** Replace the legacy SQLite-bound chunk/embed/extract pipeline in `indexNote.ts` with sequential calls to `runTier1` (already in place from Phase 2), `runTier2`, and `runTier3`. Between Tier 2 and Tier 3, fetch the persisted chunks (`ord`, `text`, `vector`) via a new `fetchChunksForTier3(db, noteId)` DAL helper. Publish `indexer:tier1-done`, `indexer:tier2-done` (with `chunkCount`), and `indexer:tier3-done` events on success. Remove all calls into the SQLite `embeddings` table, `hnswVectorIndex.add(...)`, and the SQLite-bound `graph_nodes` / `graph_edges` writes for extractor + linker outputs.

**Invariants:**
- Tier order is strictly Tier 1 → Tier 2 → Tier 3 within a single note.
- An error in any tier aborts the remaining tiers for that note and falls through to the existing error path.
- Search-side reads against the SQLite `embeddings` table remain untouched (locked decision 7); only writes are removed.
- `fetchChunksForTier3` orders rows by `ord` ascending.

**Acceptance:** `bun test` passes. Search tests still query SQLite and still pass against pre-migration data. The handoff doc (Task 12) records the known short-term staleness gap.

---

### Task 10: Delete `hnswlib-wasm` and the kernel slot

**Files:**
- Delete: `src/core/indexer/hnswVectorIndex.ts`
- Delete: `src/core/indexer/hnswEnvShim.ts`
- Delete: `src/core/indexer/vectorIndex.test.ts`
- Modify: `src/core/kernel.ts`
- Modify: `src/daemon/bootstrap.ts`
- Modify: `package.json`

**Objective:** Retire `hnswlib-wasm` entirely. Verify no live import of `hnsw*` or `HnswVectorIndex` remains outside the three files being deleted, the kernel slot, and the bootstrap instantiation. Delete the three files. Drop the `hnswVectorIndex` slot from `src/core/kernel.ts`. Remove the `new HnswVectorIndex(...)` instantiation and its `kernel.set("hnswVectorIndex", ...)` call from `src/daemon/bootstrap.ts`. Run `bun remove hnswlib-wasm`.

**Invariants:**
- After this task, `grep -rln "hnsw\|HnswVectorIndex" src/` returns nothing.
- The kernel slot map no longer mentions `hnswVectorIndex`.
- `package.json` no longer lists `hnswlib-wasm`.
- No deprecation shim, no compat layer.

**Acceptance:** `bun run typecheck` and `bun test` both pass with zero references to the removed library.

---

### Task 11: Phase 3 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/tier23.smoke.test.ts`

**Objective:** End-to-end smoke that boots SurrealDB, applies the Phase 1 schema, seeds two notes through Tier 1, runs Tier 2 with a mocked `embedAll` returning deterministic vectors, and runs Tier 3 with a mocked LLM client that returns one entity, one claim, one question, and one `supports` edge proposal.

**Invariants / assertions:**
- Chunk rows exist for both notes with the expected vectors and `embed_model`.
- A kNN query against `chunk.vector` finds the seeded chunks.
- `mentions`, `asserts`, `asks` rows exist with `approved = true`.
- The `supports` row exists with `approved = false`.
- `linkerNeighbors` excludes the active note from its results.
- `linkerNeighbors` excludes notes that already share a `wikilink` edge with the active note (in either direction); the smoke seeds at least one such wikilink to verify the filter.

**Acceptance:** `bun test src/daemon/__smoke__/tier23.smoke.test.ts` passes against a live local SurrealDB instance.

---

### Task 12: Phase 3 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-3-vault-enrichment-handoff.md`

**Objective:** Write a handoff under 80 lines documenting: priority queue shipped, full Tier 1/2/3 pipeline writes only to SurrealDB, `hnswlib-wasm` deleted, search consumers still on SQLite (known short-term staleness gap), linker uses one-hop SurrealQL with the skip-already-wikilinked filter. State the Phase 4 entry point: search/agent migration to SurrealDB, AST writeback, `daemon_write` provenance, awaken control plane.

**Invariants:** Document the staleness gap explicitly so Phase 4 owners do not miss it.

**Acceptance:** File exists, is under 80 lines, and names every Phase 3 deliverable plus the Phase 4 entry point.

---

## Self-review

**Spec coverage:**
- §3.2 chunk schema → Task 6 (`replaceChunks`) and Task 7 (`runTier2`).
- §3.4 semantic edge tables → Task 6 (`relateEdge`, `upsertConcept`/`Claim`/`Question`) and Task 8 (extractor + linker writes).
- §5.1 priority queue → Tasks 1, 2.
- §5.3 Tier 2 → Tasks 3, 4, 5, 6, 7.
- §5.4 Tier 3 → Task 8.
- Linker skip-already-wikilinked filter → Task 6 (`linkerNeighbors`) plus Task 11 (smoke verifies).
- HNSW deletion → Task 10.

**Type consistency:** `BlockSpec` (Phase 2) feeds `chunkBlocks` (Task 4) producing `ChunkSpec` consumed by `replaceChunks` (Task 6). `EdgeTable` (Phase 1) is consumed by `relateEdge` and `linkerNeighbors`. `RecordId<"note" | "block" | "chunk" | "concept" | "claim" | "question">` is consistent across the DAL.

**Known short-term gap:** Search consumers (`searchPipeline.ts`, `strategies/*.ts`) still query SQLite and return pre-Phase-3 data until Phase 4 migrates them. The Phase 3 handoff documents this. Acceptable because the daemon is on `beta-spec` between phases, not shipped.

---

## Execution

Phase 3 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md`. Execute via `superpowers:subagent-driven-development` after Phase 2 ships green.
