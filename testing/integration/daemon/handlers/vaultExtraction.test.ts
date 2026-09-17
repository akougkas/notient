import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsVault } from "../../../../src/adapters/fsVault";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  connect,
  relateEdge,
  replaceChunks,
  upsertConcept,
  upsertNoteByPath,
} from "../../../../src/core/db/surreal";
import { sha256Hex } from "../../../../src/core/utils/sha256";
import { collectExtraction } from "../../../../src/daemon/handlers/vaultExtraction";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";
const IDENTITY = { model: "vault-extraction-test", dimension: 3 } as const;

describe.skipIf(!SMOKE_ENABLED)("[smoke] vault.extraction containment", () => {
  let root: string;
  let vaultRoot: string;
  let connection: SurrealConnection;
  let server: SurrealServerHandle;
  let vault: FsVault;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "notient-vault-extraction-"));
    vaultRoot = join(root, "vault");
    await mkdir(vaultRoot, { recursive: true });
    server = await startSurreal({
      dataDir: join(root, "data"),
      secret: "vault-extraction-test-secret",
      portFile: join(root, "surreal.port"),
      pidFile: join(root, "surreal.pid"),
      logLevel: "warn",
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: server.url,
      user: "root",
      pass: "vault-extraction-test-secret",
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, "vault-extraction-test-secret", {
      embedDim: IDENTITY.dimension,
      embedModel: IDENTITY.model,
    });
    vault = new FsVault(vaultRoot, { recoveryDir: join(root, "recovery") });
  }, 30_000);

  afterAll(async () => {
    await connection?.close().catch(() => {});
    await server?.stop().catch(() => {});
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 30_000);

  test("serves only evidence bound to the current live public note bytes", async () => {
    const notePath = "public.md";
    const body = "# Public\n\nThe current note owns this exact evidence.\n";
    await writeFile(join(vaultRoot, notePath), body);
    const noteId = await upsertNoteByPath(connection.db, {
      path: notePath,
      sha: await sha256Hex(body),
      wordCount: 8,
    });
    const [chunkId] = await replaceChunks(connection.db, noteId, IDENTITY, [
      {
        ord: 0,
        text: "The current note owns this exact evidence.",
        tokenEstimate: 8,
        vector: [0, 0, 0],
      },
    ]);
    if (chunkId === undefined) throw new Error("expected one evidence chunk");
    const conceptId = await upsertConcept(connection.db, "owned evidence");
    await relateEdge(connection.db, {
      table: "mentions",
      from: noteId,
      to: conceptId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.9,
      agent: "extractor",
      approved: true,
      evidence: [chunkId],
    });

    const current = await collectExtraction({ db: connection.db, vault }, notePath);
    expect(current.concepts).toHaveLength(1);
    expect(current.concepts[0]?.evidence).toEqual([
      { chunkId: chunkId.toString(), text: "The current note owns this exact evidence." },
    ]);

    await writeFile(join(vaultRoot, notePath), "# Changed outside the index\n");
    expect((await collectExtraction({ db: connection.db, vault }, notePath)).concepts).toEqual([]);

    await writeFile(join(vaultRoot, notePath), body);
    await connection.db
      .query("UPDATE $note SET tombstoned_at = time::now();", { note: noteId })
      .collect();
    expect((await collectExtraction({ db: connection.db, vault }, notePath)).concepts).toEqual([]);
  });
});
