import { z } from "zod";
import { changePreviewSchema } from "./changes";
import type { OperationInput } from "./operations";
import { notePathSchema, noteReferenceSchema } from "./schema";

export const draftSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  body: z.string(),
  base: noteReferenceSchema.extend({ body: z.string() }).nullable(),
  preview: changePreviewSchema.nullable(),
});
export type NoteDraft = z.infer<typeof draftSchema>;

export function newDraft(folder: string, text = "", now = new Date()): NoteDraft {
  const stamp = now.toISOString().replace(/:/g, "-").slice(0, 19);
  return {
    id: crypto.randomUUID(),
    path: `${folder ? `${folder}/` : ""}Thought ${stamp}.md`,
    body: text,
    base: null,
    preview: null,
  };
}

export function draftChangeSet(draft: NoteDraft): OperationInput<"changes.preview"> {
  if (!notePathSchema.safeParse(draft.path).success)
    throw new Error("Use a relative Markdown destination, such as Inbox/Thought.md.");
  if (!draft.base && !draft.body.trim()) throw new Error("Write a thought before saving.");
  if (!draft.base)
    return {
      idempotencyKey: draft.id,
      changes: [{ kind: "create", path: draft.path, body: draft.body, expected: null }],
    };
  if (draft.path !== draft.base.path)
    throw new Error(
      "This editor changes content only. Keep the original path; moving a note requires reference-aware move.",
    );
  let replacement = draft.body.replace(/\r\n/g, "\n");
  if (draft.base.body.includes("\r\n")) replacement = replacement.replace(/\n/g, "\r\n");
  if (draft.base.body.startsWith("\ufeff") && !replacement.startsWith("\ufeff"))
    replacement = `\ufeff${replacement}`;
  return {
    idempotencyKey: draft.id,
    changes: [
      {
        kind: "edit",
        source: { path: draft.base.path, revision: draft.base.revision },
        selector: { kind: "range", start: 0, end: draft.base.body.length },
        replacement,
      },
    ],
  };
}
