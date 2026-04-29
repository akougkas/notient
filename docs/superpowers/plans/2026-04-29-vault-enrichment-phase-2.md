# Notient Vault Enrichment — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real markdown parser (unified/remark with three custom plugins for Obsidian-flavored syntax) and a Tier 1 indexer that turns every saved note into deterministic edges in SurrealDB — wikilinks, embeds, block IDs, tags, frontmatter refs, structural `contained_in` and `under_heading` edges — without disturbing the existing SQLite-backed Tier 2 (chunks/vectors) or Tier 3 (extractor/linker) consumers.

**Architecture:** Phase 2 introduces `src/core/markdown/` as a self-contained AST module: pipeline + plugins + walker, all pure (no IO). The existing `indexNote.ts` orchestrator gains a Tier 1 step that runs **before** the existing chunk/embed/extract path. Tier 1 writes to SurrealDB via the DAL skeleton from Phase 1; the rest of the indexer continues to write to SQLite. This is a parallel-write phase: the same note now produces deterministic edges in SurrealDB AND chunks/concepts/etc. in SQLite. Phase 3 migrates Tier 2/3 to SurrealDB; Phase 5 deletes the SQLite paths.

**Tech Stack:** unified/remark plugin ecosystem (`unified`, `remark-parse`, `remark-stringify`, `remark-frontmatter`, `remark-gfm`), `mdast-util-to-string`, `unist-util-visit`, custom plugins in `src/core/markdown/plugins/`. SurrealDB DAL from Phase 1. `chokidar` for the watcher. No new substrate.

**Source of truth:**
- `docs/superpowers/specs/2026-04-29-vault-enrichment-data-model-design.md` — §3.2 (block schema), §3.4 (edge tables), §5.2 (Tier 1), §5.5 (watcher), §8.1-§8.3 (markdown pipeline + extractor + resolution).
- `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-1.md` — substrate this phase consumes.
- `docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md` — confirms `surrealDb` slot is live and DAL skeleton (`createNote`, `relateWikilink`, `searchVector`) is callable.

**Locked decisions (Phase 2, 2026-04-29):**

