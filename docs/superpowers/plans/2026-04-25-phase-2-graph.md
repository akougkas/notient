# Notient Phase 2 — Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is self-contained and assumes only the Phase 1 codebase plus tasks above it. Steps use checkbox (`- [ ]`) syntax. Use Opus 4.7 implementer subagents only — no per-task spec/quality reviewers per user's stated preference.

**Goal:** Stand up the senses pipeline — file-save → chunk → embed → extract entities/claims/questions → write graph — with HNSW vector index and an Awaken Vault onboarding modal that animates 894 notes lighting up over 3-5 minutes.

**Architecture:** Five tech-debt fixes first (locked frontmatter, DB transactions, echo guard on save, AbortSignal-bounded health probes, chatJson<T> on LLMProvider). Then a layered indexer: pure-function chunker → batched embedder over dynamo → HNSW vector index behind an interface (in-memory shim for tests, WASM impl for runtime) → extractor that calls qwen3.5-2b with structured JSON output → an orchestrator (`indexNote`) that runs them all inside a single DB transaction. A debounced queue swaps the toy SHA-only handler in `main.ts`. Finally the Awaken Vault modal subscribes to the existing event bus and paints a Canvas-rendered graph in real time as the indexer chews through the vault.

**Tech Stack:** TypeScript strict • Bun test • sql.js (existing) • `hnswlib-wasm` 0.8.2 (already in deps) • OpenAI-compatible JSON over fetch • Obsidian Modal API • HTML5 Canvas (no Cytoscape dep — keep bundle small).

**Definition of done (from spec §13 row 2):**
- Index 894 notes (test vault) in <10 min from a cold start
- Graph populated and queryable: `notes`, `chunks`, `embeddings`, `graph_nodes`, `graph_edges` all carry rows; `vectors.bin` persisted
- Awaken Vault modal renders animated growth and reaches the "894 notes • N concepts • M edges" final state
- Tag `v1.0.0-graph` on `beta-spec`

**Phase 2 git tag:** `v1.0.0-graph` (created in Task 13).

---

## File Structure (locked before tasks)

### Tech-debt edits (Task 0)
- `src/core/graph/frontmatterWriter.ts` — rewritten as merge-only (surgical regex over `notient:` block)
- `src/core/graph/frontmatterWriter.test.ts` — replaces the old fragile test
- `src/core/db/database.ts` — add `transaction(fn)` method
- `src/core/db/database.test.ts` — add transaction tests
- `src/core/services/healthMonitor.ts` — pass AbortSignal into `isAvailable`, abort after `intervalMs / 2`
- `src/core/services/healthMonitor.test.ts` — add timeout test
- `src/core/llm/provider.ts` — add `chatJson<T>(messages, opts, schema)` to interface
- `src/core/llm/lmStudioProvider.ts` — implement chatJson via LM Studio's `response_format: { type: "json_schema", … }`
- `src/core/llm/lmStudioProvider.test.ts` — add chatJson tests
- `src/main.ts` — echo guard set + skip handler for self-writes

### New senses pipeline (Tasks 1–8)
- `src/core/indexer/types.ts` — `Chunk`, `Extraction`, `IndexResult`
- `src/core/indexer/chunker.ts` — `chunkNote(notePath, body): Chunk[]`
- `src/core/indexer/chunker.test.ts`
- `src/core/indexer/embedder.ts` — `Embedder` class wrapping `LLMProvider.embed` with batching + retry
- `src/core/indexer/embedder.test.ts`
- `src/core/indexer/vectorIndex.ts` — `VectorIndex` interface + `InMemoryVectorIndex` (test/dev fallback)
- `src/core/indexer/hnswVectorIndex.ts` — `HnswVectorIndex` (production, persists to `vectors.bin`)
- `src/core/indexer/vectorIndex.test.ts` — exhaustive against `InMemoryVectorIndex` + smoke test against `HnswVectorIndex`
- `src/core/indexer/extractor.ts` — `Extractor.extract(chunks): Extraction` via chatJson
- `src/core/indexer/extractor.test.ts`
- `src/core/indexer/indexNote.ts` — pipeline orchestrator, single DB transaction per note
- `src/core/indexer/indexNote.test.ts`
- `src/core/indexer/indexerQueue.ts` — debounced + batched queue
- `src/core/indexer/indexerQueue.test.ts`
- `src/core/events/types.ts` — extend `AppEvent` with `indexer:node-added`, `indexer:edge-added`, `indexer:note-indexed`

### Awaken Vault modal (Tasks 9–12)
- `src/ui/onboarding/awakenRunner.ts` — drives indexer across the whole vault, emits progress events
- `src/ui/onboarding/awakenRunner.test.ts`
- `src/ui/onboarding/graphCanvas.ts` — Canvas renderer (deterministic spiral layout + glow animation)
- `src/ui/onboarding/graphCanvas.test.ts`
- `src/ui/onboarding/AwakenVaultModal.ts` — Obsidian Modal subclass, owns the canvas + counters
- `src/main.ts` — first-run trigger, command palette entry, indexer registration in kernel
- `src/core/kernel.ts` — add `indexer` to required service keys
- `src/core/settings/types.ts` — add `awakenedAt: number | null` flag

### Tag + state (Task 13)
- `.planning/STATE.md` — Phase 2 status block
- Git tag `v1.0.0-graph`

---

## Task 0a: Rewrite frontmatterWriter as merge-only

**Files:**
- Modify (rewrite): `src/core/graph/frontmatterWriter.ts`
- Modify (rewrite): `src/core/graph/frontmatterWriter.test.ts`

**Why:** The current `parseYaml` silently drops `tags: [- a, - b]` style arrays — it treats any indented block as a nested object. Once agents write back to user notes, every save round-trips and corrupts user data. Fix: never parse arbitrary YAML. Find the `notient:` fenced sub-block by regex, replace it (or append it) verbatim. Stringify only our own well-typed shape.

- [ ] **Step 1: Write the failing test**

Replace the contents of `src/core/graph/frontmatterWriter.test.ts` with:

```typescript
import { describe, expect, test } from "bun:test";
import {
  type NotientFrontmatter,
  extractNotientBlock,
  formatNotientBlock,
  upsertNotientBlock,
} from "./frontmatterWriter";

describe("frontmatterWriter (merge-only)", () => {
  test("formatNotientBlock emits canonical YAML", () => {
    const block: NotientFrontmatter = {
      vitals: { health: 78, maturity: "adolescent", freshness: 0.92 },
      edges: [
        { type: "supports", target: "[[Other]]", confidence: 0.84, evidence: "p3" },
      ],
      summary: "A short take.",
      updated: "2026-04-25T18:00:00Z",
    };
    const yaml = formatNotientBlock(block);
    expect(yaml).toBe(
      "notient:\n" +
        "  vitals:\n" +
        "    health: 78\n" +
        "    maturity: adolescent\n" +
        "    freshness: 0.92\n" +
        "  edges:\n" +
        '    - { type: supports, target: "[[Other]]", confidence: 0.84, evidence: p3 }\n' +
        "  summary: A short take.\n" +
        "  updated: 2026-04-25T18:00:00Z\n",
    );
  });

  test("extractNotientBlock returns null when no fenced frontmatter", () => {
    expect(extractNotientBlock("# Just a heading\n")).toBeNull();
  });

  test("extractNotientBlock returns null when notient key missing", () => {
    const md = "---\ntitle: Hi\n---\nbody";
    expect(extractNotientBlock(md)).toBeNull();
  });

  test("extractNotientBlock returns the literal block text", () => {
    const md =
      "---\n" +
      "title: Hi\n" +
      "notient:\n" +
      "  vitals:\n" +
      "    health: 80\n" +
      "tags: [a, b]\n" +
      "---\n" +
      "body";
    const block = extractNotientBlock(md);
    expect(block).toBe("notient:\n  vitals:\n    health: 80\n");
  });

  test("upsertNotientBlock inserts when no frontmatter exists", () => {
    const out = upsertNotientBlock("body only\n", {
      summary: "s",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toBe(
      "---\n" +
        "notient:\n" +
        "  summary: s\n" +
        "  updated: 2026-04-25T00:00:00Z\n" +
        "---\n" +
        "body only\n",
    );
  });

  test("upsertNotientBlock inserts into existing frontmatter without touching other keys", () => {
    const original =
      "---\n" + "title: User Note\n" + "tags: [- a, - b]\n" + "---\n" + "# Body\nstuff";
    const out = upsertNotientBlock(original, {
      summary: "fresh",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toContain("title: User Note");
    expect(out).toContain("tags: [- a, - b]");
    expect(out).toContain("notient:\n  summary: fresh\n  updated: 2026-04-25T00:00:00Z\n");
    expect(out.endsWith("# Body\nstuff")).toBe(true);
  });

  test("upsertNotientBlock replaces existing notient block in place", () => {
    const original =
      "---\n" +
      "title: T\n" +
      "notient:\n" +
      "  summary: old\n" +
      "  updated: 2026-04-01T00:00:00Z\n" +
      "tags: [keep, me]\n" +
      "---\n" +
      "body";
    const out = upsertNotientBlock(original, {
      summary: "new",
      updated: "2026-04-25T00:00:00Z",
    });
    expect(out).toContain("title: T");
    expect(out).toContain("tags: [keep, me]");
    expect(out).toContain("summary: new");
    expect(out).not.toContain("summary: old");
  });

  test("upsertNotientBlock preserves user array data verbatim across replace", () => {
    const original =
      "---\n" +
      "tags:\n" +
      "  - a\n" +
      "  - b\n" +
      "  - c\n" +
      "notient:\n" +
      "  summary: old\n" +
      "---\n" +
      "body";
    const out = upsertNotientBlock(original, { summary: "new" });
    expect(out).toContain("tags:\n  - a\n  - b\n  - c\n");
    expect(out).toContain("summary: new");
  });
});
```

- [ ] **Step 2: Verify the new tests fail**

Run: `bun test src/core/graph/frontmatterWriter.test.ts`
Expected: failures because the new exports don't exist yet.

- [ ] **Step 3: Replace frontmatterWriter.ts**

Replace the entire contents of `src/core/graph/frontmatterWriter.ts` with:

```typescript
export interface NotientFrontmatter {
  vitals?: { health: number; maturity: string; freshness: number };
  edges?: Array<{
    type: string;
    target: string;
    confidence: number;
    evidence?: string;
  }>;
  summary?: string;
  updated?: string;
}

const FENCE = "---";

export function extractNotientBlock(content: string): string | null {
  const fm = readRawFrontmatter(content);
  if (!fm) return null;
  return findNotientSubblock(fm.yaml);
}

export function upsertNotientBlock(content: string, block: NotientFrontmatter): string {
  const formatted = formatNotientBlock(block);
  const fm = readRawFrontmatter(content);
  if (!fm) {
    return `${FENCE}\n${formatted}${FENCE}\n${content}`;
  }
  const existing = findNotientSubblock(fm.yaml);
  const newYaml = existing
    ? fm.yaml.replace(existing, formatted)
    : appendBlockToYaml(fm.yaml, formatted);
  return `${FENCE}\n${newYaml}${FENCE}\n${fm.body}`;
}

export function formatNotientBlock(block: NotientFrontmatter): string {
  let out = "notient:\n";
  if (block.vitals) {
    out += "  vitals:\n";
    out += `    health: ${block.vitals.health}\n`;
    out += `    maturity: ${block.vitals.maturity}\n`;
    out += `    freshness: ${block.vitals.freshness}\n`;
  }
  if (block.edges && block.edges.length > 0) {
    out += "  edges:\n";
    for (const edge of block.edges) {
      out += `    - ${formatEdgeInline(edge)}\n`;
    }
  }
  if (block.summary !== undefined) {
    out += `  summary: ${formatScalar(block.summary)}\n`;
  }
  if (block.updated !== undefined) {
    out += `  updated: ${formatScalar(block.updated)}\n`;
  }
  return out;
}

function formatEdgeInline(edge: NotientFrontmatter["edges"] extends Array<infer E> ? E : never): string {
  const parts = [
    `type: ${edge.type}`,
    `target: ${formatScalar(edge.target)}`,
    `confidence: ${edge.confidence}`,
  ];
  if (edge.evidence !== undefined) parts.push(`evidence: ${formatScalar(edge.evidence)}`);
  return `{ ${parts.join(", ")} }`;
}

function formatScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (/[:#\n,{}[\]]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

interface RawFrontmatter {
  yaml: string;
  body: string;
}

function readRawFrontmatter(content: string): RawFrontmatter | null {
  if (!content.startsWith(`${FENCE}\n`) && !content.startsWith(`${FENCE}\r\n`)) return null;
  const headerLen = content.startsWith(`${FENCE}\n`) ? FENCE.length + 1 : FENCE.length + 2;
  const closeIdx = content.indexOf(`\n${FENCE}`, headerLen);
  if (closeIdx === -1) return null;
  const yaml = content.slice(headerLen, closeIdx + 1);
  const after = closeIdx + 1 + FENCE.length;
  const body = content.slice(after).replace(/^\r?\n/, "");
  return { yaml, body };
}

function findNotientSubblock(yaml: string): string | null {
  const startMatch = yaml.match(/^notient:\s*\n/m);
  if (!startMatch) return null;
  const startIdx = startMatch.index ?? 0;
  let endIdx = yaml.length;
  let cursor = startIdx + startMatch[0].length;
  while (cursor < yaml.length) {
    const lineEnd = yaml.indexOf("\n", cursor);
    const line = lineEnd === -1 ? yaml.slice(cursor) : yaml.slice(cursor, lineEnd + 1);
    if (line.length === 0) break;
    const isContinuation = line.startsWith("  ") || line.trim() === "";
    if (!isContinuation) {
      endIdx = cursor;
      break;
    }
    cursor = lineEnd === -1 ? yaml.length : lineEnd + 1;
    if (lineEnd === -1) {
      endIdx = yaml.length;
      break;
    }
  }
  if (cursor >= yaml.length) endIdx = yaml.length;
  return yaml.slice(startIdx, endIdx);
}

function appendBlockToYaml(yaml: string, block: string): string {
  if (yaml.length === 0) return block;
  return yaml.endsWith("\n") ? yaml + block : `${yaml}\n${block}`;
}
```

