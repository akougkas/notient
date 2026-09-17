import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId, Surreal } from "surrealdb";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import { type SurrealConnection, connect, upsertNoteByPath } from "../../../../src/core/db/surreal";
import {
  Extractor,
  filterNoiseEntities,
  writeExtractionToSurreal,
} from "../../../../src/core/indexer/extractor";
import { purgeNoteGraph, tombstoneNoteByPath } from "../../../../src/core/indexer/purgeNote";
import type { Chunk, Extraction } from "../../../../src/core/indexer/types";
import type {
  ChatMessage,
  ChatOptions,
  JsonSchema,
  LLMProvider,
} from "../../../../src/core/llm/provider";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

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
const NO_APPROVAL_CANCELLATION = {
  cancelForNoteDeletion: async () => ({ cancelled: 0, failed: 0 }),
};

async function createEvidenceChunk(
  db: Surreal,
  noteId: RecordId<"note">,
  ord: number,
): Promise<RecordId<"chunk">> {
  const [row] = await db
    .query<[{ id: RecordId<"chunk"> } | null]>(
      "CREATE ONLY chunk CONTENT { note: $note, ord: $ord, text: $text, token_estimate: 1 } RETURN id;",
      { note: noteId, ord, text: `chunk ${ord}` },
    )
    .collect<[{ id: RecordId<"chunk"> } | null]>();
  if (row === null) throw new Error("test setup: failed to create evidence chunk");
  return row.id;
}

interface QueryGate {
  db: Surreal;
  entered: Promise<void>;
  release(): void;
}

function gateFirstMatchingQuery(
  db: Surreal,
  matches: (sql: string) => boolean,
  phase: "before" | "after",
): QueryGate {
  let signalEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let signalRelease = () => {};
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  let intercepted = false;
  const gated = {
    query: (sql: string, bindings?: Record<string, unknown>) => {
      if (intercepted || !matches(sql)) return db.query(sql, bindings);
      intercepted = true;
      return {
        collect: async () => {
          if (phase === "before") {
            signalEntered();
            await released;
          }
          const result = await db.query(sql, bindings).collect();
          if (phase === "after") {
            signalEntered();
            await released;
          }
          return result;
        },
      };
    },
    create: db.create.bind(db),
  } as unknown as Surreal;
  return { db: gated, entered, release: signalRelease };
}