1. **Three custom remark plugins, all in-repo.** No external `remark-wiki-link` package; the parsing rules for `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` are Obsidian-specific and we want full control. Plugins ship as `src/core/markdown/plugins/{remarkWikilink,remarkBlockId,remarkTag}.ts`.
2. **AST node types are plain `unist` extensions, not classes.** `wikiLink`, `wikiEmbed`, `tagRef` nodes carry `target`, `alias?`, `heading?`, `block?`, `tag?` as plain string fields. The walker reads them via `unist-util-visit`; no type registry, no plugin coupling.
3. **Heading nodes cap at H3.** H4/H5/H6 are NOT block nodes. Their content is rolled into the nearest H3 ancestor block's `text`. Wikilinks with H4+ headings (`[[note#H4]]`) still resolve to the H3 ancestor block, with the full original heading path preserved on the edge attribute `target_heading_path`. Implemented in §10's wikilink resolver.
4. **Block extraction granularity:** one block per H1/H2/H3 plus one block per top-level paragraph or list item that contains a `^block-id` marker. No block per plain paragraph; the chunker (Phase 3) chunks at a different granularity.
5. **Tier 1 indexer writes are transactional.** One SurrealDB `BEGIN/COMMIT` per note: upsert note, replace blocks (delete-then-insert keyed on `block.note`), replace deterministic edges, set `tier1_at`. If any step fails, the whole transaction rolls back; the note's `tier1_at` does not advance.
6. **Wikilink target resolution is best-effort.** Same-vault target lookup runs in two passes: (a) exact `note.path` match modulo `.md` extension, (b) basename match if no folder is specified. Ambiguous basename matches resolve to the closest by edit distance to the active note's folder.
7. **Unresolved wikilinks persist with `target = NONE`.** When a `[[target]]` cannot be resolved to a `note` row (the path or basename has no match in the vault), the Tier 1 indexer still inserts a `wikilink` edge with `target = NONE` and stores the original raw target string in a `target_unresolved` field on the edge. This is non-negotiable: Phase 5's `links audit` verb relies on unresolved edges being queryable. Skipping them with `continue` would silently lose the data. The same rule applies to `embed` edges (unresolved embeds also persist with `target = NONE`). Frontmatter refs follow the same pattern when the schema permits; if `frontmatter_ref` does not allow null targets, drop only those and log via `indexer:warn`.
8. **Tag edges have `source = 'structure'`.** All `tagged` RELATIONs created by Tier 1 must record `source = 'structure'` (NOT `'wikilink'`). The schema permits both via the source-enum, but downstream stats and filters partition by source; mis-tagging tag edges as wikilinks corrupts those reports. Acceptance tests must assert the exact source value, not just edge existence.
9. **Tier 1 runs as a parallel branch in the existing `indexNote.ts`.** It is not a separate worker. The existing flow stays: read file → SHA → if changed, run extractor + chunker + embedder + linker + write SQLite. Phase 2 prepends: read file → SHA → if changed, run **markdown pipeline** → write Tier 1 to SurrealDB → continue with existing flow. Errors in Tier 1 do NOT block Tier 2/3; they emit `indexer:error` and proceed.
10. **Watcher gains `unlink` + 60s SHA-match rename detection.** New listener on `chokidar`'s `unlink` event sets `note.tombstoned_at = time::now()`. A scheduled task (`setTimeout` per tombstone) cascade-deletes after 60 seconds unless the note has been resurrected. On `add(path)`, if a tombstoned `note` row exists with the same body SHA within the window, the path is updated and `tombstoned_at` is cleared. `change` events are unchanged.
11. **The unified pipeline is built once and reused.** `getMarkdownPipeline()` is a memoised factory; the same processor instance handles every note. Idempotency over `parse → stringify → parse` is verified by a golden fixture test (`src/core/markdown/__fixtures__/golden.md`).
12. **No write-back from Tier 1.** Tier 1 reads the note and writes to SurrealDB. It does NOT write back to the markdown file. The `daemon_write` provenance table is empty during Phase 2; it gets its first writers in Phase 4. Cross-referencing daemon_write to attribute wikilink source is therefore a no-op in Phase 2 (every wikilink edge gets `source = 'wikilink'`); Phase 4 turns it on.
13. **No deletion of existing markdown utilities yet.** `relatedSection.ts`, `frontmatterWriter.ts`, `nativeGraphBridge.ts` continue to live. They write SQLite-backed staging edges; that path is untouched until Phase 4.
14. **`MarkdownExtraction` is the contract between the AST module and the indexer.** Pure shape, no helper methods. The walker returns it; the indexer turns it into SurrealDB writes.

---

## Hard rules (carry forward from Phase 1)

- TypeScript strict, no `any` without justification.
- No `console.log` outside `src/cli/output.ts` and the existing `debug<Subsystem>` helpers.
- No abbreviations: `context` not `ctx`, `error` not `err`, `message` not `msg`, `event` not `evt`, `index` not `idx`, `options` not `opts`.
- No `[noun] - [parenthetical clause]` dash-clause prose.
- No emojis in source.
- One commit per logical step on `beta-spec`. Stage by name only.
- Substrate tests stay green throughout. New tests are additive and targeted.
- The kernel is the only place where new DAL slots get registered; Phase 2 adds none.

---

## File structure

### Files created

