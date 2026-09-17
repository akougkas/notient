/**
 * Phase 4 Task 12 AgentEventStore smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/services/`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes
 * the `agent_event` table added by Task 12), and exercises the
 * record/since/latestId/countSince/dispose surface end-to-end. Each test
 * truncates the table in `afterEach` so ordering assertions stay
 * independent.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringRecordId } from "surrealdb";
import { defaultPipelinePolicy } from "../../../../src/api/background";
import type { PipelineJob } from "../../../../src/api/pipelines";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect } from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { JobStore, stableJobId } from "../../../../src/core/pipelines/jobStore";
import { AgentEventStore } from "../../../../src/core/services/agentEventStore";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000007"';

async function clearLedger(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE agent_event;").collect();
}

async function flush(): Promise<void> {
  // Bus subscribers fire-and-forget the SurrealDB write because EventBus.emit
  // is synchronous; tests that observe the resulting row through `since`
  // need to yield twice (once to drain microtasks for the Surreal SDK
  // promise, once to absorb the trailing post-resolution work).
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] AgentEventStore", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase4-agentevent-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-agentevent-smoke-"));
    handle = await startSurreal({
      dataDir: path.join(tempDir, "data"),
      secret,
      portFile: path.join(tempDir, "port"),
      pidFile: path.join(tempDir, "pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, { embedDim: 768, embedModel: "fixture-embedding" });
  }, 30_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await connection.close().catch(() => {});
    }
    if (handle !== undefined) {
      await handle.stop().catch(() => {});
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  afterEach(async () => {
    await clearLedger(connection);
  });

  test("[smoke] record persists a row and returns id + ts", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const before = Date.now();
    const result = await store.record("swarm:link_proposed", {
      edgeId: "edge:a",
      confidence: 0.9,
    });
    expect(result.id).toStartWith("agent_event:");
    expect(result.ts).toBeGreaterThanOrEqual(before);
    const rows = await store.since(null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.id);
    expect(rows[0].type).toBe("swarm:link_proposed");
    store.dispose();
  });

  test("[smoke] schema rejects unsupported event kinds", async () => {
    const create = connection.db
      .query(
        `CREATE ONLY agent_event:u"0198f4f0-1234-7000-8000-000000000002" CONTENT {
          kind: 'swarm:imagined',
          payload: { data: {} },
          ts_ms: 1800000000000
        };`,
      )
      .collect();
    await expect(create).rejects.toThrow();
  });

  test("durable job state preserves reserved usage and rejects stale controls", async () => {
    const store = new JobStore(connection.db);
    const at = Date.now();
    const input: PipelineJob = {
      id: stableJobId("human", `test-${at}`),
      revision: "0".repeat(64),
      pipeline: "enrich",
      state: "queued",
      caller: { id: "human", kind: "human", scopes: ["read", "write"] },
      background: false,
      preview: false,
      reason: "integration test",
      createdAt: at,
      updatedAt: at,
      sourceRevisions: [],
      configurationRevision: "a".repeat(64),
      policy: defaultPipelinePolicy("enrich"),
      attempts: [],
      runAttempts: 0,
      activeDurationMs: 0,
      stage: "queued",
      progress: { completed: 0, total: 0 },
      plan: null,
      previewId: null,
      previewRevision: null,
      proposalIds: [],
      effects: null,
      failure: null,
      nextAttemptAt: null,
    };
    const created = await store.create(input);
    const running = await store.update(
      created.id,
      (job) => {
        job.state = "running";
        job.attempts.push({
          sequence: 1,
          inputTokenEstimate: 100,
          generationCeiling: 8192,
          chargedTokens: 8292,
          accounting: "reserved-estimate",
          completion: null,
        });
      },
      created.revision,
    );
    expect(running.revision).not.toBe(created.revision);
    await expect(
      store.update(
        created.id,
        (job) => {
          job.state = "cancelled";
        },
        created.revision,
      ),
    ).rejects.toThrow("changed");
    const restarted = new JobStore(connection.db);
    expect(await restarted.get(created.id)).toEqual(running);
    await connection.db.query("DELETE pipeline_job;").collect();
  });

  test("resumes concurrent writes across restart and rejects expired cursors", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 3 });
    const written = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        store.record("indexer:note-indexed", { path: `${index}.md` }),
      ),
    );
    expect((await store.resume(written[0].id, 100)).map((event) => event.id)).toEqual(
      written.slice(1).map((entry) => entry.id),
    );
    store.dispose();
    await store.drain();
    const restarted = new AgentEventStore({ db: connection.db, bus, maxRows: 3 });
    const next = await restarted.record("indexer:note-indexed", { path: "next.md" });
    expect(next.id > written[2].id).toBe(true);
    expect((await restarted.resume(written[2].id, 100)).map((event) => event.id)).toEqual([
      next.id,
    ]);
    await expect(restarted.resume(written[0].id, 100)).rejects.toThrow("expired");
    restarted.dispose();
    await restarted.drain();
  });

  test("[smoke] since returns rows with id strictly greater than cursor", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const a = await store.record("swarm:link_proposed", { tag: "a" });
    const b = await store.record("swarm:link_proposed", { tag: "b" });
    const c = await store.record("swarm:link_proposed", { tag: "c" });
    const after = await store.since(a.id, 10);
    expect(after.map((row) => row.id)).toEqual([b.id, c.id]);
    const fromB = await store.since(b.id, 10);
    expect(fromB.map((row) => row.id)).toEqual([c.id]);
    store.dispose();
  });

  test("[smoke] since respects the limit and returns ascending order", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    for (let index = 0; index < 5; index++) {
      await store.record("swarm:link_proposed", { index });
    }
    const rows = await store.since(null, 3);
    expect(rows).toHaveLength(3);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index].id.localeCompare(rows[index - 1].id)).toBeGreaterThan(0);
    }
    store.dispose();
  });

  test("[smoke] snapshot returns newest matching window rows and a global cursor", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const old = await store.record("swarm:link_proposed", { tag: "old" });
    await connection.db
      .query("UPDATE $id SET ts_ms = $oldTs;", {
        id: new StringRecordId(old.id),
        oldTs: Date.now() - 2 * 60 * 60 * 1000,
      })
      .collect();
    await store.record("swarm:link_proposed", { tag: "recent-a" });
    const newestMatch = await store.record("swarm:link_proposed", { tag: "recent-b" });
    const globalLatest = await store.record("indexer:note-indexed", { path: "x.md" });

    const snapshot = await store.snapshot(Date.now() - 60 * 60 * 1000, ["swarm:link_proposed"], 1);

    expect(snapshot.events.map((event) => event.id)).toEqual([newestMatch.id]);
    expect(snapshot.events[0]?.payload).toEqual({ tag: "recent-b" });
    expect(snapshot.cursor).toBe(globalLatest.id);
    store.dispose();
  });

  test("[smoke] since returns native structured payloads", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const payload = { edgeId: "edge:42", members: ["a", "b"], score: 0.77 };
    await store.record("swarm:link_proposed", payload);
    const rows = await store.since(null, 1);
    expect(rows[0].payload).toEqual(payload);
    store.dispose();
  });

  test("[smoke] latestId returns null when empty and the newest record id after rows", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    expect(await store.latestId()).toBeNull();
    const first = await store.record("swarm:link_proposed", {});
    const second = await store.record("swarm:link_proposed", {});
    expect(await store.latestId()).toBe(second.id);
    expect((await store.latestId())?.localeCompare(first.id)).toBeGreaterThan(0);
    store.dispose();
  });

  test("[smoke] countSince returns the count of rows after the cursor", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    expect(await store.countSince(null)).toBe(0);
    const a = await store.record("swarm:link_proposed", {});
    await store.record("swarm:link_proposed", {});
    await store.record("swarm:link_proposed", {});
    expect(await store.countSince(null)).toBe(3);
    expect(await store.countSince(a.id)).toBe(2);
    expect(await store.countSince(await store.latestId())).toBe(0);
    store.dispose();
  });

  test("[smoke] emits a row when swarm:contradiction_discovered fires on the bus", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    const payload = {
      type: "swarm:contradiction_discovered" as const,
      pair: ["claim:a", "claim:b"] as [string, string],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"] as [string, string],
      runId: AGENT_RUN_ID,
    };
    bus.emit(payload);
    await flush();
    const rows = await store.since(null, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("swarm:contradiction_discovered");
    expect(rows[0].payload).toEqual({
      pair: ["claim:a", "claim:b"],
      severity: 0.82,
      notePaths: ["/a.md", "/b.md"],
      runId: AGENT_RUN_ID,
    });
    store.dispose();
  });

  test("[smoke] subscribes to every produced swarm:* event type", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: AGENT_RUN_ID,
    });
    await flush();
    bus.emit({
      type: "swarm:contradiction_discovered",
      pair: ["a", "b"],
      severity: 0.9,
      notePaths: ["/a", "/b"],
      runId: AGENT_RUN_ID,
    });
    await flush();
    bus.emit({
      type: "swarm:claim_advanced",
      claimId: "claim:1",
      notePath: "/n.md",
      fromMaturity: "raw",
      toMaturity: "adolescent",
      runId: AGENT_RUN_ID,
    });
    await flush();
    const rows = await store.since(null, 10);
    expect(rows.map((row) => row.type)).toEqual([
      "swarm:link_proposed",
      "swarm:contradiction_discovered",
      "swarm:claim_advanced",
    ]);
    store.dispose();
  });

  test("[smoke] subscribes to indexer:note-indexed, indexer:error, indexer:warn", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    bus.emit({
      type: "indexer:note-indexed",
      path: "01-introduction.md",
      result: {
        chunkCount: 3,
        embedCount: 3,
        durationMs: 12,
        llmCalls: 1,
        extractionWindows: 1,
      },
    });
    await flush();
    bus.emit({
      type: "indexer:error",
      path: "01-introduction.md",
      message: "tier2 failed",
      phase: "tier2",
    });
    await flush();
    bus.emit({ type: "indexer:warn", message: "ref dropped", phase: "tier1" });
    await flush();
    const rows = await store.since(null, 10);
    expect(rows.map((row) => row.type)).toEqual([
      "indexer:note-indexed",
      "indexer:error",
      "indexer:warn",
    ]);
    store.dispose();
  });

  test("[smoke] does not subscribe to indexer:tier1-done, tier2-done, tier3-done, progress", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    bus.emit({ type: "indexer:tier1-done", path: "x.md", bodySha: "deadbeef" });
    await flush();
    bus.emit({ type: "indexer:tier2-done", path: "x.md", chunkCount: 2 });
    await flush();
    bus.emit({ type: "indexer:tier3-done", path: "x.md" });
    await flush();
    bus.emit({ type: "indexer:progress", processed: 1, total: 10 });
    await flush();
    expect(await store.countSince(null)).toBe(0);
    store.dispose();
  });

  test("[smoke] maxRows caps the ledger via per-write sweep past the cap", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 5 });
    const createdIds: string[] = [];
    for (let index = 0; index < 12; index++) {
      createdIds.push((await store.record("swarm:link_proposed", { index })).id);
    }
    const count = await store.countSince(null);
    expect(count).toBe(5);
    const latest = await store.latestId();
    expect(latest).toBe(createdIds.at(-1) ?? null);
    const rows = await store.since(null, 100);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.id)).toEqual(createdIds.slice(-5));
    store.dispose();
  });

  test("[smoke] dispose detaches listeners so further events do not produce rows", async () => {
    const bus = new EventBus();
    const store = new AgentEventStore({ db: connection.db, bus, maxRows: 50_000 });
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e1",
      sourceId: "n1",
      targetId: "n2",
      edgeType: "supports",
      confidence: 0.7,
      runId: AGENT_RUN_ID,
    });
    await flush();
    expect(await store.countSince(null)).toBe(1);
    store.dispose();
    bus.emit({
      type: "swarm:link_proposed",
      edgeId: "e2",
      sourceId: "n1",
      targetId: "n3",
      edgeType: "supports",
      confidence: 0.7,
      runId: AGENT_RUN_ID,
    });
    await flush();
    expect(await store.countSince(null)).toBe(1);
  });
});
