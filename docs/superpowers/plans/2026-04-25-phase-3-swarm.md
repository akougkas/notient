# Notient Phase 3 — Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is self-contained and assumes only the Phase 1 + Phase 2 + Phase 2.5 codebase plus tasks above it. Steps use checkbox (`- [ ]`) syntax. Use Opus 4.7 implementer subagents only — no per-task spec/quality reviewers per user's stated preference.

**Goal:** Stand up the Mind layer. Schema v2 adds staging tables so agent proposals never touch live `graph_edges` until the user approves them. A 50-line Coordinator runs an event loop over save / idle / user-action triggers, enforces a single-flight reasoning mutex against dynamo, and dispatches the four specialist agents (Linker, Synthesizer, Contradiction Hunter, Maturity Advancer) to read the graph and stage proposals with provenance and confidence. The Continuous Co-author panel streams a real-time take on the active note, in the user's own voice, with cancellation on note switch and throttling on typing. An idle detector feeds the Coordinator. An Approvals UI promotes staged edges to live.

**Architecture (locked, references spec §6 and §7):**

- **Trust gate is a database wall.** Per spec §4.2 every proposed edge carries `{ source: agent_name, confidence, evidence: chunk_id[], created_at, approved_by_user }`. Agents write **only** to `staging_edges` / `staging_nodes`. The Approvals UI promotes accepted rows into `graph_nodes` / `graph_edges`. The existing `graph_edges.approved` column stays the source of truth for *live* edges; staging is a separate table so cancelled / rejected proposals never pollute the live graph. This is non-negotiable per spec brand pillar 2 ("Human steers, AI amplifies").
- **Single-flight reasoning.** Per spec §6.5 the Coordinator owns a 1-slot mutex around every reasoning-model call (Linker, Synthesizer, Contradiction Hunter, Co-author). Embedding calls and Maturity Advancer (no LLM) bypass the mutex. Co-author has priority — when a co-author run is queued, in-flight non-co-author work gets aborted via AbortSignal so the user-facing stream starts within spec §7's <2s budget.
- **All structured calls go through `provider.chatJson<T>()`.** The Phase 2.5 fix (commit 6b8b10b) makes nemotron-cascade-2-30b-a3b-i1 routable through chatJson. The plan uses `primaryLLM` everywhere; mini stays reserved for v1.1 nightly passes per spec §13.
- **Co-author uses `chatStream`.** It is free-form prose, not JSON. Streaming, throttling, cancellation are first-class.
- **Agents are network-bound, not CPU-bound.** Unlike the indexer, agents do not need their own Web Worker. The Coordinator runs on the main thread; concurrency comes from awaiting dynamo, not from threads.
- **AbortSignal end-to-end.** Every agent accepts a signal and threads it into `chatJson` / `chat`. The Coordinator preempts on user activity (active typing, leaf change).
- **Producer-side EchoGuard finally lands.** Maturity Advancer is the first agent that writes back to user markdown (via `notient.vitals.maturity` in frontmatter); it must call `echoGuard.mark(path, sha)` before writing so the indexer doesn't re-fire on its own write.
- **TypeScript strict, Bun test, no `console.log` in production, no abbreviations, no `[noun] - [parenthetical]` dash patterns.** Each task ends with a single commit on `beta-spec`. **No tag at end of phase.** Version stays 0.2.0.

**Tech Stack:** TypeScript strict • Bun test • sql.js (existing) • `hnswlib-wasm` (existing) • OpenAI-compatible JSON over fetch (existing) • Obsidian Modal / View / Workspace APIs • Preact (already in deps via Phase 2 sidebar) • a 30-line in-house DBSCAN over Float32Array vectors (no new dep).

**Definition of done (from spec §13 row 3):**
- Open any note → Co-author streams its first token in <2s.
- Linker, Synthesizer, Contradiction Hunter, Maturity Advancer each produce at least one real proposal on the test vault during a single session.
- Every proposal lands in `staging_edges` (or `staging_nodes`) with non-null `confidence`, `agent`, `evidence`, `created_at`.
- Approvals UI surfaces staged rows; user accept promotes to `graph_edges`; user reject deletes the staged row.
- `bun run typecheck && bun run lint && bun test` all green.
- `scripts/smoke-coordinator.ts` runs against dynamo and prints "linker staged N, synthesizer drafted M, contradiction-hunter staged K, maturity advancer promoted L" with N+M+K+L > 0.

**Phase 3 git tag:** none. Version stays at 0.2.0 in both `manifest.json` and `package.json`. Tagging is reserved for the v1.0 release.

---

## File Structure (locked before tasks)

### Schema v2 + migration (Task 0)
- `src/core/db/schema.ts` (extend)
- `src/core/db/migrations.ts` (extend)
- `src/core/db/database.test.ts` (extend)
- `src/core/db/migrations.test.ts` (new)

### Coordinator + idle (Tasks 1, 2)
- `src/core/coordinator/types.ts`
- `src/core/coordinator/coordinator.ts`
- `src/core/coordinator/coordinator.test.ts`
- `src/core/coordinator/reasoningMutex.ts`
- `src/core/coordinator/reasoningMutex.test.ts`
- `src/core/services/idleDetector.ts`
- `src/core/services/idleDetector.test.ts`
- `src/core/events/types.ts` (extend with idle + agent + coAuthor + approval events)

### Agents (Tasks 3–6)
- `src/core/agents/types.ts`
- `src/core/agents/linker.ts`
- `src/core/agents/linker.test.ts`
- `src/core/agents/synthesizer.ts`
- `src/core/agents/synthesizer.test.ts`
- `src/core/agents/contradictionHunter.ts`
- `src/core/agents/contradictionHunter.test.ts`
- `src/core/agents/maturityAdvancer.ts`
- `src/core/agents/maturityAdvancer.test.ts`
- `src/core/agents/dbscan.ts` (used by Synthesizer)
- `src/core/agents/dbscan.test.ts`

### Co-author (Tasks 7, 8, 9)
- `src/core/coAuthor/voiceContext.ts`
- `src/core/coAuthor/voiceContext.test.ts`
- `src/core/coAuthor/chatStream.ts`
- `src/core/coAuthor/chatStream.test.ts`
- `src/ui/coAuthor/CoAuthorView.ts`
- `src/ui/coAuthor/coAuthorRender.ts`
- `src/ui/coAuthor/coAuthorRender.test.ts`

### Approvals (Task 10)
- `src/core/approvals/approvalService.ts`
- `src/core/approvals/approvalService.test.ts`
- `src/ui/approvals/ApprovalsView.ts`

### Wiring + smoke + close-out (Tasks 11, 12)
- `src/main.ts` (Coordinator + idle + agents + Co-author + Approvals + EchoGuard producer wiring)
- `src/core/kernel.ts` (add `coordinator`, `idleDetector`, `approvalService` keys)
- `scripts/smoke-coordinator.ts`
- `package.json` (add `smoke:coordinator` script)
- `.planning/STATE.md` (Phase 3 close-out)

---

## Task 0: Schema v2 + migration

**Files:**
- Modify: `src/core/db/schema.ts`
- Modify: `src/core/db/migrations.ts`
- Modify: `src/core/db/database.test.ts`
- Create: `src/core/db/migrations.test.ts`

**Why:** Phase 2's schema_v1 has `graph_edges.approved` but no separate staging table. Phase 3 agents must stage proposals without touching live edges; Approvals UI promotes them. We also need an `agent_runs` provenance table (started_at, finished_at, ok, error) so the status footer can surface "Synthesizer ran 3 min ago, ok" and so debugging has a paper trail.

- [ ] **Step 1: Extend `schema.ts` with v2 tables**

Append below `SCHEMA_V1` in `src/core/db/schema.ts`:

```typescript
export const SCHEMA_V2 = [
  // staging_edges: agent proposals before user approval. Promoted to graph_edges
  // by ApprovalService. Rejected rows are deleted.
  `CREATE TABLE IF NOT EXISTS staging_edges (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    agent TEXT NOT NULL,
    evidence TEXT NOT NULL,
    rationale TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decision TEXT
  );`,
  "CREATE INDEX IF NOT EXISTS staging_edges_agent ON staging_edges(agent);",
  "CREATE INDEX IF NOT EXISTS staging_edges_decided ON staging_edges(decided_at);",
  "CREATE INDEX IF NOT EXISTS staging_edges_source ON staging_edges(source_id);",
  // staging_nodes: claim/concept/question proposals that don't yet have a home in
  // the live graph. Synthesizer + Contradiction Hunter use this for proposed
  // synthesis-note shells before the user accepts.
  `CREATE TABLE IF NOT EXISTS staging_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    note_path TEXT,
    payload TEXT,
    agent TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    decision TEXT
  );`,
  "CREATE INDEX IF NOT EXISTS staging_nodes_agent ON staging_nodes(agent);",
  // agent_runs: provenance / status footer / debug trail.
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    trigger TEXT NOT NULL,
    note_path TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    error TEXT,
    proposals_count INTEGER NOT NULL DEFAULT 0
  );`,
  "CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at);",
  "CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent);",
];
```

`decision` is `'accepted' | 'rejected' | NULL` for staging tables. `trigger` is one of `vault-save | idle-30s | idle-5m | idle-30m | user-action | new-claim` for `agent_runs`.

- [ ] **Step 2: Wire v2 into `migrations.ts`**

Replace `src/core/db/migrations.ts` with:

```typescript
import type { Database } from "sql.js";
import { SCHEMA_V1, SCHEMA_V2 } from "./schema";

export const CURRENT_VERSION = 2;

export function applyMigrations(db: Database): number {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);");
  const result = db.exec("SELECT version FROM schema_version LIMIT 1;");
  const current = (result[0]?.values[0]?.[0] as number | undefined) ?? 0;

  if (current < 1) {
    for (const stmt of SCHEMA_V1) db.run(stmt);
  }
  if (current < 2) {
    for (const stmt of SCHEMA_V2) db.run(stmt);
  }

  if (current === 0) {
    db.run("INSERT INTO schema_version (version) VALUES (?);", [CURRENT_VERSION]);
  } else if (current < CURRENT_VERSION) {
    db.run("UPDATE schema_version SET version = ?;", [CURRENT_VERSION]);
  }

  return CURRENT_VERSION;
}
```

The Phase 1 + Phase 2 fresh-install path runs both v1 and v2 in sequence; existing 0.2.0 vaults at `current = 1` skip v1 and only run v2.

- [ ] **Step 3: Write the migration test**

Create `src/core/db/migrations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "./database";
import { MemoryAdapter, loadWasm } from "./database.test";

describe("migrations v1 -> v2", () => {
  test("fresh install lands on v2", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    expect(db.version()).toBe(2);
    const tables = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain("staging_edges");
    expect(names).toContain("staging_nodes");
    expect(names).toContain("agent_runs");
    expect(names).toContain("graph_edges");
  });

  test("v1 -> v2 upgrade preserves existing rows", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db1 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db1.init();
    db1.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/seed.md", "sha", 1, 1, 1],
    );
    // Force-downgrade the recorded version to simulate a v1 vault opened by v2 code.
    db1.run("UPDATE schema_version SET version = 1;");
    await db1.persist();
    await db1.close();

    const db2 = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db2.init();
    expect(db2.version()).toBe(2);
    const rows = db2.query<{ path: string }>("SELECT path FROM notes;");
    expect(rows).toEqual([{ path: "/seed.md" }]);
    const tables = db2.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'staging_edges';",
    );
    expect(tables).toHaveLength(1);
  });

  test("staging_edges accepts a row with required columns", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
       VALUES (?,?,?,?,?,?,?,?,?);`,
      ["e1", "supports", "note:/a.md", "note:/b.md", 0.84, "linker", JSON.stringify(["c1"]), "shared idea X", 1],
    );
    const rows = db.query<{ id: string; agent: string }>("SELECT id, agent FROM staging_edges;");
    expect(rows).toEqual([{ id: "e1", agent: "linker" }]);
  });

  test("agent_runs accepts a complete run record", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO agent_runs (agent, trigger, note_path, started_at, finished_at, ok, error, proposals_count)
       VALUES (?,?,?,?,?,?,?,?);`,
      ["linker", "idle-30s", "/a.md", 1, 5, 1, null, 3],
    );
    const rows = db.query<{ agent: string; proposals_count: number }>(
      "SELECT agent, proposals_count FROM agent_runs;",
    );
    expect(rows).toEqual([{ agent: "linker", proposals_count: 3 }]);
  });
});
```

(`MemoryAdapter` and `loadWasm` are exported from `database.test.ts` — re-export them from there if not already; the Phase 2 plan already does this.)

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 4 new tests pass; existing tests stay green.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/schema.ts src/core/db/migrations.ts src/core/db/migrations.test.ts
git commit -m "feat(db): schema v2 with staging_edges, staging_nodes, agent_runs"
```

---

## Task 1: Reasoning mutex (single-flight + abort priority)

**Files:**
- Create: `src/core/coordinator/reasoningMutex.ts`
- Create: `src/core/coordinator/reasoningMutex.test.ts`

**Why:** Spec §6.5 caps concurrent reasoning calls at 1 to keep dynamo responsive for Co-author. Co-author has priority — when it asks for the slot, in-flight agent work must abort. We isolate this in a tiny dedicated module so the Coordinator and Co-author both share one mutex instance.

- [ ] **Step 1: Write the failing test**

Create `src/core/coordinator/reasoningMutex.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ReasoningMutex } from "./reasoningMutex";

describe("ReasoningMutex", () => {
  test("serializes two normal acquisitions", async () => {
    const m = new ReasoningMutex();
    const order: string[] = [];
    await Promise.all([
      m.run("a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      m.run("b", async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("priority acquisition aborts the in-flight low-priority job", async () => {
    const m = new ReasoningMutex();
    const events: string[] = [];
    const slow = m.run("agent", async (signal) => {
      events.push("agent-start");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("agent-aborted");
          reject(new DOMException("aborted", "AbortError"));
        });
        setTimeout(() => {
          events.push("agent-finished");
          resolve();
        }, 200);
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    await m.runPriority("co-author", async () => {
      events.push("co-author-ran");
    });
    await slow.catch(() => {
      // expected to throw on abort
    });
    expect(events).toEqual(["agent-start", "agent-aborted", "co-author-ran"]);
  });

  test("priority acquisition with no in-flight job runs immediately", async () => {
    const m = new ReasoningMutex();
    const flag = { hit: false };
    await m.runPriority("co-author", async () => {
      flag.hit = true;
    });
    expect(flag.hit).toBe(true);
  });

  test("caller signal aborts a queued task", async () => {
    const m = new ReasoningMutex();
    const blocker = m.run("a", async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      m.run("b", async () => {}, { signal: ctrl.signal }),
    ).rejects.toThrow();
    await blocker;
  });
});
```

