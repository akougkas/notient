import { z } from "zod";
import { changeResultSchema } from "../../../src/api/changes";
import { NotientApiError, type NotientClient } from "../../../src/api/client";
import { type NoteDraft, draftChangeSet, draftSchema, newDraft } from "../../../src/api/drafts";

const captureSchema = z
  .object({
    draft: draftSchema,
    vaultId: z.string().nullable(),
    saveStarted: z.boolean(),
    receipt: changeResultSchema.nullable(),
  })
  .strict();
type CaptureRecord = z.infer<typeof captureSchema>;
export interface CaptureStorage {
  read(): unknown;
  write(record: CaptureRecord): void;
}

/** Device-local composition state. The daemon still owns all previews, writes
 * and receipts. Persist the exact review before dispatch, including on reload. */
export class CaptureDraft {
  record: CaptureRecord;
  busy = false;
  error: string | null = null;
  persisted = true;
  private readonly controller = new AbortController();
  private listeners = new Set<() => void>();
  constructor(
    private readonly storage: CaptureStorage,
    private readonly connection: () => { client: NotientClient; vaultId: string } | null,
    folder = "Inbox",
  ) {
    const value = storage.read();
    const parsed = captureSchema.nullable().safeParse(value ?? null);
    if (!parsed.success)
      throw new Error(
        "The saved capture could not be read. Its local contents have been preserved.",
      );
    this.record = parsed.data ?? {
      draft: newDraft(folder),
      vaultId: null,
      saveStarted: false,
      receipt: null,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.controller.abort();
    this.listeners.clear();
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private persist(): void {
    try {
      // Bound local recovery independently of the network request limits.
      if (JSON.stringify(this.record).length > 512000)
        throw new Error("This capture is too large to keep locally. Shorten it before continuing.");
      this.storage.write(this.record);
      this.persisted = true;
    } catch (error) {
      this.persisted = false;
      throw error;
    }
  }
  private report(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
  }
  edit(patch: Partial<Pick<NoteDraft, "path" | "body">>): void {
    if (this.busy || this.record.saveStarted || this.record.receipt?.state === "applied") return;
    this.record = {
      draft: { ...this.record.draft, ...patch, id: crypto.randomUUID(), preview: null },
      vaultId: null,
      saveStarted: false,
      receipt: null,
    };
    this.error = null;
    try {
      this.persist();
    } catch (error) {
      this.report(error);
    }
    this.changed();
  }
  /** Explicit UI action only; it never discards a dispatched write's identity. */
  reset(): void {
    if (this.busy || this.record.saveStarted) return;
    const path = this.record.draft.path;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.record = { draft: newDraft(folder), vaultId: null, saveStarted: false, receipt: null };
    this.error = null;
    try {
      this.persist();
    } catch (error) {
      this.report(error);
    }
    this.changed();
  }
  seed(text: string): boolean {
    if (this.busy || this.record.saveStarted || this.record.draft.body.trim()) return false;
    this.edit({ body: text });
    return true;
  }
  private connected() {
    const connected = this.connection();
    if (!connected) throw new Error("Reconnect Notient to review and save. Your draft stays here.");
    if (this.record.vaultId && this.record.vaultId !== connected.vaultId)
      throw new Error(
        "This review belongs to a different paired vault. Reconnect its original daemon.",
      );
    return connected;
  }
  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.controller.signal.aborted) return;
    this.busy = true;
    this.error = null;
    this.changed();
    try {
      await work();
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async preview(): Promise<void> {
    if (this.record.saveStarted || this.record.receipt?.state === "applied") return;
    await this.run(async () => {
      const { client, vaultId } = this.connected();
      const request = draftChangeSet(this.record.draft);
      this.persist();
      const preview = await client.call(
        "changes.preview",
        request,
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      );
      if (this.controller.signal.aborted) return;
      if (preview.conflicts.length)
        throw new Error(preview.conflicts.map((item) => item.reason).join("; "));
      if (!preview.effects.length) throw new Error("There is no new content to save.");
      this.record = { ...this.record, draft: { ...this.record.draft, preview }, vaultId };
      this.persist();
    });
  }
  async save(): Promise<void> {
    if (!this.record.draft.preview || this.record.receipt?.state === "applied") return;
    await this.run(async () => {
      const { client } = this.connected();
      const { draft } = this.record;
      const preview = draft.preview;
      if (!preview) return;
      this.record = { ...this.record, saveStarted: true };
      this.persist();
      try {
        const receipt = await client.call(
          "changes.apply",
          {
            previewId: preview.previewId,
            previewRevision: preview.revision,
            idempotencyKey: `${draft.id}:apply`,
          },
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]),
        );
        if (this.controller.signal.aborted) return;
        this.record = { ...this.record, receipt, saveStarted: false };
        this.persist();
        if (receipt.state !== "applied")
          throw new Error(
            receipt.effects
              .map((effect) => effect.message)
              .filter(Boolean)
              .join("; ") || `Save ${receipt.state}. Your draft is retained.`,
          );
      } catch (error) {
        if (this.controller.signal.aborted) return;
        // A transport disconnect cannot prove that a save failed. Keep the
        // reviewed content and key until an explicit retry returns its receipt.
        if (error instanceof NotientApiError && !error.outcomeMayBeUnknown) {
          this.record = { ...this.record, saveStarted: false };
          this.persist();
        }
        throw error;
      }
    });
  }
}