| Path | Responsibility |
|---|---|
| `src/core/markdown/types.ts` | `MarkdownExtraction`, `BlockSpec`, `WikilinkSpec`, `EmbedSpec`, `TagSpec`, `FrontmatterRefSpec`, all pure shape |
| `src/core/markdown/pipeline.ts` | `getMarkdownPipeline()` memoised unified processor; `parse(source)` and `stringify(ast)` helpers |
| `src/core/markdown/pipeline.test.ts` | Round-trip golden test on `__fixtures__/golden.md` |
| `src/core/markdown/plugins/remarkWikilink.ts` | Parse `[[target]]`, `[[target\|alias]]`, `[[target#heading]]`, `[[target#^block]]`, `![[target]]` |
| `src/core/markdown/plugins/remarkWikilink.test.ts` | Plugin unit tests |
| `src/core/markdown/plugins/remarkBlockId.ts` | Parse `^block-id` markers (end of paragraph or list item) |
| `src/core/markdown/plugins/remarkBlockId.test.ts` | Plugin unit tests |
| `src/core/markdown/plugins/remarkTag.ts` | Parse `#tag/sub` outside code spans/blocks |
| `src/core/markdown/plugins/remarkTag.test.ts` | Plugin unit tests |
| `src/core/markdown/extractor.ts` | `extract(ast, notePath): MarkdownExtraction`; pure walker, no IO |
| `src/core/markdown/extractor.test.ts` | Walker tests against AST fixtures |
| `src/core/markdown/__fixtures__/golden.md` | Round-trip + extraction golden fixture |
| `src/core/markdown/__fixtures__/edge-cases.md` | Wikilinks in code spans, frontmatter wikilinks, nested headings, malformed input |
| `src/core/indexer/tier1.ts` | Tier 1 orchestrator: AST → SurrealDB transaction |
| `src/core/indexer/tier1.test.ts` | Smoke against a temp SurrealDB |
| `src/core/markdown/resolver.ts` | Wikilink target resolution (note path lookup, basename fallback, edit-distance disambiguation) |
| `src/core/markdown/resolver.test.ts` | Resolver unit tests with synthetic vault |

### Files modified

| Path | Change |
|---|---|
| `package.json` | Add `unified`, `remark-parse`, `remark-stringify`, `remark-frontmatter`, `remark-gfm`, `mdast-util-to-string`, `unist-util-visit` |
| `src/core/db/surreal.ts` | Add Tier 1 DAL: `createBlock`, `replaceBlocks`, `relateEdge` (typed enum on edge table name), `clearTier1Edges`, `markTier1Done`, `lookupNoteByPath`, `lookupBlockByHeading` |
| `src/core/indexer/indexNote.ts` | Prepend Tier 1 step before existing flow |
| `src/daemon/watcher.ts` | Add `unlink` listener, rename detection within 60s SHA-match window |
| `src/daemon/watcher.test.ts` | Cover unlink + rename |

### Files deleted

None. Phase 2 is purely additive.

### Files NOT touched (deferred)

- `src/core/db/database.ts`, `src/core/db/schema.ts`, `src/core/db/migrations.ts` — Phase 5.
- `src/core/indexer/hnswVectorIndex.ts`, `src/core/indexer/chunker.ts`, `src/core/indexer/embedder.ts`, `src/core/indexer/extractor.ts` — Phase 3 migrates these to SurrealDB.
- `src/core/graph/graphStore.ts`, `nativeGraphBridge.ts`, `relatedSection.ts`, `frontmatterWriter.ts` — Phase 4.
- `src/core/services/echoGuard.ts` — still a no-op shim from Phase 1; Phase 4 deletes the shim and consumer call sites.
- All Phase D1 handlers, agent code, chat tools, search code — Phase 3/4/5 migrate the DAL.

---

## Schema precondition (Phase 1 owns; this phase asserts)

- The `wikilink` edge table must have an `option<string> target_unresolved` field. The `embed` edge table must allow the same field. If Phase 1 omitted these, the first task in Phase 2 that needs them adds the migration. The acceptance criterion for Tasks 11 and 12 includes a `DEFINE FIELD` for `target_unresolved` with `option<string>` type.
- The `source` enum on every edge table must include both `'wikilink'` and `'structure'` (and `'embed'`, `'frontmatter'`, `'extractor'`, `'linker'`, `'user'`).

---

## Tasks

### Task 1: Add unified/remark dependencies

**Files:**
- Modify: `package.json`, `bun.lockb`

**Objective:** Land the unified/remark stack as runtime deps and the matching `@types/mdast`, `@types/unist` as dev deps so subsequent tasks can import them.

**Acceptance:** `bun add unified remark-parse remark-stringify remark-frontmatter remark-gfm mdast-util-to-string unist-util-visit` and `bun add -d @types/mdast @types/unist` succeed; `bun run typecheck` is clean; a one-line smoke import of `unified` evaluates to a function. Commit `package.json` and `bun.lockb`.

---

### Task 2: Markdown extraction types