- [ ] **Step 2: Implement the mutex**

Create `src/core/coordinator/reasoningMutex.ts`:

```typescript
export type MutexTask<T> = (signal: AbortSignal) => Promise<T>;

export interface MutexRunOptions {
  signal?: AbortSignal;
}

interface RunningJob {
  label: string;
  controller: AbortController;
}

export class ReasoningMutex {
  private chain: Promise<unknown> = Promise.resolve();
  private running: RunningJob | null = null;

  run<T>(label: string, task: MutexTask<T>, options: MutexRunOptions = {}): Promise<T> {
    const next = this.chain.then(async () => {
      if (options.signal?.aborted) throw asAbortError();
      const controller = new AbortController();
      const onCallerAbort = (): void => controller.abort();
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      this.running = { label, controller };
      try {
        return await task(controller.signal);
      } finally {
        options.signal?.removeEventListener("abort", onCallerAbort);
        this.running = null;
      }
    });
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  async runPriority<T>(label: string, task: MutexTask<T>): Promise<T> {
    if (this.running && this.running.label !== label) {
      this.running.controller.abort();
    }
    return this.run(label, task);
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  currentLabel(): string | null {
    return this.running?.label ?? null;
  }
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
```

- [ ] **Step 3: Verify**

Run: `bun test src/core/coordinator/reasoningMutex.test.ts`
Expected: 4/4 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/coordinator/reasoningMutex.ts src/core/coordinator/reasoningMutex.test.ts
git commit -m "feat(coordinator): single-flight reasoning mutex with priority preemption"
```

---

## Task 2: Idle detector

**Files:**
- Create: `src/core/services/idleDetector.ts`
- Create: `src/core/services/idleDetector.test.ts`
- Modify: `src/core/events/types.ts` (extend `AppEvent`)

**Why:** Per spec §3 and §6 the Coordinator fires agents on three idle thresholds (30s, 5m, 30m). Idle is defined as no editor key/focus events for the threshold duration. We expose the detector as an injectable service so tests can drive a fake clock.

- [ ] **Step 1: Extend `AppEvent`**

Append to the union in `src/core/events/types.ts`:

```typescript
  | { type: "user:active" }
  | { type: "user:idle"; level: "30s" | "5m" | "30m" }
```

- [ ] **Step 2: Write the failing test**

Create `src/core/services/idleDetector.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../events/eventBus";
import { IdleDetector } from "./idleDetector";

