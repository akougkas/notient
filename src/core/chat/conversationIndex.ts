import { DateTime, RecordId, type Surreal } from "surrealdb";
import { isCanonicalAgentId } from "../auth/agentIdentity";
import { isExactRecord, readSingleStatementRows } from "../db/queryResult";
import type { EmbeddingIdentity } from "../llm/embeddingIdentity";
import type { Conversation } from "./types";

/**
 * Metadata for one conversation summary in the derived semantic index.
 *
 * Conversation Markdown remains canonical. SurrealDB stores only the native
 * vector and enough provenance to prove which canonical summary produced it.
 */
export interface ConversationMemoryEntry {
  id: string;
  path: string;
  topic: string;
  clientIdentity: string;
  updatedAt: number;
  summaryHash: string;
  embedModel: string;
  dimension: number;
}

export interface ConversationMemoryMatch {
  entry: ConversationMemoryEntry;
  similarity: number;
}

/** The narrow dependency consumed by chat orchestration and context assembly. */
export interface ConversationMemory {
  list(): Promise<ConversationMemoryEntry[]>;
  record(conversation: Conversation, embedding: Float32Array | null): Promise<void>;
  remove(id: string): Promise<void>;
  reconcile(conversations: readonly Conversation[]): Promise<void>;
  search(
    queryEmbedding: Float32Array,
    options: { k: number; threshold: number; clientIdentity: string },
  ): Promise<ConversationMemoryMatch[]>;
}

export interface ConversationIndexOptions {
  db: Surreal;
  /** The boot-resolved vector space. A null width disables semantic memory. */
  identity: EmbeddingIdentity;
  /** Maximum semantic rows retained, newest canonical conversations first. */
  maxEntries?: number;
}

interface DecodedMemoryRow {
  recordId: RecordId<"conversation_memory">;
  entry: ConversationMemoryEntry;
  vector: number[];
}

interface DecodedSearchRow extends DecodedMemoryRow {
  similarity: number;
}

const ROW_PROJECTION =
  "id, conversation_id, path, topic, client_identity, updated_at, summary_hash, embed_model, vector, array::len(vector) AS dimension";
const ENTRY_ROW_KEYS = [
  "id",
  "conversation_id",
  "path",
  "topic",
  "client_identity",
  "updated_at",
  "summary_hash",
  "embed_model",
  "vector",
  "dimension",
] as const;
const SEARCH_ROW_KEYS = [...ENTRY_ROW_KEYS, "similarity"] as const;
const SUMMARY_HASH_RE = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_ENTRIES = 500;

export class ConversationMemoryIntegrityError extends Error {
  constructor(message: string) {
    super(`conversation memory storage integrity failure: ${message}`);
    this.name = "ConversationMemoryIntegrityError";
  }
}

export class ConversationMemoryUnavailableError extends Error {
  constructor(model: string) {
    super(
      `conversation memory is unavailable because embedding model '${model}' has no resolved dimension`,
    );
    this.name = "ConversationMemoryUnavailableError";
  }
}

/**
 * Strict SurrealDB-backed semantic index for conversation summaries.
 *
 * There is deliberately no file sidecar, base64 codec, startup migration, or
 * in-memory shadow copy. Every search reads the canonical derived table, and
 * every retained row must match the exact boot model, vector width, and SHA-256
 * of the summary currently stored in Markdown.
 */
export class ConversationIndex implements ConversationMemory {
  private readonly db: Surreal;
  private readonly identity: EmbeddingIdentity;
  private readonly maxEntries: number;

