import type { Conversation } from "./types";

/**
 * In-memory conversation index keyed by `conversation_id`, persisted to the
 * shared sidecar `<vault>/Notient/.index.json` under the `conversations`
 * key. Other slices of that sidecar (search history, etc.) are preserved
 * verbatim on every write.
 *
 * The index caches the summary embedding (Float32Array, 768-dim from
 * nomic-embed-text-v2-moe) decoded from the conversation's
 * `summary_embedding_b64`. Cross-session memory (Task 13) uses
 * {@link ConversationIndex.search} to find prior conversations by cosine
 * similarity over those vectors. Entries without an embedding are kept for
 * listing but skipped during similarity search.
 */

export interface ConversationIndexEntry {
  id: string;
  path: string;
  topic: string;
  updatedAt: number;
  embedding: Float32Array | null;
}

export interface ConversationIndexFacade {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export interface ConversationIndexOptions {
  facade: ConversationIndexFacade;
  /** Absolute vault path of the sidecar, e.g. `Notient/.index.json`. */
  indexPath: string;
  /** Cap on stored conversation entries. Oldest by `updatedAt` are evicted first. */
  maxEntries?: number;
}

interface PersistedEntry {
  id: string;
  path: string;
  topic: string;
  updatedAt: number;
  embedding: string | null;
}

const SIDECAR_KEY = "conversations";

export class ConversationIndex {
  private entries: ConversationIndexEntry[] = [];
  private otherSidecarKeys: Record<string, unknown> = {};
  private readonly maxEntries: number;

  constructor(private readonly options: ConversationIndexOptions) {
    this.maxEntries = options.maxEntries ?? 500;
  }

  async load(): Promise<void> {
    const raw = await this.options.facade.read(this.options.indexPath);
    if (raw === null) {
      this.entries = [];
      this.otherSidecarKeys = {};
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      const decoded = JSON.parse(raw) as unknown;
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        this.entries = [];
        this.otherSidecarKeys = {};
        return;
      }
      parsed = decoded as Record<string, unknown>;
    } catch {
      this.entries = [];
      this.otherSidecarKeys = {};
      return;
    }

    const slice = parsed[SIDECAR_KEY];
    this.otherSidecarKeys = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key === SIDECAR_KEY) continue;
      this.otherSidecarKeys[key] = value;
    }

    if (!Array.isArray(slice)) {
      this.entries = [];
      return;
    }

    this.entries = slice
      .map((value) => coercePersisted(value))
      .filter((entry): entry is PersistedEntry => entry !== null)
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        topic: entry.topic,
        updatedAt: entry.updatedAt,
        embedding: entry.embedding ? safeDecode(entry.embedding) : null,
      }));
  }

  list(): ConversationIndexEntry[] {
    return [...this.entries].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async record(conversation: Conversation): Promise<void> {
    const embedding = conversation.summaryEmbeddingB64
      ? safeDecode(conversation.summaryEmbeddingB64)
      : null;
    const entry: ConversationIndexEntry = {
      id: conversation.id,
      path: conversation.notePath,
      topic: conversation.topic,
      updatedAt: conversation.updatedAt,
      embedding,
    };
    const existingIndex = this.entries.findIndex((candidate) => candidate.id === conversation.id);
    if (existingIndex >= 0) {
      this.entries[existingIndex] = entry;
    } else {
      this.entries.push(entry);
    }
    this.evictBeyondCap();
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) return;
    await this.persist();
  }

  search(
    queryEmbedding: Float32Array,
    options: { k: number; threshold: number },
  ): { entry: ConversationIndexEntry; similarity: number }[] {
    return this.entries
      .filter(
        (entry): entry is ConversationIndexEntry & { embedding: Float32Array } =>
          entry.embedding !== null,
      )
      .map((entry) => ({ entry, similarity: cosine(entry.embedding, queryEmbedding) }))
      .filter((scored) => scored.similarity >= options.threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.k);
  }

  private evictBeyondCap(): void {
    if (this.entries.length <= this.maxEntries) return;
    this.entries.sort((a, b) => b.updatedAt - a.updatedAt);
    this.entries = this.entries.slice(0, this.maxEntries);
  }

  private async persist(): Promise<void> {
    const payload: Record<string, unknown> = { ...this.otherSidecarKeys };
    payload[SIDECAR_KEY] = this.entries.map((entry) => ({
      id: entry.id,
      path: entry.path,
      topic: entry.topic,
      updatedAt: entry.updatedAt,
      embedding: entry.embedding ? encodeBase64Float32(entry.embedding) : null,
    }));
    await this.options.facade.write(this.options.indexPath, JSON.stringify(payload));
  }
}

function coercePersisted(value: unknown): PersistedEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  const path = typeof record.path === "string" ? record.path : null;
  const topic = typeof record.topic === "string" ? record.topic : null;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : null;
  if (id === null || path === null || topic === null || updatedAt === null) return null;
  const embedding = typeof record.embedding === "string" ? record.embedding : null;
  return { id, path, topic, updatedAt, embedding };
}

function safeDecode(b64: string): Float32Array | null {
  try {
    return decodeBase64Float32(b64);
  } catch {
    return null;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function decodeBase64Float32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function encodeBase64Float32(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
