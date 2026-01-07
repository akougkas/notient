# Phase 3: INTELLIGENCE — Tiered Semantic Chunking, Hierarchical Embeddings, Multi‑Pass Note Intelligence (Implementation Prompt)

> **AI Coding Agent**
> You are implementing **Notient Phase 3** in `/home/akougkas/projects/notient`.
> **Do not redesign Phase 1.8/Phase 2 architecture. Extend it.**

## Context (Phase 2 Complete → Phase 3 Starts Now)

Notient is a **local‑only** Obsidian community plugin (desktop/Electron) written in **TypeScript (strict)** and built with **Bun + esbuild + Biome**.

By Phase 2, Notient already has:
- **LLM abstraction** (`src/core/llm/`) with streaming + reranking (LM Studio).
- **Embeddings** via Ollama (`src/services/ollama.ts`).
- **Indexer** (`src/core/indexer/simpleIndexer.ts`) producing chunks via `src/core/indexer/simpleChunker.ts`.
- **Vector store** (`src/services/simpleVectorStore.ts`) brute‑force cosine + JSON persistence (`index-{modelKey}.json`, `meta.version = 1`).
- **SearchPipeline** (`src/core/search/pipeline.ts`) doing: query embed → vector search → group by note → LLM rerank **notes** (by first chunk).
- **Agentic system** (Phase 2): trust levels + propose/review/apply + undo + bulk workflows + persistence.

Phase 3 is where Notient “flies”: the system needs **real intelligence pipelines** driven by **hierarchical semantics**, not just flat chunk vectors.

---

## Problem Statement

### Current limitations (must be addressed)

1. **Flat index**
   - Current index stores “chunks” only; no **note‑level** vectors and no **hierarchy** (note → section → block).
   - Reranking is performed at the **note level** using `text = chunks[0]?.text`, which is often the wrong snippet for relevance.

2. **Chunking is structural‑light**
   - `simpleChunker.ts` splits at **H1/H2 only**, then paragraph boundaries, with char‑based limits.
   - Obsidian markdown features (callouts, tasks, code fences, tables, block refs) are not represented as first‑class blocks.
   - YAML frontmatter parsing is a simplistic line parser, losing structure.

3. **No “note intelligence memory”**
   - There’s no persisted store of derived intelligence (summaries, entities, tag/link suggestions, health diagnostics).
   - Phase 2 can apply actions safely, but Phase 3 lacks the intelligence to propose *high‑value* actions reliably.

### Phase 3 thesis

Implement **Tiered Semantic Chunking** to build **hierarchical embeddings**, then use a **multi‑stage retrieval + chunk‑level reranking** pipeline to power **multi‑pass note processing**:

**Parse → Tiered semantic chunks → Hierarchical embeddings → Hierarchical retrieval → Rerank chunks → Intelligence passes (classify/enrich/link/triage/health).**

---

## Non‑Negotiables (Constraints)

### Privacy & runtime
- **Local‑only**: only local LM Studio + local/remote-on-LAN Ollama. No cloud APIs.
- **Desktop-only** (Obsidian FileSystemAdapter assumed).

### Engineering
- **Bun-only** workflows (`bun run build`, `bun run typecheck`, `bun run lint`).
- Keep the **Phase 1.8 boundaries** and Phase 2 trust system; extend via new modules/services.
- Keep **sequential agent task execution** (one at a time).
- Avoid heavy dependencies; prefer **Obsidian APIs** and small, deterministic utilities.

### UX / Safety
- Phase 3 outputs are primarily **suggestions** and **structured proposals** that flow through Phase 2 trust gates.
- The user must stay “human in the steering wheel”.

---

## Phase 3 Deliverables (Exit Criteria)

### 1) Tiered Semantic Index (TSI v2)
- A new chunker that produces **tiered chunks**:
  - **Tier 0: Note** (one per note) — global semantics
  - **Tier 1: Section** (per heading node) — mid‑level semantics
  - **Tier 2: Block** (semantic blocks) — fine‑grained retrieval
- Persisted index schema is upgraded to **`meta.version = 2`** with backward compatibility and/or migration path.