  constructor(options: ConversationIndexOptions) {
    if (!Number.isSafeInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
      throw new Error("ConversationIndex maxEntries must be a positive integer");
    }
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (this.maxEntries <= 0) {
      throw new Error("ConversationIndex maxEntries must be a positive integer");
    }
    if (
      (options.identity.model.length === 0 && options.identity.dimension !== null) ||
      options.identity.model.trim() !== options.identity.model
    ) {
      throw new Error("ConversationIndex embedding model must be a canonical non-empty string");
    }
    if (
      options.identity.dimension !== null &&
      (!Number.isSafeInteger(options.identity.dimension) || options.identity.dimension <= 0)
    ) {
      throw new Error(
        "ConversationIndex embedding dimension must be a positive safe integer or null",
      );
    }
    this.db = options.db;
    this.identity = options.identity;
  }

  async list(): Promise<ConversationMemoryEntry[]> {
    const rows = await this.readAllStoredRows();
    this.assertActiveRows(rows, "list");
    assertOwnerCaps(rows, this.maxEntries, "list");
    return rows.map((row) => row.entry);
  }

  /**
   * Upsert one proven embedding, or retain an existing row only when its
   * model, width, and summary hash still match. A null embedding never creates
   * semantic data and deletes any stale row for the conversation.
   */
  async record(conversation: Conversation, embedding: Float32Array | null): Promise<void> {
    validateConversationMetadata(conversation);
    const recordId = conversationRecordId(conversation.id);
    const dimension = this.identity.dimension;

    if (conversation.summary.length === 0 || dimension === null) {
      await this.deleteRecord(recordId, "invalidate conversation memory");
      return;
    }

    const summaryHash = await hashConversationSummary(conversation.summary);
    if (embedding === null) {
      const current = await this.readOne(recordId);
      if (
        current === null ||
        current.entry.summaryHash !== summaryHash ||
        current.entry.embedModel !== this.identity.model ||
        current.entry.dimension !== dimension ||
        current.entry.clientIdentity !== conversation.clientIdentity
      ) {
        await this.deleteRecord(recordId, "invalidate unproven conversation memory");
        return;
      }
      await this.updateMetadata(recordId, conversation);
      return;
    }

    validateVector(embedding, dimension, "conversation summary embedding");
    const result: unknown = await this.db
      .query(
        `UPSERT $recordId CONTENT {
          conversation_id: $conversationId,
          path: $path,
          topic: $topic,
          client_identity: $clientIdentity,
          updated_at: $updatedAt,
          summary_hash: $summaryHash,
          embed_model: $embedModel,
          vector: $vector
        } RETURN NONE;`,
        {
          recordId,
          conversationId: conversation.id,
          path: conversation.notePath,
          topic: conversation.topic,
          clientIdentity: conversation.clientIdentity,
          updatedAt: toStoredDateTime(conversation.updatedAt),
          summaryHash,
          embedModel: this.identity.model,
          vector: Array.from(embedding),
        },
      )
      .collect();
    readNoRows(result, "record upsert");
    const stored = await this.readOne(recordId);
    if (stored === null) {
      throw new ConversationMemoryIntegrityError("record upsert did not persist the requested row");
    }
    assertPersistedWrite(
      stored,
      conversation,
      summaryHash,
      this.identity.model,
      dimension,
      embedding,
    );
    await this.evictBeyondCap(conversation.clientIdentity);
  }

  async remove(id: string): Promise<void> {
    await this.deleteRecord(conversationRecordId(id), "remove conversation memory");
  }

