import { parseConversation, serializeConversation } from "./conversationParser";
import type { Conversation } from "./types";

/**
 * Vault-native CRUD over `<vault>/Notient/conversations/`.
 *
 * The store is IO-injected: callers wire {@link ConversationStoreFacade} to
 * Obsidian's vault adapter in main.ts (Task 16) and tests use an in-memory
 * fake. Path layout: `${folder}/${YYYY-MM-DD} ${slug(topic)}.md`.
 *
 * Phase 4 Task 6 removed the legacy self-write hook. Conversation files live
 * under the indexer's exclusion list, and daemon-authored writes are now
 * cross-referenced through the SurrealDB `daemon_write` table (Task 2)
 * rather than a per-write mark.
 */

export interface ConversationStoreFacade {
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export interface ConversationStoreOptions {
  facade: ConversationStoreFacade;
  folder: string;
  now: () => number;
}

export class ConversationStore {
  constructor(private readonly options: ConversationStoreOptions) {}

  async list(): Promise<Conversation[]> {
    const paths = await this.options.facade.list(this.options.folder);
    const conversations: Conversation[] = [];
    for (const path of paths) {
      try {
        const raw = await this.options.facade.read(path);
        conversations.push(parseConversation(raw, path));
      } catch {
        // Malformed or unreadable conversation file: ignore so a single bad
        // file does not poison the whole listing.
      }
    }
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(notePath: string): Promise<Conversation> {
    const raw = await this.options.facade.read(notePath);
    return parseConversation(raw, notePath);
  }

  /**
   * Persists the conversation to the path it carries. Updates `updatedAt` to
   * the injected clock and rebases `messageCount` on the actual messages
   * array so the markdown frontmatter stays honest.
   */
  async save(conversation: Conversation): Promise<Conversation> {
    const next: Conversation = {
      ...conversation,
      updatedAt: this.options.now(),
      messageCount: conversation.messages.length,
    };
    const content = serializeConversation(next);
    await this.options.facade.write(next.notePath, content);
    return next;
  }

  /**
   * Creates a brand-new conversation file at the slug-derived path. Returns
   * the persisted Conversation including the generated `notePath`. The
   * caller supplies `id`, `model`, `topic`, etc.; the store handles
   * timestamps, path slugging, and frontmatter assembly.
   */
  async create(input: {
    id: string;
    model: string;
    pinnedContext: string[];
    approvalMode: Conversation["approvalMode"];
    topic: string;
    clientIdentity?: string;
    summary?: string;
    summaryEmbeddingB64?: string | null;
  }): Promise<Conversation> {
    const now = this.options.now();
    const path = computeConversationPath(this.options.folder, now, input.topic, input.id);
    const conversation: Conversation = {
      id: input.id,
      notePath: path,
      model: input.model,
      pinnedContext: input.pinnedContext,
      approvalMode: input.approvalMode,
      topic: input.topic,
      summary: input.summary ?? "",
      summaryEmbeddingB64: input.summaryEmbeddingB64 ?? null,
      clientIdentity: input.clientIdentity ?? "human",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    const content = serializeConversation(conversation);
    await this.options.facade.write(path, content);
    return conversation;
  }

  async delete(notePath: string): Promise<void> {
    await this.options.facade.delete(notePath);
  }
}

export function computeConversationPath(
  folder: string,
  createdAt: number,
  topic: string,
  id: string,
): string {
  return `${folder}/${formatDate(createdAt)} ${slugifyTopic(topic)} ${suffixFromId(id)}.md`;
}

export function suffixFromId(id: string): string {
  const cleaned = id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (cleaned.length === 0) return "000000";
  return cleaned.slice(0, 6).padEnd(6, "0");
}

export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "conversation";
}

function formatDate(value: number): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
