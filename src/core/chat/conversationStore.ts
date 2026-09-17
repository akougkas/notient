import {
  interruptedClaimTargetName,
  interruptedRollbackTargetName,
  isAtomicWriteTempName,
} from "../utils/atomicWrite";
import { isCanonicalConversationPath } from "../vault/publicPath";
import {
  claimsNotientConversation,
  parseConversation,
  serializeConversation,
} from "./conversationParser";
import type { Conversation } from "./types";

/**
 * Vault-native CRUD over `<vault>/Notient/conversations/`.
 *
 * The store is IO-injected: callers wire {@link ConversationStoreFacade} to
 * the filesystem vault adapter and tests use an in-memory fake. Path layout:
 * `${folder}/${YYYY-MM-DD} ${slug(topic)} ${idSuffix}.md`. Conversation files
 * live under the indexer's exclusion list and therefore never enter the note
 * graph or reset the human-activity clock.
 */

export interface ConversationStoreFacade {
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  createIfAbsent(path: string, content: string): Promise<boolean>;
  writeIfUnchanged(path: string, expected: string, content: string): Promise<boolean>;
  removeIfUnchanged(path: string, expected: string): Promise<boolean>;
}

export interface ConversationStoreOptions {
  facade: ConversationStoreFacade;
  folder: string;
  now: () => number;
}

export class ConversationStore {
  private readonly mutationTails = new Map<string, Promise<void>>();
  /** Held while `list` scans; mutations that begin later wait for it. */
  private listGate: Promise<void> = Promise.resolve();

  constructor(private readonly options: ConversationStoreOptions) {}

  /**
   * A guarded replacement briefly renames its target away, so a scan racing
   * this store's own save would miss that conversation. The scan therefore
   * waits for mutations already queued and holds back later ones.
   */
  async list(): Promise<Conversation[]> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.listGate = this.listGate.then(() => held);
    try {
      await Promise.all(this.mutationTails.values());
      return await this.listUnlocked();
    } finally {
      release();
    }
  }

  private async listUnlocked(): Promise<Conversation[]> {
    const paths = await this.options.facade.list(this.options.folder);
    const conversations: Conversation[] = [];
    const seenPaths = new Set<string>();
    const seenIds = new Map<string, string>();
    for (const path of paths) {
      // A concurrent guarded write (the post-answer memory refresh) briefly
      // leaves the vault writer's own artifact beside its target.
      if (isWriterArtifact(path)) continue;
      this.assertOwnedPath(path);
      if (seenPaths.has(path)) {
        throw new Error(`conversation storage integrity: duplicate path '${path}'`);
      }
      seenPaths.add(path);
      const raw = await this.options.facade.read(path);
      if (!claimsNotientConversation(raw)) continue;
      try {
        const conversation = parseConversation(raw, path);
        const priorPath = seenIds.get(conversation.id);
        if (priorPath !== undefined) {
          throw new Error(
            `duplicate conversation id '${conversation.id}' in '${priorPath}' and '${path}'`,
          );
        }
        seenIds.set(conversation.id, path);
        conversations.push(conversation);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new Error(`invalid Notient conversation '${path}': ${error.message}`, {
          cause: error,
        });
      }
    }
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(notePath: string): Promise<Conversation> {
    this.assertOwnedPath(notePath);
    return this.serializeMutation(notePath, async () =>
      parseConversation(await this.options.facade.read(notePath), notePath),
    );
  }

  /**
   * Persists the conversation to the path it carries. Updates `updatedAt` to
   * the injected clock and rebases `messageCount` on the actual messages
   * array so the markdown frontmatter stays honest.
   */
  async save(base: Conversation, next: Conversation): Promise<Conversation> {
    this.assertOwnedPath(base.notePath);
    assertSaveTransition(base, next);
    return this.serializeMutation(base.notePath, () => this.saveUnlocked(base, next));
  }

  /**
   * Replace only the summary on the latest canonical transcript. Foreground
   * turn saves and background summary refreshes share the same per-file lane,
   * so an older refresh can never overwrite messages from a newer turn.
   */
  async updateSummary(
    notePath: string,
    conversationId: string,
    summary: string,
  ): Promise<Conversation> {
    this.assertOwnedPath(notePath);
    return this.serializeMutation(notePath, async () => {
      const latest = parseConversation(await this.options.facade.read(notePath), notePath);
      if (latest.id !== conversationId) {
        throw new Error(
          `conversation id mismatch at '${notePath}': expected '${conversationId}', found '${latest.id}'`,
        );
      }
      return this.saveUnlocked(latest, { ...latest, summary });
    });
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
    clientIdentity: string;
  }): Promise<Conversation> {
    const now = this.options.now();
    const path = computeConversationPath(this.options.folder, now, input.topic, input.id);
    this.assertOwnedPath(path);
    const conversation: Conversation = {
      id: input.id,
      notePath: path,
      model: input.model,
      pinnedContext: input.pinnedContext,
      approvalMode: input.approvalMode,
      topic: input.topic,
      summary: "",
      clientIdentity: input.clientIdentity,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    return this.serializeMutation(path, async () => {
      const content = serializeConversation(conversation);
      if (!(await this.options.facade.createIfAbsent(path, content))) {
        throw conversationConflict(path);
      }
      return conversation;
    });
  }

  async delete(notePath: string): Promise<void> {
    this.assertOwnedPath(notePath);
    await this.serializeMutation(notePath, async () => {
      const expected = await this.options.facade.read(notePath);
      if (!(await this.options.facade.removeIfUnchanged(notePath, expected))) {
        throw conversationConflict(notePath);
      }
    });
  }

  private async saveUnlocked(
    base: Conversation,
    conversation: Conversation,
  ): Promise<Conversation> {
    const expected = await this.options.facade.read(base.notePath);
    const current = parseConversation(expected, base.notePath);
    assertSameIdentity(base, current);
    if (!samePersistedBaseRevision(base, current)) {
      throw conversationConflict(base.notePath);
    }
    const next: Conversation = {
      ...conversation,
      // A summary refresh is allowed to land while a foreground turn is
      // running. Preserve it when this caller did not intentionally change
      // the summary; transcript divergence remains a hard conflict.
      summary: conversation.summary === base.summary ? current.summary : conversation.summary,
      // The revision must advance even when the wall clock has not. Otherwise
      // two stale callers can carry the same timestamp and both appear current.
      updatedAt: Math.max(this.options.now(), current.updatedAt + 1),
      messageCount: conversation.messages.length,
    };
    const content = serializeConversation(next);
    if (!(await this.options.facade.writeIfUnchanged(next.notePath, expected, content))) {
      throw conversationConflict(next.notePath);
    }
    return next;
  }

  private async serializeMutation<T>(notePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(notePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTails.set(notePath, current);
    const scan = this.listGate;
    await previous;
    await scan;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(notePath) === current) this.mutationTails.delete(notePath);
    }
  }

  private assertOwnedPath(notePath: string): void {
    if (this.options.folder !== "Notient/conversations" || !isCanonicalConversationPath(notePath)) {
      throw new Error(
        `conversation storage integrity: path is outside '${this.options.folder}': '${notePath}'`,
      );
    }
  }
}