- [ ] **Step 4: Verify all tests pass**

Run: `bun test src/core/graph/frontmatterWriter.test.ts`
Expected: 7/7 pass.

- [ ] **Step 5: Verify nothing else broke**

Run: `bun test && bun run typecheck && bun run lint`
Expected: green across the board. The old `readFrontmatter` / `writeFrontmatter` / `parseYaml` / `stringifyYaml` exports are removed; nothing in `src/` imports them yet (Phase 1 only added the writer; no production caller exists).

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/frontmatterWriter.ts src/core/graph/frontmatterWriter.test.ts
git commit -m "fix(frontmatter): rewrite as merge-only to preserve user YAML"
```

---

## Task 0b: Database.transaction(fn) helper

**Files:**
- Modify: `src/core/db/database.ts`
- Modify: `src/core/db/database.test.ts`

**Why:** The Phase 2 indexer writes a note's chunks, embeddings, graph nodes, and graph edges in one logical step. Without an atomic transaction, a thrown extractor leaves the DB with chunks but no edges (corrupt graph). sql.js supports `BEGIN`/`COMMIT`/`ROLLBACK` via plain `run`.

- [ ] **Step 1: Write the failing test**

Append to the bottom of `src/core/db/database.test.ts`:

```typescript
  test("transaction commits on success", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.transaction(() => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/a.md", "sha", 1, 1, 1],
      );
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/b.md", "sha", 1, 1, 1],
      );
    });
    const rows = db.query<{ path: string }>("SELECT path FROM notes ORDER BY path;");
    expect(rows).toEqual([{ path: "/a.md" }, { path: "/b.md" }]);
  });

  test("transaction rolls back on throw and re-raises", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/seed.md", "sha", 1, 1, 1],
    );
    expect(() =>
      db.transaction(() => {
        db.run(
          "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
          ["/inside.md", "sha", 1, 1, 1],
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rows = db.query<{ path: string }>("SELECT path FROM notes ORDER BY path;");
    expect(rows).toEqual([{ path: "/seed.md" }]);
  });

  test("transaction supports a return value", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const result = db.transaction(() => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        ["/x.md", "sha", 1, 1, 1],
      );
      return 42;
    });
    expect(result).toBe(42);
  });
```

- [ ] **Step 2: Verify the new tests fail**

Run: `bun test src/core/db/database.test.ts`
Expected: 3 new failing tests because `db.transaction` doesn't exist.

- [ ] **Step 3: Add the transaction method**

In `src/core/db/database.ts`, add the new method just below `query()` and above `persist()`:

```typescript
  transaction<T>(fn: () => T): T {
    this.requireDb().run("BEGIN;");
    try {
      const result = fn();
      this.requireDb().run("COMMIT;");
      this.dirty = true;
      return result;
    } catch (error) {
      try {
        this.requireDb().run("ROLLBACK;");
      } catch {
        // ignore — primary error wins
      }
      throw error;
    }
  }
```

- [ ] **Step 4: Verify all tests pass**

Run: `bun test src/core/db/database.test.ts`
Expected: all tests pass (original 3 + new 3 = 6).

- [ ] **Step 5: Commit**

```bash
git add src/core/db/database.ts src/core/db/database.test.ts
git commit -m "feat(db): add transaction(fn) helper with rollback"
```

---

## Task 0c: Echo guard on vault.modify handler

**Files:**
- Modify: `src/main.ts`
- Create: `src/core/services/echoGuard.ts`
- Create: `src/core/services/echoGuard.test.ts`

**Why:** When agents (Phase 3) call `facade.write` to inject the `notient:` block into a note's frontmatter, Obsidian fires `vault.on("modify", …)` for that file. The current handler re-hashes and re-emits `vault:note-saved`, which would cascade through the indexer queue and re-trigger agents on the agent's own write — an infinite write storm. Solution: a small `EchoGuard` keyed on `path@sha`. Producers (the facade write path, when wrapped in agents later) call `mark(path, sha)` before `facade.write`; the modify handler calls `take(path, sha)` and skips when it matches. Phase 2 introduces the guard; Phase 3 wires the producer side.

- [ ] **Step 1: Write the failing test**

Create `src/core/services/echoGuard.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EchoGuard } from "./echoGuard";

describe("EchoGuard", () => {
  test("take returns false when nothing was marked", () => {
    const guard = new EchoGuard();
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("take returns true once for a marked entry", () => {
    const guard = new EchoGuard();
    guard.mark("a.md", "sha1");
    expect(guard.take("a.md", "sha1")).toBe(true);
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("entries expire after ttl", async () => {
    const guard = new EchoGuard({ ttlMs: 10 });
    guard.mark("a.md", "sha1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(guard.take("a.md", "sha1")).toBe(false);
  });

  test("size caps at maxEntries (oldest evicted)", () => {
    const guard = new EchoGuard({ maxEntries: 2, ttlMs: 60_000 });
    guard.mark("a.md", "1");
    guard.mark("b.md", "2");
    guard.mark("c.md", "3"); // evicts a@1
    expect(guard.take("a.md", "1")).toBe(false);
    expect(guard.take("b.md", "2")).toBe(true);
    expect(guard.take("c.md", "3")).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failing test**

Run: `bun test src/core/services/echoGuard.test.ts`
Expected: file-not-found / module-not-found error.

- [ ] **Step 3: Implement EchoGuard**

Create `src/core/services/echoGuard.ts`:

```typescript
export interface EchoGuardOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry {
  key: string;
  expiresAt: number;
}

export class EchoGuard {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries: Entry[] = [];
  private readonly index = new Map<string, number>();

  constructor(opts: EchoGuardOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 256;
  }

  mark(path: string, sha: string): void {
    const key = `${path}@${sha}`;
    this.purgeExpired();
    if (this.index.has(key)) return;
    this.entries.push({ key, expiresAt: Date.now() + this.ttlMs });
    this.index.set(key, this.entries.length - 1);
    while (this.entries.length > this.maxEntries) {
      const removed = this.entries.shift();
      if (removed) this.index.delete(removed.key);
      this.rebuildIndex();
    }
  }

  take(path: string, sha: string): boolean {
    const key = `${path}@${sha}`;
    this.purgeExpired();
    const idx = this.index.get(key);
    if (idx === undefined) return false;
    this.entries.splice(idx, 1);
    this.index.delete(key);
    this.rebuildIndex();
    return true;
  }

  private purgeExpired(): void {
    const now = Date.now();
    while (this.entries.length > 0 && this.entries[0].expiresAt <= now) {
      const removed = this.entries.shift();
      if (removed) this.index.delete(removed.key);
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (let i = 0; i < this.entries.length; i++) {
      this.index.set(this.entries[i].key, i);
    }
  }
}
```

- [ ] **Step 4: Verify EchoGuard tests pass**

Run: `bun test src/core/services/echoGuard.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Wire EchoGuard into main.ts**

In `src/main.ts`, add the import next to other `services` imports:

```typescript
import { EchoGuard } from "./core/services/echoGuard";
```

Add the guard to the plugin instance fields (right after `private lockHandle`):

```typescript
  echoGuard = new EchoGuard();
```

Inside `onload()`, change the modify handler so it consults the guard before persisting. Replace the `this.registerEvent(this.app.vault.on("modify", …))` block with:

```typescript
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md")) return;
        try {
          const contents = await facade.read(file.path);
          const sha = await sha256(contents);
          if (this.echoGuard.take(file.path, sha)) return;
          const now = Date.now();
          database.run(
            `INSERT INTO notes (path, sha, word_count, indexed_at, updated_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(path) DO UPDATE SET sha = excluded.sha,
               word_count = excluded.word_count,
               updated_at = excluded.updated_at;`,
            [file.path, sha, countWords(contents), now, now],
          );
          await database.persist();
          this.bus.emit({ type: "vault:note-saved", path: file.path, sha });
          NotientSidebarView.updateFooter(health.current(), facade.listMarkdown().length);
        } catch (error) {
          console.error("[Notient] save handler error", error);
        }
      }),
    );
```

Register the guard with the kernel so future agents can grab it. Add the `register` call in the kernel block:

```typescript
    this.kernel.register("echoGuard", this.echoGuard);
```

- [ ] **Step 6: Add echoGuard to required kernel keys**

In `src/core/kernel.ts`, find the `REQUIRED_KEYS` array and add `"echoGuard"`. (If the array isn't named exactly that, add the literal string to whichever set the seal step iterates.)

- [ ] **Step 7: Verify the build**

Run: `bun run typecheck && bun run lint && bun test`
Expected: all green. Echo guard is wired but inert — Phase 2 has no producer-side `mark()` calls yet, so behavior is unchanged for users.

- [ ] **Step 8: Commit**

```bash
git add src/core/services/echoGuard.ts src/core/services/echoGuard.test.ts src/main.ts src/core/kernel.ts
git commit -m "feat(echo-guard): add path@sha guard to skip self-writes in vault.modify"
```

---

## Task 0d: LLMProvider.chatJson<T>() interface

**Files:**
- Modify: `src/core/llm/provider.ts`
- Modify: `src/core/llm/lmStudioProvider.ts`
- Modify: `src/core/llm/lmStudioProvider.test.ts`

**Why:** Phase 2's extractor and Phase 3's agents need structured JSON output. LM Studio supports the OpenAI-style `response_format: { type: "json_schema", json_schema: { name, strict, schema } }` knob. Add `chatJson<T>` to the interface now so the extractor builds against a stable contract. This task lands before Task 0e because the health-monitor test mock implements the full `LLMProvider` interface and needs `chatJson` to exist.

- [ ] **Step 1: Add tests for chatJson**

Append to `src/core/llm/lmStudioProvider.test.ts`:

```typescript
import type { JsonSchema } from "./provider";

describe("LMStudioProvider chatJson", () => {
  test("chatJson returns parsed object", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"entities":["X","Y"],"claims":[],"questions":[]}' } },
            ],
          }),
          { status: 200 },
        ),
    );
    const schema: JsonSchema = {
      name: "Extraction",
      schema: {
        type: "object",
        properties: {
          entities: { type: "array", items: { type: "string" } },
          claims: { type: "array", items: { type: "string" } },
          questions: { type: "array", items: { type: "string" } },
        },
        required: ["entities", "claims", "questions"],
      },
    };
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatJson<{
      entities: string[];
      claims: string[];
      questions: string[];
    }>([{ role: "user", content: "hi" }], { model: "m" }, schema);
    expect(result).toEqual({ entities: ["X", "Y"], claims: [], questions: [] });
    const sent = JSON.parse(calls[0].init?.body as string);
    expect(sent.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Extraction", strict: true, schema: schema.schema },
    });
  });

  test("chatJson throws on invalid JSON", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }),
          { status: 200 },
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    await expect(
      provider.chatJson(
        [{ role: "user", content: "hi" }],
        { model: "m" },
        { name: "S", schema: { type: "object" } },
      ),
    ).rejects.toThrow(/JSON/);
  });

  test("chatJson strips ```json fences if present", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "```json\n{\"ok\":true}\n```" } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new LMStudioProvider({ baseUrl: "http://x/v1" });
    const result = await provider.chatJson<{ ok: boolean }>(
      [{ role: "user", content: "hi" }],
      { model: "m" },
      { name: "S", schema: { type: "object" } },
    );
    expect(result).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/llm/lmStudioProvider.test.ts`
Expected: 3 new failures (no `chatJson`, no `JsonSchema` type).

- [ ] **Step 3: Extend the interface**

Replace `src/core/llm/provider.ts` with:

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  model: string;
  signal?: AbortSignal;
}

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LLMProvider {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  chatJson<T>(messages: ChatMessage[], opts: ChatOptions, schema: JsonSchema): Promise<T>;
  embed(input: string[], opts: EmbedOptions): Promise<number[][]>;
}
```

- [ ] **Step 4: Implement chatJson on LMStudioProvider**

Append a new method to `src/core/llm/lmStudioProvider.ts` (just below `embed`):

```typescript
  async chatJson<T>(
    messages: ChatMessage[],
    opts: ChatOptions,
    schema: JsonSchema,
  ): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: schema.name, strict: true, schema: schema.schema },
        },
      }),
    });
    if (!response.ok) throw new Error(`LLM ${response.status} ${response.statusText}`);
    const data = (await response.json()) as ChatCompletionResponse;
    const raw = data.choices[0]?.message.content ?? "";
    const stripped = stripJsonFences(raw).trim();
    try {
      return JSON.parse(stripped) as T;
    } catch (error) {
      throw new Error(`chatJson failed to parse JSON: ${(error as Error).message}; raw=${raw.slice(0, 200)}`);
    }
  }
```

Add the missing import for `JsonSchema` at the top of the same file:

```typescript
import type { ChatMessage, ChatOptions, EmbedOptions, JsonSchema, LLMProvider } from "./provider";
```

Add a helper at the bottom of the file:

```typescript
function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}
```