### 2) Hierarchical Retrieval + Chunk‑Level Reranking
- Search becomes:
  1) Retrieve candidate **notes** (Tier 0)
  2) Retrieve best **sections/blocks** within candidates (Tier 1/2)
  3) **Rerank chunks** using LM Studio
  4) Aggregate back to **note results with best supporting chunks**
- Citations become precise: `[[Note Title#Heading]]` and/or block refs when available.

### 3) Multi‑Pass Note Intelligence Pipelines
Build a persisted intelligence layer that runs in background:
- **Summaries** (short + structured)
- **Entity/keyword extraction**
- **Suggested tags**
- **Suggested links (with preview)**
- **Inbox triage workflow**
- **Note health scoring algorithm**

---

## Key Concepts

### Tiered Semantic Chunking (TSC)

Tiered semantic chunking combines:
- **Structural chunking** (markdown hierarchy + Obsidian blocks)
- **Size control** (token/char budgets)
- **Semantic refinement** (embedding similarity to find topic breaks, selectively)

This yields chunks that are:
- semantically coherent
- context‑rich (title/heading/tag context)
- stable across edits (as much as possible)
- addressable for citations

### Hierarchical Embeddings

Embeddings exist at multiple levels:
- Note-level: “What is this note about?”
- Section-level: “What is this part about?”
- Block-level: “Where is the exact answer?”

Hierarchical embeddings enable:
- broad recall (note tier)
- precision (block tier)
- better reranking candidates (chunk rerank)
- better context assembly (include only the best blocks)

---

## Current Code Reality (Anchor Points)

### Indexing today
- Chunking: `src/core/indexer/simpleChunker.ts`
  - H1/H2 sections → paragraph splits → store `NoteChunk`
  - tags from YAML + inline `#tag` regex
  - frontmatter parsed by a minimal key:value parser
- Indexing orchestration: `src/core/indexer/simpleIndexer.ts`
- Persistence:
  - vectors: `src/services/simpleVectorStore.ts` (`index-{modelKey}.json`, `meta.version=1`)
  - state: `src/services/indexManager.ts` (`state-{modelKey}.json`, version=1)

### Search today
- `src/core/search/pipeline.ts`:
  - query embed → vector search over *all chunks* → group by note → rerank **notes** using first chunk text

Phase 3 must evolve this without breaking Phase 1.8/2 assumptions.

---

## Design Decisions (Follow Exactly)

### 1) Index stays file-backed JSON (for now)
- Keep the “portable JSON” philosophy.
- Upgrade schema version to v2 and preserve a safe migration path.

### 2) Chunk tiers are explicit fields (not inferred)
- Every stored vector doc must declare its **tier** and **kind**.

### 3) Semantic chunking is *selective*
- Default: structure-first chunking (fast).
- Semantic refinement is applied only when it meaningfully improves quality:
  - long notes/sections
  - “headingless” notes
  - inbox notes
  - user-configurable “high value” folders

### 4) Hierarchy uses parent pointers (tree)
- Block → parent section
- Section → parent note
- Parent pointers enable:
  - context expansion
  - aggregation (per-note/per-section)
  - stable citations

### 5) Reranking happens at chunk-level
- LM Studio reranks **chunks** (block/section), not whole notes.
- Notes are scored by the best supporting chunks.

---

## Tiered Semantic Chunking Spec (Obsidian Markdown + YAML Frontmatter)

### A) Parsing (Obsidian-first)

Phase 3 must treat Obsidian notes as:
- YAML frontmatter (properties)
- Markdown body with Obsidian‑specific constructs:
  - wikilinks: `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`
  - embeds: `![[Note]]`, `![[Note#Heading]]`
  - block refs: `^block-id`
  - callouts: `> [!info] ...`
  - tasks: `- [ ]`, `- [x]`
  - code fences: ```...```
  - tables, quotes, lists

**Frontmatter parsing rule:**
- Do not maintain a custom YAML parser.
- Use an Obsidian API helper (preferred) or Obsidian metadata cache:
  - `metadataCache.getFileCache(file)?.frontmatter`
  - `parseYaml()` if available in Obsidian API

**Metadata fields to extract (minimum):**
- `tags` (frontmatter + inline)
- `aliases`
- `title` (if provided)
- `created`, `updated` (if present)
- `status`, `type`, `source` (common Obsidian properties)
- any user-defined fields should be kept raw for filtering, but only a curated subset is injected into embedding text