describe("IdleDetector", () => {
  test("emits 30s, 5m, 30m sequentially while inactive", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("user:idle", (e) => events.push(e.level));
    bus.on("user:active", () => events.push("active"));
    let now = 0;
    const detector = new IdleDetector(bus, {
      now: () => now,
      thresholds: { "30s": 30_000, "5m": 300_000, "30m": 1_800_000 },
    });
    detector.start();
    detector.recordActivity();
    now = 30_001;
    detector.tick();
    now = 300_001;
    detector.tick();
    now = 1_800_001;
    detector.tick();
    detector.stop();
    expect(events).toEqual(["30s", "5m", "30m"]);
  });

  test("recordActivity resets idle and re-emits active", async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("user:idle", (e) => events.push(`idle:${e.level}`));
    bus.on("user:active", () => events.push("active"));
    let now = 0;
    const detector = new IdleDetector(bus, {
      now: () => now,
      thresholds: { "30s": 30_000, "5m": 300_000, "30m": 1_800_000 },
    });
    detector.start();
    detector.recordActivity();
    now = 30_001;
    detector.tick();
    detector.recordActivity();
    expect(events).toEqual(["idle:30s", "active"]);
    now = 60_002;
    detector.tick();
    expect(events).toEqual(["idle:30s", "active", "idle:30s"]);
  });

  test("stop clears any timer", () => {
    const bus = new EventBus();
    const detector = new IdleDetector(bus);
    detector.start();
    detector.stop();
    expect(detector.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 3: Implement**

Create `src/core/services/idleDetector.ts`:

```typescript
import type { EventBus } from "../events/eventBus";

export type IdleLevel = "30s" | "5m" | "30m";

export interface IdleDetectorOptions {
  thresholds?: Record<IdleLevel, number>;
  now?: () => number;
  tickMs?: number;
}

const DEFAULT_THRESHOLDS: Record<IdleLevel, number> = {
  "30s": 30_000,
  "5m": 300_000,
  "30m": 1_800_000,
};

const ORDER: IdleLevel[] = ["30s", "5m", "30m"];

export class IdleDetector {
  private readonly thresholds: Record<IdleLevel, number>;
  private readonly now: () => number;
  private readonly tickMs: number;
  private lastActivityAt: number;
  private highestEmitted: IdleLevel | null = null;
  private wasIdle = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly bus: EventBus, opts: IdleDetectorOptions = {}) {
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.now = opts.now ?? (() => Date.now());
    this.tickMs = opts.tickMs ?? 5_000;
    this.lastActivityAt = this.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivityAt = this.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  recordActivity(): void {
    this.lastActivityAt = this.now();
    if (this.wasIdle) {
      this.bus.emit({ type: "user:active" });
      this.wasIdle = false;
    }
    this.highestEmitted = null;
  }

  tick(): void {
    const elapsed = this.now() - this.lastActivityAt;
    let next: IdleLevel | null = null;
    for (const level of ORDER) {
      if (elapsed >= this.thresholds[level]) next = level;
    }
    if (next === null) return;
    if (this.highestEmitted === next) return;
    if (this.highestEmitted !== null && ORDER.indexOf(next) <= ORDER.indexOf(this.highestEmitted)) {
      return;
    }
    this.highestEmitted = next;
    this.wasIdle = true;
    this.bus.emit({ type: "user:idle", level: next });
  }
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/core/services/idleDetector.test.ts && bun run typecheck && bun run lint`
Expected: 3/3 pass; everything else stays green.

- [ ] **Step 5: Commit**

```bash
git add src/core/events/types.ts src/core/services/idleDetector.ts src/core/services/idleDetector.test.ts
git commit -m "feat(idle): add IdleDetector emitting 30s/5m/30m thresholds"
```

---

## Task 3: Coordinator (50-line scheduler)

**Files:**
- Create: `src/core/coordinator/types.ts`
- Create: `src/core/coordinator/coordinator.ts`
- Create: `src/core/coordinator/coordinator.test.ts`
- Modify: `src/core/events/types.ts` (extend with `agent:run-started`, `agent:run-finished`, `coordinator:trigger-fired`)

**Why:** The Coordinator is the heart of the Mind layer. It listens to the event bus, maps `vault:note-saved` / `user:idle:*` / `user-action` to which agents should fire, owns the reasoning mutex, and writes `agent_runs` rows. It is **not** an agent itself — it has no LLM calls.

- [ ] **Step 1: Extend `AppEvent`**

Append to `src/core/events/types.ts`:

```typescript
  | { type: "agent:run-started"; agent: string; trigger: string; notePath: string | null; runId: number }
  | { type: "agent:run-finished"; agent: string; ok: boolean; proposals: number; durationMs: number; error?: string; runId: number }
  | { type: "user:action"; kind: "deepen"; notePath: string }
  | { type: "active-leaf-change"; notePath: string | null; wordCount: number }
```

- [ ] **Step 2: Define agent contract**

Create `src/core/coordinator/types.ts`:

```typescript
export type AgentName =
  | "linker"
  | "synthesizer"
  | "contradictionHunter"
  | "maturityAdvancer";

export type AgentTrigger =
  | "vault-save"
  | "idle-30s"
  | "idle-5m"
  | "idle-30m"
  | "user-action"
  | "new-claim";

export interface AgentRunContext {
  trigger: AgentTrigger;
  notePath: string | null;
  signal: AbortSignal;
}

export interface AgentRunResult {
  proposals: number;
}

export interface Agent {
  name: AgentName;
  /** True if this agent makes a reasoning-model call (counts against the mutex). */
  usesReasoningModel: boolean;
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}
```

- [ ] **Step 3: Write the failing test**

Create `src/core/coordinator/coordinator.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { Coordinator } from "./coordinator";
import { ReasoningMutex } from "./reasoningMutex";
import type { Agent, AgentRunContext } from "./types";

function makeDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  return { adapter, config: { dbPath: "/db", wasmPath: "/wasm" } };
}

function fakeAgent(name: Agent["name"], proposals = 1, fail = false): Agent {
  return {
    name,
    usesReasoningModel: name !== "maturityAdvancer",
    async run(_ctx: AgentRunContext) {
      if (fail) throw new Error("boom");
      return { proposals };
    },
  };
}

describe("Coordinator", () => {
  test("vault-save triggers Linker on the saved note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run(ctx) {
        calls.push(`linker:${ctx.trigger}:${ctx.notePath ?? ""}`);
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "vault:note-saved", path: "/a.md", sha: "x" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["linker:vault-save:/a.md"]);
    const rows = db.query<{ agent: string; ok: number; proposals_count: number }>(
      "SELECT agent, ok, proposals_count FROM agent_runs;",
    );
    expect(rows).toEqual([{ agent: "linker", ok: 1, proposals_count: 1 }]);
  });

  test("idle-30s also runs Linker on the active note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run(ctx) {
        calls.push(`linker:${ctx.trigger}:${ctx.notePath ?? ""}`);
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.setActiveNote("/a.md");
    coord.start();
    bus.emit({ type: "user:idle", level: "30s" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["linker:idle-30s:/a.md"]);
  });

  test("idle-5m fans out to Synthesizer + ContradictionHunter", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const make = (name: Agent["name"]): Agent => ({
      name,
      usesReasoningModel: true,
      async run(ctx) {
        calls.push(`${name}:${ctx.trigger}`);
        return { proposals: 1 };
      },
    });
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0),
        synthesizer: make("synthesizer"),
        contradictionHunter: make("contradictionHunter"),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "user:idle", level: "5m" });
    await coord.idle();
    coord.stop();
    expect(calls.sort()).toEqual([
      "contradictionHunter:idle-5m",
      "synthesizer:idle-5m",
    ]);
  });

  test("idle-30m runs Maturity Advancer (no mutex slot needed)", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const ma: Agent = {
      name: "maturityAdvancer",
      usesReasoningModel: false,
      async run(ctx) {
        calls.push(`ma:${ctx.trigger}`);
        return { proposals: 2 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0),
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: ma,
      },
    });
    coord.start();
    bus.emit({ type: "user:idle", level: "30m" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual(["ma:idle-30m"]);
  });

  test("user-action 'deepen' fires all four sequentially on a single note", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const make = (name: Agent["name"], usesReasoning: boolean): Agent => ({
      name,
      usesReasoningModel: usesReasoning,
      async run(ctx) {
        calls.push(`${name}:${ctx.notePath}`);
        return { proposals: 1 };
      },
    });
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: make("linker", true),
        synthesizer: make("synthesizer", true),
        contradictionHunter: make("contradictionHunter", true),
        maturityAdvancer: make("maturityAdvancer", false),
      },
    });
    coord.start();
    bus.emit({ type: "user:action", kind: "deepen", notePath: "/x.md" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual([
      "linker:/x.md",
      "synthesizer:/x.md",
      "contradictionHunter:/x.md",
      "maturityAdvancer:/x.md",
    ]);
  });

  test("agent failure is recorded and does not crash the coordinator", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker: fakeAgent("linker", 0, true),
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.start();
    bus.emit({ type: "vault:note-saved", path: "/a.md", sha: "x" });
    await coord.idle();
    coord.stop();
    const rows = db.query<{ agent: string; ok: number; error: string | null }>(
      "SELECT agent, ok, error FROM agent_runs;",
    );
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toContain("boom");
  });

  test("active typing suppresses idle dispatch", async () => {
    const { adapter, config } = makeDb();
    const db = new Database(adapter, config);
    await db.init();
    const bus = new EventBus();
    const calls: string[] = [];
    const linker: Agent = {
      name: "linker",
      usesReasoningModel: true,
      async run() {
        calls.push("linker");
        return { proposals: 1 };
      },
    };
    const coord = new Coordinator({
      bus,
      db,
      mutex: new ReasoningMutex(),
      agents: {
        linker,
        synthesizer: fakeAgent("synthesizer", 0),
        contradictionHunter: fakeAgent("contradictionHunter", 0),
        maturityAdvancer: fakeAgent("maturityAdvancer", 0),
      },
    });
    coord.setActiveNote("/a.md");
    coord.start();
    bus.emit({ type: "user:active" });
    bus.emit({ type: "user:idle", level: "30s" });
    bus.emit({ type: "user:active" });
    await coord.idle();
    coord.stop();
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 4: Implement the Coordinator**

Create `src/core/coordinator/coordinator.ts`:

```typescript
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { ReasoningMutex } from "./reasoningMutex";
import type {
  Agent,
  AgentName,
  AgentRunContext,
  AgentTrigger,
} from "./types";

export interface CoordinatorAgents {
  linker: Agent;
  synthesizer: Agent;
  contradictionHunter: Agent;
  maturityAdvancer: Agent;
}

export interface CoordinatorOptions {
  bus: EventBus;
  db: Database;
  mutex: ReasoningMutex;
  agents: CoordinatorAgents;
}

export class Coordinator {
  private readonly subs: Array<() => void> = [];
  private inflight: Set<Promise<unknown>> = new Set();
  private activeNotePath: string | null = null;
  private userActive = false;
  private running = false;

  constructor(private readonly opts: CoordinatorOptions) {}

  setActiveNote(path: string | null): void {
    this.activeNotePath = path;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { bus } = this.opts;
    this.subs.push(
      bus.on("vault:note-saved", (e) => {
        this.userActive = false;
        this.dispatch("vault-save", e.path, ["linker"]);
      }),
      bus.on("user:active", () => {
        this.userActive = true;
      }),
      bus.on("user:idle", (e) => {
        this.userActive = false;
        if (e.level === "30s") {
          this.dispatch("idle-30s", this.activeNotePath, ["linker"]);
        } else if (e.level === "5m") {
          this.dispatch("idle-5m", this.activeNotePath, [
            "synthesizer",
            "contradictionHunter",
          ]);
        } else if (e.level === "30m") {
          this.dispatch("idle-30m", null, ["maturityAdvancer"]);
        }
      }),
      bus.on("user:action", (e) => {
        if (e.kind === "deepen") {
          this.dispatch("user-action", e.notePath, [
            "linker",
            "synthesizer",
            "contradictionHunter",
            "maturityAdvancer",
          ]);
        }
      }),
      bus.on("active-leaf-change", (e) => {
        this.activeNotePath = e.notePath;
      }),
    );
  }

  stop(): void {
    this.running = false;
    for (const off of this.subs) off();
    this.subs.length = 0;
  }

  /** Resolves once all dispatched agent runs complete. Used by tests. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled(Array.from(this.inflight));
    }
  }

  private dispatch(
    trigger: AgentTrigger,
    notePath: string | null,
    agents: AgentName[],
  ): void {
    if (!this.running) return;
    if (this.userActive && trigger.startsWith("idle")) return;
    const promise = this.runSequential(trigger, notePath, agents).finally(() => {
      this.inflight.delete(promise);
    });
    this.inflight.add(promise);
  }

  private async runSequential(
    trigger: AgentTrigger,
    notePath: string | null,
    agents: AgentName[],
  ): Promise<void> {
    for (const name of agents) {
      const agent = this.opts.agents[name];
      await this.runOne(agent, trigger, notePath);
    }
  }

  private async runOne(
    agent: Agent,
    trigger: AgentTrigger,
    notePath: string | null,
  ): Promise<void> {
    const startedAt = Date.now();
    this.opts.db.run(
      `INSERT INTO agent_runs (agent, trigger, note_path, started_at) VALUES (?,?,?,?);`,
      [agent.name, trigger, notePath, startedAt],
    );
    const idRow = this.opts.db.query<{ id: number }>(
      "SELECT last_insert_rowid() AS id;",
    )[0];
    const runId = idRow?.id ?? -1;
    this.opts.bus.emit({
      type: "agent:run-started",
      agent: agent.name,
      trigger,
      notePath,
      runId,
    });
    let proposals = 0;
    let ok = false;
    let errMsg: string | undefined;
    try {
      const result = await this.executeAgent(agent, { trigger, notePath, signal: undefined as unknown as AbortSignal });
      proposals = result.proposals;
      ok = true;
    } catch (error) {
      errMsg = (error as Error).message ?? String(error);
    }
    const finishedAt = Date.now();
    this.opts.db.run(
      `UPDATE agent_runs SET finished_at = ?, ok = ?, error = ?, proposals_count = ? WHERE id = ?;`,
      [finishedAt, ok ? 1 : 0, errMsg ?? null, proposals, runId],
    );
    this.opts.bus.emit({
      type: "agent:run-finished",
      agent: agent.name,
      ok,
      proposals,
      durationMs: finishedAt - startedAt,
      error: errMsg,
      runId,
    });
  }

  private async executeAgent(agent: Agent, ctxNoSignal: AgentRunContext) {
    if (agent.usesReasoningModel) {
      return this.opts.mutex.run(`agent:${agent.name}`, async (signal) => {
        return agent.run({ ...ctxNoSignal, signal });
      });
    }
    const controller = new AbortController();
    return agent.run({ ...ctxNoSignal, signal: controller.signal });
  }
}
```

- [ ] **Step 5: Verify**

Run: `bun test src/core/coordinator/coordinator.test.ts && bun run typecheck && bun run lint`
Expected: 7/7 pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/coordinator/types.ts src/core/coordinator/coordinator.ts src/core/coordinator/coordinator.test.ts src/core/events/types.ts
git commit -m "feat(coordinator): event-driven scheduler with mutex-bound agent dispatch"
```

---

## Task 4: Linker agent

**Files:**
- Create: `src/core/agents/types.ts`
- Create: `src/core/agents/linker.ts`
- Create: `src/core/agents/linker.test.ts`

**Why:** Per spec §6.1 the Linker reads the active note's embedding neighborhood, asks the reasoning model to type each candidate edge with grounded justification, and stages the result. We use `primaryLLM` with `reasoningModel = nemotron-cascade-2-30b-a3b-i1` because the Phase 2.5 fix (commit 6b8b10b) makes its JSON output reachable through `chatJson` and we want one model serving both extractor and reasoning paths until v1.1 (avoids cold-loading a second 30B model and halving dynamo VRAM headroom).

- [ ] **Step 1: Define shared agent types**

Create `src/core/agents/types.ts`:

```typescript
export interface StagingEdgeRow {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  agent: string;
  evidence: string[];
  rationale: string | null;
  createdAt: number;
}

export interface StagingNodeRow {
  id: string;
  type: "claim" | "concept" | "question" | "synthesis";
  label: string;
  notePath: string | null;
  payload: Record<string, unknown> | null;
  agent: string;
  confidence: number;
  createdAt: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/core/agents/linker.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import type { JsonSchema, LLMProvider } from "../llm/provider";
import { Linker } from "./linker";

function fakeProvider(json: unknown): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      yield "";
    },
    chatJson: async <T>(_m: unknown, _o: unknown, _s: JsonSchema) => json as T,
    embed: async () => [],
  };
}

describe("Linker", () => {
  test("stages typed edges to staging_edges with evidence + confidence", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/active.md", "sha", 100, 1, 1],
    );
    db.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/neighbor.md", "sha", 100, 1, 1],
    );
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c1", "/active.md", 0, "POSIX is leaky in HPC.", "s1",
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c2", "/neighbor.md", 0, "Distributed file systems break POSIX assumptions.", "s2",
    ]);
    const provider = fakeProvider({
      edges: [
        {
          targetNotePath: "/neighbor.md",
          type: "supports",
          confidence: 0.84,
          rationale: "Both note POSIX limits.",
          evidenceChunkIds: ["c1", "c2"],
        },
      ],
    });
    const linker = new Linker({
      db,
      provider,
      reasoningModel: "nemotron",
      neighborhood: async () => [
        { notePath: "/neighbor.md", chunkId: "c2", text: "Distributed file systems break POSIX assumptions.", score: 0.91 },
      ],
    });
    const result = await linker.run({
      trigger: "vault-save",
      notePath: "/active.md",
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ type: string; agent: string; confidence: number; evidence: string }>(
      "SELECT type, agent, confidence, evidence FROM staging_edges;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("supports");
    expect(rows[0].agent).toBe("linker");
    expect(rows[0].confidence).toBeCloseTo(0.84);
    expect(JSON.parse(rows[0].evidence)).toEqual(["c1", "c2"]);
  });

  test("returns 0 proposals when notePath is null", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const linker = new Linker({
      db,
      provider: fakeProvider({ edges: [] }),
      reasoningModel: "nemotron",
      neighborhood: async () => [],
    });
    const result = await linker.run({
      trigger: "idle-30s",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(0);
  });

  test("respects abort signal mid-run", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
      ["/active.md", "sha", 100, 1, 1],
    );
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "c1", "/active.md", 0, "x", "s",
    ]);
    let saw: AbortSignal | undefined;
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* () { yield ""; },
      chatJson: async (_m, opts) => {
        saw = opts.signal;
        return { edges: [] };
      },
      embed: async () => [],
    };
    const linker = new Linker({
      db,
      provider,
      reasoningModel: "nemotron",
      neighborhood: async () => [
        { notePath: "/n.md", chunkId: "c2", text: "x", score: 0.5 },
      ],
    });
    const ctrl = new AbortController();
    await linker.run({
      trigger: "vault-save",
      notePath: "/active.md",
      signal: ctrl.signal,
    });
    expect(saw).toBe(ctrl.signal);
  });
});
```

- [ ] **Step 3: Implement the Linker**

Create `src/core/agents/linker.ts`:

```typescript
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";

export interface NeighborChunk {
  notePath: string;
  chunkId: string;
  text: string;
  score: number;
}

export interface NeighborhoodFn {
  (notePath: string, opts: { signal: AbortSignal; topK: number }): Promise<NeighborChunk[]>;
}

export interface LinkerOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  neighborhood: NeighborhoodFn;
  topK?: number;
}

interface LinkerJsonResponse {
  edges: Array<{
    targetNotePath: string;
    type: "supports" | "extends" | "exemplifies" | "related_to";
    confidence: number;
    rationale: string;
    evidenceChunkIds: string[];
  }>;
}

const SCHEMA = {
  name: "LinkerEdges",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["edges"],
    properties: {
      edges: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["targetNotePath", "type", "confidence", "rationale", "evidenceChunkIds"],
          properties: {
            targetNotePath: { type: "string" },
            type: { type: "string", enum: ["supports", "extends", "exemplifies", "related_to"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 240 },
            evidenceChunkIds: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
        },
      },
    },
  },
} as const;

export class Linker implements Agent {
  readonly name = "linker" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: LinkerOptions) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    if (!ctx.notePath) return { proposals: 0 };
    const topK = this.opts.topK ?? 20;
    const neighbors = await this.opts.neighborhood(ctx.notePath, { signal: ctx.signal, topK });
    if (neighbors.length === 0) return { proposals: 0 };

    const activeChunks = this.opts.db.query<{ id: string; text: string }>(
      "SELECT id, text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 6;",
      [ctx.notePath],
    );
    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Notient Linker. Given an active note and its top embedding neighbours, propose typed edges with evidence. Cite only chunk IDs that appear in the input. Be conservative: confidence < 0.6 means do not propose.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          activeNote: { path: ctx.notePath, chunks: activeChunks },
          neighbors,
          edgeTypes: ["supports", "extends", "exemplifies", "related_to"],
        }),
      },
    ];

    const response = await this.opts.provider.chatJson<LinkerJsonResponse>(
      messages,
      { model: this.opts.reasoningModel, temperature: 0.1, signal: ctx.signal, maxTokens: 800 },
      SCHEMA,
    );

    const allowedChunkIds = new Set([
      ...activeChunks.map((c) => c.id),
      ...neighbors.map((n) => n.chunkId),
    ]);

    const sourceId = `note:${ctx.notePath}`;
    let staged = 0;
    for (const edge of response.edges) {
      if (edge.confidence < 0.6) continue;
      const evidence = edge.evidenceChunkIds.filter((id) => allowedChunkIds.has(id));
      if (evidence.length === 0) continue;
      const targetId = `note:${edge.targetNotePath}`;
      const id = `staging:${this.name}:${sourceId}:${targetId}:${Date.now()}:${staged}`;
      this.opts.db.run(
        `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          id,
          edge.type,
          sourceId,
          targetId,
          edge.confidence,
          this.name,
          JSON.stringify(evidence),
          edge.rationale,
          Date.now(),
        ],
      );
      staged++;
    }
    return { proposals: staged };
  }
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/core/agents/linker.test.ts && bun run typecheck && bun run lint`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/agents/types.ts src/core/agents/linker.ts src/core/agents/linker.test.ts
git commit -m "feat(linker): stage typed edges with grounded evidence + confidence"
```

---

## Task 5: DBSCAN over embedding space

**Files:**
- Create: `src/core/agents/dbscan.ts`
- Create: `src/core/agents/dbscan.test.ts`

**Why:** The Synthesizer needs cluster detection (spec §6.2). Pulling a JS DBSCAN dep adds a dependency footprint; a 30-line implementation over Float32Array vectors with cosine distance is enough for v1.0 and stays inside the existing zero-runtime-deps boundary.

- [ ] **Step 1: Write the failing test**

Create `src/core/agents/dbscan.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { dbscanCosine } from "./dbscan";

function vec(x: number, y: number): Float32Array {
  return Float32Array.from([x, y]);
}

describe("dbscanCosine", () => {
  test("clusters near-identical vectors and isolates outliers", () => {
    const points = [
      { id: "a", v: vec(1, 0) },
      { id: "b", v: vec(0.99, 0.01) },
      { id: "c", v: vec(0.98, 0.02) },
      { id: "d", v: vec(0, 1) },
      { id: "e", v: vec(0.01, 0.99) },
      { id: "f", v: vec(-1, -1) },
    ];
    const clusters = dbscanCosine(points, { epsilon: 0.05, minPoints: 2 });
    expect(clusters.length).toBe(2);
    const ids = clusters.map((c) => c.map((p) => p.id).sort()).sort();
    expect(ids).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  test("returns no clusters when minPoints not met", () => {
    const points = [
      { id: "a", v: vec(1, 0) },
      { id: "b", v: vec(0, 1) },
    ];
    expect(dbscanCosine(points, { epsilon: 0.1, minPoints: 3 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement DBSCAN**

Create `src/core/agents/dbscan.ts`:

```typescript
export interface DbscanPoint {
  id: string;
  v: Float32Array;
}

export interface DbscanOptions {
  epsilon: number;
  minPoints: number;
}

export function dbscanCosine(points: DbscanPoint[], opts: DbscanOptions): DbscanPoint[][] {
  const labels = new Array<number | null>(points.length).fill(null);
  let cluster = -1;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== null) continue;
    const neighbors = regionQuery(points, i, opts.epsilon);
    if (neighbors.length < opts.minPoints) {
      labels[i] = -1;
      continue;
    }
    cluster++;
    labels[i] = cluster;
    const queue = [...neighbors];
    while (queue.length > 0) {
      const j = queue.shift() as number;
      if (labels[j] === -1) labels[j] = cluster;
      if (labels[j] !== null) continue;
      labels[j] = cluster;
      const inner = regionQuery(points, j, opts.epsilon);
      if (inner.length >= opts.minPoints) {
        for (const k of inner) queue.push(k);
      }
    }
  }
  const result: DbscanPoint[][] = [];
  for (let c = 0; c <= cluster; c++) {
    const group = points.filter((_, i) => labels[i] === c);
    if (group.length > 0) result.push(group);
  }
  return result;
}

function regionQuery(points: DbscanPoint[], i: number, epsilon: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < points.length; j++) {
    if (i === j) continue;
    if (cosineDistance(points[i].v, points[j].v) <= epsilon) out.push(j);
  }
  return out;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}
```

- [ ] **Step 3: Verify**

Run: `bun test src/core/agents/dbscan.test.ts && bun run typecheck && bun run lint`
Expected: 2/2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/agents/dbscan.ts src/core/agents/dbscan.test.ts
git commit -m "feat(agents): add cosine DBSCAN for cluster detection"
```

---

## Task 6: Synthesizer agent

**Files:**
- Create: `src/core/agents/synthesizer.ts`
- Create: `src/core/agents/synthesizer.test.ts`

**Why:** Per spec §6.2 the Synthesizer reads a cluster of related notes and drafts a synthesis note into `0-inbox/notient-synthesis/`. The cluster is detected via DBSCAN over recently-changed note embeddings (use the centroid of each note's chunk vectors). The synthesis itself is *not* a markdown write yet — it's a `staging_node` with `type='synthesis'` that the Approvals UI can promote into a real file.

- [ ] **Step 1: Write the failing test**

Create `src/core/agents/synthesizer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import type { JsonSchema, LLMProvider } from "../llm/provider";
import { Synthesizer } from "./synthesizer";

function fakeProvider(json: unknown): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () { yield ""; },
    chatJson: async <T>(_m: unknown, _o: unknown, _s: JsonSchema) => json as T,
    embed: async () => [],
  };
}

function vecBlob(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

describe("Synthesizer", () => {
  test("clusters recent notes and stages a synthesis node", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const now = Date.now();
    for (const path of ["/a.md", "/b.md", "/c.md"]) {
      db.run(
        "INSERT INTO notes (path, sha, word_count, indexed_at, updated_at) VALUES (?,?,?,?,?)",
        [path, "s", 100, now, now],
      );
    }
    // a + b are tight cluster, c is far.
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "ca", "/a.md", 0, "POSIX leaks", "s",
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "cb", "/b.md", 0, "POSIX limits", "s",
    ]);
    db.run("INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);", [
      "cc", "/c.md", 0, "Astronomy", "s",
    ]);
    db.run(
      "INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);",
      ["ca", "primary-embed", 2, vecBlob([1, 0])],
    );
    db.run(
      "INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);",
      ["cb", "primary-embed", 2, vecBlob([0.99, 0.01])],
    );
    db.run(
      "INSERT INTO embeddings (chunk_id, model, dim, vector) VALUES (?,?,?,?);",
      ["cc", "primary-embed", 2, vecBlob([-1, -1])],
    );
    const provider = fakeProvider({
      title: "POSIX Limits in Distributed Systems",
      body: "## Themes\n- POSIX is leaky.\n- ...",
      memberPaths: ["/a.md", "/b.md"],
      confidence: 0.78,
    });
    const synth = new Synthesizer({
      db,
      provider,
      reasoningModel: "nemotron",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ type: string; agent: string; payload: string; label: string }>(
      "SELECT type, agent, payload, label FROM staging_nodes;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("synthesis");
    expect(rows[0].agent).toBe("synthesizer");
    expect(rows[0].label).toContain("POSIX");
    const payload = JSON.parse(rows[0].payload);
    expect(payload.memberPaths).toEqual(["/a.md", "/b.md"]);
  });

  test("returns 0 proposals when no cluster meets minSize", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const synth = new Synthesizer({
      db,
      provider: fakeProvider({}),
      reasoningModel: "nemotron",
      epsilon: 0.05,
      minClusterSize: 2,
      sinceMs: 0,
    });
    const result = await synth.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(0);
  });
});
```

- [ ] **Step 2: Implement Synthesizer**

Create `src/core/agents/synthesizer.ts`:

```typescript
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import { type DbscanPoint, dbscanCosine } from "./dbscan";

export interface SynthesizerOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  epsilon: number;
  minClusterSize: number;
  /** Notes updated within the last N ms are eligible. 0 = all notes. */
  sinceMs: number;
  maxClusterSize?: number;
}

const SCHEMA = {
  name: "SynthesisDraft",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body", "memberPaths", "confidence"],
    properties: {
      title: { type: "string", maxLength: 120 },
      body: { type: "string", maxLength: 4000 },
      memberPaths: { type: "array", items: { type: "string" }, maxItems: 12 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const;

interface SynthesisResponse {
  title: string;
  body: string;
  memberPaths: string[];
  confidence: number;
}

interface NoteCentroid {
  path: string;
  centroid: Float32Array;
}

export class Synthesizer implements Agent {
  readonly name = "synthesizer" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: SynthesizerOptions) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const cutoff = this.opts.sinceMs > 0 ? Date.now() - this.opts.sinceMs : 0;
    const centroids = this.collectCentroids(cutoff);
    if (centroids.length < this.opts.minClusterSize) return { proposals: 0 };
    const points: DbscanPoint[] = centroids.map((c) => ({ id: c.path, v: c.centroid }));
    const clusters = dbscanCosine(points, {
      epsilon: this.opts.epsilon,
      minPoints: this.opts.minClusterSize,
    });
    let staged = 0;
    for (const cluster of clusters) {
      if (cluster.length < this.opts.minClusterSize) continue;
      const memberPaths = cluster.map((p) => p.id).slice(0, this.opts.maxClusterSize ?? 12);
      const noteSummaries = this.collectSummaries(memberPaths);
      const messages = [
        {
          role: "system" as const,
          content:
            "You are the Notient Synthesizer. Given a cluster of related notes, draft a synthesis note. Quote source notes via [[wikilinks]] in the body. Confidence < 0.6 means do not propose.",
        },
        {
          role: "user" as const,
          content: JSON.stringify({ memberPaths, summaries: noteSummaries }),
        },
      ];
      const response = await this.opts.provider.chatJson<SynthesisResponse>(
        messages,
        {
          model: this.opts.reasoningModel,
          temperature: 0.2,
          signal: ctx.signal,
          maxTokens: 1500,
        },
        SCHEMA,
      );
      if (response.confidence < 0.6) continue;
      const id = `staging:synthesis:${slug(response.title)}:${Date.now()}`;
      this.opts.db.run(
        `INSERT INTO staging_nodes (id, type, label, note_path, payload, agent, confidence, created_at)
         VALUES (?,?,?,?,?,?,?,?);`,
        [
          id,
          "synthesis",
          response.title,
          null,
          JSON.stringify({
            body: response.body,
            memberPaths: response.memberPaths,
            targetPath: `0-inbox/notient-synthesis/${slug(response.title)}.md`,
          }),
          this.name,
          response.confidence,
          Date.now(),
        ],
      );
      staged++;
    }
    return { proposals: staged };
  }

  private collectCentroids(cutoff: number): NoteCentroid[] {
    const noteRows = this.opts.db.query<{ path: string }>(
      cutoff > 0
        ? "SELECT path FROM notes WHERE updated_at >= ?;"
        : "SELECT path FROM notes;",
      cutoff > 0 ? [cutoff] : [],
    );
    const centroids: NoteCentroid[] = [];
    for (const row of noteRows) {
      const vectors = this.opts.db.query<{ vector: Uint8Array; dim: number }>(
        `SELECT e.vector AS vector, e.dim AS dim
         FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE c.note_path = ?;`,
        [row.path],
      );
      if (vectors.length === 0) continue;
      const dim = vectors[0].dim;
      const sum = new Float32Array(dim);
      for (const v of vectors) {
        const view = new Float32Array(v.vector.buffer, v.vector.byteOffset, dim);
        for (let i = 0; i < dim; i++) sum[i] += view[i];
      }
      for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
      centroids.push({ path: row.path, centroid: sum });
    }
    return centroids;
  }

  private collectSummaries(paths: string[]): Array<{ path: string; head: string }> {
    return paths.map((path) => {
      const rows = this.opts.db.query<{ text: string }>(
        "SELECT text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 2;",
        [path],
      );
      return { path, head: rows.map((r) => r.text).join("\n").slice(0, 600) };
    });
  }
}

function slug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
```

- [ ] **Step 3: Verify**

Run: `bun test src/core/agents/synthesizer.test.ts && bun run typecheck && bun run lint`
Expected: 2/2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/agents/synthesizer.ts src/core/agents/synthesizer.test.ts
git commit -m "feat(synthesizer): cluster notes via DBSCAN and stage synthesis drafts"
```

---

## Task 7: Contradiction Hunter agent

**Files:**
- Create: `src/core/agents/contradictionHunter.ts`
- Create: `src/core/agents/contradictionHunter.test.ts`

**Why:** Per spec §6.3 the Contradiction Hunter triggers on new claims (or 5-min idle), pulls top-50 existing claims by embedding similarity, and asks the reasoning model which pairs are incompatible. Each `contradicts` edge carries `evidence: [chunk_id_a, chunk_id_b]`. Reads `claim` nodes from `graph_nodes`.

- [ ] **Step 1: Write the failing test**

Create `src/core/agents/contradictionHunter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import type { JsonSchema, LLMProvider } from "../llm/provider";
import { ContradictionHunter } from "./contradictionHunter";

function fakeProvider(json: unknown): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () { yield ""; },
    chatJson: async <T>(_m: unknown, _o: unknown, _s: JsonSchema) => json as T,
    embed: async () => [],
  };
}

describe("ContradictionHunter", () => {
  test("stages contradicts edges between claim nodes", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      `INSERT INTO graph_nodes (id, type, label, note_path, payload, created_at)
       VALUES (?,?,?,?,?,?), (?,?,?,?,?,?);`,
      [
        "claim:abc",
        "claim",
        "POSIX is leaky in HPC.",
        "/a.md",
        JSON.stringify({ chunkIds: ["c1"] }),
        1,
        "claim:def",
        "claim",
        "POSIX semantics are fully respected by parallel filesystems.",
        "/b.md",
        JSON.stringify({ chunkIds: ["c2"] }),
        1,
      ],
    );
    const provider = fakeProvider({
      pairs: [
        {
          claimAId: "claim:abc",
          claimBId: "claim:def",
          confidence: 0.84,
          rationale: "Direct negation of the same property.",
          evidenceChunkIds: ["c1", "c2"],
        },
      ],
    });
    const hunter = new ContradictionHunter({
      db,
      provider,
      reasoningModel: "nemotron",
      neighbors: async () => [{ id: "claim:def", score: 0.91, chunkIds: ["c2"] }],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "new-claim",
      notePath: "/a.md",
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(1);
    const rows = db.query<{ type: string; source_id: string; target_id: string; confidence: number }>(
      "SELECT type, source_id, target_id, confidence FROM staging_edges;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("contradicts");
    expect(rows[0].source_id).toBe("claim:abc");
    expect(rows[0].target_id).toBe("claim:def");
    expect(rows[0].confidence).toBeCloseTo(0.84);
  });

  test("returns 0 proposals when no claims exist", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const hunter = new ContradictionHunter({
      db,
      provider: fakeProvider({ pairs: [] }),
      reasoningModel: "nemotron",
      neighbors: async () => [],
      maxPairs: 5,
    });
    const result = await hunter.run({
      trigger: "idle-5m",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(0);
  });
});
```

- [ ] **Step 2: Implement Contradiction Hunter**

Create `src/core/agents/contradictionHunter.ts`:

```typescript
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";

export interface ClaimNeighbor {
  id: string;
  score: number;
  chunkIds: string[];
}

export interface ClaimNeighborsFn {
  (recentClaimIds: string[], opts: { signal: AbortSignal; topK: number }): Promise<ClaimNeighbor[]>;
}

export interface ContradictionHunterOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  neighbors: ClaimNeighborsFn;
  maxPairs: number;
  topK?: number;
}

const SCHEMA = {
  name: "ContradictionPairs",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["pairs"],
    properties: {
      pairs: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claimAId", "claimBId", "confidence", "rationale", "evidenceChunkIds"],
          properties: {
            claimAId: { type: "string" },
            claimBId: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 240 },
            evidenceChunkIds: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
          },
        },
      },
    },
  },
} as const;

interface PairsResponse {
  pairs: Array<{
    claimAId: string;
    claimBId: string;
    confidence: number;
    rationale: string;
    evidenceChunkIds: string[];
  }>;
}

export class ContradictionHunter implements Agent {
  readonly name = "contradictionHunter" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: ContradictionHunterOptions) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const recentClaims = this.opts.db.query<{ id: string; label: string; payload: string | null }>(
      ctx.notePath
        ? "SELECT id, label, payload FROM graph_nodes WHERE type = 'claim' AND note_path = ? ORDER BY created_at DESC LIMIT 10;"
        : "SELECT id, label, payload FROM graph_nodes WHERE type = 'claim' ORDER BY created_at DESC LIMIT 10;",
      ctx.notePath ? [ctx.notePath] : [],
    );
    if (recentClaims.length === 0) return { proposals: 0 };

    const neighbors = await this.opts.neighbors(
      recentClaims.map((c) => c.id),
      { signal: ctx.signal, topK: this.opts.topK ?? 50 },
    );
    if (neighbors.length === 0) return { proposals: 0 };

    const neighborClaims = this.opts.db.query<{ id: string; label: string; payload: string | null }>(
      `SELECT id, label, payload FROM graph_nodes WHERE id IN (${neighbors.map(() => "?").join(",")});`,
      neighbors.map((n) => n.id),
    );

    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Notient Contradiction Hunter. Identify pairs of claims that directly contradict. Confidence < 0.6 means do not propose. Cite the chunk IDs that prove the contradiction.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          recentClaims: recentClaims.map((c) => ({
            id: c.id,
            text: c.label,
            chunkIds: extractChunkIds(c.payload),
          })),
          candidateClaims: neighborClaims.map((c) => ({
            id: c.id,
            text: c.label,
            chunkIds: extractChunkIds(c.payload),
          })),
        }),
      },
    ];

    const response = await this.opts.provider.chatJson<PairsResponse>(
      messages,
      {
        model: this.opts.reasoningModel,
        temperature: 0.1,
        signal: ctx.signal,
        maxTokens: 1000,
      },
      SCHEMA,
    );

    const validIds = new Set([
      ...recentClaims.map((c) => c.id),
      ...neighborClaims.map((c) => c.id),
    ]);

    let staged = 0;
    for (const pair of response.pairs.slice(0, this.opts.maxPairs)) {
      if (pair.confidence < 0.6) continue;
      if (!validIds.has(pair.claimAId) || !validIds.has(pair.claimBId)) continue;
      const id = `staging:${this.name}:${pair.claimAId}:${pair.claimBId}:${Date.now()}:${staged}`;
      this.opts.db.run(
        `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          id,
          "contradicts",
          pair.claimAId,
          pair.claimBId,
          pair.confidence,
          this.name,
          JSON.stringify(pair.evidenceChunkIds),
          pair.rationale,
          Date.now(),
        ],
      );
      staged++;
    }
    return { proposals: staged };
  }
}

