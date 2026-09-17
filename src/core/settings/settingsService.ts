import { createHash } from "node:crypto";
import { type BackgroundSettings, backgroundSchema } from "../../api/background";
import { type ChatBudget, type ChatConfigureResult, chatBudgetSchema } from "../../api/chat";
import { NoteApiError } from "../../api/schema";
import {
  type SettingsChangeEntry,
  type SettingsTransaction,
  requireSameRequest,
  settingsRequest,
} from "./changeJournal";
import { deepFreeze, parseNotientConfig } from "./configSchema";
import type { NotientConfig, NotientSettings } from "./types";

export interface ProductConfigPersistence {
  config: NotientConfig;
  load: () => Promise<string | null>;
  compareAndSwap: (
    before: string | null,
    after: string,
    authorize?: () => void | Promise<void>,
  ) => Promise<boolean>;
}

/**
 * Runtime owner of product settings. Each snapshot stays immutable; validated
 * updates replace it only after the existing config file commits. Deployment
 * environment and resolved model identity retain their existing precedence.
 */
export class SettingsService {
  private snapshot: NotientSettings;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(
    snapshot: NotientSettings,
    private readonly persistence?: ProductConfigPersistence,
  ) {
    this.snapshot = deepFreeze(snapshot);
  }

  get(): NotientSettings {
    return this.snapshot;
  }
  background(): { revision: string; settings: BackgroundSettings } {
    return { revision: revision(this.snapshot.background), settings: this.snapshot.background };
  }
  onBackgroundChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  updateBackground(
    next: unknown,
    expectedRevision: string,
    transaction?: SettingsTransaction,
  ): Promise<{ ok: true; revision: string; settings: BackgroundSettings; replayed: boolean }> {
    return this.updateSection(
      {
        read: (config) => config.background,
        parse: (value) => backgroundSchema.safeParse(value),
        write: (config, background) => ({ ...config, background }),
        adopt: (background) => this.adoptBackground(background),
        result: (settings) => ({ ok: true as const, revision: revision(settings), settings }),
        conflict: "background configuration changed; refresh before saving",
      },
      next,
      expectedRevision,
      transaction,
    ) as Promise<{ ok: true; revision: string; settings: BackgroundSettings; replayed: boolean }>;
  }
  chatBudget(): { revision: string; budget: ChatBudget } {
    return { revision: revision(this.snapshot.chat.budget), budget: this.snapshot.chat.budget };
  }
  /** Chat turns read the snapshot when they start; a saved budget governs the next turn. */
  updateChatBudget(
    next: unknown,
    expectedRevision: string,
    transaction?: SettingsTransaction,
  ): Promise<ChatConfigureResult> {
    return this.updateSection(
      {
        read: (config) => config.chat.budget,
        parse: (value) => chatBudgetSchema.safeParse(value),
        write: (config, budget) => ({ ...config, chat: { ...config.chat, budget } }),
        adopt: (budget) => this.adoptChatBudget(budget),
        result: (budget) => ({ ok: true as const, revision: revision(budget), budget }),
        conflict: "chat resource limits changed; refresh before saving",
      },
      next,
      expectedRevision,
      transaction,
    ) as Promise<ChatConfigureResult>;
  }
  /** Adopt operator edits to the chat budget without touching deployment fields. */
  refreshChatBudget(): Promise<void> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (!this.persistence) return;
        const raw = await this.persistence.load();
        const current =
          raw === null ? this.persistence.config : parseNotientConfig(raw, ".notient/config.json");
        if (revision(current.chat.budget) !== this.chatBudget().revision)
          this.adoptChatBudget(current.chat.budget);
      });
    this.tail = operation;
    return operation;
  }
  /**
   * One journaled compare-and-swap for a configuration section. A lost receipt
   * is confirmed only from the exact file content it would have produced;
   * later operator edits are never overwritten by a replay.
   */
  private updateSection<T>(
    section: {
      read: (config: NotientConfig) => T;
      parse: (value: unknown) => { success: true; data: T } | { success: false; error: Error };
      write: (config: NotientConfig, value: T) => NotientConfig;
      adopt: (value: T) => void;
      result: (value: T) => { ok: true; revision: string } & Record<string, unknown>;
      conflict: string;
    },
    next: unknown,
    expectedRevision: string,
    transaction?: SettingsTransaction,
  ): Promise<SettingsChangeEntry["result"]> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (!this.persistence) throw new Error("product configuration persistence is unavailable");
        await transaction?.authorize();
        const raw = await this.persistence.load();
        const identity = transaction ? settingsRequest(transaction) : null;
        if (transaction && identity) {
          const stored = await transaction.journal.get(identity.id);
          if (stored) {
            requireSameRequest(stored, identity.request);
            if (stored.state === "committed") return { ...stored.result, replayed: true };
            if (stored.state === "prepared" && raw !== null && revision(raw) === stored.after) {
              // The exact desired file proves the interrupted commit. Never
              // overwrite later operator edits or reapply a prepared request.
              section.adopt(section.read(parseNotientConfig(raw, ".notient/config.json")));
              await transaction.journal.save(identity.id, { ...stored, state: "committed" });
              return { ...stored.result, replayed: true };
            }
            if (stored.state !== "abandoned")
              await transaction.journal.save(identity.id, { ...stored, state: "abandoned" });
            throw new NoteApiError(
              "CONFLICT",
              "Interrupted configuration change cannot be confirmed. Refresh current settings and submit a new decision; this request will not be reapplied.",
            );
          }
        }
        const current =
          raw === null ? this.persistence.config : parseNotientConfig(raw, ".notient/config.json");
        const parsed = section.parse(
          typeof next === "function" ? next(section.read(current)) : next,
        );
        if (!parsed.success) throw new NoteApiError("INVALID_PARAMS", parsed.error.message);
        if (revision(section.read(current)) !== expectedRevision)
          throw new NoteApiError("CONFLICT", section.conflict);
        const after = `${JSON.stringify(section.write(current, parsed.data), null, 2)}\n`;
        const result = {
          ...section.result(parsed.data),
          replayed: false,
        } as SettingsChangeEntry["result"];
        const entry: SettingsChangeEntry | null = identity
          ? {
              request: identity.request,
              after: revision(after),
              state: "prepared",
              result,
            }
          : null;
        if (transaction && identity && entry) await transaction.journal.save(identity.id, entry);
        // A failed write can have an ambiguous filesystem outcome. Leave its
        // prepared record for exact-content inspection on an explicit retry.
        await transaction?.authorize();
        if (!(await this.persistence.compareAndSwap(raw, after, transaction?.authorize)))
          throw new NoteApiError("CONFLICT", "configuration was edited during save");
        section.adopt(parsed.data);
        if (transaction && identity && entry)
          await transaction.journal.save(identity.id, { ...entry, state: "committed" });
        return result;
      });
    this.tail = operation;
    return operation;
  }
  async refreshToolPolicy(): Promise<Pick<NotientSettings["chat"], "approvalMode" | "perTool">> {
    if (this.persistence) {
      const raw = await this.persistence.load();
      const current =
        raw === null ? this.persistence.config : parseNotientConfig(raw, ".notient/config.json");
      this.snapshot = deepFreeze({
        ...this.snapshot,
        chat: {
          ...this.snapshot.chat,
          approvalMode: current.chat.approvalMode,
          perTool: structuredClone(current.chat.perTool),
        },
      });
    }
    return this.snapshot.chat;
  }
  /** Polling callers honor operator edits without overriding deployment fields. */
  refreshBackground(): Promise<void> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        if (!this.persistence) return;
        const raw = await this.persistence.load();
        const current =
          raw === null ? this.persistence.config : parseNotientConfig(raw, ".notient/config.json");
        if (revision(current.background) !== this.background().revision)
          this.adoptBackground(current.background);
      });
    this.tail = operation;
    return operation;
  }
  private adoptChatBudget(budget: ChatBudget): void {
    this.snapshot = deepFreeze({
      ...this.snapshot,
      chat: { ...this.snapshot.chat, budget: structuredClone(budget) },
    });
  }
  private adoptBackground(background: BackgroundSettings): void {
    this.snapshot = deepFreeze({ ...this.snapshot, background: structuredClone(background) });
    for (const listener of this.listeners) listener();
  }
}
function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
