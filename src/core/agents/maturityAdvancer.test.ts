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
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { applySchema } from "../db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../db/surreal";
import { EventBus } from "../events/eventBus";
import { MaturityAdvancer } from "./maturityAdvancer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

class FakeFacade {
  files = new Map<string, string>();
  marks: string[] = [];
  async read(filePath: string): Promise<string> {
    return this.files.get(filePath) ?? "";
  }
  async write(filePath: string, body: string): Promise<void> {
    this.files.set(filePath, body);
    this.marks.push(`wrote:${filePath}`);
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
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret);
  });

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
  });

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
    const ma = new MaturityAdvancer({ db: connection.db, facade });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
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
    const ma = new MaturityAdvancer({ db: connection.db, facade });
    const result = await ma.run({
      trigger: "idle-30m",
      notePath: null,
      signal: new AbortController().signal,
      runId: 1,
      bus: new EventBus(),
    });
    expect(result.proposals).toBe(0);
  });
});
