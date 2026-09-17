import { RecordId, type Surreal } from "surrealdb";
import { z } from "zod";
import { backgroundResultSchema } from "../../api/background";
import { chatConfigureResultSchema } from "../../api/chat";
import { contentRevision } from "../../api/notes";
import { NoteApiError, revisionSchema } from "../../api/schema";

const entrySchema = z.object({
  request: revisionSchema,
  after: revisionSchema,
  state: z.enum(["prepared", "committed", "abandoned"]),
  result: z.union([backgroundResultSchema, chatConfigureResultSchema]),
});
export type SettingsChangeEntry = z.infer<typeof entrySchema>;
export interface SettingsChangeJournal {
  get(id: string): Promise<SettingsChangeEntry | null>;
  save(id: string, entry: SettingsChangeEntry): Promise<void>;
}
export interface SettingsTransaction {
  journal: SettingsChangeJournal;
  caller: { id: string; kind: string };
  key: string;
  request: unknown;
  authorize: () => void | Promise<void>;
}

/** The private database records intent and receipt; config.json stays the
 * single configuration authority. A prepared request is never blindly replayed. */
export class DatabaseSettingsJournal implements SettingsChangeJournal {
  constructor(private readonly db: Surreal) {}
  async get(id: string): Promise<SettingsChangeEntry | null> {
    const [rows] = await this.db
      .query<[Array<{ payload: string }>]>("SELECT payload FROM settings_change WHERE id = $id;", {
        id: new RecordId("settings_change", id),
      })
      .collect();
    return rows.length ? entrySchema.parse(JSON.parse(rows[0].payload)) : null;
  }
  async save(id: string, entry: SettingsChangeEntry): Promise<void> {
    await this.db
      .query("UPSERT $id CONTENT { payload: $payload };", {
        id: new RecordId("settings_change", id),
        payload: JSON.stringify(entrySchema.parse(entry)),
      })
      .collect();
  }
}
export function settingsRequest(transaction: SettingsTransaction) {
  return {
    id: contentRevision(
      JSON.stringify([transaction.caller.kind, transaction.caller.id, transaction.key]),
    ),
    request: contentRevision(JSON.stringify(transaction.request)),
  };
}
export function requireSameRequest(entry: SettingsChangeEntry, digest: string): void {
  if (entry.request !== digest)
    throw new NoteApiError(
      "CONFLICT",
      "idempotency key was reused with different configuration inputs",
    );
}