async function waitForGate(gate: QueryGate, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate.entered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function raceExtraction(stem: string, evidenceKey: string): Extraction {
  const entity = `${stem} Concept`;
  const claim = `${stem} ownership remains local.`;
  const question = `Who owns ${stem}?`;
  return {
    entities: [entity],
    claims: [claim],
    questions: [question],
    entityEvidence: { [entity]: [evidenceKey] },
    claimEvidence: { [claim]: [evidenceKey] },
    questionEvidence: { [question]: [evidenceKey] },
  };
}

async function writeRaceExtraction(
  db: Surreal,
  noteId: RecordId<"note">,
  evidence: RecordId<"chunk">,
  stem: string,
): Promise<void> {
  const evidenceKey = evidence.toString();
  await writeExtractionToSurreal(db, noteId, raceExtraction(stem, evidenceKey), {
    chunkIndex: new Map([[evidenceKey, evidence]]),
    coverage: { kind: "full" },
  });
}

interface SemanticTargets {
  concept: RecordId<"concept">;
  claim: RecordId<"claim">;
  question: RecordId<"question">;
}

async function semanticTargetsFor(db: Surreal, noteId: RecordId<"note">): Promise<SemanticTargets> {
  const [mentions, asserts, asks] = await db
    .query<
      [
        Array<{ out: RecordId<"concept"> }>,
        Array<{ out: RecordId<"claim"> }>,
        Array<{ out: RecordId<"question"> }>,
      ]
    >(
      [
        "SELECT out FROM mentions WHERE in = $note;",
        "SELECT out FROM asserts WHERE in = $note;",
        "SELECT out FROM asks WHERE in = $note;",
      ].join("\n"),
      { note: noteId },
    )
    .collect<
      [
        Array<{ out: RecordId<"concept"> }>,
        Array<{ out: RecordId<"claim"> }>,
        Array<{ out: RecordId<"question"> }>,
      ]
    >();
  if (mentions.length !== 1 || asserts.length !== 1 || asks.length !== 1) {
    throw new Error("test setup: expected exactly one extractor relation of each kind");
  }
  return {
    concept: mentions[0].out,
    claim: asserts[0].out,
    question: asks[0].out,
  };
}

async function extractorTargetsExist(db: Surreal, targets: SemanticTargets): Promise<boolean[]> {
  return await db
    .query<[boolean, boolean, boolean]>(
      [
        "RETURN record::exists($concept);",
        "RETURN record::exists($claim);",
        "RETURN record::exists($question);",
      ].join("\n"),
      {
        concept: targets.concept,
        claim: targets.claim,
        question: targets.question,
      },
    )
    .collect<[boolean, boolean, boolean]>();
}

async function danglingExtractorEdges(db: Surreal): Promise<unknown[][]> {
  return await db
    .query<[unknown[], unknown[], unknown[]]>(
      [
        "SELECT id FROM mentions WHERE !record::exists(in) OR !record::exists(out);",
        "SELECT id FROM asserts WHERE !record::exists(in) OR !record::exists(out);",
        "SELECT id FROM asks WHERE !record::exists(in) OR !record::exists(out);",
      ].join("\n"),
    )
    .collect<[unknown[], unknown[], unknown[]]>();
}

interface MentionRow {
  id: RecordId<"mentions">;
  label: string;
  evidence?: Array<RecordId<"chunk">>;
  source: string;
  class: string;
  confidence: number;
  agent: string | null;
  approved: boolean;
  applied: boolean;
}

async function mentionsFor(db: Surreal, noteId: RecordId<"note">): Promise<MentionRow[]> {
  const [rows] = await db
    .query<[MentionRow[]]>(
      "SELECT id, out.label AS label, source, class, confidence, agent, approved, applied, evidence FROM mentions WHERE in = $note ORDER BY label;",
      { note: noteId },
    )
    .collect<[MentionRow[]]>();
  return rows;
}

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
      hnswCacheMib: 64,
    });
    connection = await connect({
      url: handle.url,
      user: "root",
      pass: secret,
      namespace: "notient",
      database: "vault",
    });
    await applySchema(connection.db, secret, {
      embedDim: 768,
      embedModel: "fixture-embedding",
    });
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

  test("[smoke] writes mentions/asserts/asks rows with approved=true", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "extracted.md",
      sha: "sha-extracted",
      wordCount: 12,
    });
    const evidence = await createEvidenceChunk(connection.db, noteId, 0);
    const evidenceKey = evidence.toString();
    const chunkIndex = new Map([[evidenceKey, evidence]]);
    await writeExtractionToSurreal(
      connection.db,
      noteId,
      {
        entities: ["POSIX", "HPC"],
        entityKinds: { POSIX: "system", HPC: "proper_noun" },
        claims: ["POSIX is leaky.", "HPC needs new abstractions."],
        claimKinds: {
          "POSIX is leaky.": "assertion",
          "HPC needs new abstractions.": "assertion",
        },
        questions: ["Why is POSIX leaky?"],
        entityEvidence: { POSIX: [evidenceKey], HPC: [evidenceKey] },
        claimEvidence: {
          "POSIX is leaky.": [evidenceKey],
          "HPC needs new abstractions.": [evidenceKey],
        },
        questionEvidence: { "Why is POSIX leaky?": [evidenceKey] },
      },
      { chunkIndex, coverage: { kind: "full" } },
    );

    const [mentionsRows] = await connection.db
      .query<
        [
          Array<{
            approved: boolean;
            agent: string;
            source: string;
            evidence: unknown[];
          }>,
        ]
      >("SELECT approved, agent, source, evidence FROM mentions WHERE in = $note;", {
        note: noteId,
      })
      .collect<
        [
          Array<{
            approved: boolean;
            agent: string;
            source: string;
            evidence: unknown[];
          }>,
        ]
      >();
    expect(mentionsRows.length).toBe(2);
    for (const row of mentionsRows) {
      expect(row.approved).toBe(true);
      expect(row.agent).toBe("extractor");
      expect(row.source).toBe("extractor");
      expect(row.evidence.map(String)).toEqual([evidenceKey]);
    }

    const [assertsRows] = await connection.db
      .query<[Array<{ approved: boolean; evidence: unknown[] }>]>(
        "SELECT approved, evidence FROM asserts WHERE in = $note;",
        { note: noteId },
      )
      .collect<[Array<{ approved: boolean; evidence: unknown[] }>]>();
    expect(assertsRows.length).toBe(2);
    for (const row of assertsRows) {
      expect(row.approved).toBe(true);
      expect(row.evidence.map(String)).toEqual([evidenceKey]);
    }

    const [asksRows] = await connection.db
      .query<[Array<{ approved: boolean; evidence: unknown[] }>]>(
        "SELECT approved, evidence FROM asks WHERE in = $note;",
        { note: noteId },
      )
      .collect<[Array<{ approved: boolean; evidence: unknown[] }>]>();
    expect(asksRows.length).toBe(1);
    expect(asksRows[0].approved).toBe(true);
    expect(asksRows[0].evidence.map(String)).toEqual([evidenceKey]);

    const [conceptRows] = await connection.db
      .query<[Array<{ label: string; kind: string; source: string }>]>(
        "SELECT label, kind, source FROM concept WHERE label IN ['POSIX','HPC'];",
      )
      .collect<[Array<{ label: string; kind: string; source: string }>]>();
    expect(conceptRows.length).toBe(2);
    expect(conceptRows).toContainEqual({
      label: "POSIX",
      kind: "system",
      source: "extractor",
    });
    expect(conceptRows).toContainEqual({
      label: "HPC",
      kind: "proper_noun",
      source: "extractor",
    });

    const [claimRows] = await connection.db
      .query<[Array<{ kind: string }>]>("SELECT kind FROM claim;")
      .collect<[Array<{ kind: string }>]>();
    expect(claimRows).toHaveLength(2);
    expect(claimRows.every((row) => row.kind === "assertion")).toBe(true);

    const [questionRows] = await connection.db
      .query<[Array<{ count: number }>]>("SELECT count() AS count FROM question GROUP ALL;")
      .collect<[Array<{ count: number }>]>();
    expect(questionRows[0]?.count ?? 0).toBeGreaterThanOrEqual(1);

    await writeExtractionToSurreal(
      connection.db,
      noteId,
      {
        entities: ["RAG"],
        entityKinds: { RAG: "technique" },
        claims: [],
        questions: [],
        entityEvidence: { RAG: [evidenceKey] },
      },
      { chunkIndex, coverage: { kind: "full" } },
    );
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

  test("[smoke] partial coverage retains failed-window evidence and relation ids", async () => {
    const noteId = await upsertNoteByPath(connection.db, {
      path: "partial-coverage.md",
      sha: "sha-partial-coverage",
      wordCount: 8,
    });
    const chunk0 = await createEvidenceChunk(connection.db, noteId, 0);
    const chunk1 = await createEvidenceChunk(connection.db, noteId, 1);
    const chunk0Key = chunk0.toString();
    const chunk1Key = chunk1.toString();
    const fullChunkIndex = new Map([
      [chunk0Key, chunk0],
      [chunk1Key, chunk1],
    ]);

    // Full baseline: A belongs to c0 and B belongs to c1.
    await writeExtractionToSurreal(
      connection.db,
      noteId,
      {
        entities: ["Coverage A", "Coverage B"],
        claims: [],
        questions: [],
        entityEvidence: {
          "Coverage A": [chunk0Key],
          "Coverage B": [chunk1Key],
        },
      },
      { chunkIndex: fullChunkIndex, coverage: { kind: "full" } },
    );
    const baseline = await mentionsFor(connection.db, noteId);
    expect(baseline).toHaveLength(2);
    const baselineByLabel = new Map(baseline.map((row) => [row.label, row]));
    const aId = baselineByLabel.get("Coverage A")?.id.toString();
    const bId = baselineByLabel.get("Coverage B")?.id.toString();
    if (aId === undefined || bId === undefined) {
      throw new Error("test setup: full extraction did not create both mention relations");
    }
    await connection.db
      .query(
        "UPDATE $id SET source = 'user', class = 'AMBIGUOUS', confidence = 0.1, agent = 'extractor', approved = false, applied = false;",
        { id: baselineByLabel.get("Coverage B")?.id },
      )
      .collect();

    // Only c0 succeeded. A is refreshed, while B's c1 evidence is retained
    // because that window failed. Both existing relation ids survive.
    await writeExtractionToSurreal(
      connection.db,
      noteId,
      {
        entities: ["Coverage A"],
        claims: [],
        questions: [],
        entityEvidence: { "Coverage A": [chunk0Key] },
      },
      {
        chunkIndex: fullChunkIndex,
        coverage: { kind: "partial", chunkIds: new Set([chunk0Key]) },
      },
    );
    const refreshed = await mentionsFor(connection.db, noteId);
    const refreshedByLabel = new Map(refreshed.map((row) => [row.label, row]));
    expect(refreshed).toHaveLength(2);
    expect(refreshedByLabel.get("Coverage A")?.id.toString()).toBe(aId);
    expect(refreshedByLabel.get("Coverage B")?.id.toString()).toBe(bId);
    expect(refreshedByLabel.get("Coverage A")?.evidence?.map(String)).toEqual([chunk0Key]);
    expect(refreshedByLabel.get("Coverage B")?.evidence?.map(String)).toEqual([chunk1Key]);
    expect(refreshedByLabel.get("Coverage B")).toMatchObject({
      source: "extractor",
      class: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
      applied: true,
    });

    // An empty but successful c0 window authoritatively removes A. B still
    // belongs to the failed c1 window and retains its id.
    await writeExtractionToSurreal(
      connection.db,
      noteId,
      { entities: [], claims: [], questions: [] },
      {
        chunkIndex: fullChunkIndex,
        coverage: { kind: "partial", chunkIds: new Set([chunk0Key]) },
      },
    );
    const afterSuccessfulEmpty = await mentionsFor(connection.db, noteId);
    expect(afterSuccessfulEmpty).toHaveLength(1);
    expect(afterSuccessfulEmpty[0].label).toBe("Coverage B");
    expect(afterSuccessfulEmpty[0].id.toString()).toBe(bId);
    expect(afterSuccessfulEmpty[0].evidence?.map(String)).toEqual([chunk1Key]);

    // c1 is no longer in the current chunk index. Its evidence is retired,
    // not failed-window evidence, so it cannot keep B alive.
    await writeExtractionToSurreal(
      connection.db,
      noteId,
      { entities: [], claims: [], questions: [] },
      {
        chunkIndex: new Map([[chunk0Key, chunk0]]),
        coverage: { kind: "partial", chunkIds: new Set([chunk0Key]) },
      },
    );
    expect(await mentionsFor(connection.db, noteId)).toEqual([]);
  });

  test("[smoke] retries after purge wins before enforced semantic RELATE", async () => {
    const stem = "Purge First Race";
    const oldPath = "race/purge-first-old.md";
    const oldNote = await upsertNoteByPath(connection.db, {
      path: oldPath,
      sha: "sha-purge-first-old",
      wordCount: 4,
    });
    const newNote = await upsertNoteByPath(connection.db, {
      path: "race/purge-first-new.md",
      sha: "sha-purge-first-new",
      wordCount: 4,
    });
    const oldEvidence = await createEvidenceChunk(connection.db, oldNote, 0);
    const newEvidence = await createEvidenceChunk(connection.db, newNote, 0);
    await writeRaceExtraction(connection.db, oldNote, oldEvidence, stem);
    const deletedGeneration = await semanticTargetsFor(connection.db, oldNote);

    const gate = gateFirstMatchingQuery(
      connection.db,
      (sql) => sql.startsWith("BEGIN TRANSACTION;") && sql.includes("RELATE $note->mentions"),
      "before",
    );
    let extractionWrite: Promise<void> | undefined;
    try {
      extractionWrite = writeRaceExtraction(gate.db, newNote, newEvidence, stem);
      await waitForGate(gate, "extractor relation reconciliation");

      const tombstone = await tombstoneNoteByPath(connection, oldPath);
      if (tombstone === null) throw new Error("test setup: old race note was not tombstoned");
      expect(
        await purgeNoteGraph(connection, oldNote, tombstone.tombstonedAt, NO_APPROVAL_CANCELLATION),
      ).toBe(true);
      expect(await extractorTargetsExist(connection.db, deletedGeneration)).toEqual([
        false,
        false,
        false,
      ]);

      gate.release();
      await extractionWrite;
      const recreated = await semanticTargetsFor(connection.db, newNote);
      expect(await extractorTargetsExist(connection.db, recreated)).toEqual([true, true, true]);
      expect(recreated.concept.toString()).not.toBe(deletedGeneration.concept.toString());
      expect(recreated.claim.toString()).not.toBe(deletedGeneration.claim.toString());
      expect(recreated.question.toString()).not.toBe(deletedGeneration.question.toString());
      expect(await danglingExtractorEdges(connection.db)).toEqual([[], [], []]);
    } finally {
      gate.release();
      await extractionWrite?.catch(() => {});
    }
  });

  test("[smoke] a process loss after purge commit cannot strand semantic targets", async () => {
    const stem = "Committed Purge";
    const notePath = "race/committed-purge.md";
    const noteId = await upsertNoteByPath(connection.db, {
      path: notePath,
      sha: "sha-committed-purge",
      wordCount: 4,
    });
    const evidence = await createEvidenceChunk(connection.db, noteId, 0);
    await writeRaceExtraction(connection.db, noteId, evidence, stem);
    const targets = await semanticTargetsFor(connection.db, noteId);
    const tombstone = await tombstoneNoteByPath(connection, notePath);
    if (tombstone === null) throw new Error("test setup: purge note was not tombstoned");

    let injected = false;
    const crashAfterCommitDb = {
      query: (sql: string, bindings?: Record<string, unknown>) => {
        const query = connection.db.query(sql, bindings);
        if (injected || !sql.startsWith("BEGIN;") || !sql.includes("DELETE concept")) return query;
        injected = true;
        return {
          collect: async () => {
            await query.collect();
            throw new Error("simulated process loss after purge commit");
          },
        };
      },
      create: connection.db.create.bind(connection.db),
    } as unknown as Surreal;

    await expect(
      purgeNoteGraph(
        { ...connection, db: crashAfterCommitDb },
        noteId,
        tombstone.tombstonedAt,
        NO_APPROVAL_CANCELLATION,
      ),
    ).rejects.toThrow("simulated process loss after purge commit");
    expect(await extractorTargetsExist(connection.db, targets)).toEqual([false, false, false]);
    expect(
      await purgeNoteGraph(connection, noteId, tombstone.tombstonedAt, NO_APPROVAL_CANCELLATION),
    ).toBe(false);
    expect(await extractorTargetsExist(connection.db, targets)).toEqual([false, false, false]);
  });

  test("[smoke] purge pruning retains targets related by a concurrent extraction", async () => {
    const stem = "Relate First Race";
    const oldPath = "race/relate-first-old.md";
    const oldNote = await upsertNoteByPath(connection.db, {
      path: oldPath,
      sha: "sha-relate-first-old",
      wordCount: 4,
    });
    const newNote = await upsertNoteByPath(connection.db, {
      path: "race/relate-first-new.md",
      sha: "sha-relate-first-new",
      wordCount: 4,
    });
    const oldEvidence = await createEvidenceChunk(connection.db, oldNote, 0);
    const newEvidence = await createEvidenceChunk(connection.db, newNote, 0);
    await writeRaceExtraction(connection.db, oldNote, oldEvidence, stem);
    const sharedTargets = await semanticTargetsFor(connection.db, oldNote);
    const tombstone = await tombstoneNoteByPath(connection, oldPath);
    if (tombstone === null) throw new Error("test setup: old race note was not tombstoned");

    const gate = gateFirstMatchingQuery(
      connection.db,
      (sql) => sql.startsWith("BEGIN;") && sql.includes("DELETE concept"),
      "before",
    );
    const gatedConnection: SurrealConnection = { ...connection, db: gate.db };
    let purge: Promise<boolean> | undefined;
    try {
      purge = purgeNoteGraph(
        gatedConnection,
        oldNote,
        tombstone.tombstonedAt,
        NO_APPROVAL_CANCELLATION,
      );
      await waitForGate(gate, "purge target pruning");

      await writeRaceExtraction(connection.db, newNote, newEvidence, stem);
      const relatedTargets = await semanticTargetsFor(connection.db, newNote);
      expect(relatedTargets).toEqual(sharedTargets);

      gate.release();
      expect(await purge).toBe(true);
      expect(await extractorTargetsExist(connection.db, sharedTargets)).toEqual([true, true, true]);
      expect(await danglingExtractorEdges(connection.db)).toEqual([[], [], []]);
    } finally {
      gate.release();
      await purge?.catch(() => {});
    }
  });
});
