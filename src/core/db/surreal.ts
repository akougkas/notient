import { RecordId, type Surreal, Surreal as SurrealClass, Table } from "surrealdb";
import type { BlockSpec } from "../markdown/types";
import { EDGE_TABLES, type EdgeTable } from "./edgeTables";

export interface SurrealConnection {
  db: Surreal;
  close(): Promise<void>;
}

export interface NoteRecord {
  id: RecordId<"note">;
  path: string;
  sha: string;
  word_count: number;
}

export interface SearchHit {
  noteId: RecordId<"note">;
  chunkId: RecordId<"chunk">;
  distance: number;
  text: string;
}

export interface ConnectOptions {
  url: string;
  user: string;
  pass: string;
  namespace: string;
  database: string;
}

export interface CreateNoteInput {
  path: string;
  sha: string;
  wordCount: number;
}

export interface RelateWikilinkInput {
  from: RecordId;
  to: RecordId;
  source: string;
  confidenceClass: string;
  confidence: number;
  agent?: string;
}

export interface SearchVectorInput {
  vector: number[];
  k: number;
  ef?: number;
}

export async function connect(options: ConnectOptions): Promise<SurrealConnection> {
  const db = new SurrealClass();
  try {
    await db.connect(options.url);
    await db.signin({ username: options.user, password: options.pass });
    await db.use({ namespace: options.namespace, database: options.database });
  } catch (error) {
    try {
      await db.close();
    } catch {
      // Swallow secondary close failures so the original error surfaces.
    }
    throw error;
  }
  return {
    db,
    close: async () => {
      await db.close();
    },
  };
}

export async function createNote(db: Surreal, input: CreateNoteInput): Promise<NoteRecord> {
  const result = await db.create<NoteRecord>(new Table("note")).content({
    path: input.path,
    sha: input.sha,
    word_count: input.wordCount,
  });
  const record = Array.isArray(result) ? result[0] : result;
  if (!record) {
    throw new Error("createNote: SurrealDB returned no record");
  }
  return record as NoteRecord;
}

export async function relateWikilink(db: Surreal, input: RelateWikilinkInput): Promise<void> {
  const hasAgent = input.agent !== undefined;
  const agentClause = hasAgent ? ", agent = $agent" : "";
  const sql = `RELATE $from->wikilink->$to SET source = $source, class = $cls, confidence = $confidence${agentClause};`;
  const bindings: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    source: input.source,
    cls: input.confidenceClass,
    confidence: input.confidence,
  };
  if (hasAgent) {
    bindings.agent = input.agent;
  }
  await db.query(sql, bindings).collect();
}

interface ChunkSearchRow {
  id: RecordId<"chunk">;
  note: RecordId<"note"> | { id: RecordId<"note"> };
  text: string;
  d: number;
}

export async function lookupNoteByPath(
  db: Surreal,
  path: string,
): Promise<RecordId<"note"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"note"> }>]>("SELECT id FROM note WHERE path = $path LIMIT 1;", {
      path,
    })
    .collect<[Array<{ id: RecordId<"note"> }>]>();
  return rows[0]?.id ?? null;
}

export async function lookupBlockByHeading(
  db: Surreal,
  noteId: RecordId<"note">,
  headingSlug: string,
): Promise<RecordId<"block"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block"> }>]>(
      "SELECT id FROM block WHERE note = $note AND heading_slug = $slug LIMIT 1;",
      { note: noteId, slug: headingSlug },
    )
    .collect<[Array<{ id: RecordId<"block"> }>]>();
  return rows[0]?.id ?? null;
}

export async function lookupBlockByExplicitId(
  db: Surreal,
  noteId: RecordId<"note">,
  blockId: string,
): Promise<RecordId<"block"> | null> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"block"> }>]>(
      "SELECT id FROM block WHERE note = $note AND block_id = $bid LIMIT 1;",
      { note: noteId, bid: blockId },
    )
    .collect<[Array<{ id: RecordId<"block"> }>]>();
  return rows[0]?.id ?? null;
}

export interface UpsertNoteInput {
  path: string;
  sha: string;
  wordCount: number;
}