function extractChunkIds(payload: string | null): string[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as { chunkIds?: string[] };
    return Array.isArray(parsed.chunkIds) ? parsed.chunkIds : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Verify**

Run: `bun test src/core/agents/contradictionHunter.test.ts && bun run typecheck && bun run lint`
Expected: 2/2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/agents/contradictionHunter.ts src/core/agents/contradictionHunter.test.ts
git commit -m "feat(agents): contradiction hunter stages contradicts edges with chunk evidence"
```

---

## Task 8: Maturity Advancer agent

**Files:**
- Create: `src/core/agents/maturityAdvancer.ts`
- Create: `src/core/agents/maturityAdvancer.test.ts`

**Why:** Per spec §6.4 the Maturity Advancer is the only agent that writes back to the user's markdown frontmatter (via `notient.vitals.maturity`). It does **not** call any LLM; it uses simple rules:

- raw → adolescent: any user edit (word_count > 0 + maturity = 'raw')
- adolescent → mature: word_count >= 200 AND inbound+outbound graph edges >= 5 AND last edit older than 7 days
- mature → synthesis-ready: outbound `links` count >= 10 AND inbound `links` count >= 3

It is the first agent that calls `EchoGuard.mark()` so the indexer doesn't loop on its own writes.

- [ ] **Step 1: Write the failing test**

Create `src/core/agents/maturityAdvancer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EchoGuard } from "../services/echoGuard";
import { MaturityAdvancer } from "./maturityAdvancer";