  /**
   * Reconcile derived rows against the canonical Markdown conversations.
   * Missing, duplicate, empty, corrupt, wrong-model, wrong-width, and
   * wrong-summary rows are never accepted as memory.
   */
  async reconcile(conversations: readonly Conversation[]): Promise<void> {
    const canonical = new Map<string, Conversation>();
    const canonicalPaths = new Set<string>();
    for (const conversation of conversations) {
      validateConversationMetadata(conversation);
      if (canonical.has(conversation.id)) {
        throw new Error(`duplicate canonical conversation id '${conversation.id}'`);
      }
      if (canonicalPaths.has(conversation.notePath)) {
        throw new Error(`duplicate canonical conversation path '${conversation.notePath}'`);
      }
      canonical.set(conversation.id, conversation);
      canonicalPaths.add(conversation.notePath);
    }

    if (this.identity.dimension === null) {
      const result: unknown = await this.db
        .query("DELETE conversation_memory RETURN NONE;")
        .collect();
      readNoRows(result, "clear unresolved embedding memory");
      return;
    }

    const entries = await this.readAllStoredRows();
    for (const { entry } of entries) {
      const conversation = canonical.get(entry.id);
      if (conversation === undefined || conversation.summary.length === 0) {
        await this.remove(entry.id);
        continue;
      }
      const hash = await hashConversationSummary(conversation.summary);
      if (
        entry.summaryHash !== hash ||
        entry.embedModel !== this.identity.model ||
        entry.dimension !== this.identity.dimension ||
        entry.clientIdentity !== conversation.clientIdentity
      ) {
        await this.remove(entry.id);
        continue;
      }
      await this.updateMetadata(conversationRecordId(entry.id), conversation);
    }
    for (const clientIdentity of new Set(
      conversations.map((conversation) => conversation.clientIdentity),
    )) {
      await this.evictBeyondCap(clientIdentity);
    }
  }

  async search(
    queryEmbedding: Float32Array,
    options: { k: number; threshold: number; clientIdentity: string },
  ): Promise<ConversationMemoryMatch[]> {
    const dimension = this.identity.dimension;
    if (dimension === null) {
      throw new ConversationMemoryUnavailableError(this.identity.model);
    }
    validateVector(queryEmbedding, dimension, "conversation memory query");
    if (!Number.isSafeInteger(options.k) || options.k <= 0) {
      throw new Error("conversation memory search k must be a positive integer");
    }
    if (!Number.isFinite(options.threshold) || options.threshold < -1 || options.threshold > 1) {
      throw new Error("conversation memory search threshold must be between -1 and 1");
    }
    validateClientIdentity(options.clientIdentity, "conversation memory search clientIdentity");

    const result: unknown = await this.db
      .query(
        `SELECT ${ROW_PROJECTION}, vector::similarity::cosine(vector, $query) AS similarity
         FROM conversation_memory
         WHERE client_identity = $clientIdentity
           AND embed_model = $embedModel
           AND array::len(vector) = $dimension
           AND vector::similarity::cosine(vector, $query) >= $threshold
         ORDER BY similarity DESC, updated_at DESC, conversation_id ASC
         LIMIT $limit;`,
        {
          query: Array.from(queryEmbedding),
          clientIdentity: options.clientIdentity,
          embedModel: this.identity.model,
          dimension,
          threshold: options.threshold,
          limit: options.k,
        },
      )
      .collect();
    const rows = decodeSearchRows(result, "search");
    if (rows.length > options.k) {
      throw new ConversationMemoryIntegrityError(
        `search returned ${rows.length} rows beyond requested limit ${options.k}`,
      );
    }
    this.assertActiveRows(rows, "search");
    for (const row of rows) {
      if (row.entry.clientIdentity !== options.clientIdentity) {
        throw new ConversationMemoryIntegrityError(
          `search returned conversation ${row.entry.id} owned by ${row.entry.clientIdentity}, expected ${options.clientIdentity}`,
        );
      }
      if (row.similarity < options.threshold) {
        throw new ConversationMemoryIntegrityError(
          `search returned similarity ${row.similarity} below threshold ${options.threshold}`,
        );
      }
    }
    assertSearchOrder(rows, "search");
    return rows.map(({ entry, similarity }) => ({ entry, similarity }));
  }

  private async readOne(
    recordId: RecordId<"conversation_memory">,
  ): Promise<DecodedMemoryRow | null> {
    const result: unknown = await this.db
      .query(`SELECT ${ROW_PROJECTION} FROM $recordId LIMIT 1;`, { recordId })
      .collect();
    const rows = decodeMemoryRows(result, "read one");
    if (rows.length > 1) {
      throw new ConversationMemoryIntegrityError("read one returned more than one LIMIT row");
    }
    const row = rows[0];
    if (row !== undefined && row.recordId.toString() !== recordId.toString()) {
      throw new ConversationMemoryIntegrityError("read one returned a different record id");
    }
    return row ?? null;
  }

