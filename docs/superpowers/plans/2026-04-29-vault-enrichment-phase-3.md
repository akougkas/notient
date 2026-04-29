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

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { PriorityQueue } from "./priorityQueue";

describe("PriorityQueue", () => {
  test("dequeues highest priority first (lowest number)", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("c", 2, 1);
    q.enqueue("a", 0, 2);
    q.enqueue("b", 1, 3);
    expect(q.dequeue()).toBe("a");
    expect(q.dequeue()).toBe("b");
    expect(q.dequeue()).toBe("c");
    expect(q.dequeue()).toBeNull();
  });

  test("ties broken by enqueuedAt (FIFO within same priority)", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("first", 1, 100);
    q.enqueue("second", 1, 200);
    q.enqueue("third", 1, 300);
    expect(q.dequeue()).toBe("first");
    expect(q.dequeue()).toBe("second");
    expect(q.dequeue()).toBe("third");
  });

  test("size and isEmpty", () => {
    const q = new PriorityQueue<string>();
    expect(q.isEmpty()).toBe(true);
    expect(q.size()).toBe(0);
    q.enqueue("x", 0, 1);
    expect(q.size()).toBe(1);
    expect(q.isEmpty()).toBe(false);
  });

  test("countByPriority returns per-priority counts", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("a", 0, 1);
    q.enqueue("b", 0, 2);
    q.enqueue("c", 1, 3);
    q.enqueue("d", 2, 4);
    expect(q.countByPriority(0)).toBe(2);
    expect(q.countByPriority(1)).toBe(1);
    expect(q.countByPriority(2)).toBe(1);
  });

  test("remove by predicate", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("keep", 0, 1);
    q.enqueue("drop", 1, 2);
    q.enqueue("keep2", 1, 3);
    const removed = q.remove((v) => v === "drop");
    expect(removed).toBe(1);
    expect(q.size()).toBe(2);
    expect(q.dequeue()).toBe("keep");
    expect(q.dequeue()).toBe("keep2");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/core/indexer/priorityQueue.ts
interface Entry<T> { value: T; priority: number; enqueuedAt: number }

export class PriorityQueue<T> {
  private heap: Entry<T>[] = [];

  enqueue(value: T, priority: number, enqueuedAt: number): void {
    this.heap.push({ value, priority, enqueuedAt });
    this.siftUp(this.heap.length - 1);
  }

  dequeue(): T | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0].value;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  size(): number { return this.heap.length; }
  isEmpty(): boolean { return this.heap.length === 0; }

  countByPriority(priority: number): number {
    return this.heap.filter((e) => e.priority === priority).length;
  }

  remove(predicate: (value: T) => boolean): number {
    const before = this.heap.length;
    this.heap = this.heap.filter((e) => !predicate(e.value));
    // Re-heapify.
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) this.siftDown(i);
    return before - this.heap.length;
  }

  private compare(a: Entry<T>, b: Entry<T>): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.enqueuedAt - b.enqueuedAt;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.compare(this.heap[l], this.heap[smallest]) < 0) smallest = l;
      if (r < n && this.compare(this.heap[r], this.heap[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
```

- [ ] **Step 3: Run test, commit**

```bash
cd ~/projects/notient
bun test src/core/indexer/priorityQueue.test.ts
git add src/core/indexer/priorityQueue.ts src/core/indexer/priorityQueue.test.ts
git commit -m "feat(indexer): priority min-heap queue for tier-based ordering"
```

---

### Task 2: Refactor `IndexerQueue` to use the priority queue

**Files:**
- Modify: `src/core/indexer/indexerQueue.ts`
- Modify: `src/core/indexer/indexerQueue.test.ts`

- [ ] **Step 1: Read current `indexerQueue.ts`**

Run: `cd ~/projects/notient && cat src/core/indexer/indexerQueue.ts`
Note: existing `enqueue(path)` signature, debounce logic, `pendingCount()` API.

- [ ] **Step 2: Update test first**

Append to `src/core/indexer/indexerQueue.test.ts`:

```typescript
test("priority-zero work drains before priority-one work", async () => {
  const order: string[] = [];
  const queue = new IndexerQueue({
    debounceMs: 0,
    process: async (path: string) => { order.push(path); },
  });
  queue.enqueue("low", 1);
  queue.enqueue("high", 0);
  // Wait for debounce + processing.
  await new Promise((r) => setTimeout(r, 50));
  expect(order).toEqual(["high", "low"]);
});

test("pendingCount(priority) returns per-tier backlog", () => {
  const queue = new IndexerQueue({ debounceMs: 1000, process: async () => {} });
  queue.enqueue("a", 0);
  queue.enqueue("b", 0);
  queue.enqueue("c", 1);
  expect(queue.pendingCount(0)).toBe(2);
  expect(queue.pendingCount(1)).toBe(1);
  expect(queue.pendingCount(2)).toBe(0);
});
```

- [ ] **Step 3: Refactor `indexerQueue.ts`**

Replace the FIFO `ready` array with the `PriorityQueue<string>` and update `enqueue` / `pendingCount`:

```typescript
import { PriorityQueue } from "./priorityQueue";

export class IndexerQueue {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; priority: number }>();
  private readonly ready = new PriorityQueue<string>();
  // ... existing fields ...

  enqueue(path: string, priority: number = 2): void {
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(path);
      this.ready.enqueue(path, priority, Date.now());
      this.kickWorker();
    }, this.options.debounceMs);
    this.pending.set(path, { timer, priority });
  }

  pendingCount(priority?: number): number {
    if (priority === undefined) return this.pending.size + this.ready.size();
    let pendingMatch = 0;
    for (const v of this.pending.values()) if (v.priority === priority) pendingMatch++;
    return pendingMatch + this.ready.countByPriority(priority);
  }

  // runWorker:
  private async runWorker(): Promise<void> {
    while (!this.ready.isEmpty()) {
      const path = this.ready.dequeue();
      if (path === null) break;
      try {
        await this.options.process(path);
      } catch (error) {
        this.eventBus?.publish({ name: "indexer:error", payload: { path, error: String(error) } });
      }
    }
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
cd ~/projects/notient && bun test src/core/indexer/indexerQueue.test.ts
```
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/notient
git add src/core/indexer/indexerQueue.ts src/core/indexer/indexerQueue.test.ts
git commit -m "feat(indexer): priority-based queue with per-tier pendingCount"
```

---

### Task 3: Concurrency defaults

**Files:**
- Create: `src/core/indexer/concurrencyDefaults.ts`

- [ ] **Step 1: Implement**

```typescript
// src/core/indexer/concurrencyDefaults.ts
export const CONCURRENCY = {
  embed: 4,
  extract: 2,
} as const;

export const CHUNK = {
  targetTokens: 400,
  maxTokens: 800,
} as const;
```

- [ ] **Step 2: Commit (no test needed for constants)**

```bash
cd ~/projects/notient
git add src/core/indexer/concurrencyDefaults.ts
git commit -m "feat(indexer): concurrency + chunk size defaults"
```

---

### Task 4: AST-aware chunker

**Files:**
- Modify: `src/core/indexer/chunker.ts`
- Modify: `src/core/indexer/chunker.test.ts`

- [ ] **Step 1: New chunker shape**

The new `chunker.ts` consumes `BlockSpec[]` (from `MarkdownExtraction`) and produces `ChunkSpec[]`. Each chunk corresponds to a heading section, capped at `CHUNK.targetTokens` with a hard ceiling at `maxTokens`. Sections shorter than the cap merge with adjacent sections under the same H2/H1 if it stays under the cap.

```typescript
import type { BlockSpec } from "../markdown/types";
import { CHUNK } from "./concurrencyDefaults";

export interface ChunkSpec {
  ord: number;
  text: string;
  tokenEstimate: number;
  /** ord of the heading-block ancestor (the H3-or-shallower that bounds this chunk), or null if pre-heading. */
  blockOrd: number | null;
  /** start/end line spans. */
  startLine: number;
  endLine: number;
}

export function chunkBlocks(blocks: BlockSpec[]): ChunkSpec[] {
  if (blocks.length === 0) return [];

  // Group blocks into heading sections: a heading block starts a new section, all
  // following non-heading blocks belong to it until the next heading.
  interface Section { headingOrd: number | null; startLine: number; endLine: number; text: string }
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const b of blocks) {
    if (b.headingLevel !== null) {
      if (current) sections.push(current);
      current = { headingOrd: b.ord, startLine: b.startLine, endLine: b.endLine, text: b.text };
    } else {
      if (!current) {
        current = { headingOrd: null, startLine: b.startLine, endLine: b.endLine, text: "" };
      }
      current.text += "\n" + b.text;
      current.endLine = b.endLine;
    }
  }
  if (current) sections.push(current);

  // Now chunk each section: if it fits in targetTokens, one chunk. Otherwise split on
  // sentence boundaries until each chunk fits (max maxTokens).
  const chunks: ChunkSpec[] = [];
  let ord = 0;
  for (const section of sections) {
    const tokens = estimateTokens(section.text);
    if (tokens <= CHUNK.targetTokens) {
      chunks.push({
        ord: ord++, text: section.text.trim(), tokenEstimate: tokens,
        blockOrd: section.headingOrd, startLine: section.startLine, endLine: section.endLine,
      });
    } else {
      const sentences = splitSentences(section.text);
      let buffer: string[] = [];
      let bufferTokens = 0;
      for (const sentence of sentences) {
        const t = estimateTokens(sentence);
        if (bufferTokens + t > CHUNK.targetTokens && buffer.length > 0) {
          const text = buffer.join(" ").trim();
          chunks.push({
            ord: ord++, text, tokenEstimate: bufferTokens,
            blockOrd: section.headingOrd, startLine: section.startLine, endLine: section.endLine,
          });
          buffer = [];
          bufferTokens = 0;
        }
        if (t > CHUNK.maxTokens) {
          // Hard cap: split mid-sentence by whitespace.
          for (const piece of hardSplit(sentence, CHUNK.maxTokens)) {
            chunks.push({
              ord: ord++, text: piece.trim(), tokenEstimate: estimateTokens(piece),
              blockOrd: section.headingOrd, startLine: section.startLine, endLine: section.endLine,
            });
          }
        } else {
          buffer.push(sentence);
          bufferTokens += t;
        }
      }
      if (buffer.length > 0) {
        chunks.push({
          ord: ord++, text: buffer.join(" ").trim(), tokenEstimate: bufferTokens,
          blockOrd: section.headingOrd, startLine: section.startLine, endLine: section.endLine,
        });
      }
    }
  }
  return chunks;
}

function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function hardSplit(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let buffer: string[] = [];
  let buf = 0;
  const cap = maxTokens * 4;
  for (const w of words) {
    const len = w.length + 1;
    if (buf + len > cap && buffer.length > 0) {
      out.push(buffer.join(" "));
      buffer = [];
      buf = 0;
    }
    buffer.push(w);
    buf += len;
  }
  if (buffer.length > 0) out.push(buffer.join(" "));
  return out;
}
```

- [ ] **Step 2: Update tests**

Replace the existing chunker tests with tests against `BlockSpec[]` inputs. Cover: short section → one chunk, long section → multiple chunks at sentence boundaries, mid-section paragraphs roll into the heading section, sections with no heading still produce chunks.

- [ ] **Step 3: Run tests, commit**

```bash
cd ~/projects/notient
bun test src/core/indexer/chunker.test.ts
git add src/core/indexer/chunker.ts src/core/indexer/chunker.test.ts
git commit -m "feat(indexer): AST-aware chunker bounded by heading sections"
```

---

### Task 5: Embedder helper for parallel calls

**Files:**
- Modify: `src/core/indexer/embedder.ts`

- [ ] **Step 1: Add `embedAll` with bounded concurrency**

```typescript
import { CONCURRENCY } from "./concurrencyDefaults";

// Existing single-chunk embed call: embedOne(text: string): Promise<number[]>.

export async function embedAll(texts: string[]): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY.embed }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= texts.length) return;
      out[i] = await embedOne(texts[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/notient
git add src/core/indexer/embedder.ts
git commit -m "feat(embedder): bounded-concurrency embedAll wrapper"
```

---

### Task 6: Tier 2 / Tier 3 DAL extensions

**Files:**
- Modify: `src/core/db/surreal.ts`

- [ ] **Step 1: Append the new methods**

```typescript
export interface ChunkUpsert {
  noteId: RecordId<"note">;
  blockId: RecordId<"block"> | null;
  ord: number;
  text: string;
  tokenEstimate: number;
  vector: number[];
  embedModel: string;
}

export async function replaceChunks(db: Surreal, noteId: RecordId<"note">, chunks: ChunkUpsert[]): Promise<RecordId<"chunk">[]> {
  await db.query(`DELETE chunk WHERE note = $n;`, { n: noteId });
  const ids: RecordId<"chunk">[] = [];
  for (const c of chunks) {
    const result = await db.query<[Array<{ id: RecordId<"chunk"> }>]>(
      `CREATE chunk SET note = $n, block = $b, ord = $o, text = $t, token_estimate = $te, vector = $v, embed_model = $em, embedded_at = time::now() RETURN id;`,
      { n: c.noteId, b: c.blockId, o: c.ord, t: c.text, te: c.tokenEstimate, v: c.vector, em: c.embedModel },
    );
    ids.push(((result[0] as Array<{ id: RecordId<"chunk"> }>)[0]).id);
  }
  return ids;
}

export async function markTier2Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query(`UPDATE $n SET tier2_at = time::now();`, { n: noteId });
}

export async function markTier3Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query(`UPDATE $n SET tier3_at = time::now();`, { n: noteId });
}

export interface NeighborCandidate {
  noteId: RecordId<"note">;
  notePath: string;
  bestDistance: number;
  evidenceChunkIds: RecordId<"chunk">[];
}

export async function linkerNeighbors(db: Surreal, params: {
  activeNoteId: RecordId<"note">;
  activeChunkVectors: number[][];
  k: number;
  ef?: number;
}): Promise<NeighborCandidate[]> {
  if (params.activeChunkVectors.length === 0) return [];
  // Use the first chunk's vector as the query; multi-chunk fan-out is Phase 5 work.
  const q = params.activeChunkVectors[0];
  const efClause = params.ef ? `<|${params.k},${params.ef}|>` : `<|${params.k}|>`;
  // SurrealQL: neighbors by chunk kNN, group by note, exclude active, exclude already-wikilinked.
  const result = await db.query<[Array<{ note: RecordId<"note">; path: string; d: number; chunks: RecordId<"chunk">[] }>]>(
    `LET $active = $a;
     LET $linked = (SELECT VALUE out FROM wikilink WHERE in = $active OR in IN (SELECT id FROM block WHERE note = $active))
                ?? [];
     LET $linked_back = (SELECT VALUE in FROM wikilink WHERE out = $active OR out IN (SELECT id FROM block WHERE note = $active))
                ?? [];
     LET $excluded = array::concat([$active], $linked, $linked_back);
     SELECT note, note.path AS path, vector::distance::knn() AS d, [id] AS chunks
       FROM chunk
       WHERE vector ${efClause} $q
         AND note NOT IN $excluded
         AND note.tier3_at != NONE
       ORDER BY d
       LIMIT $k;`,
    { a: params.activeNoteId, q, k: params.k },
  );
  const rows = result[0] as Array<{ note: RecordId<"note">; path: string; d: number; chunks: RecordId<"chunk">[] }>;
  // Group by note (we asked for unique chunks; one chunk per row may belong to the same note — deduplicate).
  const byNote = new Map<string, NeighborCandidate>();
  for (const r of rows) {
    const key = r.note.toString();
    const existing = byNote.get(key);
    if (!existing) {
      byNote.set(key, { noteId: r.note, notePath: r.path, bestDistance: r.d, evidenceChunkIds: r.chunks });
    } else {
      if (r.d < existing.bestDistance) existing.bestDistance = r.d;
      existing.evidenceChunkIds.push(...r.chunks);
    }
  }
  return Array.from(byNote.values());
}

export async function upsertConcept(db: Surreal, label: string): Promise<RecordId<"concept">> {
  const norm = normalize(label);
  const existing = await db.query<[Array<{ id: RecordId<"concept"> }>]>(
    `SELECT id FROM concept WHERE norm_label = $n LIMIT 1;`, { n: norm },
  );
  const row = (existing[0] as Array<{ id: RecordId<"concept"> }>)[0];
  if (row) return row.id;
  const created = await db.query<[Array<{ id: RecordId<"concept"> }>]>(
    `CREATE concept SET label = $l, norm_label = $n RETURN id;`, { l: label, n: norm },
  );
  return ((created[0] as Array<{ id: RecordId<"concept"> }>)[0]).id;
}

export async function upsertClaim(db: Surreal, text: string): Promise<RecordId<"claim">> {
  const sha = await sha256(text);
  const existing = await db.query<[Array<{ id: RecordId<"claim"> }>]>(
    `SELECT id FROM claim WHERE sha = $s LIMIT 1;`, { s: sha },
  );
  const row = (existing[0] as Array<{ id: RecordId<"claim"> }>)[0];
  if (row) return row.id;
  const created = await db.query<[Array<{ id: RecordId<"claim"> }>]>(
    `CREATE claim SET text = $t, sha = $s RETURN id;`, { t: text, s: sha },
  );
  return ((created[0] as Array<{ id: RecordId<"claim"> }>)[0]).id;
}

export async function upsertQuestion(db: Surreal, text: string): Promise<RecordId<"question">> {
  const sha = await sha256(text);
  const existing = await db.query<[Array<{ id: RecordId<"question"> }>]>(
    `SELECT id FROM question WHERE sha = $s LIMIT 1;`, { s: sha },
  );
  const row = (existing[0] as Array<{ id: RecordId<"question"> }>)[0];
  if (row) return row.id;
  const created = await db.query<[Array<{ id: RecordId<"question"> }>]>(
    `CREATE question SET text = $t, sha = $s RETURN id;`, { t: text, s: sha },
  );
  return ((created[0] as Array<{ id: RecordId<"question"> }>)[0]).id;
}

function normalize(label: string): string {
  return label.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").trim();
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd ~/projects/notient
bun run typecheck 2>&1 | grep core/db/surreal | head
git add src/core/db/surreal.ts
git commit -m "feat(db): tier 2/3 DAL extensions (chunks, concepts, claims, questions, linker neighbors)"
```

---

### Task 7: Tier 2 orchestrator

**Files:**
- Create: `src/core/indexer/tier2.ts`
- Create: `src/core/indexer/tier2.test.ts`

- [ ] **Step 1: Implement**

```typescript
// src/core/indexer/tier2.ts
import type { Surreal, RecordId } from "surrealdb";
import { chunkBlocks } from "./chunker";
import { embedAll } from "./embedder";
import { replaceChunks, markTier2Done, lookupNoteByPath, lookupBlockByExplicitId } from "../db/surreal";
import type { BlockSpec } from "../markdown/types";

const EMBED_MODEL = "text-embedding-nomic-embed-text-v2-moe";

export interface Tier2Input {
  notePath: string;
  blocks: BlockSpec[]; // from MarkdownExtraction (Phase 2)
}

export async function runTier2(db: Surreal, input: Tier2Input): Promise<{ noteId: RecordId<"note">; chunkCount: number }> {
  const noteId = await lookupNoteByPath(db, input.notePath);
  if (!noteId) throw new Error(`tier2: note not found at path ${input.notePath} (tier1 must run first)`);

  const chunks = chunkBlocks(input.blocks);
  if (chunks.length === 0) {
    await markTier2Done(db, noteId);
    return { noteId, chunkCount: 0 };
  }

  const vectors = await embedAll(chunks.map((c) => c.text));

  // Resolve heading-block IDs for the chunk.block reference.
  const blockOrdToBlockSpec = new Map<number, BlockSpec>();
  for (const b of input.blocks) blockOrdToBlockSpec.set(b.ord, b);

  // For now, the linker neighbor query uses chunk → note; the chunk.block reference is not strictly required.
  // Tier 2 sets it when the heading block has a stable id (heading_slug or block_id); otherwise null.

  await db.query("BEGIN TRANSACTION;");
  try {
    await replaceChunks(db, noteId, chunks.map((c) => ({
      noteId,
      blockId: null, // Phase 4 wires the block reference once the resolver knows the row id.
      ord: c.ord, text: c.text, tokenEstimate: c.tokenEstimate,
      vector: vectors[c.ord], embedModel: EMBED_MODEL,
    })));
    await markTier2Done(db, noteId);
    await db.query("COMMIT TRANSACTION;");
  } catch (error) {
    await db.query("CANCEL TRANSACTION;");
    throw error;
  }

  return { noteId, chunkCount: chunks.length };
}
```

- [ ] **Step 2: Smoke test against real SurrealDB + mocked embedder**

(Detailed test similar to Phase 2's tier1 smoke; mock `embedAll` to return deterministic vectors.)

- [ ] **Step 3: Commit**

```bash
cd ~/projects/notient
bun test src/core/indexer/tier2.test.ts
git add src/core/indexer/tier2.ts src/core/indexer/tier2.test.ts
git commit -m "feat(indexer): tier 2 orchestrator chunk + embed -> SurrealDB HNSW"
```

---

### Task 8: Tier 3 orchestrator

**Files:**
- Create: `src/core/indexer/tier3.ts`
- Create: `src/core/indexer/tier3.test.ts`
- Modify: `src/core/agents/linker.ts`
- Modify: `src/core/indexer/extractor.ts`

- [ ] **Step 1: Rewrite extractor's writes**

Inside `src/core/indexer/extractor.ts`, replace the SQLite insert loops with:

```typescript
import { upsertConcept, upsertClaim, upsertQuestion, relateEdge } from "../db/surreal";
// ... existing prompt + chatJson logic unchanged ...

export async function writeExtractionToSurreal(
  db: Surreal,
  noteId: RecordId<"note">,
  extraction: { entities: string[]; claims: string[]; questions: string[] },
): Promise<void> {
  for (const label of extraction.entities) {
    const conceptId = await upsertConcept(db, label);
    await relateEdge(db, "mentions", {
      from: noteId, to: conceptId, source: "extractor",
      confidenceClass: "INFERRED", confidence: 0.7, agent: "extractor", approved: true,
    });
  }
  for (const text of extraction.claims) {
    const claimId = await upsertClaim(db, text);
    await relateEdge(db, "asserts", {
      from: noteId, to: claimId, source: "extractor",
      confidenceClass: "INFERRED", confidence: 0.7, agent: "extractor", approved: true,
    });
  }
  for (const text of extraction.questions) {
    const questionId = await upsertQuestion(db, text);
    await relateEdge(db, "asks", {
      from: noteId, to: questionId, source: "extractor",
      confidenceClass: "INFERRED", confidence: 0.7, agent: "extractor", approved: true,
    });
  }
}
```

- [ ] **Step 2: Rewrite linker's writes**

Inside `src/core/agents/linker.ts`:

```typescript
import { linkerNeighbors, relateEdge } from "../db/surreal";
import type { EdgeTable } from "../db/edgeTables";

const SEMANTIC_EDGE_TYPES: EdgeTable[] = ["supports", "contradicts", "extends", "exemplifies", "synthesizes", "related_to"];

// Inside the linker run:
// 1. Build active chunk vectors from the chunk table (already there from tier 2).
// 2. Call linkerNeighbors(db, { activeNoteId, activeChunkVectors, k: 20, ef: 40 }).
// 3. Send candidates + active note text to the LLM with the existing prompt.
// 4. For each LLM-proposed edge, validate type, then relateEdge with approved=false:
for (const edge of llmResponse.edges) {
  if (!SEMANTIC_EDGE_TYPES.includes(edge.type)) continue;
  const targetId = await lookupNoteByPath(db, edge.targetNotePath);
  if (!targetId) continue;
  await relateEdge(db, edge.type, {
    from: activeNoteId, to: targetId, source: "linker",
    confidenceClass: "INFERRED", confidence: edge.confidence, agent: "linker", approved: false,
  });
}
```

- [ ] **Step 3: Tier 3 orchestrator**

```typescript
// src/core/indexer/tier3.ts
import type { Surreal, RecordId } from "surrealdb";
import { lookupNoteByPath, markTier3Done } from "../db/surreal";
import { runExtractor, writeExtractionToSurreal } from "./extractor";
import { runLinker } from "../agents/linker";

export async function runTier3(db: Surreal, params: { notePath: string; chunks: { ord: number; text: string; vector: number[] }[] }): Promise<{ noteId: RecordId<"note"> }> {
  const noteId = await lookupNoteByPath(db, params.notePath);
  if (!noteId) throw new Error(`tier3: note not found at path ${params.notePath}`);

  // Run extractor + linker concurrently.
  const [extraction] = await Promise.all([
    runExtractor(params.chunks),
    runLinker(db, { noteId, activeChunkVectors: params.chunks.map((c) => c.vector) }),
  ]);
  await writeExtractionToSurreal(db, noteId, extraction);
  await markTier3Done(db, noteId);
  return { noteId };
}
```

- [ ] **Step 4: Update tests, commit**

```bash
cd ~/projects/notient
bun test src/core/indexer/extractor.test.ts src/core/indexer/tier3.test.ts src/core/agents/linker.test.ts
git add -p
# Stage the modified files explicitly:
git add src/core/indexer/extractor.ts src/core/indexer/tier3.ts src/core/indexer/tier3.test.ts src/core/agents/linker.ts src/core/agents/linker.test.ts
git commit -m "feat(indexer): tier 3 extractor + linker against SurrealDB schema"
```

---

### Task 9: Wire Tier 2 + Tier 3 into `indexNote.ts`

**Files:**
- Modify: `src/core/indexer/indexNote.ts`

- [ ] **Step 1: Replace SQLite chunk/embed/extract with calls to runTier2 + runTier3**

Replace the existing SQLite-bound chunk/embed/extract code with:

```typescript
import { runTier2 } from "./tier2";
import { runTier3 } from "./tier3";

// After Tier 1 (Phase 2 already added that):
try {
  const { extraction } = await runTier1(surrealDb.db, { notePath, source: body, vaultPaths });
  eventBus.publish({ name: "indexer:tier1-done", payload: { notePath } });

  const tier2Result = await runTier2(surrealDb.db, { notePath, blocks: extraction.blocks });
  eventBus.publish({ name: "indexer:tier2-done", payload: { notePath, chunkCount: tier2Result.chunkCount } });

  const tier3Chunks = await fetchChunksForTier3(surrealDb.db, tier2Result.noteId); // helper that selects chunk text + vector
  await runTier3(surrealDb.db, { notePath, chunks: tier3Chunks });
  eventBus.publish({ name: "indexer:tier3-done", payload: { notePath } });
} catch (error) {
  // Existing error path; details depend on the file structure.
}
```

Add a helper `fetchChunksForTier3` to `src/core/db/surreal.ts`:

```typescript
export async function fetchChunksForTier3(db: Surreal, noteId: RecordId<"note">): Promise<Array<{ ord: number; text: string; vector: number[] }>> {
  const result = await db.query<[Array<{ ord: number; text: string; vector: number[] }>]>(
    `SELECT ord, text, vector FROM chunk WHERE note = $n ORDER BY ord;`,
    { n: noteId },
  );
  return result[0] as Array<{ ord: number; text: string; vector: number[] }>;
}
```

- [ ] **Step 2: Remove the legacy SQLite chunk/embed code path inside `indexNote.ts`**

Remove the calls into `embeddings` table inserts and the `hnswVectorIndex.add(...)` invocations. Also remove the SQLite-bound calls into `graph_nodes` / `graph_edges` for the extractor + linker outputs (their data now lives in SurrealDB).

- [ ] **Step 3: Run all tests**

```bash
cd ~/projects/notient
bun test
```

The search-side tests (which still query SQLite) should pass against pre-migration data; consumers reading from SQLite see no new data. Document this in the handoff.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/notient
git add src/core/indexer/indexNote.ts src/core/db/surreal.ts
git commit -m "feat(indexer): full tier 1/2/3 pipeline writes only to SurrealDB"
```

---

### Task 10: Delete `hnswlib-wasm` and the kernel slot

**Files:**
- Delete: `src/core/indexer/hnswVectorIndex.ts`
- Delete: `src/core/indexer/hnswEnvShim.ts`
- Delete: `src/core/indexer/vectorIndex.test.ts`
- Modify: `src/core/kernel.ts`
- Modify: `src/daemon/bootstrap.ts`
- Modify: `package.json`

- [ ] **Step 1: Verify no imports remain**

```bash
cd ~/projects/notient && grep -rln "hnsw\|HnswVectorIndex" src/
```
Expected: only the three files to be deleted plus their imports in kernel + bootstrap.

- [ ] **Step 2: Delete the files**

```bash
cd ~/projects/notient
git rm src/core/indexer/hnswVectorIndex.ts src/core/indexer/hnswEnvShim.ts src/core/indexer/vectorIndex.test.ts
```

- [ ] **Step 3: Drop the kernel slot**

Edit `src/core/kernel.ts`: remove `hnswVectorIndex` from the slot keys and any typed slot mapping.

Edit `src/daemon/bootstrap.ts`: remove the `new HnswVectorIndex(...)` instantiation and its `kernel.set("hnswVectorIndex", ...)` call.

- [ ] **Step 4: Remove the dependency**

```bash
cd ~/projects/notient
bun remove hnswlib-wasm
```

- [ ] **Step 5: Verify the build**

```bash
cd ~/projects/notient
bun run typecheck
bun test
```
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/notient
git add src/core/kernel.ts src/daemon/bootstrap.ts package.json bun.lockb
git commit -m "feat(indexer): remove hnswlib-wasm; SurrealDB native HNSW is the only vector path"
```

---

### Task 11: Phase 3 smoke harness

**Files:**
- Create: `src/daemon/__smoke__/tier23.smoke.test.ts`

- [ ] **Step 1: End-to-end smoke**

A test that:
1. Boots SurrealDB + applies schema.
2. Inserts two notes via Tier 1 (using a stub `runTier1` or direct DAL writes).
3. Runs Tier 2 with a mocked `embedAll` that returns deterministic vectors.
4. Runs Tier 3 with a mocked LLM client that returns one entity, one claim, one question, and one `supports` edge proposal.
5. Asserts: chunks exist with vectors, kNN finds them, `mentions`/`asserts`/`asks` rows exist with `approved = true`, the `supports` row exists with `approved = false`.
6. Asserts: `linkerNeighbors` correctly excludes the active note and any note with a wikilink to the active note.

(Detailed code follows the structure of the Phase 2 smoke; specifics depend on the mock harness already established in Phase 1/2.)

- [ ] **Step 2: Run, commit**

```bash
cd ~/projects/notient
bun test src/daemon/__smoke__/tier23.smoke.test.ts
git add src/daemon/__smoke__/tier23.smoke.test.ts
git commit -m "test(smoke): phase 3 tier 2/3 end-to-end with mocked Ollama + LM Studio"
```

---

### Task 12: Phase 3 handoff doc

**Files:**
- Create: `docs/superpowers/handoffs/2026-04-29-phase-3-vault-enrichment-handoff.md`

- [ ] **Step 1: Write under 80 lines**

Document: priority queue shipped, full tier 1/2/3 pipeline writes to SurrealDB, hnswlib-wasm gone, search consumers still on SQLite (known short-term staleness), linker uses recursive SurrealQL with skip-already-wikilinked filter. Phase 4 entry point: search/agent migration to SurrealDB, AST writeback, daemon_write provenance, awaken control plane.

- [ ] **Step 2: Commit**

```bash
cd ~/projects/notient
git add docs/superpowers/handoffs/2026-04-29-phase-3-vault-enrichment-handoff.md
git commit -m "docs(handoff): phase 3 tier 2/3 + priority queue shipped, hnsw deleted"
```

---

## Self-review

**Spec coverage:** §3.2 chunk schema (Task 6), §3.4 semantic edge tables (Task 8), §5.1 priority queue (Task 1, 2), §5.3 Tier 2 (Task 4, 5, 6, 7), §5.4 Tier 3 (Task 8). Linker skip-already-wikilinked filter (Task 6 `linkerNeighbors`). HNSW deletion (Task 10). All covered.

**Placeholder scan:** Tasks 7, 8, 9 reference "details depend on the file structure" — these are unavoidable adapt-to-existing-code points. The full file structure is sufficiently described in the audit + Phase 2 deliverables that an executor can read the file and adapt.

**Type consistency:** `BlockSpec` (Phase 2) consumed by `chunkBlocks` (Task 4) producing `ChunkSpec` consumed by `replaceChunks` (Task 6). `EdgeTable` (Phase 1) consumed by `relateEdge` and `linkerNeighbors`. `RecordId<"note" | "block" | "chunk" | "concept" | "claim" | "question">` consistent.

**Known short-term gap:** Search consumers (`searchPipeline.ts`, `strategies/*.ts`) still query SQLite. They return stale data after Phase 3 lands until Phase 4 migrates them. Phase 3's handoff documents this; users who run `notient search` after Phase 3 lands will see "indexed before phase 3" results. Acceptable because the daemon is on `beta-spec` between phases, not shipped.

---

## Execution

Phase 3 plan complete and saved to `docs/superpowers/plans/2026-04-29-vault-enrichment-phase-3.md`. Execute via `superpowers:subagent-driven-development` after Phase 2 ships green.