class FakeFacade {
  files = new Map<string, string>();
  marks: string[] = [];
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, body: string): Promise<void> {
    this.files.set(path, body);
    this.marks.push(`wrote:${path}`);
  }
}

async function sha(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("MaturityAdvancer", () => {
  test("promotes raw -> adolescent on first edit", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const facade = new FakeFacade();
    const echo = new EchoGuard();
    const ma = new MaturityAdvancer({ db, facade, echoGuard: echo, hash: sha });
    const now = Date.now();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["/a.md", "x", 50, "raw", now, now],
    );
    facade.files.set("/a.md", "# A\nSome content.\n");
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(1);
    const row = db.query<{ maturity: string }>("SELECT maturity FROM notes WHERE path = ?;", ["/a.md"])[0];
    expect(row.maturity).toBe("adolescent");
    expect(facade.files.get("/a.md")).toContain("notient:");
    expect(facade.files.get("/a.md")).toContain("maturity: adolescent");
  });

  test("EchoGuard is marked before write so indexer skips the self-write", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const facade = new FakeFacade();
    const echo = new EchoGuard();
    const ma = new MaturityAdvancer({ db, facade, echoGuard: echo, hash: sha });
    const now = Date.now();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["/a.md", "x", 50, "raw", now, now],
    );
    facade.files.set("/a.md", "# A\nx\n");
    await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
    });
    const written = facade.files.get("/a.md") as string;
    const writtenSha = await sha(written);
    expect(echo.take("/a.md", writtenSha)).toBe(true);
  });

  test("does not promote a note that does not meet criteria", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const facade = new FakeFacade();
    const ma = new MaturityAdvancer({
      db,
      facade,
      echoGuard: new EchoGuard(),
      hash: sha,
    });
    const now = Date.now();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["/a.md", "x", 5, "adolescent", now, now],
    );
    facade.files.set("/a.md", "# A\n");
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
    });
    expect(result.proposals).toBe(0);
  });
});
```

- [ ] **Step 2: Implement Maturity Advancer**

Create `src/core/agents/maturityAdvancer.ts`:

```typescript
import type { ObsidianFacade } from "../../adapters/obsidianFacade";
import type { Database } from "../db/database";
import { upsertNotientBlock } from "../graph/frontmatterWriter";
import type { EchoGuard } from "../services/echoGuard";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";

type Maturity = "raw" | "adolescent" | "mature" | "synthesis-ready";

export interface MaturityAdvancerOptions {
  db: Database;
  facade: Pick<ObsidianFacade, "read" | "write">;
  echoGuard: EchoGuard;
  hash: (input: string) => Promise<string>;
  freshnessHalfLifeMs?: number;
}

