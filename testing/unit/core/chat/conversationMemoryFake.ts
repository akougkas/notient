import {
  type ConversationMemory,
  type ConversationMemoryEntry,
  type ConversationMemoryMatch,
  hashConversationSummary,
} from "../../../../src/core/chat/conversationIndex";
import type { Conversation } from "../../../../src/core/chat/types";

interface StoredConversationMemory {
  entry: ConversationMemoryEntry;
  vector: Float32Array;
}

/** Deterministic semantic-memory test double; production tests cover the DAL itself. */
export class InMemoryConversationMemory implements ConversationMemory {
  readonly records: Array<{ conversation: Conversation; embedding: Float32Array | null }> = [];
  readonly removals: string[] = [];
  private readonly rows = new Map<string, StoredConversationMemory>();

  constructor(
    private readonly model = "test-embedding-model",
    private readonly dimension = 4,
  ) {}

  async list(): Promise<ConversationMemoryEntry[]> {
    return [...this.rows.values()]
      .map((row) => row.entry)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async record(conversation: Conversation, embedding: Float32Array | null): Promise<void> {
    this.records.push({ conversation, embedding });
    const summaryHash = await hashConversationSummary(conversation.summary);
    if (embedding === null) {
      const current = this.rows.get(conversation.id);
      if (current?.entry.summaryHash !== summaryHash) this.rows.delete(conversation.id);
      return;
    }
    if (embedding.length !== this.dimension) {
      throw new Error(`test conversation embedding width ${embedding.length} != ${this.dimension}`);
    }
    this.rows.set(conversation.id, {
      entry: {
        id: conversation.id,
        path: conversation.notePath,
        topic: conversation.topic,
        clientIdentity: conversation.clientIdentity,
        updatedAt: conversation.updatedAt,
        summaryHash,
        embedModel: this.model,
        dimension: this.dimension,
      },
      vector: new Float32Array(embedding),
    });
  }

  async remove(id: string): Promise<void> {
    this.removals.push(id);
    this.rows.delete(id);
  }

  async reconcile(conversations: readonly Conversation[]): Promise<void> {
    const canonical = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    for (const [id, row] of this.rows) {
      const conversation = canonical.get(id);
      if (
        conversation === undefined ||
        row.entry.summaryHash !== (await hashConversationSummary(conversation.summary))
      ) {
        this.rows.delete(id);
      }
    }
  }

  async search(
    queryEmbedding: Float32Array,
    options: { k: number; threshold: number; clientIdentity: string },
  ): Promise<ConversationMemoryMatch[]> {
    return [...this.rows.values()]
      .filter((row) => row.entry.clientIdentity === options.clientIdentity)
      .map((row) => ({ entry: row.entry, similarity: cosine(row.vector, queryEmbedding) }))
      .filter((match) => match.similarity >= options.threshold)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, options.k);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
