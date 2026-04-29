import { RecordId, type Surreal, Surreal as SurrealClass, Table } from "surrealdb";

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
  const sql =
    "RELATE $from->wikilink->$to SET source = $source, class = $cls, confidence = $confidence, agent = $agent;";
  await db
    .query(sql, {
      from: input.from,
      to: input.to,
      source: input.source,
      cls: input.confidenceClass,
      confidence: input.confidence,
      agent: input.agent ?? null,
    })
    .collect();
}

interface ChunkSearchRow {
  id: RecordId<"chunk">;
  note: RecordId<"note"> | { id: RecordId<"note"> };
  text: string;
  d: number;
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
