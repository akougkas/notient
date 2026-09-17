import { z } from "zod";
import type { ChatMessage } from "../types";
import type { ToolDefinition, ToolJsonSchema } from "./registry";

export const noteDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    markdown: z
      .string()
      .min(1)
      .max(48000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export type PreparedNoteDraft = z.infer<typeof noteDraftSchema>;

/** A pure presentation tool: it never acquires mutation or approval authority. */
export function makePrepareDraftTool(): ToolDefinition<PreparedNoteDraft, PreparedNoteDraft> {
  return {
    name: "notes.prepare_draft",
    description:
      "Prepare a standalone Markdown note for the user to edit and review. This does not create or modify a vault file. Use for writing/capture requests after inspecting relevant sources. Put only the proposed note in markdown, without wrapping fences or conversational commentary; keep explanations in your final answer. Preserve the user's meaning, mark open questions, and cite inspected sources with exact [[vault/path.md]] links.",
    schema: z.toJSONSchema(noteDraftSchema) as ToolJsonSchema,
    validate: (value) => noteDraftSchema.parse(value),
    invoke: async (draft, signal) => {
      signal.throwIfAborted();
      return draft;
    },
    writeGated: false,
  };
}

/** Only successful, paired tool results supply an artifact. Text, reasoning and
 * unexecuted tool arguments are never interpreted as a prepared draft. */
export function preparedDrafts(messages: readonly ChatMessage[]): PreparedNoteDraft[] {
  const drafts: PreparedNoteDraft[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.name !== "notes.prepare_draft") continue;
      const result = message.toolResults?.find(
        (item) => item.callId === call.id && item.status === "ok",
      );
      const parsed = noteDraftSchema.safeParse(result?.data);
      if (parsed.success) drafts.push(parsed.data);
    }
  }
  return drafts;
}
