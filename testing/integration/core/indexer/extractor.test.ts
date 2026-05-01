import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RecordId, type Surreal, Table } from "surrealdb";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import type {
  ChatMessage,
  ChatOptions,
  EmbedOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { Extractor, filterNoiseEntities, writeExtractionToSurreal } from "../../../../src/core/indexer/extractor";
import type { Chunk } from "../../../../src/core/indexer/types";

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
    chatJson: async <T>() => ({}) as T,
    embed: async () => [],
    ...impl,
  };
}

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

describe.skipIf(!SMOKE_ENABLED)("[smoke] writeExtractionToSurreal", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "phase3-extractor-smoke-secret";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-extractor-smoke-"));
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

  test("[smoke] writes mentions/asserts/asks rows with approved=true", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "extracted.md",
      sha: "sha-extracted",
      wordCount: 12,
    });
    await writeExtractionToSurreal(connection.db, noteId, {
      entities: ["POSIX", "HPC"],
      entityKinds: { POSIX: "system", HPC: "proper_noun" },
      claims: ["POSIX is leaky.", "HPC needs new abstractions."],
      claimKinds: {
        "POSIX is leaky.": "assertion",
        "HPC needs new abstractions.": "assertion",
      },
      questions: ["Why is POSIX leaky?"],
    });

    const [mentionsRows] = await connection.db
      .query<[Array<{ approved: boolean; agent: string; source: string }>]>(
        "SELECT approved, agent, source FROM mentions WHERE in = $note;",
        { note: noteId },
      )
      .collect<[Array<{ approved: boolean; agent: string; source: string }>]>();
    expect(mentionsRows.length).toBe(2);
    for (const row of mentionsRows) {
      expect(row.approved).toBe(true);
      expect(row.agent).toBe("extractor");
      expect(row.source).toBe("extractor");
    }

    const [assertsRows] = await connection.db
      .query<[Array<{ approved: boolean }>]>("SELECT approved FROM asserts WHERE in = $note;", {
        note: noteId,
      })
      .collect<[Array<{ approved: boolean }>]>();
    expect(assertsRows.length).toBe(2);
    for (const row of assertsRows) {
      expect(row.approved).toBe(true);
    }

    const [asksRows] = await connection.db
      .query<[Array<{ approved: boolean }>]>("SELECT approved FROM asks WHERE in = $note;", {
        note: noteId,
      })
      .collect<[Array<{ approved: boolean }>]>();
    expect(asksRows.length).toBe(1);
    expect(asksRows[0].approved).toBe(true);

    const [conceptRows] = await connection.db
      .query<[Array<{ label: string; kind: string; source: string }>]>(
        "SELECT label, kind, source FROM concept WHERE label IN ['POSIX','HPC'];",
      )
      .collect<[Array<{ label: string; kind: string; source: string }>]>();
    expect(conceptRows.length).toBe(2);
    expect(conceptRows).toContainEqual({ label: "POSIX", kind: "system", source: "extractor" });
    expect(conceptRows).toContainEqual({ label: "HPC", kind: "proper_noun", source: "extractor" });

    const [claimRows] = await connection.db
      .query<[Array<{ kind: string }>]>("SELECT kind FROM claim;")
      .collect<[Array<{ kind: string }>]>();
    expect(claimRows).toHaveLength(2);
    expect(claimRows.every((row) => row.kind === "assertion")).toBe(true);

    const [questionRows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM question GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(questionRows[0]?.count ?? 0).toBeGreaterThanOrEqual(1);

    await writeExtractionToSurreal(connection.db, noteId, {
      entities: ["RAG"],
      entityKinds: { RAG: "technique" },
      claims: [],
      questions: [],
    });
    const [replacedMentionsRows] = await connection.db
      .query<[Array<{ out: unknown }>]>("SELECT out FROM mentions WHERE in = $note;", {
        note: noteId,
      })
      .collect<[Array<{ out: unknown }>]>();
    expect(replacedMentionsRows).toHaveLength(1);

    const [remainingConceptRows] = await connection.db
      .query<[Array<{ label: string }>]>("SELECT label FROM concept ORDER BY label;")
      .collect<[Array<{ label: string }>]>();
    expect(remainingConceptRows.map((row) => row.label)).toEqual(["RAG"]);
  });
});