**Files:**
- Create: `src/core/markdown/types.ts`

**Objective:** Define the pure data contract between the AST walker and the Tier 1 indexer.

**Acceptance:** Define `MarkdownExtraction` in `src/core/markdown/types.ts` with fields: `blocks: BlockSpec[]`, `wikilinks: WikilinkSpec[]` (includes embeds via an `isEmbed` flag), `tags: TagSpec[]`, `frontmatterRefs: FrontmatterRefSpec[]`, `frontmatter: Record<string, unknown>`, `bodySha: string`, `wordCount: number`. The shape is a pure data record; no methods.

`BlockSpec` carries: `blockId: string | null`, `headingLevel: 1 | 2 | 3 | null`, `headingPath: string[]` (full path including any rolled-up H4-H6 segments), `headingSlug: string | null`, `ord: number`, `startLine: number`, `endLine: number`, `text: string`.

`WikilinkSpec` carries: `fromBlockOrd: number | null`, `rawTarget: string`, `targetPath: string | null`, `targetHeading: string | null`, `targetBlockId: string | null`, `alias: string | null`, `isEmbed: boolean`, `targetHeadingPath: string[]`. **It must include `targetUnresolved: string | null`** so the indexer can persist the raw target on edges where resolution fails (Locked decision 7).

`TagSpec` carries: `fromBlockOrd: number | null`, `path: string` (e.g. `concept/auth/oauth`).

`FrontmatterRefSpec` carries: `key: string`, `rawTarget: string`, `targetPath: string | null`.

`bun run typecheck` is clean. Commit only the new file.

---

### Task 3: unified pipeline factory

**Files:**
- Create: `src/core/markdown/pipeline.ts`
- Create: `src/core/markdown/__fixtures__/golden.md`
- Create: `src/core/markdown/pipeline.test.ts`

**Objective:** Build a memoised `unified` processor (`remark-parse` + `remark-frontmatter` + `remark-gfm` + `remark-stringify`) and prove that the same processor instance is reused, that `parse` produces a `root` mdast node, and that `parse → stringify → parse` is byte-deterministic on a golden fixture.

**Invariants:** The pipeline is built once. Custom plugins are NOT wired here (Task 7 wires them).

**Acceptance:** A golden fixture under `src/core/markdown/__fixtures__/golden.md` exercises every node type (frontmatter, H1-H6 headings, plain wikilinks, aliased wikilinks, heading-qualified wikilinks, block-id-qualified wikilinks, embeds, paragraphs, list items, paragraph-trailing block-ids, list-item-trailing block-ids, tags, fenced code blocks containing wikilinks/tags that must NOT be parsed, inline code spans, deeper headings up to H6). The pipeline must round-trip it byte-deterministically through `parse → stringify → parse` (AST-equality, not string equality). Test file `pipeline.test.ts` proves: (a) `getMarkdownPipeline() === getMarkdownPipeline()`, (b) parse returns a `root` node, (c) round-trip AST equality on the golden fixture. `bun test src/core/markdown/pipeline.test.ts` passes.

---

### Task 4: `remarkWikilink` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkWikilink.ts`
- Create: `src/core/markdown/plugins/remarkWikilink.test.ts`

**Objective:** Parse `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target#^block]]`, and `![[target]]` (embed variant) into custom mdast `wikiLink` and `wikiEmbed` phrasing-content nodes.

**Invariants:** The plugin must NOT match patterns inside `inlineCode` or `code` parents. Multiple links inside one paragraph must each produce a separate node. The plugin must split surrounding text correctly so subsequent walkers see the right structure.

**Acceptance:** Tests cover plain target, aliased target, heading qualifier, block-id qualifier, embed variant, code-span exclusion, fenced-block exclusion, and multiple links per paragraph. Each `wikiLink`/`wikiEmbed` node carries `target`, `alias`, `heading`, `block` (any unset → `null`). `bun test src/core/markdown/plugins/remarkWikilink.test.ts` passes.

---

### Task 5: `remarkBlockId` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkBlockId.ts`
- Create: `src/core/markdown/plugins/remarkBlockId.test.ts`

**Objective:** Detect a trailing `^id` marker on the last text child of a `paragraph` or `listItem` node, attach `blockId` to the node, and remove the marker token from the text.

