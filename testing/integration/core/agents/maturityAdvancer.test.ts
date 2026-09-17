/**
 * Phase 5 Task 5 MaturityAdvancer smoke harness.
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1)
 * or directly via `NOTIENT_SMOKE=1 bun test src/core/agents/maturityAdvancer.test.ts`.
 *
 * Boots a real SurrealDB, applies the Phase 1 schema (which now includes
 * `note.maturity`, `note.health`, and `note.freshness` added in Phase 5
 * Task 5), and exercises MaturityAdvancer end-to-end against the live
 * database. Each test truncates the entity tables in `afterEach` so seeded
 * rows do not leak between cases.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DateTime, type RecordId } from "surrealdb";
import {
  MAX_PROMOTIONS_PER_TICK,
  MaturityAdvancer,
} from "../../../../src/core/agents/maturityAdvancer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const AGENT_RUN_ID = 'agent_run:u"00000000-0000-4000-8000-000000000001"';

class FakeFacade {
  files = new Map<string, string>();
  marks: string[] = [];
  async read(filePath: string): Promise<string> {
    return this.files.get(filePath) ?? "";
  }
  async writeIfUnchanged(filePath: string, expected: string, body: string): Promise<boolean> {
    if (this.files.get(filePath) !== expected) return false;
    this.files.set(filePath, body);
    this.marks.push(`wrote:${filePath}`);
    return true;
  }
}

interface SeedNoteInput {
  path: string;
  words: number;
  maturity: string;
  lastUserEditAtMs?: number;
}

async function seedNote(
  connection: SurrealConnection,
  input: SeedNoteInput,
): Promise<RecordId<"note">> {
  const id = await upsertNoteByPath(connection.db, {
    path: input.path,
    sha: "x",
    wordCount: input.words,
  });
  const setClauses: string[] = ["maturity = $maturity"];
  const bindings: Record<string, unknown> = { id, maturity: input.maturity };
  if (input.lastUserEditAtMs !== undefined) {
    setClauses.push("last_user_edit_at = $when");
    bindings.when = new DateTime(new Date(input.lastUserEditAtMs));
  }
  await connection.db.query(`UPDATE $id SET ${setClauses.join(", ")};`, bindings).collect();
  return id;
}

async function clearVault(connection: SurrealConnection): Promise<void> {
  await connection.db.query("DELETE wikilink;").collect();
  await connection.db.query("DELETE chunk;").collect();
  await connection.db.query("DELETE block;").collect();
  await connection.db.query("DELETE note;").collect();
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] MaturityAdvancer", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-maturity-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-maturity-smoke-"));
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
    await clearVault(connection);
  });

  test("[smoke] promotes raw -> adolescent on first edit", async () => {
    const now = Date.now();
    await seedNote(connection, {
      path: "a.md",
      words: 50,
      maturity: "raw",
      lastUserEditAtMs: now,
    });
    const facade = new FakeFacade();
    facade.files.set("a.md", "# A\nSome content.\n");
    const ma = new MaturityAdvancer({
      db: connection.db,
      facade,
      settings: () => ({ writeToFrontmatter: true }),
    });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    interface MaturityRow {
      maturity: string;
    }
    const [rows] = await connection.db
      .query<[MaturityRow[]]>("SELECT maturity FROM note WHERE path = $path LIMIT 1;", {
        path: "a.md",
      })
      .collect<[MaturityRow[]]>();
    expect(rows[0].maturity).toBe("adolescent");
    expect(facade.files.get("a.md")).toContain("notient:");
    expect(facade.files.get("a.md")).toContain("maturity: adolescent");
  });

  test("[smoke] does not promote a note that does not meet criteria", async () => {
    const now = Date.now();
    await seedNote(connection, {
      path: "a.md",
      words: 5,
      maturity: "adolescent",
      lastUserEditAtMs: now,
    });
    const facade = new FakeFacade();
    facade.files.set("a.md", "# A\n");
    const ma = new MaturityAdvancer({
      db: connection.db,
      facade,
      settings: () => ({ writeToFrontmatter: false }),
    });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });

  test("[smoke] promotes in the DB without touching the vault when writeback is disabled", async () => {
    await seedNote(connection, {
      path: "a.md",
      words: 50,
      maturity: "raw",
      lastUserEditAtMs: Date.now(),
    });
    const facade = new FakeFacade();
    facade.files.set("a.md", "# A\nSome content.\n");
    const ma = new MaturityAdvancer({
      db: connection.db,
      facade,
      settings: () => ({ writeToFrontmatter: false }),
    });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(1);
    expect(facade.marks).toEqual([]);
    expect(facade.files.get("a.md")).toBe("# A\nSome content.\n");
    interface MaturityRow {
      maturity: string;
    }
    const [rows] = await connection.db
      .query<[MaturityRow[]]>("SELECT maturity FROM note WHERE path = $path LIMIT 1;", {
        path: "a.md",
      })
      .collect<[MaturityRow[]]>();
    expect(rows[0].maturity).toBe("adolescent");
  });

  test("[smoke] counts approved wikilinks in SQL and promotes mature -> synthesis-ready", async () => {
    const hub = await seedNote(connection, {
      path: "hub.md",
      words: 500,
      maturity: "mature",
      lastUserEditAtMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    for (let index = 0; index < 10; index += 1) {
      const target = await seedNote(connection, {
        path: `out${index}.md`,
        words: 10,
        maturity: "adolescent",
      });
      await relateEdge(connection.db, {
        table: "wikilink",
        from: hub,
        to: target,
        source: "wikilink",
        confidenceClass: "EXTRACTED",
        confidence: 1,
        approved: true,
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const source = await seedNote(connection, {
        path: `in${index}.md`,
        words: 10,
        maturity: "adolescent",
      });
      await relateEdge(connection.db, {
        table: "wikilink",
        from: source,
        to: hub,
        source: "wikilink",
        confidenceClass: "EXTRACTED",
        confidence: 1,
        approved: true,
      });
    }
    const facade = new FakeFacade();
    const ma = new MaturityAdvancer({
      db: connection.db,
      facade,
      settings: () => ({ writeToFrontmatter: false }),
    });
    await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    interface MaturityRow {
      maturity: string;
    }
    const [rows] = await connection.db
      .query<[MaturityRow[]]>("SELECT maturity FROM note WHERE path = $path LIMIT 1;", {
        path: "hub.md",
      })
      .collect<[MaturityRow[]]>();
    expect(rows[0].maturity).toBe("synthesis-ready");
  });

  test("[smoke] caps promotions per tick", async () => {
    for (let index = 0; index < MAX_PROMOTIONS_PER_TICK + 5; index += 1) {
      await seedNote(connection, {
        path: `n${index}.md`,
        words: 10,
        maturity: "raw",
        lastUserEditAtMs: Date.now(),
      });
    }
    const facade = new FakeFacade();
    const ma = new MaturityAdvancer({
      db: connection.db,
      facade,
      settings: () => ({ writeToFrontmatter: false }),
    });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: AGENT_RUN_ID,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(MAX_PROMOTIONS_PER_TICK);
  });
});
