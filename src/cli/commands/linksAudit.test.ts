/**
 * Phase 5 Task 9 links audit CLI smoke harness.
 *
 * Skipped by default. Run with `NOTIENT_SMOKE=1 bun test src/cli/commands/linksAudit.test.ts`.
 *
 * Seeds an unresolved wikilink, an unresolved embed, and an orphan tag,
 * then asserts the audit emits one NDJSON line per finding.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySchema } from "../../core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  insertUnresolvedEdge,
  upsertNoteByPath,
  upsertTag,
} from "../../core/db/surreal";
import { vaultPortPath, vaultSecretPath, vaultStateDir } from "../../core/vault/identity";
import { type SurrealServerHandle, startSurreal } from "../../daemon/surrealServer";
import { makeEmitter } from "../output";
import { runLinksAuditCommand } from "./linksAudit";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

interface AuditFindingShape {
  kind: "unresolved-wikilink" | "unresolved-embed" | "orphan-tag";
  id: string;
  details: Record<string, unknown>;
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] links audit CLI", () => {
  let tempDir: string;
  let homeOverride: string;
  let originalHome: string | undefined;
  let vaultPath: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-task9-linksaudit-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-linksaudit-cli-"));
    homeOverride = path.join(tempDir, "home");
    await mkdir(homeOverride, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = homeOverride;

    vaultPath = path.join(tempDir, "vault");
    await mkdir(vaultPath, { recursive: true });

    handle = await startSurreal({
      dataDir: path.join(tempDir, "surreal-data"),
      secret,
      portFile: path.join(tempDir, "surreal.port"),
      pidFile: path.join(tempDir, "surreal.pid"),
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

    const stateDir = vaultStateDir(vaultPath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const port = new URL(handle.url).port;
    await writeFile(vaultPortPath(vaultPath), port, "utf8");
    await writeFile(vaultSecretPath(vaultPath), secret, { mode: 0o600 });
  });

  afterAll(async () => {
    if (connection !== undefined) await connection.close().catch(() => {});
    if (handle !== undefined) await handle.stop().catch(() => {});
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    const tables = ["wikilink_unresolved", "embed_unresolved", "tagged", "note", "tag"];
    for (const table of tables) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("[smoke] empty vault emits zero NDJSON rows", async () => {
    const lines: string[] = [];
    const exitCode = await runLinksAuditCommand({
      vaultPath,
      mode: "ndjson",
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines.length).toBe(0);
  });

  test("[smoke] empty vault in pretty mode emits the empty marker", async () => {
    const lines: string[] = [];
    const exitCode = await runLinksAuditCommand({
      vaultPath,
      mode: "pretty",
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines).toEqual(["links:audit:empty"]);
  });

  test("[smoke] populated vault reports unresolved wikilink, embed, and orphan tag", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    await insertUnresolvedEdge(connection.db, {
      kind: "wikilink",
      from: noteId,
      rawTarget: "missing-target",
      source: "wikilink",
    });
    await insertUnresolvedEdge(connection.db, {
      kind: "embed",
      from: noteId,
      rawTarget: "missing-embed",
      source: "embed",
    });
    // Orphan tag: created but no `tagged` edge points at it.
    await upsertTag(connection.db, "orphan");

    const lines: string[] = [];
    const exitCode = await runLinksAuditCommand({
      vaultPath,
      mode: "ndjson",
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines.length).toBe(3);

    const findings = lines.map((line) => JSON.parse(line) as AuditFindingShape);
    const kinds = findings.map((row) => row.kind).sort();
    expect(kinds).toEqual(["orphan-tag", "unresolved-embed", "unresolved-wikilink"]);
  });

  test("[smoke] json mode emits a single array", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "alpha.md",
      sha: "sha-alpha",
      wordCount: 5,
    });
    await insertUnresolvedEdge(connection.db, {
      kind: "wikilink",
      from: noteId,
      rawTarget: "missing-target",
      source: "wikilink",
    });

    const lines: string[] = [];
    const exitCode = await runLinksAuditCommand({
      vaultPath,
      mode: "json",
      emitter: makeEmitter({ mode: "json", write: () => {} }),
      writeStdout: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "") as AuditFindingShape[];
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.kind).toBe("unresolved-wikilink");
  });
});

describe("links audit module shape", () => {
  test("module exports the run function", () => {
    expect(typeof runLinksAuditCommand).toBe("function");
  });
});