### B) Block extraction (structure-first)

Represent note body as a stream of blocks, each with:
- `kind`: `"heading" | "paragraph" | "list" | "taskList" | "callout" | "quote" | "code" | "table" | "hr" | "embed" | "blank" | "other"`
- `startLine`, `endLine`
- `rawText`
- optional `blockRef` (detected `^id` line or trailing)

**Block rules:**
- Code fences must be a single block, never split internally.
- Callouts and blockquotes must be preserved as cohesive blocks.
- Lists should be chunked as list-blocks (group contiguous list items).
- Tables should be preserved as a single block when small; split by row groups if huge.

### C) Section tree (heading hierarchy)

Build a heading tree from H1–H6:
- Each section node has `heading`, `level`, `headingPath`, and a list of child blocks.
- The “preamble” (before first heading) is a section node with empty heading.

### D) Tier definitions (TSI v2)

#### Tier 0 — Note chunk
Exactly 1 per note.

Purpose: broad retrieval / clustering / dedupe / routing.

**Embedding text recipe (default):**
- Title (resolved)
- Path (optional, low weight)
- Selected frontmatter fields (tags/aliases/type/status)
- Outline (top headings, flattened)
- A short “content sketch” (first N blocks, excluding huge code)

#### Tier 1 — Section chunks
One per meaningful section node (H1–H3 by default; configurable).

Purpose: mid‑level retrieval, better than whole note.

Embedding text recipe:
- Note title + selected metadata
- Section headingPath
- Section text (bounded by max size)

#### Tier 2 — Block chunks (semantic blocks)
Blocks (paragraph/list/callout/code/table/etc.) inside a section.

Purpose: pinpoint retrieval + citations.

Embedding text recipe:
- Note title + selected metadata
- Section headingPath
- Block text

### E) Size control (token/char budgets)

Tiered chunking must enforce size budgets:
- Block tier max: ~256–512 tokens (or a conservative char proxy like 1200–2400 chars)
- Section tier max: larger, but bounded (e.g., ~800–1200 tokens)
- Note tier: bounded “sketch” (don’t embed entire vault novels)

If tokenization is not available, use a deterministic proxy:
- `tokenEstimate ≈ Math.ceil(text.length / 4)`

### F) Semantic refinement (selective rolling similarity)

For large, headingless, or messy sections:
1. Start from candidate units (paragraph blocks / sentences).
2. Embed each unit (cheap embeddings) and compute adjacent cosine similarity.
3. Split when similarity drops below a threshold, e.g. **0.75–0.82**.
4. Merge tiny fragments to satisfy minimum chunk size.

Optimization rules:
- Only run semantic refinement when `tokenEstimate(section) > threshold`.
- Cache unit embeddings during chunking of a single note.
- Never run semantic refinement on code fences by default.

---

## Hierarchical Embeddings Strategy

### Default (fast): embed tiers directly + optional parent pooling
- Embed Tier 0/1/2 texts directly using Ollama embeddings.
- Optionally compute parent vectors by pooling children:
  - `sectionVector = normalize(mean(blockVectors))`
  - `noteVector = normalize(mean(sectionVectors))`

Pooling is optional but helpful when you want to reduce embedding calls.

### Optional (high quality): summary embeddings (background)
In a background intelligence pass:
- Generate note and section summaries via LM Studio.
- Embed summaries (small, dense, semantic) and store as additional vectors or metadata.

### Future (research): “late chunking”
Reference idea (not required for Phase 3 default):
- Late chunking (embed long context, pool by chunk after transformer) can improve chunk representations with long-context embedding models.
  - See: “Late Chunking: Contextual Chunk Embeddings Using Long‑Context Embedding Models” (arXiv: 2409.04701)

---

## Index Schema v2 (Persistence)

### A) New fields on stored docs

Extend `NoteChunk` / `EmbeddedChunk` semantics to include:
- `tier`: `"note" | "section" | "block"`
- `kind`: block/section kind (see block kinds)
- `parentChunkId`: `string | null`
- `blockRef`: `string | null` (Obsidian `^id` if present)
- `startLine`, `endLine` (for citations + preview)
- `tokenEstimate` (for size control)
- `importance` (optional heuristic score for retrieval weighting)