interface NoteRow {
  path: string;
  word_count: number;
  maturity: string;
  updated_at: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class MaturityAdvancer implements Agent {
  readonly name = "maturityAdvancer" as const;
  readonly usesReasoningModel = false;

  constructor(private readonly opts: MaturityAdvancerOptions) {}

  async run(_ctx: AgentRunContext): Promise<AgentRunResult> {
    const rows = this.opts.db.query<NoteRow>(
      "SELECT path, word_count, maturity, updated_at FROM notes;",
    );
    let promotions = 0;
    for (const row of rows) {
      const next = this.evaluate(row);
      if (next === row.maturity) continue;
      await this.applyPromotion(row.path, next as Maturity);
      promotions++;
    }
    return { proposals: promotions };
  }

  private evaluate(row: NoteRow): Maturity {
    const inbound = this.countEdges(row.path, "target");
    const outbound = this.countEdges(row.path, "source");
    const ageMs = Date.now() - row.updated_at;
    if (row.maturity === "raw" && row.word_count > 0) return "adolescent";
    if (
      row.maturity === "adolescent" &&
      row.word_count >= 200 &&
      inbound + outbound >= 5 &&
      ageMs >= SEVEN_DAYS_MS
    ) {
      return "mature";
    }
    if (row.maturity === "mature" && outbound >= 10 && inbound >= 3) {
      return "synthesis-ready";
    }
    return row.maturity as Maturity;
  }

  private countEdges(path: string, side: "source" | "target"): number {
    const id = `note:${path}`;
    const col = side === "source" ? "source_id" : "target_id";
    const rows = this.opts.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM graph_edges WHERE ${col} = ? AND approved = 1;`,
      [id],
    );
    return rows[0]?.n ?? 0;
  }

  private async applyPromotion(path: string, next: Maturity): Promise<void> {
    const before = await this.opts.facade.read(path);
    const freshness = computeFreshness(Date.now());
    const updated = upsertNotientBlock(before, {
      vitals: { health: 0, maturity: next, freshness },
      updated: new Date().toISOString(),
    });
    if (updated === before) return;
    const sha = await this.opts.hash(updated);
    this.opts.echoGuard.mark(path, sha);
    await this.opts.facade.write(path, updated);
    this.opts.db.run("UPDATE notes SET maturity = ? WHERE path = ?;", [next, path]);
  }
}

function computeFreshness(_now: number): number {
  return 1.0;
}
```

(`computeFreshness` is a placeholder for the half-life decay; v1.0 ships flat 1.0 because the freshness signal isn't surfaced anywhere yet. Phase 4's Vitals panel will fill it in.)

- [ ] **Step 3: Verify**

Run: `bun test src/core/agents/maturityAdvancer.test.ts && bun run typecheck && bun run lint`
Expected: 3/3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/agents/maturityAdvancer.ts src/core/agents/maturityAdvancer.test.ts
git commit -m "feat(agents): maturity advancer promotes notes and writes vitals via echo-guarded write"
```

---

## Task 9: Voice-mimicry context builder

**Files:**
- Create: `src/core/coAuthor/voiceContext.ts`
- Create: `src/core/coAuthor/voiceContext.test.ts`

**Why:** Per spec §7 voice-mimicry uses 3 short examples from the user's most-edited mature notes (selected by maturity score + word count). This is one tiny pure function that the chatStream prompt builder will call.

- [ ] **Step 1: Write the failing test**

Create `src/core/coAuthor/voiceContext.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { buildVoiceContext } from "./voiceContext";

describe("buildVoiceContext", () => {
  test("returns up to 3 short snippets from mature notes ordered by recency", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    const seed = (path: string, maturity: string, wc: number, updated: number) => {
      db.run(
        "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
        [path, "s", wc, maturity, updated, updated],
      );
      db.run(
        "INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);",
        [`c:${path}`, path, 0, `Voice from ${path}.`, "s"],
      );
    };
    seed("/m1.md", "mature", 500, 5);
    seed("/m2.md", "mature", 600, 10);
    seed("/m3.md", "mature", 700, 7);
    seed("/raw.md", "raw", 50, 8);
    const ctx = buildVoiceContext(db, { excludePath: null, max: 3, snippetChars: 60 });
    expect(ctx.snippets.map((s) => s.path)).toEqual(["/m2.md", "/m3.md", "/m1.md"]);
    for (const s of ctx.snippets) {
      expect(s.text.length).toBeLessThanOrEqual(60);
    }
  });

  test("excludes the active note from the picked snippets", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 1000, "mature", 99, 99],
    );
    db.run(
      "INSERT INTO chunks (id, note_path, ord, text, sha) VALUES (?,?,?,?,?);",
      ["c:/active.md", "/active.md", 0, "active voice", "s"],
    );
    const ctx = buildVoiceContext(db, { excludePath: "/active.md", max: 3, snippetChars: 100 });
    expect(ctx.snippets).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/core/coAuthor/voiceContext.ts`:

```typescript
import type { Database } from "../db/database";

export interface VoiceContextOptions {
  excludePath: string | null;
  max: number;
  snippetChars: number;
}

export interface VoiceSnippet {
  path: string;
  text: string;
}

export interface VoiceContext {
  snippets: VoiceSnippet[];
}

export function buildVoiceContext(db: Database, opts: VoiceContextOptions): VoiceContext {
  const rows = db.query<{ path: string; word_count: number; updated_at: number }>(
    `SELECT path, word_count, updated_at
     FROM notes
     WHERE maturity IN ('mature','synthesis-ready') AND word_count >= 100
       AND (? IS NULL OR path != ?)
     ORDER BY updated_at DESC
     LIMIT 24;`,
    [opts.excludePath, opts.excludePath],
  );
  const ranked = rows
    .slice()
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, opts.max);
  const snippets: VoiceSnippet[] = [];
  for (const row of ranked) {
    const chunks = db.query<{ text: string }>(
      "SELECT text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 1;",
      [row.path],
    );
    if (chunks.length === 0) continue;
    snippets.push({
      path: row.path,
      text: chunks[0].text.slice(0, opts.snippetChars),
    });
  }
  return { snippets };
}

function scoreOf(row: { word_count: number; updated_at: number }): number {
  return row.updated_at + Math.min(row.word_count, 2000);
}
```

- [ ] **Step 3: Verify**

Run: `bun test src/core/coAuthor/voiceContext.test.ts && bun run typecheck && bun run lint`
Expected: 2/2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/coAuthor/voiceContext.ts src/core/coAuthor/voiceContext.test.ts
git commit -m "feat(co-author): voice-mimicry context picker over mature notes"
```

---

## Task 10: Co-author chat stream

**Files:**
- Create: `src/core/coAuthor/chatStream.ts`
- Create: `src/core/coAuthor/chatStream.test.ts`
- Modify: `src/core/events/types.ts` (extend with `coAuthor:section` and `coAuthor:done`)

**Why:** Per spec §7 the Co-author panel listens to `active-leaf-change`, builds a context (active note + frontmatter + top-10 graph neighbors), and streams a structured prose response with three labelled sections (SUMMARY / IMPLIES / CONNECTS). This task implements the producer side: pure logic that returns an `AsyncIterable<{ section, delta }>`. The UI in Task 11 consumes it.

- [ ] **Step 1: Extend `AppEvent`**

Append to `src/core/events/types.ts`:

```typescript
  | { type: "coAuthor:section"; notePath: string; section: "summary" | "implies" | "connects"; delta: string }
  | { type: "coAuthor:done"; notePath: string; ok: boolean; durationMs: number; error?: string }
  | { type: "coAuthor:cancelled"; notePath: string }
```

- [ ] **Step 2: Write the failing test**

Create `src/core/coAuthor/chatStream.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { CoAuthorService } from "./chatStream";

function streamProvider(parts: string[]): LLMProvider {
  return {
    isAvailable: async () => true,
    chat: async () => "",
    chatStream: async function* () {
      for (const p of parts) yield p;
    },
    chatJson: async () => ({}) as unknown,
    embed: async () => [],
  };
}

describe("CoAuthorService", () => {
  test("emits section deltas as the model streams", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    const events: Array<{ section: string; delta: string }> = [];
    bus.on("coAuthor:section", (e) => events.push({ section: e.section, delta: e.delta }));
    let done = false;
    bus.on("coAuthor:done", () => {
      done = true;
    });
    const provider = streamProvider([
      "## SUMMARY\n",
      "A short take.\n",
      "## IMPLIES\n",
      "- one\n",
      "## CONNECTS\n",
      "- [[X]]: reason\n",
    ]);
    const service = new CoAuthorService({
      db,
      bus,
      provider,
      reasoningModel: "nemotron",
      readNote: async () => "# Active\nbody",
      neighbors: () => [{ path: "/n.md", title: "N", summary: "..." }],
      minWords: 50,
    });
    await service.runFor("/active.md", new AbortController().signal);
    expect(events.find((e) => e.section === "summary")?.delta).toContain("A short take");
    expect(events.find((e) => e.section === "implies")?.delta).toContain("one");
    expect(events.find((e) => e.section === "connects")?.delta).toContain("[[X]]");
    expect(done).toBe(true);
  });

  test("skips notes below minWords", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/short.md", "s", 10, "raw", 1, 1],
    );
    const bus = new EventBus();
    const fired: string[] = [];
    bus.on("coAuthor:section", () => fired.push("section"));
    bus.on("coAuthor:done", () => fired.push("done"));
    const service = new CoAuthorService({
      db,
      bus,
      provider: streamProvider(["nothing"]),
      reasoningModel: "nemotron",
      readNote: async () => "# Short",
      neighbors: () => [],
      minWords: 100,
    });
    await service.runFor("/short.md", new AbortController().signal);
    expect(fired).toEqual([]);
  });

  test("aborting cancels the stream and emits cancelled", async () => {
    const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
    const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
    await db.init();
    db.run(
      "INSERT INTO notes (path, sha, word_count, maturity, indexed_at, updated_at) VALUES (?,?,?,?,?,?);",
      ["/active.md", "s", 200, "mature", 1, 1],
    );
    const bus = new EventBus();
    let cancelled = false;
    bus.on("coAuthor:cancelled", () => {
      cancelled = true;
    });
    const provider: LLMProvider = {
      isAvailable: async () => true,
      chat: async () => "",
      chatStream: async function* (_messages, opts) {
        for (let i = 0; i < 100; i++) {
          if (opts.signal?.aborted) return;
          await new Promise((r) => setTimeout(r, 5));
          yield `chunk ${i}`;
        }
      },
      chatJson: async () => ({}) as unknown,
      embed: async () => [],
    };
    const service = new CoAuthorService({
      db,
      bus,
      provider,
      reasoningModel: "nemotron",
      readNote: async () => "# Active\n" + "x ".repeat(300),
      neighbors: () => [],
      minWords: 50,
    });
    const ctrl = new AbortController();
    const run = service.runFor("/active.md", ctrl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctrl.abort();
    await run;
    expect(cancelled).toBe(true);
  });
});
```

- [ ] **Step 3: Implement CoAuthorService**

Create `src/core/coAuthor/chatStream.ts`:

```typescript
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";
import type { LLMProvider } from "../llm/provider";
import { buildVoiceContext } from "./voiceContext";

export interface CoAuthorNeighbor {
  path: string;
  title: string;
  summary: string;
}

export interface CoAuthorOptions {
  db: Database;
  bus: EventBus;
  provider: LLMProvider;
  reasoningModel: string;
  readNote: (path: string, signal: AbortSignal) => Promise<string>;
  neighbors: (path: string) => CoAuthorNeighbor[];
  minWords: number;
  voiceMax?: number;
}

type Section = "summary" | "implies" | "connects";

const SECTION_HEADERS: Record<Section, RegExp> = {
  summary: /##\s*SUMMARY/i,
  implies: /##\s*IMPLIES/i,
  connects: /##\s*CONNECTS/i,
};

export class CoAuthorService {
  constructor(private readonly opts: CoAuthorOptions) {}

  async runFor(notePath: string, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    const noteRow = this.opts.db.query<{ word_count: number }>(
      "SELECT word_count FROM notes WHERE path = ?;",
      [notePath],
    )[0];
    if (!noteRow || noteRow.word_count < this.opts.minWords) return;

    const noteBody = await this.opts.readNote(notePath, signal);
    if (signal.aborted) {
      this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
      return;
    }
    const neighbors = this.opts.neighbors(notePath);
    const voice = buildVoiceContext(this.opts.db, {
      excludePath: notePath,
      max: this.opts.voiceMax ?? 3,
      snippetChars: 240,
    });

    const messages = [
      {
        role: "system" as const,
        content:
          "You are the user's research chief of staff. Match the user's voice, shown in <voice/> snippets. Output exactly three labelled markdown sections in this order: ## SUMMARY (1-2 sentences), ## IMPLIES (1-3 bullet inferences), ## CONNECTS (3-5 [[wikilink]] suggestions with one-line reasons). Cite [[notes]] for every claim. Never invent a note path that is not in <neighbors/>.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          voice: voice.snippets,
          activeNote: { path: notePath, body: noteBody.slice(0, 6000) },
          neighbors,
        }),
      },
    ];

    let buffer = "";
    let currentSection: Section | null = null;
    let pending = "";
    let ok = false;
    try {
      for await (const delta of this.opts.provider.chatStream(messages, {
        model: this.opts.reasoningModel,
        temperature: 0.4,
        signal,
        maxTokens: 1200,
      })) {
        if (signal.aborted) {
          this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
          return;
        }
        buffer += delta;
        pending += delta;
        for (;;) {
          const next = findNextHeader(pending);
          if (!next) break;
          if (currentSection && next.before.length > 0) {
            this.opts.bus.emit({
              type: "coAuthor:section",
              notePath,
              section: currentSection,
              delta: next.before,
            });
          }
          currentSection = next.section;
          pending = next.after;
        }
        if (currentSection && pending.length > 0 && !containsAnyHeader(pending)) {
          this.opts.bus.emit({
            type: "coAuthor:section",
            notePath,
            section: currentSection,
            delta: pending,
          });
          pending = "";
        }
      }
      if (currentSection && pending.length > 0) {
        this.opts.bus.emit({
          type: "coAuthor:section",
          notePath,
          section: currentSection,
          delta: pending,
        });
      }
      ok = true;
    } catch (error) {
      if (signal.aborted) {
        this.opts.bus.emit({ type: "coAuthor:cancelled", notePath });
        return;
      }
      this.opts.bus.emit({
        type: "coAuthor:done",
        notePath,
        ok: false,
        durationMs: Date.now() - start,
        error: (error as Error).message,
      });
      return;
    }
    this.opts.bus.emit({
      type: "coAuthor:done",
      notePath,
      ok,
      durationMs: Date.now() - start,
    });
    void buffer;
  }
}

function containsAnyHeader(text: string): boolean {
  return Object.values(SECTION_HEADERS).some((rx) => rx.test(text));
}

function findNextHeader(text: string): { before: string; section: Section; after: string } | null {
  let earliest: { idx: number; matchLen: number; section: Section } | null = null;
  for (const section of Object.keys(SECTION_HEADERS) as Section[]) {
    const m = text.match(SECTION_HEADERS[section]);
    if (m && m.index !== undefined) {
      if (!earliest || m.index < earliest.idx) {
        earliest = { idx: m.index, matchLen: m[0].length, section };
      }
    }
  }
  if (!earliest) return null;
  const lineEnd = text.indexOf("\n", earliest.idx + earliest.matchLen);
  const consumeUntil = lineEnd === -1 ? text.length : lineEnd + 1;
  return {
    before: text.slice(0, earliest.idx),
    section: earliest.section,
    after: text.slice(consumeUntil),
  };
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/core/coAuthor/chatStream.test.ts && bun run typecheck && bun run lint`
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/coAuthor/chatStream.ts src/core/coAuthor/chatStream.test.ts src/core/events/types.ts
git commit -m "feat(co-author): stream three labelled sections with voice-mimicry context"
```

---

## Task 11: Co-author UI panel

**Files:**
- Create: `src/ui/coAuthor/coAuthorRender.ts`
- Create: `src/ui/coAuthor/coAuthorRender.test.ts`
- Create: `src/ui/coAuthor/CoAuthorView.ts`

**Why:** The presentation layer consumes `coAuthor:*` events and renders the three sections in the sidebar. The render logic is split into a pure DOM update function (testable) plus an Obsidian `ItemView` shell. Per spec §9.1 the panel sits below the active tab.

- [ ] **Step 1: Write the failing test for the render helper**

Create `src/ui/coAuthor/coAuthorRender.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CoAuthorPanelModel, renderCoAuthorPanel } from "./coAuthorRender";

function makeRoot(): HTMLElement {
  return Object.assign(document.createElement("div"), { className: "test-root" });
}

describe("renderCoAuthorPanel", () => {
  test("starts in idle state when no note is active", () => {
    const root = makeRoot();
    const model = new CoAuthorPanelModel();
    renderCoAuthorPanel(root, model);
    expect(root.textContent).toContain("Open a note");
  });

  test("shows thinking skeleton when streaming starts", () => {
    const root = makeRoot();
    const model = new CoAuthorPanelModel();
    model.startStream("/a.md");
    renderCoAuthorPanel(root, model);
    expect(root.textContent).toContain("thinking");
  });

  test("appends section deltas progressively", () => {
    const root = makeRoot();
    const model = new CoAuthorPanelModel();
    model.startStream("/a.md");
    model.appendSection("summary", "A short take.");
    model.appendSection("implies", "X follows.");
    model.appendSection("connects", "- [[B]]: reason");
    renderCoAuthorPanel(root, model);
    expect(root.textContent).toContain("A short take.");
    expect(root.textContent).toContain("X follows.");
    expect(root.textContent).toContain("[[B]]");
  });

  test("shows cancellable state during stream", () => {
    const root = makeRoot();
    const model = new CoAuthorPanelModel();
    model.startStream("/a.md");
    renderCoAuthorPanel(root, model);
    const btn = root.querySelector("button.notient-co-author__cancel");
    expect(btn).not.toBeNull();
  });
});
```

(`document` here is jsdom-style; Bun's test runner provides one via `bun:test` `document` polyfill when run from the test file. If the existing graphCanvas tests rely on a different polyfill, mirror that pattern — see `src/ui/onboarding/graphCanvas.test.ts` for reference.)

- [ ] **Step 2: Implement the render helper**

Create `src/ui/coAuthor/coAuthorRender.ts`:

```typescript
export type Section = "summary" | "implies" | "connects";

export interface PanelState {
  notePath: string | null;
  status: "idle" | "streaming" | "done" | "error" | "cancelled";
  sections: Record<Section, string>;
  errorMessage?: string;
}

export class CoAuthorPanelModel {
  private state: PanelState = {
    notePath: null,
    status: "idle",
    sections: { summary: "", implies: "", connects: "" },
  };
  private listeners = new Set<() => void>();