  private async updateMetadata(
    recordId: RecordId<"conversation_memory">,
    conversation: Conversation,
  ): Promise<void> {
    const result: unknown = await this.db
      .query(
        "UPDATE $recordId SET path = $path, topic = $topic, client_identity = $clientIdentity, updated_at = $updatedAt RETURN NONE;",
        {
          recordId,
          path: conversation.notePath,
          topic: conversation.topic,
          clientIdentity: conversation.clientIdentity,
          updatedAt: toStoredDateTime(conversation.updatedAt),
        },
      )
      .collect();
    readNoRows(result, "metadata update");
    const stored = await this.readOne(recordId);
    if (
      stored === null ||
      stored.entry.path !== conversation.notePath ||
      stored.entry.topic !== conversation.topic ||
      stored.entry.clientIdentity !== conversation.clientIdentity ||
      stored.entry.updatedAt !== conversation.updatedAt
    ) {
      throw new ConversationMemoryIntegrityError(
        "metadata update did not persist the canonical Markdown metadata",
      );
    }
  }

  private async evictBeyondCap(clientIdentity: string): Promise<void> {
    validateClientIdentity(clientIdentity, "conversation memory eviction clientIdentity");
    const result: unknown = await this.db
      .query(
        `SELECT ${ROW_PROJECTION} FROM conversation_memory
         WHERE client_identity = $clientIdentity
         ORDER BY updated_at DESC, conversation_id ASC START $offset;`,
        { clientIdentity, offset: this.maxEntries },
      )
      .collect();
    const rows = decodeMemoryRows(result, "eviction selection");
    assertEntryOrder(rows, "eviction selection");
    for (const row of rows) {
      if (row.entry.clientIdentity !== clientIdentity) {
        throw new ConversationMemoryIntegrityError(
          `eviction selection returned conversation ${row.entry.id} owned by ${row.entry.clientIdentity}, expected ${clientIdentity}`,
        );
      }
      await this.deleteRecord(row.recordId, "evict conversation memory");
    }
  }

  private async readAllStoredRows(): Promise<DecodedMemoryRow[]> {
    const result: unknown = await this.db
      .query(
        `SELECT ${ROW_PROJECTION} FROM conversation_memory
         ORDER BY updated_at DESC, conversation_id ASC;`,
      )
      .collect();
    const rows = decodeMemoryRows(result, "list");
    assertEntryOrder(rows, "list");
    return rows;
  }

  private assertActiveRows(rows: readonly DecodedMemoryRow[], operation: string): void {
    const dimension = this.identity.dimension;
    if (dimension === null) {
      if (rows.length > 0) {
        throw new ConversationMemoryIntegrityError(
          `${operation} returned semantic rows while embedding dimension is unresolved`,
        );
      }
      return;
    }
    for (const row of rows) {
      if (row.entry.embedModel !== this.identity.model) {
        throw new ConversationMemoryIntegrityError(
          `${operation} row ${row.entry.id} belongs to embedding model ${row.entry.embedModel}, expected ${this.identity.model}`,
        );
      }
      if (row.entry.dimension !== dimension) {
        throw new ConversationMemoryIntegrityError(
          `${operation} row ${row.entry.id} has vector dimension ${row.entry.dimension}, expected ${dimension}`,
        );
      }
    }
  }

  private async deleteRecord(
    recordId: RecordId<"conversation_memory">,
    operation: string,
  ): Promise<void> {
    const result: unknown = await this.db
      .query("DELETE $recordId RETURN NONE;", { recordId })
      .collect();
    readNoRows(result, operation);
  }
}