### B) Persisted index meta changes

Upgrade `SimpleVectorStore` persisted JSON:
- `meta.version = 2`
- include:
  - `chunker: { name: "tiered-semantic", version: 1 }`
  - `tiers: { note: true, section: true, block: true }`
  - `createdAt` should remain stable; `updatedAt` changes

### C) Migration strategy

Acceptable migration behavior (choose one; be explicit in implementation):

**Option 1 (simplest): hard migration**
- If `meta.version !== 2`, the plugin marks index as stale and requires **full reindex**.
- Pros: simplest, least bug surface.
- Cons: reindex time.

**Option 2 (compat mode): mixed read**
- Load v1 docs as `tier="section"` with `parentChunkId=null`.
- Search falls back to old behavior when tiered docs absent.
- Still recommend background rebuild.

Phase 3 can implement Option 1 first (recommended).

---

## Retrieval & Reranking v3 (Hierarchical Search)

### A) Query routing (lightweight)

Add a small query router that classifies a query into one of:
- `broad` (topic exploration)
- `pinpoint` (find exact snippet / definition / quote)
- `linking` (find related notes to connect)
- `triage` (inbox cleanup, status sorting)

Routing heuristics:
- length, presence of quotes/code, slash commands, question type.
- Optional: LM Studio classification for ambiguous queries (cached).

### B) Multi-stage retrieval (default plan)

**Stage 1: Candidate notes (Tier 0)**
- Search Tier 0 note vectors across vault to get top `M` notes (e.g. 40–80).
- Apply light boosts:
  - title match boost (already exists in vector store lexical boost)
  - recency boost (small)
  - shared tags boost (small)

**Stage 2: Candidate chunks within candidates (Tier 1/2)**
- Search Tier 2 (block) vectors restricted to those candidate noteIds.
- Keep:
  - global top `K` chunks (e.g. 60–120)
  - max `kPerNote` chunks per note (e.g. 3–5)
- Include parent section metadata for each chunk.

**Stage 3: LM Studio rerank (chunk-level)**
- Rerank candidate chunks, not notes.
- Candidate text passed to reranker must be **contextual**:
  - Title
  - Heading path
  - Block text (truncated to safe budget)
  - Selected frontmatter tags/aliases (small)

**Stage 4: Aggregate to notes**
- Note score = max(rerankedChunkScore) + small diversity bonuses.
- Provide top supporting chunks per note with reasons.

### C) Context assembly for LLM answers (RAG formatting)

When the agent needs context:
- Use top reranked chunks.
- For each chunk include:
  - `[[Note Title#Heading]]` citation
  - blockRef citation if available: `[[Note Title#^blockRef]]`
  - chunk text
  - optionally parent section summary (if available)

Keep final context small and high-signal.

---

## Multi‑Pass Note Intelligence Pipelines (Phase 3 Core)

### A) New persisted store: Intelligence DB

Add a new file under plugin storage:
- `intelligence-{modelKey}.json` (recommended) or `intelligence.json` (simpler)

Each record keyed by `noteId` and `path`, with:
- `mtimeMs`, `contentHash`
- `summaryShort`, `summaryStructured`
- `entities` (people/projects/tools/concepts)
- `suggestedTags` (ranked)
- `suggestedLinks` (ranked targets + reason + suggested anchor)
- `health` (score + breakdown)
- `generatedAt`, `modelKey`

### B) Passes (run in background, incremental)

**Pass 0 — Index (embeddings)**
- Existing indexer, upgraded to tiered chunker.

**Pass 1 — Summarize**
- Generate:
  - 1–2 sentence summary
  - bullet key points
  - “what this note is for”

**Pass 2 — Extract & suggest**
- Entities/keywords
- Suggested tags (respect existing tags; propose only additions/removals)
- Suggested frontmatter fields (low-risk proposals)

**Pass 3 — Link intelligence**
- Use hierarchical retrieval to find:
  - top related notes
  - missing backlinks opportunities
  - duplicate/near-duplicate detection signals
- Produce proposals:
  - add `[[links]]` in a “Related” section
  - add link mentions inline (medium risk)