  snapshot(): PanelState {
    return {
      ...this.state,
      sections: { ...this.state.sections },
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  startStream(notePath: string): void {
    this.state = {
      notePath,
      status: "streaming",
      sections: { summary: "", implies: "", connects: "" },
    };
    this.emit();
  }

  appendSection(section: Section, delta: string): void {
    this.state.sections[section] += delta;
    this.emit();
  }

  finish(ok: boolean, error?: string): void {
    this.state.status = ok ? "done" : "error";
    this.state.errorMessage = error;
    this.emit();
  }

  cancel(): void {
    this.state.status = "cancelled";
    this.emit();
  }

  reset(): void {
    this.state = {
      notePath: null,
      status: "idle",
      sections: { summary: "", implies: "", connects: "" },
    };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export interface RenderHandlers {
  onCancel?: () => void;
}

export function renderCoAuthorPanel(
  root: HTMLElement,
  model: CoAuthorPanelModel,
  handlers: RenderHandlers = {},
): void {
  const state = model.snapshot();
  root.innerHTML = "";
  root.classList.add("notient-co-author");
  if (state.status === "idle") {
    const empty = document.createElement("div");
    empty.className = "notient-co-author__empty";
    empty.textContent = "Open a note longer than 100 words to wake the Co-author.";
    root.append(empty);
    return;
  }
  const header = document.createElement("div");
  header.className = "notient-co-author__header";
  const title = document.createElement("strong");
  title.textContent = state.notePath ?? "";
  header.append(title);
  if (state.status === "streaming") {
    const cancel = document.createElement("button");
    cancel.className = "notient-co-author__cancel";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => handlers.onCancel?.());
    header.append(cancel);
  }
  root.append(header);

  if (state.status === "streaming" && allEmpty(state.sections)) {
    const skel = document.createElement("div");
    skel.className = "notient-co-author__skeleton";
    skel.textContent = "thinking…";
    root.append(skel);
    return;
  }

  for (const section of ["summary", "implies", "connects"] as Section[]) {
    const block = document.createElement("section");
    block.className = `notient-co-author__section notient-co-author__section--${section}`;
    const heading = document.createElement("h4");
    heading.textContent = section.toUpperCase();
    const body = document.createElement("div");
    body.className = "notient-co-author__body";
    body.textContent = state.sections[section];
    block.append(heading, body);
    root.append(block);
  }
  if (state.status === "error") {
    const err = document.createElement("div");
    err.className = "notient-co-author__error";
    err.textContent = state.errorMessage ?? "stream failed";
    root.append(err);
  } else if (state.status === "cancelled") {
    const c = document.createElement("div");
    c.className = "notient-co-author__cancelled";
    c.textContent = "cancelled";
    root.append(c);
  }
}

function allEmpty(sections: PanelState["sections"]): boolean {
  return Object.values(sections).every((v) => v.length === 0);
}
```

- [ ] **Step 3: Implement the Obsidian view**

Create `src/ui/coAuthor/CoAuthorView.ts`:

```typescript
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { EventBus } from "../../core/events/eventBus";
import { CoAuthorPanelModel, renderCoAuthorPanel } from "./coAuthorRender";

export const VIEW_TYPE_NOTIENT_CO_AUTHOR = "notient-co-author";

export interface CoAuthorViewDeps {
  bus: EventBus;
  onCancel: () => void;
}

export class CoAuthorView extends ItemView {
  private model = new CoAuthorPanelModel();
  private offs: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: CoAuthorViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_CO_AUTHOR;
  }

  getDisplayText(): string {
    return "Notient Co-author";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    const draw = () =>
      renderCoAuthorPanel(root, this.model, {
        onCancel: () => this.deps.onCancel(),
      });
    draw();
    this.offs.push(this.model.subscribe(draw));
    this.offs.push(
      this.deps.bus.on("coAuthor:section", (e) =>
        this.model.appendSection(e.section, e.delta),
      ),
    );
    this.offs.push(
      this.deps.bus.on("coAuthor:done", (e) => this.model.finish(e.ok, e.error)),
    );
    this.offs.push(this.deps.bus.on("coAuthor:cancelled", () => this.model.cancel()));
    this.offs.push(
      this.deps.bus.on("active-leaf-change", (e) => {
        if (e.notePath) this.model.startStream(e.notePath);
        else this.model.reset();
      }),
    );
  }

  async onClose(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/ui/coAuthor/coAuthorRender.test.ts && bun run typecheck && bun run lint`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/coAuthor/coAuthorRender.ts src/ui/coAuthor/coAuthorRender.test.ts src/ui/coAuthor/CoAuthorView.ts
git commit -m "feat(co-author): sidebar panel renders streamed sections with cancel"
```

---

## Task 12: Approvals service + UI

**Files:**
- Create: `src/core/approvals/approvalService.ts`
- Create: `src/core/approvals/approvalService.test.ts`
- Create: `src/ui/approvals/ApprovalsView.ts`
- Modify: `src/core/events/types.ts` (extend with `approval:decided`)

**Why:** Per spec §4.2 every staged edge / staging node only becomes part of the live graph after user approval. ApprovalService promotes (insert into `graph_edges` / `graph_nodes` with `approved=1`) on accept and deletes on reject. The UI lists pending rows.

- [ ] **Step 1: Extend `AppEvent`**

Append to `src/core/events/types.ts`:

```typescript
  | { type: "approval:decided"; kind: "edge" | "node"; id: string; decision: "accepted" | "rejected" }
```

- [ ] **Step 2: Write the failing test**

Create `src/core/approvals/approvalService.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "../db/database";
import { MemoryAdapter, loadWasm } from "../db/database.test";
import { EventBus } from "../events/eventBus";
import { ApprovalService } from "./approvalService";

async function newDb() {
  const adapter = new MemoryAdapter({ "/wasm": loadWasm() });
  const db = new Database(adapter, { dbPath: "/db", wasmPath: "/wasm" });
  await db.init();
  return db;
}

function seedEdge(db: Database) {
  db.run(
    `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
     VALUES (?,?,?,?,?,?,?,?,?);`,
    ["e1", "supports", "note:/a.md", "note:/b.md", 0.84, "linker", JSON.stringify(["c1"]), "r", 1],
  );
}

describe("ApprovalService", () => {
  test("accept promotes a staging_edge into graph_edges with approved=1", async () => {
    const db = await newDb();
    seedEdge(db);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("approval:decided", (e) => events.push(`${e.kind}:${e.id}:${e.decision}`));
    const svc = new ApprovalService({ db, bus });
    await svc.acceptEdge("e1");
    const live = db.query<{ id: string; approved: number; agent: string }>(
      "SELECT id, approved, agent FROM graph_edges;",
    );
    expect(live).toHaveLength(1);
    expect(live[0].approved).toBe(1);
    expect(live[0].agent).toBe("linker");
    const staged = db.query<{ decision: string | null }>(
      "SELECT decision FROM staging_edges WHERE id = ?;",
      ["e1"],
    );
    expect(staged[0].decision).toBe("accepted");
    expect(events).toEqual(["edge:e1:accepted"]);
  });

  test("reject deletes the staging row and emits decided", async () => {
    const db = await newDb();
    seedEdge(db);
    const bus = new EventBus();
    const events: string[] = [];
    bus.on("approval:decided", (e) => events.push(`${e.kind}:${e.id}:${e.decision}`));
    const svc = new ApprovalService({ db, bus });
    await svc.rejectEdge("e1");
    const remaining = db.query<{ id: string }>("SELECT id FROM staging_edges WHERE id = ?;", ["e1"]);
    expect(remaining).toHaveLength(0);
    expect(events).toEqual(["edge:e1:rejected"]);
  });

  test("listPending returns only undecided staging rows", async () => {
    const db = await newDb();
    seedEdge(db);
    db.run(
      `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at, decided_at, decision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
      ["e2", "extends", "note:/c.md", "note:/d.md", 0.7, "linker", JSON.stringify([]), null, 1, 2, "accepted"],
    );
    const svc = new ApprovalService({ db, bus: new EventBus() });
    const pending = svc.listPendingEdges();
    expect(pending.map((p) => p.id)).toEqual(["e1"]);
  });
});
```

- [ ] **Step 3: Implement ApprovalService**

Create `src/core/approvals/approvalService.ts`:

```typescript
import type { Database } from "../db/database";
import type { EventBus } from "../events/eventBus";

export interface ApprovalServiceOptions {
  db: Database;
  bus: EventBus;
}

export interface PendingEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  agent: string;
  evidence: string[];
  rationale: string | null;
  createdAt: number;
}

export class ApprovalService {
  constructor(private readonly opts: ApprovalServiceOptions) {}

