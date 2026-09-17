import { z } from "zod";
import { isCanonicalPublicNotePath } from "../core/vault/publicPath";
import { notePathSchema, revisionSchema, sourceReferenceSchema } from "./schema";

const sessionId = z.string().uuid();
const guardPath = z.string().refine(isCanonicalPublicNotePath);
export const hostContextSchema = z
  .object({
    path: notePathSchema,
    savedRevision: revisionSchema,
    // Reading view has no active text buffer; saved source remains available.
    bufferRevision: revisionSchema.nullable(),
    dirty: z.boolean(),
    // Offsets refer to the editor buffer, never silently to the on-disk revision.
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string().max(16000),
      })
      .refine((v) => v.end >= v.start && v.end - v.start === v.text.length)
      .nullable(),
  })
  .strict();
export const hostCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({ id: sessionId, kind: z.literal("guard"), paths: z.array(guardPath).min(1).max(200) })
    .strict(),
  z.object({ id: sessionId, kind: z.literal("context") }).strict(),
  z.object({ id: sessionId, kind: z.literal("open"), source: sourceReferenceSchema }).strict(),
]);
export const hostReplySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("guard"),
      allowed: z.boolean(),
      reason: z.string().max(2000).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("context"), context: hostContextSchema.nullable() }).strict(),
  z
    .object({
      kind: z.literal("open"),
      opened: z.boolean(),
      reason: z.string().max(2000).nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("error"), message: z.string().max(2000) }).strict(),
]);
export const hostInputs = {
  "host.attach": z.object({ instanceId: sessionId, label: z.string().min(1).max(100) }).strict(),
  "host.poll": z.object({ sessionId }).strict(),
  "host.reply": z.object({ sessionId, commandId: sessionId, result: hostReplySchema }).strict(),
  "host.status": z.object({}).strict(),
  "host.context": z.object({}).strict(),
  "host.open": z.object({ source: sourceReferenceSchema }).strict(),
} as const;
export const hostOutputs = {
  "host.attach": z.object({ ok: z.literal(true), sessionId, epoch: sessionId }),
  "host.poll": z.object({
    ok: z.literal(true),
    epoch: sessionId,
    commands: z.array(hostCommandSchema).max(16),
    guards: z.array(z.object({ id: sessionId, paths: z.array(guardPath).max(200) })).max(16),
  }),
  "host.reply": z.object({ ok: z.literal(true), accepted: z.boolean() }),
  "host.status": z.object({
    ok: z.literal(true),
    hosts: z
      .array(
        z.object({
          label: z.string(),
          connected: z.boolean(),
          pending: z.number().int().nonnegative(),
        }),
      )
      .max(16),
  }),
  "host.context": z.object({ ok: z.literal(true), context: hostContextSchema.nullable() }),
  "host.open": z.object({ ok: z.literal(true), opened: z.literal(true) }),
} as const;
export type HostCommand = z.infer<typeof hostCommandSchema>;
export type HostReply = z.infer<typeof hostReplySchema>;