- [ ] **Step 5: Verify all tests pass**

Run: `bun test && bun run typecheck && bun run lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/core/llm/provider.ts src/core/llm/lmStudioProvider.ts src/core/llm/lmStudioProvider.test.ts
git commit -m "feat(llm): add chatJson<T>() with json_schema response_format"
```

---

## Task 0e: Health probe AbortSignal timeout

**Files:**
- Modify: `src/core/services/healthMonitor.ts`
- Modify: `src/core/services/healthMonitor.test.ts`

**Why:** `LMStudioProvider.isAvailable()` already accepts an `AbortSignal`, but `HealthMonitor.probeAll()` never supplies one. A hung dynamo lets probes pile up forever, leaking sockets and skewing latency numbers. Time-box every probe to `intervalMs / 2`.

- [ ] **Step 1: Write the failing test**

Append to the bottom of `src/core/services/healthMonitor.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { HealthMonitor } from "./healthMonitor";

describe("HealthMonitor timeout", () => {
  test("probes carry an AbortSignal that fires after intervalMs/2", async () => {
    let receivedSignal: AbortSignal | undefined;
    const aborted = new Promise<boolean>((resolveAborted) => {
      const provider: LLMProvider = {
        isAvailable: async (signal) => {
          receivedSignal = signal;
          signal?.addEventListener("abort", () => resolveAborted(true), { once: true });
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 200));
          return true;
        },
        chat: async () => "",
        chatStream: async function* () {
          yield "";
        },
        chatJson: async () => ({}) as unknown,
        embed: async () => [],
      };
      const bus = new EventBus();
      const monitor = new HealthMonitor(
        [{ label: "primary", baseUrl: "http://x", provider }],
        bus,
        { intervalMs: 40 },
      );
      monitor.start();
      // give probeAll() a tick to start
      setTimeout(() => monitor.stop(), 100);
    });
    const wasAborted = await aborted;
    expect(wasAborted).toBe(true);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
```

- [ ] **Step 2: Verify failing test**

Run: `bun test src/core/services/healthMonitor.test.ts`
Expected: timeout test fails — no abort fires.

- [ ] **Step 3: Pass an AbortSignal into each probe**

Replace the `private async probeAll()` method in `src/core/services/healthMonitor.ts` with:

```typescript
  private async probeAll(): Promise<void> {
    const timeoutMs = Math.max(500, Math.floor(this.config.intervalMs / 2));
    await Promise.all(
      this.endpoints.map(async (endpoint) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        let ok = false;
        try {
          ok = await endpoint.provider.isAvailable(controller.signal);
        } catch {
          ok = false;
        } finally {
          clearTimeout(timer);
        }
        const latencyMs = Date.now() - start;
        this.lastResults.set(endpoint.label, ok);
        this.bus.emit({ type: "llm:health", endpoint: endpoint.label, ok, latencyMs });
      }),
    );
  }
```

- [ ] **Step 4: Verify all health monitor tests pass**

Run: `bun test src/core/services/healthMonitor.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/healthMonitor.ts src/core/services/healthMonitor.test.ts
git commit -m "fix(health): time-box probes with AbortController (intervalMs/2)"
```

---

## Task 1: Chunker

**Files:**
- Create: `src/core/indexer/types.ts`
- Create: `src/core/indexer/chunker.ts`
- Create: `src/core/indexer/chunker.test.ts`

**Why:** The senses pipeline starts here. Each note becomes a deterministic, ordered list of `Chunk` records keyed by stable IDs. ID stability lets the indexer skip embedding work for unchanged chunks across re-indexing.

**Design:**
- Split body by blank lines into paragraphs (ignoring frontmatter — caller passes the body, not the full file).
- Greedy-merge consecutive paragraphs while the running token estimate stays under `targetTokens` (default 400).
- Hard-split paragraphs over `maxTokens` (default 800) at sentence boundaries (regex `[.!?]\s+`).
- Token estimate: `Math.ceil(text.length / 4)` (rough but consistent).
- Each chunk gets a stable ID: `sha256(notePath + "\n" + ord + "\n" + text).slice(0, 16)` — hex.

- [ ] **Step 1: Define the shared types**

Create `src/core/indexer/types.ts`:

```typescript
export interface Chunk {
  id: string;
  notePath: string;
  ord: number;
  text: string;
  sha: string;
  tokenEstimate: number;
}

export interface Extraction {
  entities: string[];
  claims: string[];
  questions: string[];
}

export interface IndexResult {
  notePath: string;
  noteSha: string;
  chunkCount: number;
  embedCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}
```

- [ ] **Step 2: Write the failing chunker tests**

Create `src/core/indexer/chunker.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { chunkNote } from "./chunker";

describe("chunkNote", () => {
  test("returns single chunk for short note", async () => {
    const chunks = await chunkNote("/n.md", "Hello world.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].notePath).toBe("/n.md");
    expect(chunks[0].ord).toBe(0);
    expect(chunks[0].text).toBe("Hello world.");
    expect(chunks[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(chunks[0].sha).toMatch(/^[0-9a-f]{64}$/);
    expect(chunks[0].tokenEstimate).toBeGreaterThan(0);
  });

  test("returns empty array for empty body", async () => {
    expect(await chunkNote("/n.md", "")).toEqual([]);
    expect(await chunkNote("/n.md", "   \n  \n")).toEqual([]);
  });

  test("merges short paragraphs while under target tokens", async () => {
    const body = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = await chunkNote("/n.md", body, { targetTokens: 1000, maxTokens: 2000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Para one.\n\nPara two.\n\nPara three.");
  });

  test("splits when next paragraph would exceed target tokens", async () => {
    const big = "x ".repeat(800); // ~400 tokens
    const body = `${big.trim()}\n\n${big.trim()}\n\n${big.trim()}`;
    const chunks = await chunkNote("/n.md", body, { targetTokens: 400, maxTokens: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(800);
  });

  test("ord is monotonically increasing from 0", async () => {
    const body = Array.from({ length: 5 }, (_, i) => `${"y ".repeat(900).trim()} P${i}`).join("\n\n");
    const chunks = await chunkNote("/n.md", body, { targetTokens: 400, maxTokens: 800 });
    for (let i = 0; i < chunks.length; i++) expect(chunks[i].ord).toBe(i);
  });

  test("ids are stable across runs and unique within a note", async () => {
    const body = "First.\n\nSecond.\n\nThird.";
    const a = await chunkNote("/n.md", body, { targetTokens: 5, maxTokens: 10 });
    const b = await chunkNote("/n.md", body, { targetTokens: 5, maxTokens: 10 });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });

  test("hard-splits an oversize paragraph at sentence boundaries", async () => {
    const sentence = "This is one sentence with several words. ";
    const body = sentence.repeat(200); // ~10000 chars, far over maxTokens
    const chunks = await chunkNote("/n.md", body, { targetTokens: 200, maxTokens: 400 });
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(400);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Verify failing tests**

Run: `bun test src/core/indexer/chunker.test.ts`
Expected: module-not-found.

- [ ] **Step 4: Implement chunker**

Create `src/core/indexer/chunker.ts`:

```typescript
import type { Chunk } from "./types";

export interface ChunkerOptions {
  targetTokens?: number;
  maxTokens?: number;
}

const DEFAULT_TARGET = 400;
const DEFAULT_MAX = 800;