**Invariants:** The marker matches `\s\^([A-Za-z0-9_-]+)\s*$` (one whitespace boundary, hyphens/underscores allowed, no internal whitespace). Only the last text child is examined; markers buried mid-paragraph are not block IDs.

**Acceptance:** Tests cover paragraph with trailing `^id`, list item with trailing `^id`, paragraphs without an ID (no `blockId` attached), and that the `^id` token is stripped from the visible text. `bun test src/core/markdown/plugins/remarkBlockId.test.ts` passes.

---

### Task 6: `remarkTag` plugin

**Files:**
- Create: `src/core/markdown/plugins/remarkTag.ts`
- Create: `src/core/markdown/plugins/remarkTag.test.ts`

**Objective:** Parse `#tag` and `#tag/sub/leaf` annotations into custom `tagRef` phrasing nodes.

**Invariants:** Must be preceded by start-of-string or whitespace (no URL-fragment false positives like `https://x.com#frag`). Must NOT match inside `inlineCode` or `code`. Must NOT match a markdown heading line (remark already handles those as `heading` nodes).

**Acceptance:** Tests cover simple `#concept`, nested `#concept/auth/oauth`, code-span exclusion, fenced-block exclusion, URL-fragment rejection, and heading-line rejection. `bun test src/core/markdown/plugins/remarkTag.test.ts` passes.

---

### Task 7: Wire all three plugins into the pipeline

**Files:**
- Modify: `src/core/markdown/pipeline.ts`
- Modify: `src/core/markdown/pipeline.test.ts`

**Objective:** Register `remarkWikilink`, `remarkBlockId`, `remarkTag` in `getMarkdownPipeline()` between `remarkGfm` and `remarkStringify`.

**Acceptance:** Add a pipeline test that walks the golden fixture's AST and asserts non-zero counts of `wikiLink`, `wikiEmbed`, `tagRef` nodes and at least one node carrying `blockId`. Existing memoisation and round-trip tests still pass. `bun test src/core/markdown/pipeline.test.ts` passes.

---

### Task 8: Heading slug helper

**Files:**
- Create: `src/core/markdown/slug.ts`
- Create: `src/core/markdown/slug.test.ts`

**Objective:** Provide `headingSlug(text: string): string` matching Obsidian's heading-slug rules (lowercase, whitespace → dashes, punctuation stripped, non-ASCII letters preserved lowercased).

**Acceptance:** Tests cover lowercase + dashes, punctuation stripping (`What's New?` → `whats-new`), whitespace collapsing, non-ASCII preservation (`Café` → `café`), and empty-string input. `bun test src/core/markdown/slug.test.ts` passes.

---

### Task 9: Markdown extractor (AST → MarkdownExtraction)

**Files:**
- Create: `src/core/markdown/extractor.ts`
- Create: `src/core/markdown/extractor.test.ts`
- Create: `src/core/markdown/__fixtures__/edge-cases.md`

**Objective:** Implement `extract(ast: Root, notePath: string): MarkdownExtraction`. Walk the AST once, emit blocks (H1-H3 only, plus one block per paragraph/list-item with a `^block-id`), wikilinks (with embeds flagged via `isEmbed`), tags, frontmatter refs (recursive walk of YAML, collecting `[[...]]` from string and array values, including nested keys like `notient.contradicts`), `frontmatter` object, `bodySha` (SHA-256 of joined block text), and `wordCount`.

**Invariants:**
- H4-H6 do NOT produce their own blocks. Their text rolls into the nearest H3 ancestor block, and their heading text appends to that block's `headingPath`.
- The `^block-id` block sits alongside the heading block under which it appears; it inherits `headingPath` from the heading stack.
- Each `wikilinks[i]` carries `fromBlockOrd` so the indexer can attribute the edge's `in` side correctly.
- Frontmatter walker recurses into nested objects and arrays; the key is dotted (`notient.contradicts`).
- The fixture `__fixtures__/edge-cases.md` includes frontmatter with string-, array-, and nested-object-shaped wikilink containers, H4 and H5 below the cap, paragraphs with `^block-id`, and heading-qualified plus block-qualified wikilinks. The agent generates the fixture content; do not copy any prescribed body.