function isWriterArtifact(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    isAtomicWriteTempName(name) ||
    interruptedClaimTargetName(name) !== null ||
    interruptedRollbackTargetName(name) !== null
  );
}

function canonicalTranscript(conversation: Conversation): string {
  const serialized = serializeConversation(conversation);
  const frontmatterEnd = serialized.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) throw new Error("conversation serialization lost its frontmatter");
  return serialized.slice(frontmatterEnd + "\n---\n".length);
}

function assertSameIdentity(base: Conversation, next: Conversation): void {
  if (
    base.id !== next.id ||
    base.notePath !== next.notePath ||
    base.createdAt !== next.createdAt ||
    base.clientIdentity !== next.clientIdentity
  ) {
    throw new Error("conversation save cannot change persisted identity");
  }
}

function assertSaveTransition(base: Conversation, next: Conversation): void {
  assertSameIdentity(base, next);
  if (
    base.model !== next.model ||
    base.approvalMode !== next.approvalMode ||
    base.topic !== next.topic
  ) {
    throw new Error("conversation save cannot change persisted configuration");
  }
}

function samePersistedBaseRevision(base: Conversation, current: Conversation): boolean {
  return (
    base.model === current.model &&
    base.approvalMode === current.approvalMode &&
    base.topic === current.topic &&
    base.messageCount === current.messageCount &&
    base.updatedAt <= current.updatedAt &&
    sameStrings(base.pinnedContext, current.pinnedContext) &&
    canonicalTranscript(base) === canonicalTranscript(current)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function conversationConflict(notePath: string): Error {
  return new Error(`conversation changed during guarded mutation: ${notePath}`);
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