export async function upsertNoteByPath(
  db: Surreal,
  input: UpsertNoteInput,
): Promise<RecordId<"note">> {
  const existing = await lookupNoteByPath(db, input.path);
  if (existing !== null) {
    await db
      .query("UPDATE $id SET sha = $sha, word_count = $wordCount;", {
        id: existing,
        sha: input.sha,
        wordCount: input.wordCount,
      })
      .collect();
    return existing;
  }
  const created = await createNote(db, input);
  return created.id;
}

export async function upsertTag(db: Surreal, path: string): Promise<RecordId<"tag">> {
  const [rows] = await db
    .query<[Array<{ id: RecordId<"tag"> }>]>("SELECT id FROM tag WHERE path = $path LIMIT 1;", {
      path,
    })
    .collect<[Array<{ id: RecordId<"tag"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"tag">; path: string }>(new Table("tag"))
    .content({ path });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertTag: SurrealDB returned no record");
  }
  return record.id;
}

interface BlockContent {
  note: RecordId<"note">;
  heading_path: string[];
  ord: number;
  start_line: number;
  end_line: number;
  text: string;
  block_id?: string;
  heading_slug?: string;
  heading_level?: number;
}

function buildBlockContent(noteId: RecordId<"note">, block: BlockSpec): BlockContent {
  const content: BlockContent = {
    note: noteId,
    heading_path: block.headingPath,
    ord: block.ord,
    start_line: block.startLine,
    end_line: block.endLine,
    text: block.text,
  };
  if (block.blockId !== null) {
    content.block_id = block.blockId;
  }
  if (block.headingSlug !== null) {
    content.heading_slug = block.headingSlug;
  }
  if (block.headingLevel !== null) {
    content.heading_level = block.headingLevel;
  }
  return content;
}

export async function replaceBlocks(
  db: Surreal,
  noteId: RecordId<"note">,
  blocks: BlockSpec[],
): Promise<RecordId<"block">[]> {
  await db.query("DELETE block WHERE note = $note;", { note: noteId }).collect();
  if (blocks.length === 0) {
    return [];
  }
  const inserted: RecordId<"block">[] = [];
  for (const block of blocks) {
    const result = await db
      .create<{ id: RecordId<"block"> }>(new Table("block"))
      .content(buildBlockContent(noteId, block) as unknown as Record<string, unknown>);
    const record = Array.isArray(result) ? result[0] : result;
    if (record === undefined) {
      throw new Error("replaceBlocks: SurrealDB returned no block record");
    }
    inserted.push(record.id);
  }
  return inserted;
}

const TIER1_EDGE_TABLES: readonly EdgeTable[] = [
  "wikilink",
  "embed",
  "frontmatter_ref",
  "tagged",
  "contained_in",
  "under_heading",
];
const TIER1_SOURCES = ["wikilink", "embed", "frontmatter", "structure"];
const TIER1_UNRESOLVED_TABLES = ["wikilink_unresolved", "embed_unresolved"] as const;

export async function clearTier1Edges(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  for (const table of TIER1_EDGE_TABLES) {
    await db
      .query(
        `DELETE ${table} WHERE source IN $sources AND (in = $note OR in IN (SELECT VALUE id FROM block WHERE note = $note));`,
        { sources: TIER1_SOURCES, note: noteId },
      )
      .collect();
  }
  for (const table of TIER1_UNRESOLVED_TABLES) {
    await db
      .query(
        `DELETE ${table} WHERE in = $note OR in IN (SELECT VALUE id FROM block WHERE note = $note);`,
        { note: noteId },
      )
      .collect();
  }
}

export interface RelateEdgeInput {
  table: EdgeTable;
  from: RecordId;
  to: RecordId;
  source: string;
  confidenceClass: string;
  confidence: number;
  agent?: string;
  approved?: boolean;
}

export async function relateEdge(db: Surreal, input: RelateEdgeInput): Promise<void> {
  if (!EDGE_TABLES.includes(input.table)) {
    throw new Error(`relateEdge: unknown edge table '${input.table}'`);
  }
  const setClauses: string[] = ["source = $source", "class = $cls", "confidence = $confidence"];
  const bindings: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    source: input.source,
    cls: input.confidenceClass,
    confidence: input.confidence,
  };
  if (input.agent !== undefined) {
    setClauses.push("agent = $agent");
    bindings.agent = input.agent;
  }
  if (input.approved !== undefined) {
    setClauses.push("approved = $approved");
    bindings.approved = input.approved;
  }
  await db
    .query(`RELATE $from->${input.table}->$to SET ${setClauses.join(", ")};`, bindings)
    .collect();
}