export async function hashConversationSummary(summary: string): Promise<string> {
  if (typeof summary !== "string") {
    throw new Error("conversation summary must be a string");
  }
  const bytes = new TextEncoder().encode(summary);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function conversationRecordId(id: string): RecordId<"conversation_memory"> {
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id || hasControlCharacter(id)) {
    throw new Error("conversation id must be a canonical non-empty string");
  }
  return new RecordId("conversation_memory", id);
}

function validateConversationMetadata(conversation: Conversation): void {
  conversationRecordId(conversation.id);
  if (
    typeof conversation.notePath !== "string" ||
    !isCanonicalMarkdownPath(conversation.notePath)
  ) {
    throw new Error("conversation path must be a canonical vault-relative Markdown path");
  }
  if (
    typeof conversation.topic !== "string" ||
    conversation.topic.includes("\n") ||
    conversation.topic.includes("\r")
  ) {
    throw new Error("conversation topic must be a single-line string");
  }
  if (typeof conversation.summary !== "string") {
    throw new Error("conversation summary must be a string");
  }
  validateClientIdentity(conversation.clientIdentity, "conversation clientIdentity");
  toStoredDateTime(conversation.updatedAt);
}

function validateClientIdentity(value: unknown, label: string): asserts value is string {
  if (!isCanonicalAgentId(value)) {
    throw new Error(`${label} must be a canonical client identity`);
  }
}