**Acceptance:** Tests verify (a) only H1/H2/H3 produce heading blocks, (b) H4-H6 text rolls into the nearest H3 block, (c) `^block-id` paragraphs produce a separate block, (d) wikilinks carry `targetHeading` and `targetBlockId` correctly, (e) frontmatter refs include nested keys, (f) `wordCount > 0` and `bodySha` matches `^[a-f0-9]{64}$`. Add `yaml` to deps if missing. `bun test src/core/markdown/extractor.test.ts` passes.

---

### Task 10: Wikilink resolver

**Files:**
- Create: `src/core/markdown/resolver.ts`
- Create: `src/core/markdown/resolver.test.ts`

**Objective:** Implement `resolveTargets(fromNotePath, unresolved[], vaultPaths[]) → resolved[]`. Each input has `rawTarget`, `targetHeading`, `targetBlockId`. Each output adds `targetPath: string | null`.

**Invariants:**
- Resolution order: (1) exact path match (with or without `.md` suffix), (2) basename match if no `/` in raw, with multi-match disambiguation by folder edit-distance to `fromNotePath`'s folder.
- Unresolved targets get `targetPath = null`. The CALLER (Tier 1 indexer) is responsible for persisting the raw target on the edge as `target_unresolved` (Locked decision 7); this resolver never throws on unresolved.

**Acceptance:** Tests cover exact path, exact path with `.md` suffix, basename with folder-distance disambiguation, basename ambiguous with no folder context, and unresolved-returns-null. `bun test src/core/markdown/resolver.test.ts` passes.

---

### Task 11: Tier 1 DAL extensions in `surreal.ts`

**Files:**
- Modify: `src/core/db/surreal.ts`

**Objective:** Add the typed DAL methods Tier 1 needs: `lookupNoteByPath`, `lookupBlockByHeading`, `lookupBlockByExplicitId`, `replaceBlocks` (delete-then-insert keyed on `block.note`), `clearTier1Edges` (deletes only deterministic-source edges originating from this note or any of its blocks), `relateEdge` (typed `EdgeTable` enum gate; accepts a `target_unresolved?: string | null` parameter so unresolved wikilink/embed edges round-trip), `upsertNoteByPath`, `upsertTag`, `markTier1Done`. Reuse `EDGE_TABLES` from Phase 1.

**Invariants:**
- `relateEdge` rejects unknown table names at runtime.
- `relateEdge` writes `target_unresolved` to the edge row when supplied; null/undefined means "resolved" and the field stays unset.
- `clearTier1Edges` is scoped: it deletes `wikilink`, `embed`, `frontmatter_ref`, `tagged`, `contained_in`, `under_heading` edges where `in` is the note or one of its blocks. It does not touch extractor/linker/user edges.

**Acceptance:** `bun run typecheck` is clean. The methods compile against the Phase 1 SurrealDB SDK types; `RecordId<"note">`, `RecordId<"block">`, `RecordId<"tag">` flow through correctly. No runtime tests in this task; the integration smoke in Task 12 exercises them.

---

### Task 12: Tier 1 indexer

**Files:**
- Create: `src/core/indexer/tier1.ts`
- Create: `src/core/indexer/tier1.test.ts`

**Objective:** Implement `runTier1(db, { notePath, source, vaultPaths }) → { noteId, extraction }`. Parse the source via the markdown pipeline, run the extractor, resolve wikilinks and frontmatter refs, then inside a single `BEGIN/COMMIT` transaction: upsert the note, replace blocks, clear Tier 1 edges for this note, write `contained_in` (block→note) and `under_heading` (block→nearest-heading-block) structural edges, write wikilink/embed edges, write frontmatter-ref edges, upsert tags and write `tagged` edges, then `markTier1Done`. Roll back on any error.