export type UnresolvedEdgeKind = "wikilink" | "embed";

export interface InsertUnresolvedEdgeInput {
  kind: UnresolvedEdgeKind;
  from: RecordId;
  rawTarget: string;
  source: string;
}

export async function insertUnresolvedEdge(
  db: Surreal,
  input: InsertUnresolvedEdgeInput,
): Promise<void> {
  const table = input.kind === "wikilink" ? "wikilink_unresolved" : "embed_unresolved";
  await db
    .query(`CREATE ${table} CONTENT { in: $from, raw_target: $rawTarget, source: $source };`, {
      from: input.from,
      rawTarget: input.rawTarget,
      source: input.source,
    })
    .collect();
}

export async function markTier1Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier1_at = time::now();", { id: noteId }).collect();
}

export async function searchVector(db: Surreal, input: SearchVectorInput): Promise<SearchHit[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("searchVector: k must be a positive integer");
  }
  const operator = input.ef !== undefined ? `<|${input.k},${input.ef}|>` : `<|${input.k}|>`;
  const sql = `SELECT id, note, text, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q ORDER BY d FETCH note;`;
  const [rows] = await db
    .query<[ChunkSearchRow[]]>(sql, { q: input.vector })
    .collect<[ChunkSearchRow[]]>();
  return rows.map((row) => {
    const note = row.note;
    const noteId = note instanceof RecordId ? (note as RecordId<"note">) : note.id;
    return {
      noteId,
      chunkId: row.id,
      distance: row.d,
      text: row.text,
    };
  });
}

export interface ChunkInsertInput {
  ord: number;
  text: string;
  tokenEstimate: number;
  vector: number[];
  embedModel: string;
}

export async function replaceChunks(
  db: Surreal,
  noteId: RecordId<"note">,
  chunks: ChunkInsertInput[],
): Promise<RecordId<"chunk">[]> {
  await db.query("DELETE chunk WHERE note = $note;", { note: noteId }).collect();
  if (chunks.length === 0) {
    return [];
  }
  const inserted: RecordId<"chunk">[] = [];
  // embedded_at is set via SurrealQL time::now() so the value lands as a
  // native datetime; passing a JS Date through .content() would be coerced
  // to a string and fail the option<datetime> field assertion.
  const sql =
    "CREATE ONLY chunk CONTENT { note: $note, ord: $ord, text: $text, token_estimate: $tokenEstimate, vector: $vector, embed_model: $embedModel, embedded_at: time::now() } RETURN id;";
  for (const chunk of chunks) {
    // CREATE ONLY returns a single record (not an array) per SurrealDB 3.x.
    const [row] = await db
      .query<[{ id: RecordId<"chunk"> } | null]>(sql, {
        note: noteId,
        ord: chunk.ord,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
        vector: chunk.vector,
        embedModel: chunk.embedModel,
      })
      .collect<[{ id: RecordId<"chunk"> } | null]>();
    if (row === null) {
      throw new Error("replaceChunks: SurrealDB returned no chunk record");
    }
    inserted.push(row.id);
  }
  return inserted;
}

export async function markTier2Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier2_at = time::now();", { id: noteId }).collect();
}

export async function markTier3Done(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  await db.query("UPDATE $id SET tier3_at = time::now();", { id: noteId }).collect();
}

export interface LinkerNeighborsInput {
  activeNoteId: RecordId<"note">;
  activeChunkVectors: number[][];
  k: number;
  ef?: number;
}

export interface NeighborCandidate {
  noteId: RecordId<"note">;
  notePath: string;
  bestDistance: number;
  evidenceChunkIds: RecordId<"chunk">[];
}

interface NeighborRow {
  id: RecordId<"chunk">;
  note: RecordId<"note"> | { id: RecordId<"note">; path: string; tier3_at?: string };
  d: number;
}

const MAX_EVIDENCE_PER_NOTE = 4;
const DEFAULT_LINKER_EF = 40;

