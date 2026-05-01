/**
 * Smoke harness for indexNote's upper-bound tier-filter semantics (Bug 4).
 *
 * Skipped by default. Run with `bun run test:smoke` (sets NOTIENT_SMOKE=1) or
 * directly via `NOTIENT_SMOKE=1 bun test src/daemon/__smoke__/indexNote.tierFilter.smoke.test.ts`.
 *
 * Bug 4 reinterprets `tierFilter` as an upper bound rather than a literal
 * subset: `awaken --tier 2` on a fresh note must run Tier 1 transparently
 * before Tier 2, while `reindex --tier 2` (which clears `tier2_at` upstream
 * before enqueueing) must still re-run Tier 2 alone, leaving Tier 1's
 * blocks and Tier 3's edges intact. The four scenarios below lock in the
 * behaviours called out in the bug report:
 *
 *   A. Fresh DB + `tierFilter=[2]` runs both Tier 1 and Tier 2.
 *   B. Fresh DB + `tierFilter=[3]` runs all three tiers.
 *   C. `tier1_at` already set + `tierFilter=[2]` runs Tier 2 only (the
 *      reindex flow regression: blocks are not regenerated).
 *   D. All three `tier{N}_at` set + default filter is a no-op (idempotency).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecordId } from "surrealdb";
import { Linker } from "../../../../src/core/agents/linker";
import { applySchema } from "../../../../src/core/db/schemaApplier";
import {
  type SurrealConnection,
  clearTierAtByPath,
  connect,
  fetchNoteTierState,
  lookupNoteByPath,
} from "../../../../src/core/db/surreal";
import { EventBus } from "../../../../src/core/events/eventBus";
import { Embedder } from "../../../../src/core/indexer/embedder";
import { Extractor } from "../../../../src/core/indexer/extractor";
import { indexNote } from "../../../../src/core/indexer/indexNote";
import { EMBED_MODEL } from "../../../../src/core/indexer/tier2";
import type { ChatMessage, ChatOptions, JsonSchema, LLMProvider } from "../../../../src/core/llm/provider";
import { type SurrealServerHandle, startSurreal } from "../../../../src/daemon/surrealServer";

const SMOKE_ENABLED = process.env.NOTIENT_SMOKE === "1";

const VECTOR_DIM = 768;

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

function deterministicVector(text: string): number[] {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  const seed = (hash & 0xffff) / 0xffff;
  const vector = new Array<number>(VECTOR_DIM);
  vector[0] = seed;
  for (let index = 1; index < VECTOR_DIM; index += 1) {
    vector[index] = 0.1;
  }
  return vector;
}

function makeEmbedder(): Embedder {
  const provider = fakeProvider({
    embed: async (input: string[]) => input.map((text) => deterministicVector(text)),
  });
  return new Embedder(provider, { model: EMBED_MODEL });
}

function makeExtractor(): Extractor {
  const provider = fakeProvider({
    chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
      ({ entities: [], claims: [], questions: [] }) as T,
  });
  return new Extractor(provider, { model: "test-extractor-model" });
}

function makeLinker(connection: SurrealConnection): Linker {
  // The linker proposes nothing here; we only need a real instance so
  // Tier 3 can run end-to-end and stamp `tier3_at`. The empty
  // `linkerNeighbors` result on a single-note DB short-circuits before
  // `chatJson` is called, so the dummy provider is sufficient.
  const provider = fakeProvider({
    chatJson: async <T>(_messages: ChatMessage[], _opts: ChatOptions, _schema: JsonSchema) =>
      ({ edges: [] }) as T,
  });
  return new Linker({
    db: connection.db,
    provider,
    reasoningModel: "test-linker-model",
  });
}

async function countWhereNote(
  connection: SurrealConnection,
  table: string,
  noteId: RecordId<"note">,
): Promise<number> {
  const [rows] = await connection.db
    .query<[Array<{ count: number }>]>(
      `SELECT count() AS count FROM ${table} WHERE note = $note GROUP ALL;`,
      { note: noteId },
    )
    .collect<[Array<{ count: number }>]>();
  return rows[0]?.count ?? 0;
}

async function clearAllNoteTables(connection: SurrealConnection): Promise<void> {
  // Order matters: delete edges and dependents before owning rows so
  // SurrealDB never sees a dangling pointer in an intermediate state.
  const tables = [
    "wikilink",
    "frontmatter_ref",
    "tagged",
    "contained_in",
    "under_heading",
    "mentions",
    "asserts",
    "asks",
    "supports",
    "wikilink_unresolved",
    "embed_unresolved",
    "embed",
    "chunk",
    "block",
    "tag",
    "concept",
    "claim",
    "question",
    "note",
  ];
  for (const table of tables) {
    await connection.db.query(`DELETE ${table};`).collect();
  }
}

const noteSource = `# Sample

A first paragraph that exists to populate Tier 1 blocks and feed the chunker.

## Subheading

A second paragraph under a deeper heading so the chunker emits more than one section.
`;

describe.skipIf(!SMOKE_ENABLED)("[smoke] indexNote upper-bound tier filter", () => {
  let tempDir: string;
  let handle: SurrealServerHandle;
  let connection: SurrealConnection;
  const secret = "indexnote-tierfilter-smoke-secret";
  const notePath = "alpha.md";

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "notient-indexnote-tierfilter-"));
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
  });

  test("[A] fresh DB + tierFilter=[2] runs Tier 1 transparently then Tier 2", async () => {
    await clearAllNoteTables(connection);
    const bus = new EventBus();
    const result = await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
      tierFilter: [2],
    });

    expect(result.notePath).toBe(notePath);
    expect(result.chunkCount).toBeGreaterThan(0);

    const noteId = await lookupNoteByPath(connection.db, notePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    const blockCount = await countWhereNote(connection, "block", noteId);
    expect(blockCount).toBeGreaterThan(0);
    const chunkCount = await countWhereNote(connection, "chunk", noteId);
    expect(chunkCount).toBeGreaterThan(0);
    expect(chunkCount).toBe(result.chunkCount);

    const state = await fetchNoteTierState(connection.db, notePath);
    expect(state.tier1Done).toBe(true);
    expect(state.tier2Done).toBe(true);
    expect(state.tier3Done).toBe(false);
  });

  test("[B] fresh DB + tierFilter=[3] runs Tier 1, Tier 2, and Tier 3", async () => {
    await clearAllNoteTables(connection);
    const bus = new EventBus();
    const result = await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
      tierFilter: [3],
    });

    expect(result.chunkCount).toBeGreaterThan(0);

    const noteId = await lookupNoteByPath(connection.db, notePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    const blockCount = await countWhereNote(connection, "block", noteId);
    expect(blockCount).toBeGreaterThan(0);
    const chunkCount = await countWhereNote(connection, "chunk", noteId);
    expect(chunkCount).toBeGreaterThan(0);

    const state = await fetchNoteTierState(connection.db, notePath);
    expect(state.tier1Done).toBe(true);
    expect(state.tier2Done).toBe(true);
    expect(state.tier3Done).toBe(true);
  });

  test("[C] tier1_at set + tierFilter=[2] runs Tier 2 only (reindex flow regression)", async () => {
    await clearAllNoteTables(connection);
    const bus = new EventBus();

    // Seed: full pass so all three tiers are stamped.
    await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
    });

    const noteId = await lookupNoteByPath(connection.db, notePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    const blocksBefore = await countWhereNote(connection, "block", noteId);
    expect(blocksBefore).toBeGreaterThan(0);

    // Mimic the reindex handler: clear only `tier2_at`, leave Tier 1's
    // stamp and blocks intact, then re-run with the upper bound at 2.
    await clearTierAtByPath(connection.db, notePath, [2]);

    const stateBefore = await fetchNoteTierState(connection.db, notePath);
    expect(stateBefore.tier1Done).toBe(true);
    expect(stateBefore.tier2Done).toBe(false);
    expect(stateBefore.tier3Done).toBe(true);

    let tier1DoneSeen = 0;
    bus.on("indexer:tier1-done", () => {
      tier1DoneSeen += 1;
    });

    await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
      tierFilter: [2],
    });

    expect(tier1DoneSeen).toBe(0);

    const blocksAfter = await countWhereNote(connection, "block", noteId);
    expect(blocksAfter).toBe(blocksBefore);

    const state = await fetchNoteTierState(connection.db, notePath);
    expect(state.tier1Done).toBe(true);
    expect(state.tier2Done).toBe(true);
    expect(state.tier3Done).toBe(true);
  });

  test("[E] body sha drift forces a full re-run of all three tiers", async () => {
    // M2: a watcher edit lands new bytes on disk while the previously
    // indexed `note` row still carries the old `sha` and stamped
    // `tier{1,2,3}_at`. Without the sha-drift gate `indexNote` would
    // short-circuit (chunkCount=0, no events) and search would keep the
    // pre-edit chunks. With the gate the orchestrator clears all three
    // stamps and runs Tier 1 → Tier 2 → Tier 3 against the new body.
    await clearAllNoteTables(connection);
    const bus = new EventBus();

    // Seed: full pass with the original body so all three tiers stamp.
    await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
    });

    const noteId = await lookupNoteByPath(connection.db, notePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    const chunksBefore = await countWhereNote(connection, "chunk", noteId);
    expect(chunksBefore).toBeGreaterThan(0);

    const stateBefore = await fetchNoteTierState(connection.db, notePath);
    expect(stateBefore.tier1Done).toBe(true);
    expect(stateBefore.tier2Done).toBe(true);
    expect(stateBefore.tier3Done).toBe(true);

    // Mutate the body so the recomputed sha drifts from the seeded one.
    const editedSource = `${noteSource}\n\n## Watcher addition\n\nA freshly typed paragraph that did not exist in the seed pass.\n`;

    let tier1DoneSeen = 0;
    let tier2DoneSeen = 0;
    let tier3DoneSeen = 0;
    bus.on("indexer:tier1-done", () => {
      tier1DoneSeen += 1;
    });
    bus.on("indexer:tier2-done", () => {
      tier2DoneSeen += 1;
    });
    bus.on("indexer:tier3-done", () => {
      tier3DoneSeen += 1;
    });

    const result = await indexNote({
      notePath,
      noteBody: editedSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
    });

    expect(tier1DoneSeen).toBe(1);
    expect(tier2DoneSeen).toBe(1);
    expect(tier3DoneSeen).toBe(1);
    expect(result.chunkCount).toBeGreaterThan(0);

    const stateAfter = await fetchNoteTierState(connection.db, notePath);
    expect(stateAfter.tier1Done).toBe(true);
    expect(stateAfter.tier2Done).toBe(true);
    expect(stateAfter.tier3Done).toBe(true);
  });

  test("[D] all tiers stamped + default filter is a no-op", async () => {
    await clearAllNoteTables(connection);
    const bus = new EventBus();

    await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
    });

    const noteId = await lookupNoteByPath(connection.db, notePath);
    expect(noteId).not.toBeNull();
    if (noteId === null) return;

    const blocksBefore = await countWhereNote(connection, "block", noteId);
    const chunksBefore = await countWhereNote(connection, "chunk", noteId);

    let tier1DoneSeen = 0;
    let tier2DoneSeen = 0;
    let tier3DoneSeen = 0;
    bus.on("indexer:tier1-done", () => {
      tier1DoneSeen += 1;
    });
    bus.on("indexer:tier2-done", () => {
      tier2DoneSeen += 1;
    });
    bus.on("indexer:tier3-done", () => {
      tier3DoneSeen += 1;
    });

    await indexNote({
      notePath,
      noteBody: noteSource,
      embedder: makeEmbedder(),
      extractor: makeExtractor(),
      bus,
      surrealDb: connection,
      linker: makeLinker(connection),
    });

    expect(tier1DoneSeen).toBe(0);
    expect(tier2DoneSeen).toBe(0);
    expect(tier3DoneSeen).toBe(0);

    const blocksAfter = await countWhereNote(connection, "block", noteId);
    const chunksAfter = await countWhereNote(connection, "chunk", noteId);
    expect(blocksAfter).toBe(blocksBefore);
    expect(chunksAfter).toBe(chunksBefore);
  });
});
