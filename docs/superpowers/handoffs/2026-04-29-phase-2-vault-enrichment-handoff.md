# Phase 2 — Vault Enrichment Handoff

Date: 2026-04-29. Branch: `beta-spec`. Plan: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md`. Spec: `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`.

## What shipped

- Unified pipeline at `src/core/markdown/pipeline.ts` (`getMarkdownPipeline`, `parse`, `stringify`, `processAst`). Memoised processor wires `remark-parse`, `remark-frontmatter` (yaml), `remark-gfm`, plus the three custom plugins, plus `remark-stringify`. Round-trip golden test on `__fixtures__/golden.md` verifies AST equality and string idempotency.
- Three in-repo plugins under `src/core/markdown/plugins/`: `remarkWikilink` (parses `[[t]]`, `[[t|a]]`, `[[t#h]]`, `[[t#^b]]`, `![[t]]`), `remarkBlockId` (trailing `\s\^id\s*$` on paragraph or listItem; attaches `blockId`), `remarkTag` (`#tag/sub` outside code spans/blocks/headings).
- Heading slugifier at `src/core/markdown/slug.ts`; lowercase + dashes + Unicode letter preservation.
- Pure walker at `src/core/markdown/extractor.ts` producing `MarkdownExtraction` (`src/core/markdown/types.ts`). H1-H3 produce blocks; H4-H6 roll into the nearest H3 ancestor's `headingPath` and text. Paragraphs and list items with `^block-id` become standalone blocks. Frontmatter walks via the `yaml` package; nested keys produce dotted `FrontmatterRefSpec.key` strings (`notient.contradicts`, `notient.notes.primary`).
- Wikilink resolver at `src/core/markdown/resolver.ts`: exact path with or without `.md` first, then basename match with folder-edit-distance disambiguation. Returns `targetPath = null` for unresolved.
- Tier 1 DAL extensions in `src/core/db/surreal.ts`: `lookupNoteByPath`, `lookupBlockByHeading`, `lookupBlockByExplicitId`, `upsertNoteByPath`, `upsertTag`, `replaceBlocks`, `clearTier1Edges`, `relateEdge` (typed `EdgeTable` enum), `markTier1Done`. Schema gains `target_unresolved option<string>` on `wikilink` and `embed`, plus the `note:unresolved` sentinel record (`UPSERT note:unresolved ...`) created at apply time.
- Tier 1 indexer at `src/core/indexer/tier1.ts` (`runTier1`). Pure parse → extract → resolve outside the database, then writes inside an indexer-driven sequence: upsert note, replace blocks, clear Tier 1 edges, RELATE structural (`contained_in`, `under_heading`), wikilink/embed, frontmatter_ref, upsert tags + `tagged`. Tag edges always `source = 'structure'`. Wikilink embeds `source = 'embed'`. Resolved wikilinks `source = 'wikilink'`. Frontmatter refs `source = 'frontmatter'`.
- Wired into `src/core/indexer/indexNote.ts` ahead of the SHA-change guard. Failures emit `indexer:error` with `phase = 'tier1'` and never block the SQLite path. New event types: `indexer:tier1-done`, `indexer:tombstoned`, `indexer:renamed`.
- Watcher at `src/daemon/watcher.ts` gains `unlink` and rename handling when an optional `surrealDb` is provided. Unlink writes `tombstoned_at = time::now()` and schedules a 60-second cascade-delete (`setTimeout(...).unref()`); cascade only fires if the row is still tombstoned at fire-time. On `add`, the watcher hashes the file body and looks up tombstoned notes with the same SHA; if found at a different path, it updates the path, clears the tombstone, cancels the cascade timer, emits `indexer:renamed`, and re-enqueues the path.
- Smoke harness at `src/daemon/__smoke__/tier1.smoke.test.ts` validates LD7 (unresolved wikilink via sentinel) and LD8 (`tagged.source === 'structure'`) end to end.

Test posture at end of phase: 933 pass / 27 skip / 0 fail across 128 files. Smoke 10/10 across both phases.

## What is deliberately NOT done

- No SQLite migration. Tier 2 (chunking + embedding) and Tier 3 (extractor + linker) still write to SQLite via the existing `chunker`, `embedder`, `extractor`, and graph paths. Phase 3 owns the Tier 2/3 cutover to SurrealDB native HNSW.
- No write-back from Tier 1. The `daemon_write` provenance table stays empty in Phase 2; every wikilink edge gets `source = 'wikilink'`. Phase 4 lights up `daemon_write` and the AST-aware writer.
- No deletion of `relatedSection.ts`, `frontmatterWriter.ts`, `nativeGraphBridge.ts`, or `echoGuard.ts` (still a no-op shim). Phase 4/5 own the cutover.
- Awaken control plane unchanged. `awaken --pause/--resume/--cancel/--status`, the `awaken_run` lifecycle, and `--background` wait for Phase 4.
- No new CLI verbs. `graph dump`, `graph stats`, `links sync`, `links audit`, `backup`, `restore`, `nuke`, `migrate-vault`, `awaken --tier`, `reindex --tier` all wait for Phase 5.

## Phase 3 entry point

Phase 3 ships the priority queue (min-heap keyed by `(priority, enqueuedAt)`), retargets `chunker` + `embedder` at `block` rows so chunks reference blocks, writes vectors into SurrealDB's native HNSW (`chunk.vector` index, `<|k,ef|>` operator), and rewrites the linker against SurrealQL kNN with the skip-already-linked filter. The external `hnswlib-wasm` dependency comes out of the graph in Phase 3. Plan path: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md`.

## Footguns inherited from Phase 1, unchanged in Phase 2

- HNSW is in-memory and rebuilt on startup; cap is `SURREAL_HNSW_CACHE_SIZE` (default 256 MiB). Bump for vaults beyond ~50k chunks.
- `<|k,ef|>` operator form is required for kNN against a cosine HNSW index; bare `<|k|>` errors.
- DAL writes that touch `option<string>` fields must omit them when undefined; `relateEdge` and `replaceBlocks` follow the pattern.
- SurrealDB 3.0.5 SCHEMAFULL hard-rejects unknown fields; only schema-declared keys may be written.

## Phase 2 footguns (new)

- LD7 deviation: SurrealDB 3.x `TYPE RELATION` rejects an `option<record>` on the implicit `out` field. Tier 1 routes unresolved wikilink and embed targets through the `note:unresolved` sentinel record with `target_unresolved` holding the raw string. Phase 5's `links audit` query becomes `SELECT in, target_unresolved FROM wikilink WHERE out = note:unresolved`. Both LD7 (unresolved persistence) and LD8 (`tagged.source === 'structure'`) are exercised by the Phase 2 smoke harness; do not regress them.
- The `surrealdb` JS SDK opens a fresh implicit transaction per `db.query` call. A session-level `BEGIN TRANSACTION; ... COMMIT TRANSACTION;` pair via separate calls is not honored. Phase 2 plan invariant 5 (transactional Tier 1) is satisfied operationally rather than literally: `markTier1Done` is the last step and `replaceBlocks` plus `clearTier1Edges` are delete-then-insert idempotent, so a partial failure self-heals on the next `runTier1` for the same note. Phase 4 may revisit this with a single-string transaction builder if write-back demands stronger guarantees.
- The watcher enforces the 60-second rename window client-side via the cascade timer rather than via a SurrealQL `time::now() - $window` filter; passing `"60000ms"` as a session parameter does not type-coerce to a duration in the SDK's binding context.
- `frontmatter_ref` is `TYPE RELATION FROM note TO note`; unresolved frontmatter targets are dropped silently (no sentinel routing) because the locked decisions did not require persisting them. Phase 5's audit will surface frontmatter unresolveds via `links audit` once that verb lands.
