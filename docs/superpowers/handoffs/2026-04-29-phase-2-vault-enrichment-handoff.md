# Phase 2 — Vault Enrichment Handoff

Date: 2026-04-29. Branch: `beta-spec`. Plan: `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md`. Spec: `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md`.

## Closeout

Four defects from the initial Phase 2 ship were corrected before Phase 3 started:

- `e36514e` replaces the `note:unresolved` sentinel record with dedicated `wikilink_unresolved` and `embed_unresolved` tables (TYPE NORMAL, SCHEMAFULL). The `wikilink` and `embed` relation traversals are now sentinel-free; Phase 5's `links audit` reads the new tables directly. Spec §3.4 and §8.3 document the new shape. Phase 1's INFO FOR DB count went from 24 to 26.
- `77f68b0` makes Tier 1 transactional. `runTier1` builds one SurrealQL script bracketed by `BEGIN TRANSACTION` and `COMMIT TRANSACTION` and submits it as a single `db.query` call. Pre-resolution work runs outside the transaction; only writes run inside. Phase 2 plan §Task 12 acceptance test 8 (rollback on partial failure) is now covered. CREATE rather than UPSERT WHERE is used for new rows because UPSERT WHERE silently no-ops on field-assertion violations in 3.x; CREATE raises and the transaction aborts.
- `74e9c8c` adds the `indexer:warn` event type and emits one warn per dropped frontmatter ref whose target does not resolve. `runTier1` accepts an optional `bus`; `indexNote` forwards its own through. Phase 2 plan locked decision 7's "drop and log via `indexer:warn`" wording is satisfied.
- `38f3a27` moves the watcher rename window from setTimeout-only enforcement to a server-side `tombstoned_at > $threshold` filter. The cascade timer still cleans up but no longer carries the sole correctness burden; a stale tombstone can no longer resurrect a fresh file with a matching SHA after a daemon restart or an event-loop hiccup.

Test posture after closeout: 933 pass / 30 skip / 0 fail across 128 files. Smoke 10/10. The Tier 1 smoke harness gained the rollback acceptance test at test 8 and the frontmatter-warn test at test 9; the watcher smoke gained the threshold-filter test.

## What shipped

- Unified pipeline at `src/core/markdown/pipeline.ts` (`getMarkdownPipeline`, `parse`, `stringify`, `processAst`). Memoised processor wires `remark-parse`, `remark-frontmatter` (yaml), `remark-gfm`, plus the three custom plugins, plus `remark-stringify`. Round-trip golden test verifies AST equality and string idempotency.
- Three in-repo plugins under `src/core/markdown/plugins/`: `remarkWikilink` (parses `[[t]]`, `[[t|a]]`, `[[t#h]]`, `[[t#^b]]`, `![[t]]`), `remarkBlockId` (trailing `\s\^id\s*$` on paragraph or listItem), `remarkTag` (`#tag/sub` outside code spans/blocks/headings).
- Heading slugifier at `src/core/markdown/slug.ts`. Pure walker at `src/core/markdown/extractor.ts` produces `MarkdownExtraction`. H1-H3 emit blocks; H4-H6 roll into the nearest H3 ancestor. Paragraphs and list items with `^block-id` emit standalone blocks. Frontmatter walks via the `yaml` package; nested keys produce dotted `FrontmatterRefSpec.key`.
- Wikilink resolver at `src/core/markdown/resolver.ts`: exact path with or without `.md`, then basename match with folder-edit-distance disambiguation.
- Tier 1 indexer at `src/core/indexer/tier1.ts`. Pure parse → extract → resolve → existence checks outside the database, then a single `BEGIN/COMMIT` SurrealQL script handles upsert + replace + relate + mark in one shot. Tag edges always `source = 'structure'`. Wikilink embeds `source = 'embed'`. Resolved wikilinks `source = 'wikilink'`. Frontmatter refs `source = 'frontmatter'`.
- Wired into `src/core/indexer/indexNote.ts` ahead of the SHA-change guard. Tier 1 errors emit `indexer:error` with `phase = 'tier1'` and never block the SQLite path. New event types: `indexer:tier1-done`, `indexer:tombstoned`, `indexer:renamed`, `indexer:warn`.
- Watcher at `src/daemon/watcher.ts` handles `unlink` (tombstone + scheduled cascade-delete) and `add` (60s SHA-match rename detection enforced via server-side `tombstoned_at > $threshold`). The cascade also clears `wikilink_unresolved` and `embed_unresolved` rows.
- Phase 2 smoke harness at `src/daemon/__smoke__/tier1.smoke.test.ts` validates LD7 (unresolved wikilink stored in `wikilink_unresolved`) and LD8 (`tagged.source === 'structure'`) end to end.

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
- DAL writes that touch `option<string>` fields must omit them when undefined; `replaceBlocks` follows the pattern.
- SurrealDB 3.0.5 SCHEMAFULL hard-rejects unknown fields; only schema-declared keys may be written.