**Invariants:**
- Unresolved wikilinks and embeds MUST persist with `target = NONE` and `target_unresolved = '<rawTarget>'` (Locked decision 7). Do NOT skip them with `continue`. Phase 5's `links audit` is downstream and depends on this; if you skip unresolved wikilinks here, audit cannot work.
- All `tagged` edges MUST have `source = 'structure'`, NOT `'wikilink'` (Locked decision 8). Tests must assert the exact source value, not just edge existence.
- Wikilink edges where the target is a known note get `source = 'wikilink'`. Embed edges get `source = 'embed'`. Frontmatter-ref edges get `source = 'frontmatter'`. Structural edges (`contained_in`, `under_heading`) get `source = 'structure'`.
- Each wikilink's `from` is the block matching `fromBlockOrd`, falling back to the note when the link sits at note-level (e.g. inside frontmatter or before any heading).
- A wikilink with `targetBlockId` resolves to the explicit block; with `targetHeading` resolves to the heading block via `headingSlug`; otherwise resolves to the note. If the note resolves but the heading/block does not, fall back to the note.
- Heading-qualifier slugging matches the rule from Task 8.

**Acceptance:** Tier 1 integration test (`tier1.test.ts`) starts a real SurrealDB via `startSurreal`, applies the schema, pre-creates `other.md` and `also.md` notes, then calls `runTier1` on a fixture note containing `[[other]]`, `[[also#section]]`, `[[non-existent-target]]`, `^para-1`, `#topic/sub`, and a frontmatter `related: "[[other]]"`. The test must assert:

1. The `block` table contains rows for the note, including one with `block_id = 'para-1'`.
2. The `wikilink` table contains a row pointing from the note (or its block) to `other.md`.
3. **An integration test demonstrates that a `[[non-existent-target]]` in a note produces a `wikilink` row with `target = NONE` and `target_unresolved = 'non-existent-target'`.** Phase 5's `links audit` is downstream and depends on this; if you skip unresolved wikilinks here, audit cannot work.
4. **An integration test asserts the `source` field of a created `tagged` edge is exactly `'structure'`** (literal-string equality, not a `length > 0` check).
5. The `tag` table has a row with `path = 'topic/sub'`.
6. A `frontmatter_ref` edge exists from the note to `other.md`.
7. Re-running `runTier1` on the same path replaces blocks deterministically (delete-then-insert; before/after counts match).
8. If the transaction body throws (simulate by passing a malformed input), `tier1_at` does not advance and no partial blocks are inserted.

`bun test src/core/indexer/tier1.test.ts` passes.

---

### Task 13: Wire Tier 1 into existing `indexNote.ts`

**Files:**
- Modify: `src/core/indexer/indexNote.ts`

**Objective:** Prepend a Tier 1 invocation inside `indexNote` so every note that hits the existing chunk/embed/extract/linker flow first runs through `runTier1` against SurrealDB. The existing SQLite-backed flow continues unchanged afterward.

**Invariants:**
- Tier 1 errors must NOT block Tier 2/3. Wrap the call, emit `indexer:error` with `phase: 'tier1'` on failure, and continue.
- Vault path snapshot for the resolver: query the existing vault facade or the SQLite `notes` table to pass `vaultPaths`. Add a thin helper if no facade method exists.
- Emit `indexer:tier1-done` on success for downstream observers.

**Acceptance:** The agent first reads `src/core/indexer/indexNote.ts` to identify the entry point and the SHA-change guard, then prepends the Tier 1 step at the right spot. `bun test` passes (all existing Phase D1 tests, plus Tier 1 tests). Commit `indexNote.ts` only.

---

### Task 14: Watcher gains `unlink` listener

**Files:**
- Modify: `src/daemon/watcher.ts`
- Modify: `src/daemon/watcher.test.ts`

**Objective:** Subscribe to `chokidar`'s `unlink` event. On unlink, set `note.tombstoned_at = time::now()` and schedule a 60-second cascade-delete via `setTimeout(...).unref()`. The cascade only fires if the row is still tombstoned at fire-time (i.e. not resurrected via rename).

**Invariants:**
- The cascade explicitly deletes the note row and its blocks/edges. SurrealDB does not auto-cascade.
- Emit `indexer:tombstoned` on tombstone.

**Acceptance:** A test triggers `fs.unlinkSync` on a known file inside a daemonised temp vault and asserts `note.tombstoned_at` becomes non-null within 200ms. The agent reads the existing `watcher.test.ts` to match its harness pattern (temp vault, daemon spin-up). `bun test src/daemon/watcher.test.ts` passes.