**Pass 4 — Inbox triage**
- For notes in configured inbox folder(s):
  - propose PARA classification
  - propose move target folder (medium risk)
  - propose status updates (low risk)
  - propose missing metadata (low risk)

**Pass 5 — Note health scoring**
- Compute a health score (0–100) with breakdown:
  - freshness (mtime)
  - connectivity (links/backlinks)
  - structure (headings, completeness)
  - metadata hygiene (frontmatter presence/consistency)
  - duplication risk

All passes:
- Must be cancellable.
- Must respect Phase 2 trust gates for applying changes.
- Should be rate-limited and run on idle where possible.

---

## Implementation Plan (Step-by-step)

### Step 1 — Types & schema versioning
- Introduce tier fields in indexer types (or new types alongside v1).
- Add `meta.version = 2` for the vector index.
- Decide migration strategy (Option 1 recommended).

### Step 2 — Implement Tiered Semantic Chunker
- Add a new chunker module (example name):
  - `src/core/indexer/tieredSemanticChunker.ts`
- Keep `simpleChunker.ts` as fallback for migration/debug.
- Ensure chunk IDs are stable and include tier/kind signals.

### Step 3 — Update VectorStore to store tier metadata
- Extend `StoredDoc` / `PersistedDoc` with tier fields.
- Extend `SearchOptions` to support:
  - `tier?: ChunkTier | ChunkTier[]`
  - `noteIds?: string[]` (restrict search)
  - `maxPerNote?: number` (optional)

### Step 4 — Upgrade SearchPipeline to hierarchical retrieval
- Add staged retrieval (Tier 0 then Tier 2).
- Swap reranking input from note-level to chunk-level.
- Aggregate results to notes with “best supporting chunks”.

### Step 5 — Intelligence DB + background jobs
- Add a new service (example):
  - `src/core/intelligence/noteIntelligence.ts`
- Hook into:
  - index completion events
  - file modify events (debounced)
  - inbox workflow triggers
- Persist intelligence records to disk (with retention rules).

### Step 6 — UI surfaces for suggestions (Phase 3 minimal UX)
- Display:
  - note summary + health breakdown in Note tab
  - suggested tags/links with preview
  - apply buttons gated by trust level
- Search results should show:
  - best chunk snippet + heading path
  - reasoning from reranker (already supported)

### Step 7 — Evaluation harness (developer-only, no telemetry)
- Add local evaluation script or debug command:
  - run a fixed set of queries
  - record top results and latency
  - compare before/after when tuning chunking thresholds

---

## Acceptance Criteria

### Tiered chunking
- Index produces Tier 0/1/2 vectors for notes.
- Obsidian constructs (code fences, callouts, tasks, block refs) do not get mangled.

### Retrieval quality
- For “pinpoint” queries, search returns notes with correct **supporting snippets** (block tier).
- Reranking reasoning aligns with displayed snippet (no “wrong first chunk” problem).

### Performance
- Vector search remains fast (<100ms typical vault sizes).
- Tiered retrieval does not exceed Phase 1 performance targets materially.

### Safety & UX
- Suggested changes flow through Phase 2 trust gates.
- Undo remains functional for applied changes.

---

## Risks & Mitigations

- **Index bloat (too many block vectors)**:
  - cap blocks per note/section
  - only block-embed long sections
  - dedupe near-identical blocks
- **Chunk instability across edits**:
  - prefer structural boundaries
  - keep chunk IDs derived from stable anchors (heading path + blockRef + contentHash prefix)
- **Semantic chunking cost**:
  - selective refinement + caching
  - background processing
- **Frontmatter parsing complexity**:
  - rely on Obsidian parsing APIs/cache instead of custom YAML parsing

---

## References (for background reading)

- Late chunking: “Late Chunking: Contextual Chunk Embeddings Using Long‑Context Embedding Models” (arXiv: 2409.04701)
- Semantic chunking best practices (structure + coherence) — see common RAG guidance from vector DB vendors (Weaviate/Pinecone) and practical writeups
- Hierarchical/tree retrieval patterns (RAPTOR-style summaries, parent/child retrieval) — conceptual guidance for building multi-level semantic indexes