function validateVector(vector: Float32Array, dimension: number, label: string): void {
  if (!(vector instanceof Float32Array)) {
    throw new Error(`${label} must be a Float32Array`);
  }
  if (vector.length !== dimension) {
    throw new Error(`${label} has width ${vector.length}; expected ${dimension}`);
  }
  let hasMagnitude = false;
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite value`);
    }
    if (value !== 0) hasMagnitude = true;
  }
  if (!hasMagnitude) {
    throw new Error(`${label} must have non-zero magnitude`);
  }
}

function toStoredDateTime(milliseconds: number): DateTime {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("conversation updatedAt must be a non-negative safe integer");
  }
  const date = new Date(milliseconds);
  if (date.getTime() !== milliseconds) {
    throw new Error("conversation updatedAt must be representable as a valid datetime");
  }
  return new DateTime(date);
}

function decodeMemoryRows(raw: unknown, operation: string): DecodedMemoryRow[] {
  const rows = readStorageRows(raw, operation);
  const decoded = rows.map((row, index) => readMemoryRow(row, operation, index));
  assertUniqueRows(decoded, operation);
  return decoded;
}

function decodeSearchRows(raw: unknown, operation: string): DecodedSearchRow[] {
  const rows = readStorageRows(raw, operation);
  const decoded = rows.map((row, index) => readSearchRow(row, operation, index));
  assertUniqueRows(decoded, operation);
  return decoded;
}

function readStorageRows(raw: unknown, operation: string): unknown[] {
  try {
    return readSingleStatementRows(raw, `conversation memory ${operation}`);
  } catch {
    throw new ConversationMemoryIntegrityError(
      `${operation} returned an invalid single-statement result envelope`,
    );
  }
}

function readNoRows(raw: unknown, operation: string): void {
  const rows = readStorageRows(raw, operation);
  if (rows.length !== 0) {
    throw new ConversationMemoryIntegrityError(
      `${operation} returned rows for a RETURN NONE mutation`,
    );
  }
}

function readMemoryRow(raw: unknown, operation: string, index: number): DecodedMemoryRow {
  if (!isExactRecord(raw, ENTRY_ROW_KEYS)) {
    throw new ConversationMemoryIntegrityError(
      `${operation} row ${index} must contain exactly ${ENTRY_ROW_KEYS.join(", ")}`,
    );
  }
  return readMemoryFields(raw, `${operation} row ${index}`);
}

function readSearchRow(raw: unknown, operation: string, index: number): DecodedSearchRow {
  if (!isExactRecord(raw, SEARCH_ROW_KEYS)) {
    throw new ConversationMemoryIntegrityError(
      `${operation} row ${index} must contain exactly ${SEARCH_ROW_KEYS.join(", ")}`,
    );
  }
  return {
    ...readMemoryFields(raw, `${operation} row ${index}`),
    similarity: readSimilarity(raw.similarity, `${operation} row ${index}.similarity`),
  };
}

function readMemoryFields(row: Record<string, unknown>, label: string): DecodedMemoryRow {
  const id = readCanonicalString(row.conversation_id, `${label}.conversation_id`);
  const expectedId = conversationRecordId(id);
  if (!isMatchingRecordId(row.id, expectedId)) {
    throw new ConversationMemoryIntegrityError(
      `${label}.id must be the native conversation_memory record keyed by conversation_id`,
    );
  }
  const recordId = row.id;
  const path = readCanonicalString(row.path, `${label}.path`);
  if (!isCanonicalMarkdownPath(path)) {
    throw new ConversationMemoryIntegrityError(
      `${label}.path must be a canonical vault-relative Markdown path`,
    );
  }
  const topic = readString(row.topic, `${label}.topic`);
  if (topic.includes("\n") || topic.includes("\r")) {
    throw new ConversationMemoryIntegrityError(`${label}.topic must be a single-line string`);
  }
  const clientIdentity = readCanonicalString(row.client_identity, `${label}.client_identity`);
  if (!isCanonicalAgentId(clientIdentity)) {
    throw new ConversationMemoryIntegrityError(
      `${label}.client_identity must be a canonical client identity`,
    );
  }
  const updatedAt = readStoredDateTime(row.updated_at, `${label}.updated_at`);
  const summaryHash = readCanonicalString(row.summary_hash, `${label}.summary_hash`);
  if (!SUMMARY_HASH_RE.test(summaryHash)) {
    throw new ConversationMemoryIntegrityError(
      `${label}.summary_hash must be lowercase SHA-256 hex`,
    );
  }
  const embedModel = readCanonicalString(row.embed_model, `${label}.embed_model`);
  const dimension = readPositiveInteger(row.dimension, `${label}.dimension`);
  const vector = readStoredVector(row.vector, `${label}.vector`);
  if (vector.length !== dimension) {
    throw new ConversationMemoryIntegrityError(
      `${label}.dimension ${dimension} does not match native vector width ${vector.length}`,
    );
  }
  return {
    recordId,
    entry: { id, path, topic, clientIdentity, updatedAt, summaryHash, embedModel, dimension },
    vector,
  };
}

function isMatchingRecordId(
  raw: unknown,
  expected: RecordId<"conversation_memory">,
): raw is RecordId<"conversation_memory"> {
  return raw instanceof RecordId && raw.toString() === expected.toString();
}

function readString(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ConversationMemoryIntegrityError(`${field} must be a string`);
  }
  return raw;
}

function readCanonicalString(raw: unknown, field: string): string {
  const value = readString(raw, field);
  if (value.length === 0 || value.trim() !== value) {
    throw new ConversationMemoryIntegrityError(`${field} must be a canonical non-empty string`);
  }
  return value;
}

function readPositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new ConversationMemoryIntegrityError(`${field} must be a positive safe integer`);
  }
  return raw;
}

function readStoredDateTime(raw: unknown, field: string): number {
  if (!(raw instanceof DateTime)) {
    throw new ConversationMemoryIntegrityError(`${field} must be a native SurrealDB datetime`);
  }
  const milliseconds = raw.toDate().getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new ConversationMemoryIntegrityError(`${field} must be a valid non-negative datetime`);
  }
  return milliseconds;
}

function readStoredVector(raw: unknown, field: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConversationMemoryIntegrityError(`${field} must be a non-empty native vector`);
  }
  let hasMagnitude = false;
  const vector = raw.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ConversationMemoryIntegrityError(`${field}[${index}] must be finite`);
    }
    if (value !== 0) hasMagnitude = true;
    return value;
  });
  if (!hasMagnitude) {
    throw new ConversationMemoryIntegrityError(`${field} must have non-zero magnitude`);
  }
  return vector;
}

function readSimilarity(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < -1 || raw > 1) {
    throw new ConversationMemoryIntegrityError(
      `${field} must be a finite cosine score between -1 and 1`,
    );
  }
  return raw;
}

function assertUniqueRows(rows: readonly DecodedMemoryRow[], operation: string): void {
  const recordIds = new Set<string>();
  const conversationIds = new Set<string>();
  const paths = new Set<string>();
  for (const row of rows) {
    const recordId = row.recordId.toString();
    if (recordIds.has(recordId)) {
      throw new ConversationMemoryIntegrityError(
        `${operation} returned duplicate record ${recordId}`,
      );
    }
    if (conversationIds.has(row.entry.id)) {
      throw new ConversationMemoryIntegrityError(
        `${operation} returned duplicate conversation_id ${row.entry.id}`,
      );
    }
    if (paths.has(row.entry.path)) {
      throw new ConversationMemoryIntegrityError(
        `${operation} returned duplicate conversation path ${row.entry.path}`,
      );
    }
    recordIds.add(recordId);
    conversationIds.add(row.entry.id);
    paths.add(row.entry.path);
  }
}

function assertOwnerCaps(
  rows: readonly DecodedMemoryRow[],
  maxEntries: number,
  operation: string,
): void {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const count = (counts.get(row.entry.clientIdentity) ?? 0) + 1;
    counts.set(row.entry.clientIdentity, count);
    if (count > maxEntries) {
      throw new ConversationMemoryIntegrityError(
        `${operation} returned ${count} rows for client ${row.entry.clientIdentity} beyond the configured per-client cap ${maxEntries}`,
      );
    }
  }
}

function assertEntryOrder(rows: readonly DecodedMemoryRow[], operation: string): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareEntryRows(previous, current) > 0
    ) {
      throw new ConversationMemoryIntegrityError(
        `${operation} rows are not ordered by updated_at DESC, conversation_id ASC`,
      );
    }
  }
}

function assertSearchOrder(rows: readonly DecodedSearchRow[], operation: string): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareSearchRows(previous, current) > 0
    ) {
      throw new ConversationMemoryIntegrityError(
        `${operation} rows are not ordered by similarity DESC, updated_at DESC, conversation_id ASC`,
      );
    }
  }
}

function compareEntryRows(left: DecodedMemoryRow, right: DecodedMemoryRow): number {
  if (left.entry.updatedAt !== right.entry.updatedAt) {
    return left.entry.updatedAt > right.entry.updatedAt ? -1 : 1;
  }
  return compareCanonicalStrings(left.entry.id, right.entry.id);
}

function compareSearchRows(left: DecodedSearchRow, right: DecodedSearchRow): number {
  if (left.similarity !== right.similarity) return left.similarity > right.similarity ? -1 : 1;
  return compareEntryRows(left, right);
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertPersistedWrite(
  stored: DecodedMemoryRow,
  conversation: Conversation,
  summaryHash: string,
  embedModel: string,
  dimension: number,
  embedding: Float32Array,
): void {
  const { entry } = stored;
  const metadataMatches =
    entry.id === conversation.id &&
    entry.path === conversation.notePath &&
    entry.topic === conversation.topic &&
    entry.updatedAt === conversation.updatedAt &&
    entry.summaryHash === summaryHash &&
    entry.embedModel === embedModel &&
    entry.dimension === dimension;
  const vectorMatches =
    stored.vector.length === embedding.length &&
    stored.vector.every((value, index) => value === embedding[index]);
  if (!metadataMatches || !vectorMatches) {
    throw new ConversationMemoryIntegrityError(
      "record upsert did not preserve the exact canonical metadata and embedding",
    );
  }
}

function isCanonicalMarkdownPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /^[a-zA-Z]:/.test(value) ||
    !value.endsWith(".md") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && segment.trim() === segment,
    );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
