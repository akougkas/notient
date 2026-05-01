/**
 * Vault chat-tool tests.
 *
 * `vault.search_notes`, `vault.read_note`, `vault.get_vitals`, and the
 * registry integration test are pure (no database). The
 * `vault.list_neighbors` tool reads the SurrealDB substrate and lives
 * behind the smoke harness, run with `bun run test:smoke`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolValidationError } from "../../../../../src/core/chat/tools/registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "../../../../../src/core/chat/tools/vault";
import { applySchema } from "../../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  upsertNoteByPath,
} from "../../../../../src/core/db/surreal";
import type { SearchPipeline } from "../../../../../src/core/search/searchPipeline";
import type { SearchEvent, SearchHit, SearchQuery } from "../../../../../src/core/search/types";
import type { VitalsSnapshot } from "../../../../../src/core/vitals/types";
import type { VitalsService } from "../../../../../src/core/vitals/vitalsService";
import { type SurrealServerHandle, startSurreal } from "../../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

class FakePipeline {
  readonly calls: { query: SearchQuery; signal: AbortSignal }[] = [];
  constructor(private readonly events: SearchEvent[]) {}
  async *run(query: SearchQuery, signal: AbortSignal): AsyncIterable<SearchEvent> {
    this.calls.push({ query, signal });
    for (const event of this.events) yield event;
  }
}

function asPipeline(fake: FakePipeline): SearchPipeline {
  return fake as unknown as SearchPipeline;
}

class InMemoryFacade implements VaultFacade {
  constructor(private readonly files: Map<string, string>) {}
  async readNote(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw new Error(`not found: ${filePath}`);
    return value;
  }
}

describe.skipIf(!SMOKE_ENABLED)("[smoke] vault.list_neighbors", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase5-vault-list-neighbors-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-vault-neighbors-smoke-"));
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
    for (const table of [
      "supports",
      "contradicts",
      "extends",
      "exemplifies",
      "synthesizes",
      "related_to",
      "wikilink",
      "note",
    ]) {
      await connection.db.query(`DELETE ${table};`).collect();
    }
  });

  test("returns approved-and-applied neighbors with direction", async () => {
    const aId = await upsertNoteByPath(connection.db, {
      path: "a.md",
      sha: "sha-a",
      wordCount: 5,
    });
    const bId = await upsertNoteByPath(connection.db, {
      path: "b.md",
      sha: "sha-b",
      wordCount: 5,
    });
    const cId = await upsertNoteByPath(connection.db, {
      path: "c.md",
      sha: "sha-c",
      wordCount: 5,
    });
    const dId = await upsertNoteByPath(connection.db, {
      path: "d.md",
      sha: "sha-d",
      wordCount: 5,
    });
    await relateEdge(connection.db, {
      table: "supports",
      from: aId,
      to: bId,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.9,
      agent: "linker",
      approved: true,
    });
    await relateEdge(connection.db, {
      table: "extends",
      from: cId,
      to: aId,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.8,
      agent: "linker",
      approved: true,
    });
    // Pending proposal must not appear in neighbors.
    await relateEdge(connection.db, {
      table: "contradicts",
      from: aId,
      to: dId,
      source: "linker",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "linker",
      approved: false,
    });
    const tool = makeListNeighborsTool(connection.db);
    const result = await tool.invoke({ notePath: "a.md" }, new AbortController().signal);
    const sorted = result.neighbors.sort((x, y) => x.notePath.localeCompare(y.notePath));
    expect(sorted).toEqual([
      {
        notePath: "b.md",
        type: "supports",
        agent: "linker",
        confidence: 0.9,
        direction: "outgoing",
      },
      {
        notePath: "c.md",
        type: "extends",
        agent: "linker",
        confidence: 0.8,
        direction: "incoming",
      },
    ]);
  });
});