  listPendingEdges(): PendingEdge[] {
    const rows = this.opts.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
      rationale: string | null;
      created_at: number;
    }>(
      `SELECT id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at
       FROM staging_edges WHERE decision IS NULL ORDER BY created_at DESC;`,
    );
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      sourceId: r.source_id,
      targetId: r.target_id,
      confidence: r.confidence,
      agent: r.agent,
      evidence: JSON.parse(r.evidence) as string[],
      rationale: r.rationale,
      createdAt: r.created_at,
    }));
  }

  async acceptEdge(id: string): Promise<void> {
    const row = this.opts.db.query<{
      id: string;
      type: string;
      source_id: string;
      target_id: string;
      confidence: number;
      agent: string;
      evidence: string;
    }>("SELECT id, type, source_id, target_id, confidence, agent, evidence FROM staging_edges WHERE id = ? AND decision IS NULL;", [id])[0];
    if (!row) return;
    const liveId = row.id.replace(/^staging:/, "edge:");
    this.opts.db.transaction(() => {
      this.opts.db.run(
        `INSERT INTO graph_edges (id, type, source_id, target_id, confidence, agent, evidence, approved, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          liveId,
          row.type,
          row.source_id,
          row.target_id,
          row.confidence,
          row.agent,
          row.evidence,
          1,
          Date.now(),
        ],
      );
      this.opts.db.run(
        "UPDATE staging_edges SET decision = 'accepted', decided_at = ? WHERE id = ?;",
        [Date.now(), id],
      );
    });
    await this.opts.db.persist();
    this.opts.bus.emit({ type: "approval:decided", kind: "edge", id, decision: "accepted" });
  }

  async rejectEdge(id: string): Promise<void> {
    this.opts.db.run("DELETE FROM staging_edges WHERE id = ?;", [id]);
    await this.opts.db.persist();
    this.opts.bus.emit({ type: "approval:decided", kind: "edge", id, decision: "rejected" });
  }
}
```

- [ ] **Step 4: Implement the Approvals view**

Create `src/ui/approvals/ApprovalsView.ts`:

```typescript
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { ApprovalService, PendingEdge } from "../../core/approvals/approvalService";
import type { EventBus } from "../../core/events/eventBus";

export const VIEW_TYPE_NOTIENT_APPROVALS = "notient-approvals";

export interface ApprovalsViewDeps {
  service: ApprovalService;
  bus: EventBus;
}

export class ApprovalsView extends ItemView {
  private offs: Array<() => void> = [];
  private root: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: ApprovalsViewDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NOTIENT_APPROVALS;
  }

  getDisplayText(): string {
    return "Notient Approvals";
  }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.draw();
    this.offs.push(this.deps.bus.on("approval:decided", () => this.draw()));
    this.offs.push(this.deps.bus.on("agent:run-finished", () => this.draw()));
  }

  async onClose(): Promise<void> {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private draw(): void {
    if (!this.root) return;
    const root = this.root;
    root.empty();
    root.classList.add("notient-approvals");
    const pending = this.deps.service.listPendingEdges();
    if (pending.length === 0) {
      const empty = root.createDiv({ cls: "notient-approvals__empty" });
      empty.setText("No pending proposals.");
      return;
    }
    for (const item of pending) {
      const card = root.createDiv({ cls: "notient-approvals__card" });
      const head = card.createDiv({ cls: "notient-approvals__head" });
      head.createSpan({ text: `${item.agent} • ${item.type} • ${(item.confidence * 100).toFixed(0)}%` });
      const body = card.createDiv({ cls: "notient-approvals__body" });
      body.createDiv({ text: `${item.sourceId} → ${item.targetId}` });
      if (item.rationale) body.createDiv({ text: item.rationale });
      const actions = card.createDiv({ cls: "notient-approvals__actions" });
      const accept = actions.createEl("button", { text: "Accept" });
      accept.addEventListener("click", () => void this.deps.service.acceptEdge(item.id));
      const reject = actions.createEl("button", { text: "Reject" });
      reject.addEventListener("click", () => void this.deps.service.rejectEdge(item.id));
    }
  }
}
```

- [ ] **Step 5: Verify**

Run: `bun test src/core/approvals/approvalService.test.ts && bun run typecheck && bun run lint`
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/approvals/approvalService.ts src/core/approvals/approvalService.test.ts src/ui/approvals/ApprovalsView.ts src/core/events/types.ts
git commit -m "feat(approvals): promote/reject staged proposals with decided event"
```

---

## Task 13: Wire everything into main.ts

**Files:**
- Modify: `src/main.ts`
- Modify: `src/core/kernel.ts`

**Why:** Bring up the Coordinator, idle detector, agents, Co-author service + view, and Approvals service + view. Hook `active-leaf-change` to dispatch Co-author runs through `mutex.runPriority`. Subscribe the idle detector to editor events.

- [ ] **Step 1: Extend the kernel**

In `src/core/kernel.ts`:
- Add to `ServiceRegistry`:
  ```typescript
    coordinator: import("./coordinator/coordinator").Coordinator;
    idleDetector: import("./services/idleDetector").IdleDetector;
    reasoningMutex: import("./coordinator/reasoningMutex").ReasoningMutex;
    approvalService: import("./approvals/approvalService").ApprovalService;
    coAuthor: import("./coAuthor/chatStream").CoAuthorService;
  ```
- Add the same five strings to `REQUIRED_KEYS`.

- [ ] **Step 2: Wire onload()**

Add — inside `onload()` after the existing `health` setup but before `kernel.seal()` — the following block. Adapt to the existing variable names; do not duplicate any existing variable.

```typescript
    const reasoningMutex = new (await import("./core/coordinator/reasoningMutex")).ReasoningMutex();
    const idleDetector = new (await import("./core/services/idleDetector")).IdleDetector(this.bus);

    const linker = new (await import("./core/agents/linker")).Linker({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighborhood: async (notePath, opts) => {
        const head = database.query<{ id: string; vector: Uint8Array; dim: number }>(
          `SELECT e.chunk_id AS id, e.vector AS vector, e.dim AS dim
           FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
           WHERE c.note_path = ? ORDER BY c.ord LIMIT 1;`,
          [notePath],
        );
        if (head.length === 0) return [];
        const view = new Float32Array(head[0].vector.buffer, head[0].vector.byteOffset, head[0].dim);
        const knn = vectorIndex.knn(view, opts.topK);
        const out: Array<{ notePath: string; chunkId: string; text: string; score: number }> = [];
        for (const hit of knn) {
          const meta = database.query<{ note_path: string; text: string }>(
            "SELECT note_path, text FROM chunks WHERE id = ?;",
            [hit.id],
          );
          if (meta.length === 0) continue;
          if (meta[0].note_path === notePath) continue;
          out.push({ notePath: meta[0].note_path, chunkId: hit.id, text: meta[0].text, score: hit.score });
        }
        return out;
      },
    });

    const synthesizer = new (await import("./core/agents/synthesizer")).Synthesizer({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      epsilon: 0.18,
      minClusterSize: 3,
      sinceMs: 24 * 60 * 60 * 1000,
    });

    const contradictionHunter = new (await import("./core/agents/contradictionHunter")).ContradictionHunter({
      db: database,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      neighbors: async (recentClaimIds, opts) => {
        // Use the first claim's chunk as the query; fall back to no neighbors.
        if (recentClaimIds.length === 0) return [];
        const probe = database.query<{ vector: Uint8Array; dim: number; chunk_id: string }>(
          `SELECT e.vector AS vector, e.dim AS dim, e.chunk_id AS chunk_id
           FROM graph_nodes n JOIN chunks c ON c.note_path = n.note_path
           JOIN embeddings e ON e.chunk_id = c.id
           WHERE n.id = ? LIMIT 1;`,
          [recentClaimIds[0]],
        );
        if (probe.length === 0) return [];
        const view = new Float32Array(probe[0].vector.buffer, probe[0].vector.byteOffset, probe[0].dim);
        const knn = vectorIndex.knn(view, opts.topK);
        // Map chunk neighbors back to claim node IDs that live on the same note.
        const out: Array<{ id: string; score: number; chunkIds: string[] }> = [];
        for (const hit of knn) {
          const claim = database.query<{ id: string }>(
            `SELECT id FROM graph_nodes WHERE type = 'claim' AND note_path = (
                SELECT note_path FROM chunks WHERE id = ?
             ) LIMIT 1;`,
            [hit.id],
          );
          if (claim.length === 0) continue;
          if (recentClaimIds.includes(claim[0].id)) continue;
          out.push({ id: claim[0].id, score: hit.score, chunkIds: [hit.id] });
        }
        return out;
      },
      maxPairs: 5,
    });

    const maturityAdvancer = new (await import("./core/agents/maturityAdvancer")).MaturityAdvancer({
      db: database,
      facade,
      echoGuard: this.echoGuard,
      hash: sha256,
    });

    const coordinator = new (await import("./core/coordinator/coordinator")).Coordinator({
      bus: this.bus,
      db: database,
      mutex: reasoningMutex,
      agents: { linker, synthesizer, contradictionHunter, maturityAdvancer },
    });

    const approvalService = new (await import("./core/approvals/approvalService")).ApprovalService({
      db: database,
      bus: this.bus,
    });

    const coAuthor = new (await import("./core/coAuthor/chatStream")).CoAuthorService({
      db: database,
      bus: this.bus,
      provider: primaryLLM,
      reasoningModel: current.primary.reasoningModel,
      readNote: async (path) => facade.read(path),
      neighbors: (path) => {
        const rows = database.query<{ target_id: string }>(
          `SELECT target_id FROM graph_edges WHERE source_id = ? AND approved = 1 LIMIT 10;`,
          [`note:${path}`],
        );
        return rows.map((r) => ({
          path: r.target_id.replace(/^note:/, ""),
          title: r.target_id,
          summary: "",
        }));
      },
      minWords: current.coAuthor.minWords,
    });

    this.kernel.register("reasoningMutex", reasoningMutex);
    this.kernel.register("idleDetector", idleDetector);
    this.kernel.register("coordinator", coordinator);
    this.kernel.register("approvalService", approvalService);
    this.kernel.register("coAuthor", coAuthor);
```

(Move these `register` calls into the existing `kernel.register(...)` block above `kernel.seal()`. Don't seal twice.)

- [ ] **Step 3: Start coordinator + idle detector + active-leaf-change wiring**

After `health.start()`:

```typescript
    coordinator.start();
    idleDetector.start();

    let coAuthorAbort: AbortController | null = null;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        const path = file?.extension === "md" ? file.path : null;
        const wordRow = path
          ? database.query<{ word_count: number }>("SELECT word_count FROM notes WHERE path = ?;", [path])[0]
          : undefined;
        this.bus.emit({
          type: "active-leaf-change",
          notePath: path,
          wordCount: wordRow?.word_count ?? 0,
        });
        if (coAuthorAbort) coAuthorAbort.abort();
        if (!path) return;
        const ctrl = new AbortController();
        coAuthorAbort = ctrl;
        void reasoningMutex.runPriority("co-author", async (signal) => {
          const merged = mergeSignals(signal, ctrl.signal);
          await coAuthor.runFor(path, merged);
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        idleDetector.recordActivity();
      }),
    );
```

Add a small helper `mergeSignals` near the existing top-level `sha256` helper:

```typescript
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const cancel = (): void => ctrl.abort();
  if (a.aborted || b.aborted) ctrl.abort();
  else {
    a.addEventListener("abort", cancel, { once: true });
    b.addEventListener("abort", cancel, { once: true });
  }
  return ctrl.signal;
}
```

- [ ] **Step 4: Register the Approvals + Co-author views and ribbon entries**

After the existing `registerView(VIEW_TYPE_NOTIENT, …)`:

```typescript
    this.registerView(
      (await import("./ui/coAuthor/CoAuthorView")).VIEW_TYPE_NOTIENT_CO_AUTHOR,
      (leaf) =>
        new (require("./ui/coAuthor/CoAuthorView") as typeof import("./ui/coAuthor/CoAuthorView")).CoAuthorView(
          leaf,
          { bus: this.bus, onCancel: () => coAuthorAbort?.abort() },
        ),
    );
    this.registerView(
      (await import("./ui/approvals/ApprovalsView")).VIEW_TYPE_NOTIENT_APPROVALS,
      (leaf) =>
        new (require("./ui/approvals/ApprovalsView") as typeof import("./ui/approvals/ApprovalsView")).ApprovalsView(
          leaf,
          { service: approvalService, bus: this.bus },
        ),
    );
```

(If the `require()`-style imports don't sit well with the existing module style, replace with top-of-file `import` statements; the dynamic-import pattern is shown only because the existing main.ts uses static imports for everything else and the `await import(...)` style avoids reordering.)

- [ ] **Step 5: Stop the new services on unload**

In `onunload()`, before the existing health.stop() / indexer.dispose() block:

```typescript
      try {
        this.kernel.get("coordinator").stop();
      } catch {
        // ignore
      }
      try {
        this.kernel.get("idleDetector").stop();
      } catch {
        // ignore
      }
```

- [ ] **Step 6: Verify the build compiles**

Run: `bun run typecheck && bun run lint && bun test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/core/kernel.ts
git commit -m "feat(swarm): wire coordinator, agents, co-author, approvals into plugin"
```

---

## Task 14: Smoke harness + Phase 3 close-out

**Files:**
- Create: `scripts/smoke-coordinator.ts`
- Modify: `package.json` (add `smoke:coordinator` script)
- Modify: `.planning/STATE.md`

**Why:** Closes Phase 3. The smoke harness drives one cycle of every agent against the live LM Studio endpoint and prints proposal counts. STATE.md is updated to reflect Phase 3 completion. **No git tag.**

- [ ] **Step 1: Write the smoke harness**

Create `scripts/smoke-coordinator.ts`:

```typescript
#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Database } from "../src/core/db/database";
import { EventBus } from "../src/core/events/eventBus";
import { LMStudioProvider } from "../src/core/llm/lmStudioProvider";
import { Linker } from "../src/core/agents/linker";
import { Synthesizer } from "../src/core/agents/synthesizer";
import { ContradictionHunter } from "../src/core/agents/contradictionHunter";
import { MaturityAdvancer } from "../src/core/agents/maturityAdvancer";
import { Coordinator } from "../src/core/coordinator/coordinator";
import { ReasoningMutex } from "../src/core/coordinator/reasoningMutex";
import { EchoGuard } from "../src/core/services/echoGuard";

const VAULT = "/mnt/c/Users/akougk/Projects/vaultex";
const PLUGIN_DIR = `${VAULT}/.obsidian/plugins/notient`;

async function loadAdapter(): Promise<{
  readBinary: (p: string) => Promise<ArrayBuffer | null>;
  writeBinary: (p: string, d: ArrayBuffer) => Promise<void>;
}> {
  await mkdir(PLUGIN_DIR, { recursive: true });
  return {
    readBinary: async (p) => {
      try {
        const buf = await readFile(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      } catch {
        return null;
      }
    },
    writeBinary: async (p, d) => writeFile(p, Buffer.from(d)),
  };
}

async function main() {
  const adapter = await loadAdapter();
  const db = new Database(adapter, {
    dbPath: `${PLUGIN_DIR}/notient.db`,
    wasmPath: `${PLUGIN_DIR}/sql-wasm.wasm`,
  });
  await db.init();

  const bus = new EventBus();
  const provider = new LMStudioProvider({ baseUrl: "http://192.168.86.143:1234/v1" });
  const reasoningModel = "nemotron-cascade-2-30b-a3b-i1";

  const linker = new Linker({
    db,
    provider,
    reasoningModel,
    neighborhood: async () => [],
  });
  const synthesizer = new Synthesizer({
    db,
    provider,
    reasoningModel,
    epsilon: 0.2,
    minClusterSize: 2,
    sinceMs: 0,
  });
  const contradictionHunter = new ContradictionHunter({
    db,
    provider,
    reasoningModel,
    neighbors: async () => [],
    maxPairs: 3,
  });
  const maturityAdvancer = new MaturityAdvancer({
    db,
    facade: {
      read: async (path) => readFile(`${VAULT}/${path}`, "utf8"),
      write: async (path, body) => writeFile(`${VAULT}/${path}`, body, "utf8"),
    },
    echoGuard: new EchoGuard(),
    hash: async (s) => {
      const b = new TextEncoder().encode(s);
      const h = await crypto.subtle.digest("SHA-256", b);
      return Array.from(new Uint8Array(h)).map((x) => x.toString(16).padStart(2, "0")).join("");
    },
  });

  const coord = new Coordinator({
    bus,
    db,
    mutex: new ReasoningMutex(),
    agents: { linker, synthesizer, contradictionHunter, maturityAdvancer },
  });

  const tally = { linker: 0, synthesizer: 0, contradictionHunter: 0, maturityAdvancer: 0 };
  bus.on("agent:run-finished", (e) => {
    tally[e.agent as keyof typeof tally] += e.proposals;
    console.log(`[smoke] ${e.agent} ok=${e.ok} proposals=${e.proposals} ${e.durationMs}ms${e.error ? " " + e.error : ""}`);
  });

  coord.start();
  // Trigger every agent path.
  bus.emit({ type: "vault:note-saved", path: pickFirstNote(db), sha: "smoke" });
  bus.emit({ type: "user:idle", level: "5m" });
  bus.emit({ type: "user:idle", level: "30m" });
  await coord.idle();
  coord.stop();
  await db.persist();
  console.log("[smoke] tally", tally);
  if (tally.linker + tally.synthesizer + tally.contradictionHunter + tally.maturityAdvancer === 0) {
    console.error("[smoke] no proposals; failing");
    process.exit(1);
  }
}

function pickFirstNote(db: Database): string {
  const rows = db.query<{ path: string }>(
    "SELECT path FROM notes WHERE word_count >= 100 ORDER BY updated_at DESC LIMIT 1;",
  );
  return rows[0]?.path ?? "";
}

await main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `scripts`, alongside `smoke:indexer`:

```json
    "smoke:coordinator": "bun scripts/smoke-coordinator.ts",
```

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && bun test`
Expected: green; ~30+ new tests on top of the Phase 2.5 baseline of 104 (target ~135 total).

Run (only when dynamo is up): `bun run smoke:coordinator`
Expected: at least one of the four counters is non-zero on the test vault. Copy the printed `tally` line into the STATE update below.

- [ ] **Step 4: Update STATE.md**

Replace `.planning/STATE.md` with:

```markdown
# Notient Project State

**Version:** 0.2.0 (no git tag — tags reserved for v1.0.0 release)
**Current phase:** Phase 3 (Swarm) — COMPLETE
**Date completed:** <fill in>
**Next phase:** Phase 4 (Stream)
**AI substrate:** dynamo (`192.168.86.143:1234`, LM Studio, primary) + mini (`192.168.86.141:8080`, llama-server, deep)
**Test vault:** `/mnt/c/Users/akougk/Projects/vaultex/` (894 markdown notes, PARA structure)

## What works (verified by tests + smoke run)

- Everything from Phase 2.5, plus:
- Schema v2: `staging_edges`, `staging_nodes`, `agent_runs` with v1 → v2 migration path.
- Single-flight reasoning mutex with priority preemption (Co-author beats agents).
- IdleDetector emitting 30s / 5m / 30m levels with re-armable activity reset.
- Coordinator dispatching Linker (vault-save + idle-30s), Synthesizer + ContradictionHunter (idle-5m), MaturityAdvancer (idle-30m), and all four (user "Deepen" action).
- Linker, Synthesizer, ContradictionHunter all using `chatJson<T>` against nemotron-cascade-2-30b-a3b-i1.
- MaturityAdvancer the only frontmatter-writing agent; calls `EchoGuard.mark()` before every write so the indexer skips its self-write.
- DBSCAN-cosine cluster detector for the Synthesizer, in-house, no new dep.
- Continuous Co-author panel: streams SUMMARY / IMPLIES / CONNECTS sections from `chatStream`, voice-mimicry context from top mature notes, cancels on note switch via `mutex.runPriority`.
- Approvals UI promotes staged edges to `graph_edges` with `approved=1`; reject deletes the staged row.
- All structured-output agents go through `provider.chatJson<T>()` and the reasoning_content fallback (commit 6b8b10b) ensures nemotron output reaches the parser.

## DoD (spec §13 row 3)

- [ ] Open any note → Co-author streams its first token in <2s (manual smoke)
- [ ] Linker / Synthesizer / Contradiction Hunter / Maturity Advancer all produce ≥1 real proposal in one session (`bun run smoke:coordinator` tally line)
- [ ] Approvals UI accept promotes a staged edge to live (manual smoke)

(Tick during the Phase 3 close-out smoke run.)

## Tech debt to address opportunistically

- Co-author header detection is a regex over deltas; brittle if the model emits `# SUMMARY` or `### Summary`. Phase 4 should harden this with a stricter prompt + post-stream validator.
- Synthesizer cluster threshold (`epsilon`, `minClusterSize`) is a static tuning. Phase 4 should expose these in settings.
- Approvals UI is list-only; no graph-view promotion preview. Acceptable for v1.0; Phase 4 polishes.
- IdleDetector is wall-clock based. If the user puts the laptop to sleep, the next `tick` may fire all three levels at once. Acceptable for v1.0.
- Maturity Advancer's freshness signal is a placeholder constant of 1.0. Phase 4 Vitals work needs a real decay function.

## What does not exist yet

- The Stream (sidebar feed) + editor decorations + Vitals panel + Graph view overlay (Phase 4)
- Chat MVP + multi-strategy search MVP (Phase 4)
- Universal undo via SQLite history (Phase 4)
- Hardening + telemetry + docs site + notient.com landing (Phase 5)

## How to resume in next session (Phase 4 — Stream)

1. Read this file + spec §9 (Surfacing UI) + spec §13 row 4.
2. Phase 4 deliverables:
   - The Stream tab — feed of agent insights ranked by `confidence × recency × relevance(active_note)`
   - CodeMirror editor decorations at paragraph boundaries
   - Vitals panel (per-note health/maturity/connectivity/freshness)
   - Graph view overlay
   - Chat MVP (3 commands: /find, /synthesize, /explain)
   - Multi-strategy search MVP (Quick + Balanced)
   - Universal undo (history table)
3. Same workflow: `superpowers:writing-plans` → `superpowers:subagent-driven-development` (Opus 4.7 implementers only).
```

- [ ] **Step 5: Commit STATE update (no tag)**

```bash
git add scripts/smoke-coordinator.ts package.json .planning/STATE.md
git commit -m "docs(state): Phase 3 (Swarm) complete + smoke:coordinator harness"
```

- [ ] **Step 6: Confirm no tag was created**

```bash
git tag --list | grep -E '^v1' || echo "no v1 tags (expected)"
```

Expected output: `no v1 tags (expected)`. Phase 3 deliberately does not tag.

---

## End of Phase 3 plan

Total: 14 numbered tasks (Task 0 = schema migration, Tasks 1–14 cover mutex, idle detector, coordinator, four agents, DBSCAN, voice context, co-author stream, co-author UI, approvals service + UI, main.ts wiring, smoke + close-out). Each task is committable and tested in isolation. Estimated test count after Phase 3: ~135 (Phase 2.5 baseline of 104 + Schema (4) + Mutex (4) + Idle (3) + Coordinator (7) + Linker (3) + DBSCAN (2) + Synthesizer (2) + ContradictionHunter (2) + MaturityAdvancer (3) + Voice (2) + ChatStream (3) + CoAuthorRender (4) + Approvals (3) ≈ 42 new = ~146 total).

After Task 14, the next session's first action is to read `.planning/STATE.md` and invoke `superpowers:writing-plans` for Phase 4 (Stream).