---

### Task 15: Rename detection within 60-second SHA-match window

**Files:**
- Modify: `src/daemon/watcher.ts`
- Modify: `src/daemon/watcher.test.ts`

**Objective:** On the watcher's `add` handler, before normal new-note enqueue, check for a tombstoned note row with the same body SHA whose `tombstoned_at > time::now() - 60s`. If a match exists at a different path, update the path, clear `tombstoned_at`, emit `indexer:renamed`, and re-enqueue Tier 1 for the new path (because path-based wikilink resolution may have shifted).

**Invariants:**
- The SHA-match window is exactly 60 seconds; outside the window, a same-SHA add is treated as a new note.
- `change` events are unaffected.

**Acceptance:** Test creates note A, unlinks it, writes the same body to a new path B within 1 second, and asserts (a) the note id is preserved, (b) `path = B`, (c) `tombstoned_at IS NONE`. `bun test src/daemon/watcher.test.ts` passes.

---

### Task 16: Phase 2 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/tier1.smoke.test.ts`

**Objective:** End-to-end smoke that spins up a real SurrealDB via `startSurreal`, applies the schema, runs `runTier1` against a small fixture vault, and asserts wikilinks/tags/blocks exist as expected.

**Invariants:**
- The smoke must include at least one unresolved wikilink and assert it persists with `target = NONE` and `target_unresolved` populated.
- The smoke must assert a `tagged` edge has `source = 'structure'`.

**Acceptance:** `bun test src/daemon/__smoke__/tier1.smoke.test.ts` passes. The smoke validates the two locked-decision invariants (7 and 8) end-to-end against a real database.

---

### Task 17: Phase 2 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-2-vault-enrichment-handoff.md`

**Objective:** Write a handoff under 80 lines describing what shipped (markdown pipeline + 3 plugins, MarkdownExtraction walker, resolver, Tier 1 indexer wired into indexNote, watcher unlink + rename detection, unresolved-wikilink persistence, tag-source `'structure'` invariant), what is deferred (Tier 2 still SQLite, Tier 3 still SQLite, write-back unchanged, awaken control plane unchanged), and Phase 3's entry point (priority queue + Tier 2 chunk/embed migration to SurrealDB native HNSW, Tier 3 retargeted, hnswlib-wasm deletion).

**Acceptance:** Handoff is ≤80 lines, references the two correctness invariants explicitly so Phase 5's `links audit` planner can confirm prerequisites. Commit only the handoff file.

---

## Self-review

- Spec §3.2 block schema: covered by Task 9 (extractor BlockSpec) + Task 11 (`replaceBlocks` DAL).
- Spec §3.4 deterministic edge tables: covered by Tasks 11 + 12 (`relateEdge`, structural + wikilink + frontmatter + tag edges).
- Spec §5.2 Tier 1: covered by Task 12 (orchestrator) + Task 13 (wiring).
- Spec §5.5 watcher: covered by Tasks 14 + 15 (unlink + rename).
- Spec §8.1 markdown pipeline: covered by Tasks 3 + 7.
- Spec §8.2 extractor: covered by Task 9.
- Spec §8.3 wikilink resolution: covered by Task 10 (resolver) + Task 12 (heading/block lookup at indexer time).
- H3 cap: enforced in Task 9 extractor.
- Locked decision 7 (unresolved wikilinks persist): enforced in Tasks 10, 11, 12, 16.
- Locked decision 8 (tag edges have `source = 'structure'`): enforced in Tasks 11, 12, 16.
- Type consistency: `MarkdownExtraction` (Task 2) consumed by `extract` (Task 9) and `runTier1` (Task 12). `BlockSpec` flows from extractor through `replaceBlocks` (Task 11). `EDGE_TABLES` from Phase 1 consumed by `relateEdge` (Task 11).

---

## Execution

Phase 2 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-2.md`. Execute in a fresh Notient session via `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Phase 1 must ship green first (`docs/superpowers/handoffs/2026-04-29-phase-1-vault-enrichment-handoff.md` confirms readiness).