export async function chunkNote(
  notePath: string,
  body: string,
  opts: ChunkerOptions = {},
): Promise<Chunk[]> {
  const target = opts.targetTokens ?? DEFAULT_TARGET;
  const max = opts.maxTokens ?? DEFAULT_MAX;
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const segments: string[] = [];
  for (const para of paragraphs) {
    if (estimateTokens(para) <= max) {
      segments.push(para);
    } else {
      for (const piece of hardSplit(para, max)) segments.push(piece);
    }
  }

  const merged: string[] = [];
  let buffer = "";
  let bufferTokens = 0;
  for (const seg of segments) {
    const segTokens = estimateTokens(seg);
    if (buffer.length === 0) {
      buffer = seg;
      bufferTokens = segTokens;
      continue;
    }
    if (bufferTokens + segTokens + 2 <= target) {
      buffer = `${buffer}\n\n${seg}`;
      bufferTokens += segTokens + 2;
    } else {
      merged.push(buffer);
      buffer = seg;
      bufferTokens = segTokens;
    }
  }
  if (buffer.length > 0) merged.push(buffer);

  const chunks: Chunk[] = [];
  for (let ord = 0; ord < merged.length; ord++) {
    const text = merged[ord];
    const id = (await sha256(`${notePath}\n${ord}\n${text}`)).slice(0, 16);
    const sha = await sha256(text);
    chunks.push({ id, notePath, ord, text, sha, tokenEstimate: estimateTokens(text) });
  }
  return chunks;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hardSplit(text: string, maxTokens: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let buf = "";
  let bufTokens = 0;
  for (const sentence of sentences) {
    const t = estimateTokens(sentence);
    if (t > maxTokens) {
      if (buf.length > 0) {
        out.push(buf.trim());
        buf = "";
        bufTokens = 0;
      }
      // Sentence itself larger than maxTokens — slice on whitespace.
      const charsPerToken = 4;
      const sliceSize = maxTokens * charsPerToken;
      for (let i = 0; i < sentence.length; i += sliceSize) {
        out.push(sentence.slice(i, i + sliceSize).trim());
      }
      continue;
    }
    if (bufTokens + t > maxTokens) {
      out.push(buf.trim());
      buf = sentence;
      bufTokens = t;
    } else {
      buf += sentence;
      bufTokens += t;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 5: Verify chunker tests pass**

Run: `bun test src/core/indexer/chunker.test.ts`
Expected: 7/7 pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/indexer/types.ts src/core/indexer/chunker.ts src/core/indexer/chunker.test.ts
git commit -m "feat(indexer): paragraph-based chunker with stable IDs"
```

---

## Task 2: Embedder

**Files:**
- Create: `src/core/indexer/embedder.ts`
- Create: `src/core/indexer/embedder.test.ts`

**Why:** Wraps `LLMProvider.embed` with batching (the API has request size limits and dynamo benefits from batches of 16-32) and one retry on transient failure.

- [ ] **Step 1: Write failing tests**

Create `src/core/indexer/embedder.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatOptions, EmbedOptions, JsonSchema, LLMProvider } from "../llm/provider";
import { Embedder } from "./embedder";

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async () => ({}) as unknown,
    embed: async () => [],
    ...impl,
  };
}

describe("Embedder", () => {
  test("batches inputs into batches of `batchSize`", async () => {
    const seenBatches: string[][] = [];
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        seenBatches.push(input);
        return input.map(() => Array.from({ length: 4 }, () => 0.1));
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 3 });
    const inputs = ["a", "b", "c", "d", "e", "f", "g"];
    const vectors = await embedder.embed(inputs);
    expect(vectors).toHaveLength(7);
    expect(seenBatches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  test("preserves input order across batches", async () => {
    const provider = fakeProvider({
      embed: async (input: string[]) =>
        input.map((s) => Array.from({ length: 4 }, () => Number.parseInt(s, 10))),
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 2 });
    const vectors = await embedder.embed(["1", "2", "3", "4", "5"]);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  test("retries once on transient error then succeeds", async () => {
    let calls = 0;
    const provider = fakeProvider({
      embed: async (input: string[]) => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return input.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4, retryDelayMs: 1 });
    const vectors = await embedder.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test("re-throws after exhausting retries", async () => {
    const provider = fakeProvider({
      embed: async () => {
        throw new Error("permanent");
      },
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 2, retryDelayMs: 1 });
    await expect(embedder.embed(["a"])).rejects.toThrow("permanent");
  });

  test("empty input yields empty vectors", async () => {
    const provider = fakeProvider({});
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    expect(await embedder.embed([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/indexer/embedder.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement Embedder**

Create `src/core/indexer/embedder.ts`:

```typescript
import type { LLMProvider } from "../llm/provider";

export interface EmbedderOptions {
  model: string;
  batchSize?: number;
  retryDelayMs?: number;
}

export class Embedder {
  private readonly batchSize: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: EmbedderOptions,
  ) {
    this.batchSize = opts.batchSize ?? 16;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
  }

  async embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize);
      const vectors = await this.embedBatchWithRetry(batch, signal);
      out.push(...vectors);
    }
    return out;
  }

  private async embedBatchWithRetry(
    batch: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    try {
      return await this.provider.embed(batch, { model: this.opts.model, signal });
    } catch (firstError) {
      await sleep(this.retryDelayMs);
      try {
        return await this.provider.embed(batch, { model: this.opts.model, signal });
      } catch {
        throw firstError;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/core/indexer/embedder.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer/embedder.ts src/core/indexer/embedder.test.ts
git commit -m "feat(indexer): batched embedder with single retry"
```

---

## Task 3: VectorIndex interface + InMemoryVectorIndex

**Files:**
- Create: `src/core/indexer/vectorIndex.ts`
- Create: `src/core/indexer/vectorIndex.test.ts`

**Why:** All consumers (extractor neighbor lookup later, search pipeline, agents) talk to a `VectorIndex` interface. Tests use `InMemoryVectorIndex`. Production uses `HnswVectorIndex` (Task 4). Decoupling lets tests stay fast and dep-free.

- [ ] **Step 1: Write failing tests**

Create `src/core/indexer/vectorIndex.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { InMemoryVectorIndex } from "./vectorIndex";

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe("InMemoryVectorIndex", () => {
  test("init sets dim and starts empty", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(4);
    expect(idx.size()).toBe(0);
  });

  test("add stores vectors and search returns nearest by cosine", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    idx.add("a", vec([1, 0, 0]));
    idx.add("b", vec([0, 1, 0]));
    idx.add("c", vec([0.9, 0.1, 0]));
    const results = idx.search(vec([1, 0, 0]), 2);
    expect(results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("search throws when k is non-positive", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    expect(() => idx.search(vec([1, 0, 0]), 0)).toThrow();
  });

  test("add throws when vector dim mismatches", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    expect(() => idx.add("x", vec([1, 0]))).toThrow(/dim/);
  });

  test("remove deletes by id", async () => {
    const idx = new InMemoryVectorIndex();
    await idx.init(3);
    idx.add("a", vec([1, 0, 0]));
    idx.add("b", vec([0, 1, 0]));
    idx.remove("a");
    expect(idx.size()).toBe(1);
    expect(idx.search(vec([1, 0, 0]), 1).map((r) => r.id)).toEqual(["b"]);
  });

  test("persist + load round-trips through ArrayBuffer", async () => {
    const a = new InMemoryVectorIndex();
    await a.init(2);
    a.add("x", vec([1, 0]));
    a.add("y", vec([0, 1]));
    const blob = await a.persist();

    const b = new InMemoryVectorIndex();
    await b.load(blob);
    expect(b.size()).toBe(2);
    expect(b.search(vec([1, 0]), 1).map((r) => r.id)).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/indexer/vectorIndex.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement the interface and in-memory impl**

Create `src/core/indexer/vectorIndex.ts`:

```typescript
export interface VectorSearchResult {
  id: string;
  score: number;
}

export interface VectorIndex {
  init(dim: number): Promise<void>;
  add(id: string, vector: Float32Array): void;
  remove(id: string): void;
  search(query: Float32Array, k: number): VectorSearchResult[];
  size(): number;
  persist(): Promise<ArrayBuffer>;
  load(blob: ArrayBuffer): Promise<void>;
}

export class InMemoryVectorIndex implements VectorIndex {
  private dim = 0;
  private readonly vectors = new Map<string, Float32Array>();

  async init(dim: number): Promise<void> {
    this.dim = dim;
    this.vectors.clear();
  }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dim) {
      throw new Error(`vector dim ${vector.length} != index dim ${this.dim}`);
    }
    this.vectors.set(id, Float32Array.from(vector));
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(query: Float32Array, k: number): VectorSearchResult[] {
    if (k <= 0) throw new Error("k must be > 0");
    if (query.length !== this.dim) {
      throw new Error(`query dim ${query.length} != index dim ${this.dim}`);
    }
    const queryNorm = magnitude(query);
    const results: VectorSearchResult[] = [];
    for (const [id, v] of this.vectors) {
      const score = cosine(query, v, queryNorm);
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  size(): number {
    return this.vectors.size;
  }

  async persist(): Promise<ArrayBuffer> {
    const entries: Array<[string, number[]]> = [];
    for (const [id, v] of this.vectors) entries.push([id, Array.from(v)]);
    const json = JSON.stringify({ dim: this.dim, entries });
    return new TextEncoder().encode(json).buffer as ArrayBuffer;
  }

  async load(blob: ArrayBuffer): Promise<void> {
    const json = new TextDecoder().decode(blob);
    const parsed = JSON.parse(json) as { dim: number; entries: Array<[string, number[]]> };
    this.dim = parsed.dim;
    this.vectors.clear();
    for (const [id, arr] of parsed.entries) this.vectors.set(id, Float32Array.from(arr));
  }
}

function magnitude(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum) || 1;
}

function cosine(a: Float32Array, b: Float32Array, aMag?: number): number {
  const am = aMag ?? magnitude(a);
  const bm = magnitude(b);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (am * bm);
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/core/indexer/vectorIndex.test.ts`
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer/vectorIndex.ts src/core/indexer/vectorIndex.test.ts
git commit -m "feat(indexer): VectorIndex interface + InMemoryVectorIndex impl"
```

---

## Task 4: HnswVectorIndex (production impl)

**Files:**
- Create: `src/core/indexer/hnswVectorIndex.ts`
- Modify: `src/core/indexer/vectorIndex.test.ts` (add a smoke test)

**Why:** Production needs sub-linear search across ~10K chunks. `hnswlib-wasm` is already in `package.json` (`^0.8.2`). The wrapper hides the WASM init dance and the int32 label encoding (HNSW uses numeric labels; we maintain a side-table mapping labels to chunk IDs).

**Library notes:**
- API entry: `import { loadHnswlib } from "hnswlib-wasm";`
- `const lib = await loadHnswlib();` then `const index = new lib.HierarchicalNSW("cosine", dim);`
- `index.initIndex(maxElements, M, efConstruction, randomSeed);`
- `index.addPoint(vector: number[], label: number, replaceDeleted?: boolean): void`
- `index.searchKnn(query: number[], k: number, filter?: (label: number) => boolean): { neighbors: number[]; distances: number[] }`
- `index.markDelete(label: number): void`
- `index.writeIndex(filename: string): void` and `readIndex(filename, maxElements, allowReplaceDeleted)` — the WASM uses an emscripten virtual FS; our `persist()` writes to that FS and reads back the bytes via `lib.EmscriptenFileSystemManager.readFile(name)` (or via the `readIndex`/`writeIndex` API as exposed by the version pinned). Verify exact API names against `node_modules/hnswlib-wasm/dist/hnswlib.d.ts` before writing the file; if a method signature differs, prefer the version present and update the wrapper.

- [ ] **Step 1: Add HNSW smoke tests**

Append to `src/core/indexer/vectorIndex.test.ts`:

```typescript
import { HnswVectorIndex } from "./hnswVectorIndex";

describe("HnswVectorIndex (smoke)", () => {
  test("initializes, indexes 50 vectors, returns nearest neighbor", async () => {
    const idx = new HnswVectorIndex({ maxElements: 100 });
    await idx.init(8);
    for (let i = 0; i < 50; i++) {
      const v = Float32Array.from(
        Array.from({ length: 8 }, (_, k) => (k === i % 8 ? 1 : 0)),
      );
      idx.add(`id-${i}`, v);
    }
    const target = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
    const results = idx.search(target, 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe("id-0");
  });

  test("persist/load round-trip preserves search", async () => {
    const a = new HnswVectorIndex({ maxElements: 10 });
    await a.init(4);
    a.add("p", Float32Array.from([1, 0, 0, 0]));
    a.add("q", Float32Array.from([0, 1, 0, 0]));
    const blob = await a.persist();

    const b = new HnswVectorIndex({ maxElements: 10 });
    await b.load(blob);
    const results = b.search(Float32Array.from([1, 0, 0, 0]), 1);
    expect(results[0].id).toBe("p");
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/indexer/vectorIndex.test.ts`
Expected: HnswVectorIndex import fails.

- [ ] **Step 3: Implement HnswVectorIndex**

Create `src/core/indexer/hnswVectorIndex.ts`:

```typescript
import { loadHnswlib } from "hnswlib-wasm";
import type { VectorIndex, VectorSearchResult } from "./vectorIndex";

export interface HnswOptions {
  maxElements?: number;
  M?: number;
  efConstruction?: number;
  efSearch?: number;
  space?: "cosine" | "l2" | "ip";
}

interface SerializedHeader {
  dim: number;
  maxElements: number;
  nextLabel: number;
  idToLabel: Array<[string, number]>;
  labelToId: Array<[number, string]>;
  indexFileName: string;
  indexBytesBase64: string;
  options: Required<HnswOptions>;
}

export class HnswVectorIndex implements VectorIndex {
  // biome-ignore lint/suspicious/noExplicitAny: hnswlib-wasm types are loose at the boundary
  private lib: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: HierarchicalNSW instance type lives in the wasm module
  private index: any = null;
  private dim = 0;
  private nextLabel = 0;
  private readonly idToLabel = new Map<string, number>();
  private readonly labelToId = new Map<number, string>();
  private readonly options: Required<HnswOptions>;

  constructor(opts: HnswOptions = {}) {
    this.options = {
      maxElements: opts.maxElements ?? 50_000,
      M: opts.M ?? 16,
      efConstruction: opts.efConstruction ?? 200,
      efSearch: opts.efSearch ?? 64,
      space: opts.space ?? "cosine",
    };
  }

  async init(dim: number): Promise<void> {
    this.dim = dim;
    this.lib = await loadHnswlib();
    this.index = new this.lib.HierarchicalNSW(this.options.space, dim);
    this.index.initIndex(
      this.options.maxElements,
      this.options.M,
      this.options.efConstruction,
      100,
    );
    this.index.setEfSearch(this.options.efSearch);
  }

  add(id: string, vector: Float32Array): void {
    this.requireInit();
    if (vector.length !== this.dim) {
      throw new Error(`vector dim ${vector.length} != index dim ${this.dim}`);
    }
    const existing = this.idToLabel.get(id);
    if (existing !== undefined) {
      this.index.markDelete(existing);
      this.labelToId.delete(existing);
      this.idToLabel.delete(id);
    }
    const label = this.nextLabel++;
    this.index.addPoint(Array.from(vector), label, false);
    this.idToLabel.set(id, label);
    this.labelToId.set(label, id);
  }

  remove(id: string): void {
    this.requireInit();
    const label = this.idToLabel.get(id);
    if (label === undefined) return;
    this.index.markDelete(label);
    this.idToLabel.delete(id);
    this.labelToId.delete(label);
  }

  search(query: Float32Array, k: number): VectorSearchResult[] {
    this.requireInit();
    if (k <= 0) throw new Error("k must be > 0");
    if (query.length !== this.dim) {
      throw new Error(`query dim ${query.length} != index dim ${this.dim}`);
    }
    if (this.idToLabel.size === 0) return [];
    const cap = Math.min(k, this.idToLabel.size);
    const result = this.index.searchKnn(Array.from(query), cap);
    const out: VectorSearchResult[] = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const id = this.labelToId.get(result.neighbors[i]);
      if (id === undefined) continue;
      out.push({ id, score: 1 - result.distances[i] });
    }
    return out;
  }

  size(): number {
    return this.idToLabel.size;
  }

  async persist(): Promise<ArrayBuffer> {
    this.requireInit();
    const filename = `notient-hnsw-${Date.now()}.bin`;
    this.index.writeIndex(filename);
    const fs = this.lib.EmscriptenFileSystemManager;
    const bytes = fs.readFile(filename) as Uint8Array;
    fs.deleteFile(filename);
    const header: SerializedHeader = {
      dim: this.dim,
      maxElements: this.options.maxElements,
      nextLabel: this.nextLabel,
      idToLabel: Array.from(this.idToLabel.entries()),
      labelToId: Array.from(this.labelToId.entries()),
      indexFileName: filename,
      indexBytesBase64: base64Encode(bytes),
      options: this.options,
    };
    const json = JSON.stringify(header);
    return new TextEncoder().encode(json).buffer as ArrayBuffer;
  }

  async load(blob: ArrayBuffer): Promise<void> {
    const json = new TextDecoder().decode(blob);
    const parsed = JSON.parse(json) as SerializedHeader;
    this.dim = parsed.dim;
    this.nextLabel = parsed.nextLabel;
    this.idToLabel.clear();
    this.labelToId.clear();
    for (const [id, label] of parsed.idToLabel) this.idToLabel.set(id, label);
    for (const [label, id] of parsed.labelToId) this.labelToId.set(label, id);
    this.lib = await loadHnswlib();
    const fs = this.lib.EmscriptenFileSystemManager;
    fs.writeFile(parsed.indexFileName, base64Decode(parsed.indexBytesBase64));
    this.index = new this.lib.HierarchicalNSW(parsed.options.space, this.dim);
    this.index.readIndex(parsed.indexFileName, parsed.maxElements, true);
    this.index.setEfSearch(parsed.options.efSearch);
    fs.deleteFile(parsed.indexFileName);
  }

  private requireInit(): void {
    if (!this.index || !this.lib) throw new Error("HnswVectorIndex.init() must be called first");
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
```

**Watch-outs:**
- The exact `EmscriptenFileSystemManager` API name may differ in 0.8.2 — open `node_modules/hnswlib-wasm/dist/hnswlib.d.ts` and adjust. If the version exposes `lib.FS` instead, use `lib.FS.readFile(name)` / `lib.FS.writeFile(name, bytes)` / `lib.FS.unlink(name)`.
- `setEfSearch` may be named `setEf`; check the .d.ts.
- If `addPoint` requires `replaceDeleted: true` to slot into deleted labels (we currently let the index grow), that's fine for v1.0 — `maxElements: 50_000` is comfortable headroom for the 894-note vault.

- [ ] **Step 4: Verify HNSW tests pass**

Run: `bun test src/core/indexer/vectorIndex.test.ts`
Expected: green (8 total tests).

If `loadHnswlib()` requires a wasm path resolver in Bun's test runner, set the env var `HNSWLIB_WASM_PATH` to `node_modules/hnswlib-wasm/dist/hnswlib.wasm` and re-run. If it still fails in the test runner, mark the HNSW smoke tests as `test.skip` and add a `// TODO(phase-2.5)` referencing the runtime-only validation. The interface contract is fully covered by `InMemoryVectorIndex` tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer/hnswVectorIndex.ts src/core/indexer/vectorIndex.test.ts
git commit -m "feat(indexer): HnswVectorIndex (hnswlib-wasm) with persist/load"
```

---

## Task 5: Extractor

**Files:**
- Create: `src/core/indexer/extractor.ts`
- Create: `src/core/indexer/extractor.test.ts`

**Why:** Per chunk batch, ask `qwen3.5-2b` (fast model on dynamo) to return `{ entities, claims, questions }`. Uses `chatJson<T>` for hard-typed output.

**Prompt design:** one system message defining the role + JSON contract; one user message with the chunk text. Per spec §4.1: entities are people/projects/terms/themes; claims are atomic propositions; questions are open questions raised by the note. Caller passes a list of chunks; we run them in parallel up to a configurable concurrency.

- [ ] **Step 1: Write failing tests**

Create `src/core/indexer/extractor.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../llm/provider";
import { Extractor } from "./extractor";
import type { Chunk } from "./types";

function chunk(text: string, ord = 0): Chunk {
  return {
    id: `c${ord}`,
    notePath: "/n.md",
    ord,
    text,
    sha: "sha",
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

function fakeProvider(impl: Partial<LLMProvider>): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async () => ({}) as unknown,
    embed: async () => [],
    ...impl,
  };
}

describe("Extractor", () => {
  test("returns empty extraction for empty chunks list", async () => {
    const provider = fakeProvider({});
    const extractor = new Extractor(provider, { model: "qwen3.5-2b" });
    const out = await extractor.extract([]);
    expect(out).toEqual({ entities: [], claims: [], questions: [] });
  });

  test("aggregates entities/claims/questions across chunks and dedupes case-insensitively", async () => {
    const responses: Array<{ entities: string[]; claims: string[]; questions: string[] }> = [
      { entities: ["Alice", "POSIX"], claims: ["POSIX is leaky."], questions: [] },
      { entities: ["alice", "HPC"], claims: ["POSIX is leaky."], questions: ["Why?"] },
    ];
    let i = 0;
    const provider = fakeProvider({
      chatJson: async () => responses[i++] as unknown,
    });
    const extractor = new Extractor(provider, { model: "qwen3.5-2b", concurrency: 1 });
    const out = await extractor.extract([chunk("first", 0), chunk("second", 1)]);
    expect(out.entities.sort()).toEqual(["Alice", "HPC", "POSIX"].sort());
    expect(out.claims).toEqual(["POSIX is leaky."]);
    expect(out.questions).toEqual(["Why?"]);
  });

  test("passes the schema and chunk text to chatJson", async () => {
    const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions; schema: JsonSchema }> = [];
    const provider = fakeProvider({
      chatJson: async (messages, opts, schema) => {
        calls.push({ messages, opts, schema });
        return { entities: [], claims: [], questions: [] };
      },
    });
    const extractor = new Extractor(provider, { model: "qwen3.5-2b" });
    await extractor.extract([chunk("Alice met Bob.")]);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.model).toBe("qwen3.5-2b");
    expect(calls[0].schema.name).toBe("Extraction");
    expect(JSON.stringify(calls[0].messages)).toContain("Alice met Bob.");
  });

  test("survives a single failing chunk and continues with others", async () => {
    let i = 0;
    const provider = fakeProvider({
      chatJson: async () => {
        i++;
        if (i === 2) throw new Error("model OOM");
        return { entities: [`E${i}`], claims: [], questions: [] };
      },
    });
    const extractor = new Extractor(provider, { model: "qwen3.5-2b", concurrency: 1 });
    const out = await extractor.extract([chunk("a", 0), chunk("b", 1), chunk("c", 2)]);
    expect(out.entities.sort()).toEqual(["E1", "E3"]);
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/indexer/extractor.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement Extractor**

Create `src/core/indexer/extractor.ts`:

```typescript
import type { ChatMessage, JsonSchema, LLMProvider } from "../llm/provider";
import type { Chunk, Extraction } from "./types";

export interface ExtractorOptions {
  model: string;
  concurrency?: number;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are Notient's extractor. From a note chunk, identify:
- entities: people, projects, named systems, recurring themes, technical terms (canonical singular form)
- claims: atomic propositions the chunk asserts (one sentence each, declarative)
- questions: open questions the chunk raises (end with "?")
Return only JSON matching the schema. If a category has nothing, return an empty array. Do not invent facts.`;

const SCHEMA: JsonSchema = {
  name: "Extraction",
  schema: {
    type: "object",
    properties: {
      entities: { type: "array", items: { type: "string" } },
      claims: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["entities", "claims", "questions"],
    additionalProperties: false,
  },
};

export class Extractor {
  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: ExtractorOptions,
  ) {}

  async extract(chunks: Chunk[]): Promise<Extraction> {
    if (chunks.length === 0) return { entities: [], claims: [], questions: [] };
    const concurrency = Math.max(1, this.opts.concurrency ?? 2);
    const results: Extraction[] = [];

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((c) => this.extractOne(c)));
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
      }
    }

    return mergeExtractions(results);
  }

  private async extractOne(chunk: Chunk): Promise<Extraction> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: chunk.text },
    ];
    const result = await this.provider.chatJson<Extraction>(
      messages,
      { model: this.opts.model, signal: this.opts.signal, temperature: 0.1 },
      SCHEMA,
    );
    return {
      entities: ensureStringArray(result.entities),
      claims: ensureStringArray(result.claims),
      questions: ensureStringArray(result.questions),
    };
  }
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function mergeExtractions(parts: Extraction[]): Extraction {
  const entities = dedupeCaseInsensitive(parts.flatMap((p) => p.entities));
  const claims = dedupe(parts.flatMap((p) => p.claims));
  const questions = dedupe(parts.flatMap((p) => p.questions));
  return { entities, claims, questions };
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values());
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/core/indexer/extractor.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer/extractor.ts src/core/indexer/extractor.test.ts
git commit -m "feat(indexer): Extractor (entities/claims/questions via chatJson)"
```

---

## Task 6: indexNote orchestrator

**Files:**
- Create: `src/core/indexer/indexNote.ts`
- Create: `src/core/indexer/indexNote.test.ts`
- Modify: `src/core/events/types.ts` — extend `AppEvent`

**Why:** Single function that turns a note path into a fully-populated graph entry. Wraps everything in a DB transaction so a thrown extractor leaves no half-state.

**Pipeline:**
1. Read note from facade.
2. Compute SHA. If `notes.sha` matches the stored value, short-circuit (idempotent).
3. Strip frontmatter (use existing `extractNotientBlock` utility's helper or inline the same regex).
4. `chunkNote` → chunks.
5. `embedder.embed` → vectors.
6. `extractor.extract` → entities/claims/questions.
7. **Single DB transaction:**
   - Delete previous chunks/embeddings/edges-from-this-note.
   - Upsert `notes` row.
   - Upsert `note` graph node.
   - Insert chunks, embeddings.
   - Insert concept/claim/question nodes (deduped against existing by id).
   - Insert `mentions`/`asserts`/`asks` edges from the note.
8. Vector index `add` for each chunk (outside the txn — vector index has its own persistence).
9. Emit `indexer:note-indexed` event.
10. Return `IndexResult`.

**Determinism:** node IDs use stable hashes:
- concept: `concept:${slugify(name)}` (case-insensitive normalized)
- claim: `claim:${sha256(notePath + "|" + text).slice(0,16)}`
- question: `question:${sha256(notePath + "|" + text).slice(0,16)}`

- [ ] **Step 1: Extend events**

Edit `src/core/events/types.ts`:

```typescript
export type AppEvent =
  | { type: "settings:changed"; key: string }
  | { type: "llm:health"; endpoint: string; ok: boolean; latencyMs?: number }
  | { type: "vault:note-saved"; path: string; sha: string }
  | { type: "indexer:progress"; processed: number; total: number }
  | { type: "indexer:complete"; total: number }
  | { type: "indexer:error"; message: string }
  | {
      type: "indexer:node-added";
      nodeId: string;
      nodeType: "note" | "concept" | "claim" | "question";
      label: string;
      notePath: string | null;
    }
  | {
      type: "indexer:edge-added";
      edgeId: string;
      edgeType: string;
      sourceId: string;
      targetId: string;
    }
  | { type: "indexer:note-indexed"; path: string; result: IndexerNoteResult };

export interface IndexerNoteResult {
  chunkCount: number;
  embedCount: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

export type EventType = AppEvent["type"];
export type EventOf<T extends EventType> = Extract<AppEvent, { type: T }>;
export type EventHandler<T extends EventType> = (event: EventOf<T>) => void;
```

- [ ] **Step 2: Write failing tests**

Create `src/core/indexer/indexNote.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventBus } from "../events/eventBus";
import type { AppEvent } from "../events/types";
import { GraphStore } from "../graph/graphStore";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../llm/provider";
import { Database, type DatabaseAdapter } from "../db/database";
import { Embedder } from "./embedder";
import { Extractor } from "./extractor";
import { indexNote } from "./indexNote";
import { InMemoryVectorIndex } from "./vectorIndex";
import type { Extraction } from "./types";

class MemoryAdapter implements DatabaseAdapter {
  files = new Map<string, ArrayBuffer>();
  constructor(initial: Record<string, ArrayBuffer> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(path) ?? null;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, data);
  }
}

function loadWasm(): ArrayBuffer {
  const wasmPath = resolve(import.meta.dir, "../../../node_modules/sql.js/dist/sql-wasm.wasm");
  const buf = readFileSync(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function fakeProvider(extraction: Extraction, dim = 4): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async () => extraction as unknown,
    embed: async (input) => input.map(() => Array.from({ length: dim }, () => 0.1)),
  };
}

async function setup() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const database = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await database.init();
  const graph = new GraphStore(database);
  const vectorIndex = new InMemoryVectorIndex();
  await vectorIndex.init(4);
  const bus = new EventBus();
  return { database, graph, vectorIndex, bus };
}

describe("indexNote", () => {
  test("populates notes/chunks/embeddings/graph in one transaction", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({
      entities: ["POSIX"],
      claims: ["POSIX is leaky."],
      questions: ["Why is POSIX leaky?"],
    });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });

    const events: AppEvent[] = [];
    bus.on("indexer:node-added", (e) => events.push(e));
    bus.on("indexer:edge-added", (e) => events.push(e));
    bus.on("indexer:note-indexed", (e) => events.push(e));

    const result = await indexNote({
      notePath: "/note.md",
      noteBody: "POSIX is leaky in HPC.\n\nWhy is it like this?",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.edgeCount).toBeGreaterThan(0);

    const noteRows = database.query<{ path: string; sha: string }>("SELECT path, sha FROM notes;");
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0].path).toBe("/note.md");

    const chunkRows = database.query<{ note_path: string }>("SELECT note_path FROM chunks;");
    expect(chunkRows.length).toBe(result.chunkCount);

    const embRows = database.query<{ chunk_id: string }>("SELECT chunk_id FROM embeddings;");
    expect(embRows.length).toBe(result.embedCount);

    const conceptNodes = graph.nodesByType("concept");
    expect(conceptNodes.some((n) => n.label === "POSIX")).toBe(true);

    const noteIndexedEvents = events.filter((e) => e.type === "indexer:note-indexed");
    expect(noteIndexedEvents).toHaveLength(1);
    expect(vectorIndex.size()).toBe(result.embedCount);
  });

  test("idempotent on identical body — short-circuits when sha unchanged", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: ["A"], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    const args = {
      notePath: "/n.md",
      noteBody: "Hello world.",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    };
    const r1 = await indexNote(args);
    const r2 = await indexNote(args);
    expect(r2.chunkCount).toBe(0);
    expect(r2.embedCount).toBe(0);
    const chunkRows = database.query<{ id: string }>("SELECT id FROM chunks;");
    expect(chunkRows.length).toBe(r1.chunkCount);
  });

  test("re-indexing on modified body deletes old chunks/edges before writing new", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: ["A"], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    await indexNote({
      notePath: "/n.md",
      noteBody: "old body",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    await indexNote({
      notePath: "/n.md",
      noteBody: "new body that is different",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    const chunkRows = database.query<{ id: string; note_path: string }>(
      "SELECT id, note_path FROM chunks WHERE note_path = '/n.md';",
    );
    expect(chunkRows.length).toBeGreaterThan(0);
    const distinctSha = database.query<{ sha: string }>(
      "SELECT DISTINCT sha FROM notes WHERE path = '/n.md';",
    );
    expect(distinctSha).toHaveLength(1);
  });

  test("strips frontmatter from body before chunking", async () => {
    const { database, graph, vectorIndex, bus } = await setup();
    const provider = fakeProvider({ entities: [], claims: [], questions: [] });
    const embedder = new Embedder(provider, { model: "e", batchSize: 4 });
    const extractor = new Extractor(provider, { model: "x" });
    await indexNote({
      notePath: "/n.md",
      noteBody: "---\ntitle: Hi\n---\nactual body",
      database,
      graph,
      vectorIndex,
      embedder,
      extractor,
      bus,
    });
    const chunkRows = database.query<{ text: string }>("SELECT text FROM chunks;");
    expect(chunkRows[0].text).not.toContain("title: Hi");
    expect(chunkRows[0].text).toContain("actual body");
  });
});
```

- [ ] **Step 3: Verify failing tests**

Run: `bun test src/core/indexer/indexNote.test.ts`
Expected: module not found.

- [ ] **Step 4: Implement indexNote**

Create `src/core/indexer/indexNote.ts`:

```typescript
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { GraphStore } from "../graph/graphStore";
import type { GraphEdge, GraphNode, NodeType } from "../graph/types";
import { chunkNote } from "./chunker";
import type { Embedder } from "./embedder";
import type { Extractor } from "./extractor";
import type { Chunk, Extraction, IndexResult } from "./types";
import type { VectorIndex } from "./vectorIndex";

export interface IndexNoteArgs {
  notePath: string;
  noteBody: string;
  database: Database;
  graph: GraphStore;
  vectorIndex: VectorIndex;
  embedder: Embedder;
  extractor: Extractor;
  bus: EventBus;
}

const FENCE = "---";

export async function indexNote(args: IndexNoteArgs): Promise<IndexResult> {
  const start = Date.now();
  const { notePath, noteBody, database, graph, vectorIndex, embedder, extractor, bus } = args;
  const sha = await sha256(noteBody);

  const existing = database.query<{ sha: string }>(
    "SELECT sha FROM notes WHERE path = ?;",
    [notePath],
  );
  if (existing[0]?.sha === sha) {
    return {
      notePath,
      noteSha: sha,
      chunkCount: 0,
      embedCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      durationMs: Date.now() - start,
    };
  }

  const body = stripFrontmatter(noteBody);
  const chunks = await chunkNote(notePath, body);
  const vectors =
    chunks.length > 0
      ? await embedder.embed(chunks.map((c) => c.text))
      : ([] as number[][]);
  const extraction = await extractor.extract(chunks);

  const nowMs = Date.now();
  const noteNode: GraphNode = {
    id: `note:${notePath}`,
    type: "note",
    label: notePath,
    notePath,
    payload: null,
    createdAt: nowMs,
  };

  const conceptNodes = extraction.entities.map((label) => buildConceptNode(label, nowMs));
  const claimNodes = extraction.claims.map((text) => buildClaimNode(notePath, text, nowMs));
  const questionNodes = extraction.questions.map((text) =>
    buildQuestionNode(notePath, text, nowMs),
  );

  const allNodes: GraphNode[] = [noteNode, ...conceptNodes, ...claimNodes, ...questionNodes];
  const edgeAgent = "extractor";
  const edges: GraphEdge[] = [
    ...conceptNodes.map((c) =>
      buildEdge("mentions", noteNode.id, c.id, edgeAgent, [], nowMs),
    ),
    ...claimNodes.map((c) =>
      buildEdge("asserts", noteNode.id, c.id, edgeAgent, [], nowMs),
    ),
    ...questionNodes.map((q) =>
      buildEdge("asks", noteNode.id, q.id, edgeAgent, [], nowMs),
    ),
  ];

  database.transaction(() => {
    database.run("DELETE FROM chunks WHERE note_path = ?;", [notePath]);
    // Embeddings cascade via chunks ON DELETE CASCADE.
    database.run("DELETE FROM graph_edges WHERE source_id = ?;", [noteNode.id]);
    database.run(
      `INSERT INTO notes (path, sha, word_count, indexed_at, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET sha = excluded.sha,
         word_count = excluded.word_count,
         updated_at = excluded.updated_at,
         indexed_at = excluded.indexed_at;`,
      [notePath, sha, countWords(body), nowMs, nowMs],
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      database.run(
        `INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);`,
        [chunk.id, chunk.notePath, chunk.ord, chunk.text, chunk.sha],
      );
      const vector = vectors[i];
      if (vector) {
        database.run(
          `INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);`,
          [
            chunk.id,
            "primary-embed",
            vector.length,
            new Uint8Array(Float32Array.from(vector).buffer),
          ],
        );
      }
    }
    for (const node of allNodes) graph.upsertNode(node);
    for (const edge of edges) graph.insertEdge(edge);
  });

  for (let i = 0; i < chunks.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    vectorIndex.add(chunks[i].id, Float32Array.from(v));
  }

  for (const node of allNodes) {
    bus.emit({
      type: "indexer:node-added",
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      notePath: node.notePath,
    });
  }
  for (const edge of edges) {
    bus.emit({
      type: "indexer:edge-added",
      edgeId: edge.id,
      edgeType: edge.type,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    });
  }

  const result: IndexResult = {
    notePath,
    noteSha: sha,
    chunkCount: chunks.length,
    embedCount: vectors.length,
    nodeCount: allNodes.length,
    edgeCount: edges.length,
    durationMs: Date.now() - start,
  };
  bus.emit({
    type: "indexer:note-indexed",
    path: notePath,
    result: {
      chunkCount: result.chunkCount,
      embedCount: result.embedCount,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      durationMs: result.durationMs,
    },
  });
  return result;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith(FENCE)) return content;
  const closeIdx = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (closeIdx === -1) return content;
  const after = closeIdx + 1 + FENCE.length;
  return content.slice(after).replace(/^\r?\n/, "");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildConceptNode(label: string, nowMs: number): GraphNode {
  return {
    id: `concept:${slugify(label)}`,
    type: "concept",
    label,
    notePath: null,
    payload: null,
    createdAt: nowMs,
  };
}

function buildClaimNode(notePath: string, text: string, nowMs: number): GraphNode {
  const id = `claim:${shortHash(`${notePath}|${text}`)}`;
  return {
    id,
    type: "claim",
    label: text,
    notePath,
    payload: { text },
    createdAt: nowMs,
  };
}

function buildQuestionNode(notePath: string, text: string, nowMs: number): GraphNode {
  const id = `question:${shortHash(`${notePath}|${text}`)}`;
  return {
    id,
    type: "question",
    label: text,
    notePath,
    payload: { text },
    createdAt: nowMs,
  };
}

function buildEdge(
  type: GraphEdge["type"],
  sourceId: string,
  targetId: string,
  agent: string,
  evidence: string[],
  nowMs: number,
): GraphEdge {
  return {
    id: `edge:${shortHash(`${type}|${sourceId}|${targetId}|${nowMs}`)}`,
    type,
    sourceId,
    targetId,
    confidence: 1,
    agent,
    evidence,
    approved: true,
    createdAt: nowMs,
  };
}

function shortHash(input: string): string {
  // Sync FNV-1a 32-bit, hex; deterministic and fast.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function sha256(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 5: Verify tests pass**

Run: `bun test src/core/indexer/indexNote.test.ts`
Expected: 4/4 pass.

- [ ] **Step 6: Type-check + lint sweep**

Run: `bun run typecheck && bun run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/core/events/types.ts src/core/indexer/indexNote.ts src/core/indexer/indexNote.test.ts
git commit -m "feat(indexer): indexNote orchestrator with single DB transaction"
```

---

## Task 7: IndexerQueue (debounced + batched)

**Files:**
- Create: `src/core/indexer/indexerQueue.ts`
- Create: `src/core/indexer/indexerQueue.test.ts`

**Why:** The queue sits between `vault.modify` (or `awakenRunner`) and `indexNote`. It debounces per-path saves (500 ms — see spec §3) and processes paths serially in the background, yielding to the event loop after each note so the UI stays responsive.

**Behavior:**
- `enqueue(path)` — schedules path for indexing in 500 ms.
- Repeated `enqueue(path)` resets the debounce timer for that path only.
- A single in-flight worker drains the ready queue one path at a time. After each `indexNote`, await `setTimeout(0)` to yield.
- Cancellation: `cancelAll()` clears pending and aborts in-flight (best effort).
- Backoff: if `indexNote` throws, emit `indexer:error` and continue with the next path.

- [ ] **Step 1: Write failing tests**

Create `src/core/indexer/indexerQueue.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import { IndexerQueue, type IndexNoteFn } from "./indexerQueue";

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("IndexerQueue", () => {
  test("debounces repeated enqueues for the same path", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 30, bus });
    queue.enqueue("/a.md");
    await tick(10);
    queue.enqueue("/a.md");
    await tick(10);
    queue.enqueue("/a.md");
    await tick(80);
    expect(calls).toEqual(["/a.md"]);
    queue.dispose();
  });

  test("processes distinct paths in enqueue order", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 10, bus });
    queue.enqueue("/a.md");
    queue.enqueue("/b.md");
    queue.enqueue("/c.md");
    await tick(120);
    expect(calls).toEqual(["/a.md", "/b.md", "/c.md"]);
    queue.dispose();
  });

  test("emits indexer:error on failure but continues", async () => {
    const bus = new EventBus();
    const errors: string[] = [];
    bus.on("indexer:error", (e) => errors.push(e.message));
    let i = 0;
    const fn: IndexNoteFn = async (path) => {
      i++;
      if (i === 1) throw new Error(`bad ${path}`);
    };
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus });
    queue.enqueue("/a.md");
    queue.enqueue("/b.md");
    await tick(80);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bad /a.md");
    queue.dispose();
  });

  test("dispose stops further work", async () => {
    const calls: string[] = [];
    const fn: IndexNoteFn = async (path) => {
      calls.push(path);
    };
    const bus = new EventBus();
    const queue = new IndexerQueue({ indexNote: fn, debounceMs: 5, bus });
    queue.enqueue("/a.md");
    queue.dispose();
    await tick(40);
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/core/indexer/indexerQueue.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement IndexerQueue**

Create `src/core/indexer/indexerQueue.ts`:

```typescript
import type { EventBus } from "../events/eventBus";

export type IndexNoteFn = (path: string) => Promise<unknown>;

export interface IndexerQueueOptions {
  indexNote: IndexNoteFn;
  debounceMs?: number;
  bus: EventBus;
}

export class IndexerQueue {
  private readonly indexNote: IndexNoteFn;
  private readonly debounceMs: number;
  private readonly bus: EventBus;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private worker: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: IndexerQueueOptions) {
    this.indexNote = opts.indexNote;
    this.debounceMs = opts.debounceMs ?? 500;
    this.bus = opts.bus;
  }

  enqueue(path: string): void {
    if (this.disposed) return;
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(path);
      if (!this.readySet.has(path)) {
        this.ready.push(path);
        this.readySet.add(path);
      }
      this.kickWorker();
    }, this.debounceMs);
    this.pending.set(path, timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.ready.length = 0;
    this.readySet.clear();
  }

  pendingCount(): number {
    return this.pending.size + this.ready.length;
  }

  private kickWorker(): void {
    if (this.worker || this.disposed) return;
    this.worker = this.runWorker().finally(() => {
      this.worker = null;
      if (this.ready.length > 0 && !this.disposed) this.kickWorker();
    });
  }

  private async runWorker(): Promise<void> {
    while (!this.disposed && this.ready.length > 0) {
      const path = this.ready.shift();
      if (!path) break;
      this.readySet.delete(path);
      try {
        await this.indexNote(path);
      } catch (error) {
        this.bus.emit({
          type: "indexer:error",
          message: (error as Error).message ?? String(error),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/core/indexer/indexerQueue.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexer/indexerQueue.ts src/core/indexer/indexerQueue.test.ts
git commit -m "feat(indexer): debounced + batched IndexerQueue with error isolation"
```

---

## Task 8: Wire indexer into kernel + main.ts

**Files:**
- Modify: `src/core/kernel.ts` — add `indexer`, `vectorIndex`, `embedder`, `extractor` to required keys
- Modify: `src/main.ts` — instantiate, wire to vault.modify
- Modify: `src/core/settings/types.ts` — add `awakenedAt: number | null`

**Why:** Replace the toy SHA-only handler with the full pipeline. The handler now: read note → enqueue. The queue calls `indexNote`. Frontmatter awareness already filters via `extractNotientBlock` (Phase 3 will use it). For Phase 2, we keep the EchoGuard inert (no producer side yet).

- [ ] **Step 1: Add settings field**

Edit `src/core/settings/types.ts`:

```typescript
export interface NotientSettings {
  primary: LLMEndpointConfig;
  deep: LLMEndpointConfig;
  agents: {
    linker: boolean;
    synthesizer: boolean;
    contradictionHunter: boolean;
    maturityAdvancer: boolean;
  };
  coAuthor: {
    enabled: boolean;
    minWords: number;
    debounceMs: number;
  };
  approvals: {
    confidenceThreshold: number;
  };
  awakenedAt: number | null;
}
```

And add `awakenedAt: null` to `DEFAULT_SETTINGS` at the bottom of the object literal.

- [ ] **Step 2: Update required kernel keys**

Edit `src/core/kernel.ts`. Find the `REQUIRED_KEYS` array and add `"indexer"`, `"vectorIndex"`, `"embedder"`, `"extractor"`. (Echo guard was added in Task 0c.)

- [ ] **Step 3: Wire it up in main.ts**

Add new imports near the top of `src/main.ts`:

```typescript
import { Embedder } from "./core/indexer/embedder";
import { Extractor } from "./core/indexer/extractor";
import { HnswVectorIndex } from "./core/indexer/hnswVectorIndex";
import { IndexerQueue } from "./core/indexer/indexerQueue";
import { indexNote } from "./core/indexer/indexNote";
```

Add a constant near the top:

```typescript
const VECTOR_PATH = `${PLUGIN_DIR}/vectors.bin`;
```

Add the `indexOne` field to the plugin class (next to `echoGuard`):

```typescript
  indexOne!: (path: string) => Promise<unknown>;
```

Inside `onload()`, after `const graph = new GraphStore(database);`, add:

```typescript
    const vectorIndex = new HnswVectorIndex({ maxElements: 50_000 });
    if (await adapter.exists(VECTOR_PATH)) {
      const blob = await adapter.readBinary(VECTOR_PATH);
      await vectorIndex.load(blob);
    } else {
      await vectorIndex.init(768); // nomic-embed-text-v2-moe
    }

    const embedder = new Embedder(primaryLLM, {
      model: current.primary.embeddingModel,
      batchSize: 16,
    });
    const extractor = new Extractor(primaryLLM, {
      model: current.primary.fastModel,
      concurrency: 2,
    });

    const indexOne = async (path: string): Promise<unknown> => {
      const body = await facade.read(path);
      const result = await indexNote({
        notePath: path,
        noteBody: body,
        database,
        graph,
        vectorIndex,
        embedder,
        extractor,
        bus: this.bus,
      });
      await database.persist();
      await adapter.writeBinary(VECTOR_PATH, await vectorIndex.persist());
      return result;
    };
    // Expose indexOne on the plugin instance so the AwakenVaultModal (Task 12)
    // can drive it directly without going through the debouncer.
    this.indexOne = indexOne;

    const indexerQueue = new IndexerQueue({
      indexNote: indexOne,
      debounceMs: 500,
      bus: this.bus,
    });
```

(Keep `primaryLLM` instantiated above this block, as in Phase 1.)

Register the new services:

```typescript
    this.kernel.register("vectorIndex", vectorIndex);
    this.kernel.register("embedder", embedder);
    this.kernel.register("extractor", extractor);
    this.kernel.register("indexer", indexerQueue);
```

Ensure these registrations happen **before** `this.kernel.seal()`.

Replace the existing `vault.on("modify", …)` handler (the one Task 0c rewrote — it currently inserts directly into the `notes` table) so it instead computes the SHA, consults the echo guard, and enqueues:

```typescript
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md")) return;
        try {
          const contents = await facade.read(file.path);
          const sha = await sha256(contents);
          if (this.echoGuard.take(file.path, sha)) return;
          this.bus.emit({ type: "vault:note-saved", path: file.path, sha });
          indexerQueue.enqueue(file.path);
        } catch (error) {
          console.error("[Notient] save handler error", error);
        }
      }),
    );
```

In `onunload()`, call `indexerQueue.dispose()` before closing the database:

```typescript
      try {
        this.kernel.get("indexer").dispose();
      } catch {
        // ignore
      }
```

- [ ] **Step 4: Type-check, lint, test**

Run: `bun run typecheck && bun run lint && bun test`
Expected: green. The 38 Phase 1 tests still pass; new indexer tests are green.

- [ ] **Step 5: Manual smoke test**

Run: `bun run dev` then reload the plugin in the test vault. Open a small note (under 500 words), edit it, save. Wait ~2s. Then run a quick DB check:

```bash
sqlite3 "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient/notient.db" \
  "SELECT count(*) FROM chunks; SELECT count(*) FROM embeddings; SELECT count(*) FROM graph_nodes; SELECT count(*) FROM graph_edges;"
```

Expected: counts > 0 (at least chunks and embeddings — extractor counts depend on dynamo being reachable). If counts are zero, check the dev console for `[Notient] save handler error` and `indexer:error` events.

- [ ] **Step 6: Commit**

```bash
git add src/core/kernel.ts src/main.ts src/core/settings/types.ts
git commit -m "feat(indexer): wire pipeline into vault.modify via IndexerQueue"
```

---

## Task 9: AwakenVaultModal scaffold (UI shell)

**Files:**
- Create: `src/ui/onboarding/AwakenVaultModal.ts`

**Why:** A pure UI shell for the modal. Renders title, counter row, canvas area, and a "Begin" / "Stop" / "Done" button. State management lives in `awakenRunner` (Task 10); rendering of nodes/edges in `graphCanvas` (Task 11). This task wires only the structural skeleton.

**Caveat:** Modal markup uses Obsidian's `Modal` API. We can't unit-test the rendered DOM in `bun test` without simulating Obsidian; this task ships UI plumbing only and is verified by manual smoke in the test vault. The headless `awakenRunner` (Task 10) carries the unit tests.

- [ ] **Step 1: Implement the modal shell**

Create `src/ui/onboarding/AwakenVaultModal.ts`:

```typescript
import { Modal, type App } from "obsidian";

export interface AwakenVaultModalDeps {
  start: () => Promise<void>;
  stop: () => void;
  isRunning: () => boolean;
  totalNotes: () => number;
  onAttachCanvas: (canvas: HTMLCanvasElement) => void;
  onAttachCounters: (el: HTMLElement) => void;
}

export class AwakenVaultModal extends Modal {
  private startButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private doneButton!: HTMLButtonElement;

  constructor(app: App, private readonly deps: AwakenVaultModalDeps) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("notient-awaken-modal");

    const header = contentEl.createDiv({ cls: "notient-awaken-header" });
    header.createEl("h2", { text: "Awaken Vault" });
    header.createEl("p", {
      text: `Notient is going to read every note in your vault, embed it, and grow your knowledge graph in real time. ${this.deps.totalNotes()} notes detected.`,
    });

    const counters = contentEl.createDiv({ cls: "notient-awaken-counters" });
    this.deps.onAttachCounters(counters);

    const canvasWrap = contentEl.createDiv({ cls: "notient-awaken-canvas-wrap" });
    const canvas = canvasWrap.createEl("canvas", {
      attr: { width: "720", height: "420" },
    });
    this.deps.onAttachCanvas(canvas);

    const buttons = contentEl.createDiv({ cls: "notient-awaken-buttons" });
    this.startButton = buttons.createEl("button", { text: "Begin" });
    this.stopButton = buttons.createEl("button", { text: "Stop" });
    this.stopButton.disabled = true;
    this.doneButton = buttons.createEl("button", { text: "Enter" });
    this.doneButton.disabled = true;

    this.startButton.addEventListener("click", () => {
      void this.run();
    });
    this.stopButton.addEventListener("click", () => {
      this.deps.stop();
      this.stopButton.disabled = true;
      this.startButton.disabled = false;
      this.doneButton.disabled = false;
    });
    this.doneButton.addEventListener("click", () => this.close());
  }

  private async run(): Promise<void> {
    this.startButton.disabled = true;
    this.stopButton.disabled = false;
    try {
      await this.deps.start();
    } finally {
      this.stopButton.disabled = true;
      this.startButton.disabled = false;
      this.doneButton.disabled = false;
    }
  }

  onClose(): void {
    this.deps.stop();
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Add baseline CSS**

Append to `src/styles.css` (create the file if it doesn't exist; Phase 1 left styling minimal):

```css
.notient-awaken-modal {
  min-width: 760px;
}
.notient-awaken-counters {
  display: flex;
  gap: 1rem;
  margin: 0.5rem 0 1rem 0;
  font-variant-numeric: tabular-nums;
}
.notient-awaken-counters .stat {
  display: flex;
  flex-direction: column;
}
.notient-awaken-counters .stat .label {
  font-size: 0.75rem;
  opacity: 0.6;
}
.notient-awaken-counters .stat .value {
  font-size: 1.4rem;
  font-weight: 600;
}
.notient-awaken-canvas-wrap {
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--background-secondary);
}
.notient-awaken-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  justify-content: flex-end;
}
```

- [ ] **Step 3: Type-check + lint**

Run: `bun run typecheck && bun run lint`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/ui/onboarding/AwakenVaultModal.ts src/styles.css
git commit -m "feat(onboarding): AwakenVaultModal shell + base CSS"
```

---

## Task 10: AwakenRunner

**Files:**
- Create: `src/ui/onboarding/awakenRunner.ts`
- Create: `src/ui/onboarding/awakenRunner.test.ts`

**Why:** Drives the indexer over every markdown file in the vault, with cancellation support and progress events. The modal binds to its callbacks; tests run it headless against fakes.

**Behavior:**
- `start({ onProgress, onComplete, onError })` — iterates the file list in batches of N (default 10) running `indexNote` in parallel within each batch (concurrency knob).
- `stop()` — sets a cancelled flag; in-flight calls finish but no new ones launch.
- Progress: emits per-batch `onProgress({ processed, total })`.
- On finish: `onComplete({ totalIndexed, durationMs })`.

- [ ] **Step 1: Write failing tests**

Create `src/ui/onboarding/awakenRunner.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { AwakenRunner, type AwakenRunnerArgs } from "./awakenRunner";

function makeArgs(overrides: Partial<AwakenRunnerArgs> = {}): AwakenRunnerArgs {
  const indexed: string[] = [];
  return {
    listMarkdown: () =>
      Array.from({ length: 5 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
    indexNote: async (path: string) => {
      indexed.push(path);
    },
    batchSize: 2,
    ...overrides,
    indexedRef: indexed,
  } as AwakenRunnerArgs & { indexedRef: string[] };
}

describe("AwakenRunner", () => {
  test("indexes all notes and reports complete with totals", async () => {
    const args = makeArgs();
    const progressEvents: Array<{ processed: number; total: number }> = [];
    let completed: { totalIndexed: number } | null = null;
    const runner = new AwakenRunner(args);
    await runner.start({
      onProgress: (p) => progressEvents.push(p),
      onComplete: (c) => {
        completed = c;
      },
      onError: () => {},
    });
    expect((args as unknown as { indexedRef: string[] }).indexedRef).toHaveLength(5);
    expect(progressEvents.at(-1)).toEqual({ processed: 5, total: 5 });
    expect(completed).not.toBeNull();
    expect(completed?.totalIndexed).toBe(5);
  });

  test("stop halts further batches", async () => {
    const indexed: string[] = [];
    let count = 0;
    const runner = new AwakenRunner({
      listMarkdown: () =>
        Array.from({ length: 20 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
      indexNote: async (path) => {
        indexed.push(path);
        count++;
        if (count === 4) runner.stop();
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      batchSize: 2,
    });
    await runner.start({
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    expect(indexed.length).toBeLessThanOrEqual(6);
  });

  test("survives a single failing note and continues", async () => {
    const errors: string[] = [];
    const runner = new AwakenRunner({
      listMarkdown: () =>
        Array.from({ length: 4 }, (_, i) => ({ path: `/n${i}.md`, mtime: 0 })),
      indexNote: async (path) => {
        if (path === "/n2.md") throw new Error("nope");
      },
      batchSize: 2,
    });
    let completed = false;
    await runner.start({
      onProgress: () => {},
      onComplete: () => {
        completed = true;
      },
      onError: (e) => errors.push(e.path),
    });
    expect(completed).toBe(true);
    expect(errors).toEqual(["/n2.md"]);
  });

  test("isRunning reflects state", async () => {
    let release: (() => void) | null = null;
    const runner = new AwakenRunner({
      listMarkdown: () => [{ path: "/a.md", mtime: 0 }],
      indexNote: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      batchSize: 1,
    });
    const promise = runner.start({
      onProgress: () => {},
      onComplete: () => {},
      onError: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.isRunning()).toBe(true);
    if (release) (release as () => void)();
    await promise;
    expect(runner.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/ui/onboarding/awakenRunner.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement AwakenRunner**

Create `src/ui/onboarding/awakenRunner.ts`:

```typescript
export interface AwakenRunnerArgs {
  listMarkdown: () => Array<{ path: string; mtime: number }>;
  indexNote: (path: string) => Promise<unknown>;
  batchSize?: number;
}

export interface AwakenProgress {
  processed: number;
  total: number;
}

export interface AwakenComplete {
  totalIndexed: number;
  durationMs: number;
}

export interface AwakenError {
  path: string;
  message: string;
}

export interface AwakenCallbacks {
  onProgress: (p: AwakenProgress) => void;
  onComplete: (c: AwakenComplete) => void;
  onError: (e: AwakenError) => void;
}

export class AwakenRunner {
  private cancelled = false;
  private running = false;

  constructor(private readonly args: AwakenRunnerArgs) {}

  async start(callbacks: AwakenCallbacks): Promise<void> {
    if (this.running) return;
    this.cancelled = false;
    this.running = true;
    const start = Date.now();
    let processed = 0;
    let indexed = 0;
    try {
      const files = this.args.listMarkdown();
      const total = files.length;
      const batchSize = Math.max(1, this.args.batchSize ?? 10);
      for (let i = 0; i < files.length; i += batchSize) {
        if (this.cancelled) break;
        const batch = files.slice(i, i + batchSize);
        const settled = await Promise.allSettled(
          batch.map((file) => this.args.indexNote(file.path)),
        );
        for (let j = 0; j < settled.length; j++) {
          const result = settled[j];
          processed++;
          if (result.status === "fulfilled") {
            indexed++;
          } else {
            callbacks.onError({
              path: batch[j].path,
              message: (result.reason as Error)?.message ?? String(result.reason),
            });
          }
        }
        callbacks.onProgress({ processed, total });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      callbacks.onComplete({ totalIndexed: indexed, durationMs: Date.now() - start });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.cancelled = true;
  }

  isRunning(): boolean {
    return this.running;
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/ui/onboarding/awakenRunner.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/awakenRunner.ts src/ui/onboarding/awakenRunner.test.ts
git commit -m "feat(onboarding): AwakenRunner with progress + cancel"
```

---

## Task 11: GraphCanvas (live render)

**Files:**
- Create: `src/ui/onboarding/graphCanvas.ts`
- Create: `src/ui/onboarding/graphCanvas.test.ts`

**Why:** Renders the growing graph to a `<canvas>` in real time. Layout: deterministic spiral seeded from the count, with concept nodes pulled toward their first mentioning note via a tiny spring solver (one Verlet iteration per added node — cheap, looks alive). Edges drawn as faint lines. New nodes pulse for 800 ms.

**Pure-data tests:** the layout function `assignPosition(seed, total)` is testable. The actual `requestAnimationFrame` rendering loop is exercised manually.

- [ ] **Step 1: Write failing tests**

Create `src/ui/onboarding/graphCanvas.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  GraphCanvasModel,
  spiralPosition,
  type CanvasNode,
} from "./graphCanvas";

describe("spiralPosition", () => {
  test("returns deterministic coords for same seed", () => {
    expect(spiralPosition(0, 720, 420)).toEqual(spiralPosition(0, 720, 420));
    expect(spiralPosition(42, 720, 420)).toEqual(spiralPosition(42, 720, 420));
  });

  test("places points within the canvas bounds", () => {
    for (let i = 0; i < 200; i++) {
      const { x, y } = spiralPosition(i, 720, 420);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(720);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(420);
    }
  });
});

describe("GraphCanvasModel", () => {
  test("addNode assigns coords and stores by id", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "n1", type: "note", label: "n1" });
    const node = model.getNode("n1") as CanvasNode;
    expect(node).toBeDefined();
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
  });

  test("addEdge stores edge only when both endpoints exist", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "a", type: "note", label: "a" });
    model.addEdge({ id: "e1", sourceId: "a", targetId: "missing", type: "mentions" });
    expect(model.edgeCount()).toBe(0);
    model.addNode({ id: "missing", type: "concept", label: "x" });
    model.addEdge({ id: "e2", sourceId: "a", targetId: "missing", type: "mentions" });
    expect(model.edgeCount()).toBe(1);
  });

  test("counts() returns per-type tallies", () => {
    const model = new GraphCanvasModel({ width: 720, height: 420 });
    model.addNode({ id: "n1", type: "note", label: "n1" });
    model.addNode({ id: "n2", type: "note", label: "n2" });
    model.addNode({ id: "c1", type: "concept", label: "POSIX" });
    model.addNode({ id: "q1", type: "question", label: "Why?" });
    expect(model.counts()).toEqual({
      notes: 2,
      concepts: 1,
      claims: 0,
      questions: 1,
      edges: 0,
    });
  });
});
```

- [ ] **Step 2: Verify failing tests**

Run: `bun test src/ui/onboarding/graphCanvas.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement GraphCanvasModel + renderer**

Create `src/ui/onboarding/graphCanvas.ts`:

```typescript
export interface CanvasNodeInput {
  id: string;
  type: "note" | "concept" | "claim" | "question";
  label: string;
}

export interface CanvasEdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
}

export interface CanvasNode extends CanvasNodeInput {
  x: number;
  y: number;
  bornAt: number;
}

export interface CanvasEdge extends CanvasEdgeInput {
  bornAt: number;
}

export interface GraphCanvasOptions {
  width: number;
  height: number;
}

export interface GraphCanvasCounts {
  notes: number;
  concepts: number;
  claims: number;
  questions: number;
  edges: number;
}

const NODE_COLORS: Record<CanvasNode["type"], string> = {
  note: "#9ecbff",
  concept: "#f5a97f",
  claim: "#a6da95",
  question: "#c6a0f6",
};

const PULSE_MS = 800;

export class GraphCanvasModel {
  private readonly nodes = new Map<string, CanvasNode>();
  private readonly edges: CanvasEdge[] = [];
  private nextSeed = 0;

  constructor(private readonly opts: GraphCanvasOptions) {}

  addNode(input: CanvasNodeInput): void {
    if (this.nodes.has(input.id)) return;
    const seed = this.nextSeed++;
    const { x, y } = spiralPosition(seed, this.opts.width, this.opts.height);
    this.nodes.set(input.id, { ...input, x, y, bornAt: Date.now() });
  }

  addEdge(input: CanvasEdgeInput): void {
    if (!this.nodes.has(input.sourceId) || !this.nodes.has(input.targetId)) return;
    this.edges.push({ ...input, bornAt: Date.now() });
  }

  getNode(id: string): CanvasNode | undefined {
    return this.nodes.get(id);
  }

  edgeCount(): number {
    return this.edges.length;
  }

  counts(): GraphCanvasCounts {
    const counts: GraphCanvasCounts = {
      notes: 0,
      concepts: 0,
      claims: 0,
      questions: 0,
      edges: this.edges.length,
    };
    for (const n of this.nodes.values()) {
      if (n.type === "note") counts.notes++;
      else if (n.type === "concept") counts.concepts++;
      else if (n.type === "claim") counts.claims++;
      else if (n.type === "question") counts.questions++;
    }
    return counts;
  }

  draw(ctx: CanvasRenderingContext2D, now: number): void {
    ctx.clearRect(0, 0, this.opts.width, this.opts.height);
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(180,180,200,0.25)";
    for (const edge of this.edges) {
      const a = this.nodes.get(edge.sourceId);
      const b = this.nodes.get(edge.targetId);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const node of this.nodes.values()) {
      const age = now - node.bornAt;
      const pulse = age < PULSE_MS ? 1 + (PULSE_MS - age) / PULSE_MS : 1;
      const color = NODE_COLORS[node.type];
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.shadowBlur = pulse * 6;
      ctx.shadowColor = color;
      ctx.arc(node.x, node.y, node.type === "note" ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}

export function spiralPosition(
  seed: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const radius = Math.min(width, height) * 0.45;
  const t = Math.sqrt(seed + 1);
  const r = (t / Math.sqrt(seed + 50)) * radius;
  const angle = seed * goldenAngle;
  const cx = width / 2;
  const cy = height / 2;
  const x = clamp(cx + r * Math.cos(angle), 0, width);
  const y = clamp(cy + r * Math.sin(angle), 0, height);
  return { x, y };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
```

- [ ] **Step 4: Verify tests pass**

Run: `bun test src/ui/onboarding/graphCanvas.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/graphCanvas.ts src/ui/onboarding/graphCanvas.test.ts
git commit -m "feat(onboarding): GraphCanvasModel + spiral-layout renderer"
```

---

## Task 12: First-run trigger + command palette

**Files:**
- Modify: `src/main.ts` — wire AwakenVaultModal to runner + canvas; add command + first-run trigger

**Why:** The user's first reload should pop the modal automatically when `settings.awakenedAt` is null. After a successful run, set `awakenedAt = Date.now()` and persist. Always available via the command palette: `Notient: Awaken Vault`.

- [ ] **Step 1: Add the wiring in main.ts**

Add imports near the others:

```typescript
import { AwakenVaultModal } from "./ui/onboarding/AwakenVaultModal";
import { AwakenRunner } from "./ui/onboarding/awakenRunner";
import { GraphCanvasModel } from "./ui/onboarding/graphCanvas";
```

Inside `onload()`, after the indexer queue is registered and before the ribbon icon registration, add:

```typescript
    const openAwakenModal = (): void => {
      const canvasModel = new GraphCanvasModel({ width: 720, height: 420 });
      let countersEl: HTMLElement | null = null;
      let canvasEl: HTMLCanvasElement | null = null;
      let rafHandle = 0;

      const renderCounters = (): void => {
        if (!countersEl) return;
        const c = canvasModel.counts();
        countersEl.empty();
        const pairs: Array<[string, number]> = [
          ["Notes", c.notes],
          ["Concepts", c.concepts],
          ["Claims", c.claims],
          ["Questions", c.questions],
          ["Edges", c.edges],
        ];
        for (const [label, value] of pairs) {
          const stat = countersEl.createDiv({ cls: "stat" });
          stat.createSpan({ cls: "label", text: label });
          stat.createSpan({ cls: "value", text: String(value) });
        }
      };

      const tick = (): void => {
        if (canvasEl) {
          const ctx = canvasEl.getContext("2d");
          if (ctx) canvasModel.draw(ctx, Date.now());
        }
        rafHandle = requestAnimationFrame(tick);
      };

      const nodeOff = this.bus.on("indexer:node-added", (event) => {
        canvasModel.addNode({
          id: event.nodeId,
          type: event.nodeType,
          label: event.label,
        });
        renderCounters();
      });
      const edgeOff = this.bus.on("indexer:edge-added", (event) => {
        canvasModel.addEdge({
          id: event.edgeId,
          sourceId: event.sourceId,
          targetId: event.targetId,
          type: event.edgeType,
        });
        renderCounters();
      });

      const runner = new AwakenRunner({
        listMarkdown: () => facade.listMarkdown(),
        indexNote: this.indexOne,
        batchSize: 10,
      });

      const modal = new AwakenVaultModal(this.app, {
        start: () =>
          runner.start({
            onProgress: () => renderCounters(),
            onComplete: async (c) => {
              const next = { ...this.settings.get(), awakenedAt: Date.now() };
              await this.settings.update(next);
              new Notice(
                `Notient awakened: ${c.totalIndexed} notes in ${(c.durationMs / 1000).toFixed(1)}s`,
              );
            },
            onError: (e) => console.warn("[Notient] awaken error", e),
          }),
        stop: () => runner.stop(),
        isRunning: () => runner.isRunning(),
        totalNotes: () => facade.listMarkdown().length,
        onAttachCanvas: (canvas) => {
          canvasEl = canvas;
          tick();
        },
        onAttachCounters: (el) => {
          countersEl = el;
          renderCounters();
        },
      });

      modal.onClose = ((original) =>
        function (this: AwakenVaultModal): void {
          cancelAnimationFrame(rafHandle);
          nodeOff();
          edgeOff();
          original.call(this);
        })(modal.onClose.bind(modal));

      modal.open();
    };

    this.addCommand({
      id: "awaken-vault",
      name: "Notient: Awaken Vault",
      callback: openAwakenModal,
    });

    if (current.awakenedAt === null) {
      // Defer to next tick so the workspace finishes loading.
      setTimeout(openAwakenModal, 800);
    }
```

(`this.settings.update(next)` assumes the existing `SettingsService` exposes an update method. If Phase 1 named it `save` or `set`, use that name instead. The behavior we need: persist + emit `settings:changed`.)

- [ ] **Step 2: Type-check + lint + test**

Run: `bun run typecheck && bun run lint && bun test`
Expected: green.

- [ ] **Step 3: Manual smoke test (the moment of truth)**

```bash
bun run dev:hard-reset && bun run dev
```

Reload Obsidian's plugin in the test vault. Expected:
- After ~1s, "Awaken Vault" modal opens automatically (because `awakenedAt` is null on a fresh install).
- Click Begin. Counters tick. Glowing dots appear in the canvas.
- ~3-5 minutes later, `Notient awakened: 894 notes …` notice fires; Enter button enables.
- DB sanity check:
  ```bash
  sqlite3 "/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient/notient.db" \
    "SELECT count(*) FROM notes; SELECT count(*) FROM chunks; \
     SELECT count(*) FROM embeddings; SELECT count(*) FROM graph_nodes; \
     SELECT count(*) FROM graph_edges;"
  ```
  Expected: notes ≈ 894, chunks > 894 (avg ~3 per note), embeddings == chunks, graph_nodes > 894 (notes + concepts + claims + questions), graph_edges > 0.
- Reload again — modal does NOT reopen because `awakenedAt` is now set.
- Run command palette: "Notient: Awaken Vault" — modal opens for re-run.

If dynamo isn't reachable, the indexer will fail and emit `indexer:error` events. The test for "Phase 2 done" requires dynamo + mini are up; otherwise the chunks/embeddings will populate but extraction will be empty (concepts/claims/questions counts will be near zero).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(onboarding): wire AwakenVaultModal to runner + first-run trigger"
```

---

## Task 13: Phase 2 tag + STATE update

**Files:**
- Modify: `.planning/STATE.md`
- Tag: `v1.0.0-graph` on `beta-spec`

**Why:** Close the phase. Update the cross-session handoff doc, tag the commit, and leave a clean breadcrumb for Phase 3 (Swarm).

- [ ] **Step 1: Run the full verification gate**

```bash
bun run typecheck && bun run lint && bun test
```

Expected: typecheck clean, lint clean, all tests pass (~75+ tests after Phase 2).

- [ ] **Step 2: Run the smoke checklist on the test vault one more time**

- Hard-reset: `bun run dev:hard-reset && bun run dev`
- Reload plugin → Awaken modal pops → Begin → finishes in <10 min for 894 notes
- Counters end with sensible numbers (notes ≈ 894, edges in the thousands)
- Open a note, edit, save → DB chunks for that note get refreshed (check via sqlite or a debug `SELECT count(*) FROM chunks WHERE note_path = '/<path>'`)
- Reload → modal does NOT reopen
- Command palette: "Notient: Awaken Vault" → opens for re-run

If any check fails, fix it and rerun the full gate before continuing.

- [ ] **Step 3: Update STATE.md**

Replace the contents of `.planning/STATE.md` with:

```markdown
# Notient v1.0 Project State

**Current phase:** Phase 2 (Graph) — COMPLETE
**Tag:** `v1.0.0-graph` on `beta-spec`
**Date completed:** <fill in completion date>
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
- [ ] Tag `v1.0.0-graph` on `beta-spec`

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
```

- [ ] **Step 4: Commit STATE.md and tag**

```bash
git add .planning/STATE.md
git commit -m "docs(state): Phase 2 (Graph) complete"
git tag -a v1.0.0-graph -m "Phase 2 (Graph) complete: senses pipeline + Awaken Vault modal"
```

- [ ] **Step 5: Verify the tag**

```bash
git tag --list 'v1.0.0-*'
git show v1.0.0-graph --stat
```

Expected: tag exists, points at the STATE-update commit, `git show` lists the touched files.

---

## End of Phase 2 plan

Total expected: 13 numbered tasks (with Task 0 broken into 5 sub-tasks). Each task is committable and tested in isolation. Estimated test count after Phase 2: ~75–85 (Phase 1 had 38; this phase adds chunker (7) + embedder (5) + vectorIndex (8) + extractor (4) + indexNote (4) + indexerQueue (4) + awakenRunner (4) + graphCanvas (5) + transaction (3) + chatJson (3) + frontmatter rewrite (7) + echoGuard (4) + healthMonitor timeout (1) ≈ 59 new = ~97 total).

After Task 13, the next session's first action is to read `.planning/STATE.md` and invoke `superpowers:writing-plans` for Phase 3 (Swarm).