export async function linkerNeighbors(
  db: Surreal,
  input: LinkerNeighborsInput,
): Promise<NeighborCandidate[]> {
  if (!Number.isInteger(input.k) || input.k <= 0) {
    throw new Error("linkerNeighbors: k must be a positive integer");
  }
  if (input.activeChunkVectors.length === 0) {
    return [];
  }
  const queryVector = input.activeChunkVectors[0];
  const ef = input.ef ?? DEFAULT_LINKER_EF;
  const operator = `<|${input.k},${ef}|>`;
  // Multi-statement query: SurrealDB returns one result slice per statement.
  // We only care about the final SELECT, so we read the last slice.
  const sql = [
    "LET $excluded = (SELECT VALUE ->wikilink->note FROM ONLY $active);",
    "LET $excludedBack = (SELECT VALUE <-wikilink<-note FROM ONLY $active);",
    `SELECT id, note, vector::distance::knn() AS d FROM chunk WHERE vector ${operator} $q AND note != $active AND note NOT IN $excluded AND note NOT IN $excludedBack AND note.tier3_at != NONE ORDER BY d FETCH note;`,
  ].join("\n");
  const results = await db
    .query(sql, { active: input.activeNoteId, q: queryVector })
    .collect<unknown[]>();
  const lastSlice = results[results.length - 1];
  const rows = (Array.isArray(lastSlice) ? (lastSlice as NeighborRow[]) : []) as NeighborRow[];
  const grouped = new Map<
    string,
    { noteId: RecordId<"note">; notePath: string; rows: NeighborRow[] }
  >();
  for (const row of rows) {
    const note = row.note;
    let noteId: RecordId<"note">;
    let notePath: string;
    if (note instanceof RecordId) {
      noteId = note as RecordId<"note">;
      notePath = "";
    } else {
      noteId = note.id;
      notePath = note.path;
    }
    const key = noteId.toString();
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { noteId, notePath, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }
  const candidates: NeighborCandidate[] = [];
  for (const entry of grouped.values()) {
    const sortedRows = entry.rows.slice().sort((a, b) => a.d - b.d);
    const evidenceChunkIds = sortedRows.slice(0, MAX_EVIDENCE_PER_NOTE).map((row) => row.id);
    const bestDistance = sortedRows[0].d;
    candidates.push({
      noteId: entry.noteId,
      notePath: entry.notePath,
      bestDistance,
      evidenceChunkIds,
    });
  }
  candidates.sort((a, b) => a.bestDistance - b.bestDistance);
  return candidates;
}

function normalizeLabel(label: string): string {
  return label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function upsertConcept(db: Surreal, label: string): Promise<RecordId<"concept">> {
  const normalized = normalizeLabel(label);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"concept"> }>]>(
      "SELECT id FROM concept WHERE norm_label = $norm LIMIT 1;",
      { norm: normalized },
    )
    .collect<[Array<{ id: RecordId<"concept"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"concept">; label: string; norm_label: string }>(new Table("concept"))
    .content({ label, norm_label: normalized });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertConcept: SurrealDB returned no record");
  }
  return record.id;
}

export async function upsertClaim(db: Surreal, text: string): Promise<RecordId<"claim">> {
  const sha = await sha256Hex(text);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"claim"> }>]>("SELECT id FROM claim WHERE sha = $sha LIMIT 1;", {
      sha,
    })
    .collect<[Array<{ id: RecordId<"claim"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"claim">; text: string; sha: string }>(new Table("claim"))
    .content({ text, sha });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertClaim: SurrealDB returned no record");
  }
  return record.id;
}

export async function upsertQuestion(db: Surreal, text: string): Promise<RecordId<"question">> {
  const sha = await sha256Hex(text);
  const [rows] = await db
    .query<[Array<{ id: RecordId<"question"> }>]>(
      "SELECT id FROM question WHERE sha = $sha LIMIT 1;",
      { sha },
    )
    .collect<[Array<{ id: RecordId<"question"> }>]>();
  if (rows[0] !== undefined) {
    return rows[0].id;
  }
  const result = await db
    .create<{ id: RecordId<"question">; text: string; sha: string }>(new Table("question"))
    .content({ text, sha });
  const record = Array.isArray(result) ? result[0] : result;
  if (record === undefined) {
    throw new Error("upsertQuestion: SurrealDB returned no record");
  }
  return record.id;
}
