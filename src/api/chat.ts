import { z } from "zod";
import { isCanonicalConversationPath } from "../core/vault/publicPath";
import { notePathSchema, revisionSchema } from "./schema";

/**
 * Resources one chat turn may consume across capability probes, context
 * preparation, agent rounds, nested analysis and post-answer memory.
 */
export const chatBudgetSchema = z
  .object({
    modelCalls: z.number().int().min(1).max(128),
    tokens: z.number().int().min(1024).max(1000000),
    durationMs: z.number().int().min(1000).max(3600000),
    generationTokens: z.number().int().min(1024).max(131072),
  })
  .strict();
export type ChatBudget = z.infer<typeof chatBudgetSchema>;

export const chatSettingsResultSchema = z.object({
  ok: z.literal(true),
  revision: revisionSchema,
  budget: chatBudgetSchema,
});
export const chatConfigureResultSchema = chatSettingsResultSchema.extend({
  replayed: z.boolean(),
});
export type ChatConfigureResult = z.infer<typeof chatConfigureResultSchema>;

const jsonRecordSchema = z.record(z.string(), z.json());
const chatToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: jsonRecordSchema,
  })
  .strict();
const chatToolResultSchema = z
  .object({
    callId: z.string().min(1),
    status: z.enum(["ok", "error"]),
    data: z.json().optional(),
    error: z.string().optional(),
    durationMs: z.number().nonnegative(),
  })
  .strict();
const chatApprovalSchema = z
  .object({
    callId: z.string().min(1),
    approved: z.boolean(),
    decidedAt: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();
export const chatMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    toolCalls: z.array(chatToolCallSchema).optional(),
    toolResults: z.array(chatToolResultSchema).optional(),
    approvals: z.array(chatApprovalSchema).optional(),
    reasoningContent: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    toolCallId: z.string().optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role === "tool" && !message.toolCallId) {
      context.addIssue({ code: "custom", path: ["toolCallId"], message: "tool message requires a call id" });
    }
    if (message.role !== "tool" && message.toolCallId !== undefined) {
      context.addIssue({ code: "custom", path: ["toolCallId"], message: "only tool messages have a call id" });
    }
  });
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const conversationSchema = z
  .object({
    id: z.string().min(1),
    notePath: z.string().min(1),
    model: z.string(),
    pinnedContext: z.array(z.string()),
    approvalMode: z.enum(["safe", "yolo"]),
    topic: z.string(),
    summary: z.string(),
    clientIdentity: z.string(),
    messageCount: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    messages: z.array(chatMessageSchema),
  })
  .strict();
export type Conversation = z.infer<typeof conversationSchema>;

export const chatStartResultSchema = z
  .object({ ok: z.literal(true), conversation: conversationSchema })
  .strict();
export const chatListResultSchema = z
  .object({ ok: z.literal(true), conversations: z.array(conversationSchema) })
  .strict();
export const chatLoadResultSchema = chatStartResultSchema;
export const chatSendResultSchema = chatStartResultSchema;
export const chatAbortResultSchema = z
  .object({
    ok: z.literal(true),
    aborted: z.boolean(),
    scope: z.literal("all").optional(),
  })
  .strict();
export const chatApproveResultSchema = z.discriminatedUnion("approved", [
  z.object({ ok: z.literal(true), callId: z.string(), approved: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(true),
      callId: z.string(),
      approved: z.literal(false),
      reason: z.string(),
    })
    .strict(),
]);
export type ChatStartResult = z.infer<typeof chatStartResultSchema>;
export type ChatListResult = z.infer<typeof chatListResultSchema>;
export type ChatLoadResult = z.infer<typeof chatLoadResultSchema>;
export type ChatSendResult = z.infer<typeof chatSendResultSchema>;
export type ChatAbortResult = z.infer<typeof chatAbortResultSchema>;
export type ChatApproveResult = z.infer<typeof chatApproveResultSchema>;
export const chatStartRequestSchema = z
  .object({
    topic: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) => value.trim().length > 0 && value.trim() === value,
        "topic must be non-empty and have no leading or trailing whitespace",
      )
      .optional(),
    pinnedContext: z.array(notePathSchema).max(64).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const totalCharacters = input.pinnedContext?.reduce((total, path) => total + path.length, 0) ?? 0;
    if (totalCharacters > 262144) {
      context.addIssue({
        code: "custom",
        path: ["pinnedContext"],
        message: "pinnedContext must not exceed 262144 characters",
      });
    }
  });
export const chatSendRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    userMessage: z.string().min(1).max(262144),
    turnId: z.string().uuid(),
  })
  .strict();
export const chatAbortRequestSchema = z
  .object({ turnId: z.string().uuid().optional(), allConnections: z.boolean().optional() })
  .strict()
  .refine(
    (input) => !(input.turnId !== undefined && input.allConnections === true),
    "turnId and process-wide abort cannot be combined",
  );
export const chatLoadRequestSchema = z
  .object({ notePath: z.string().refine(isCanonicalConversationPath) })
  .strict();
export const chatApproveRequestSchema = z.discriminatedUnion("approved", [
  z.object({ callId: z.string().min(1), approved: z.literal(true) }).strict(),
  z
    .object({
      callId: z.string().min(1),
      approved: z.literal(false),
      reason: z.string().max(4000).optional(),
    })
    .strict(),
]);
export type ChatStartRequest = z.infer<typeof chatStartRequestSchema>;
export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>;
export type ChatAbortRequest = z.infer<typeof chatAbortRequestSchema>;
export type ChatApproveRequest = z.infer<typeof chatApproveRequestSchema>;

const tokenUsageSchema = z
  .object({
    source: z.enum(["provider", "unavailable"]),
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    visibleAnswerTokens: z.number().int().nonnegative().nullable(),
    nonReasoningCompletionTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();
const inferenceAttemptSchema = z
  .object({
    sequence: z.number().int().positive(),
    inputTokenEstimate: z.number().int().nonnegative(),
    generationCeiling: z.number().int().nonnegative(),
    chargedTokens: z.number().int().nonnegative(),
    accounting: z.enum(["reserved-estimate", "provider-total", "provider-components"]),
    completion: z
      .object({
        finishReason: z.string().nullable(),
        state: z.enum(["complete", "truncated", "incomplete", "filtered", "cancelled"]),
        usage: tokenUsageSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export const chatStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("turn:start"), conversationId: z.string(), userMessage: chatMessageSchema }).strict(),
  z.object({ event: z.literal("loop:assistant_delta"), contentDelta: z.string() }).strict(),
  z.object({ event: z.literal("loop:reasoning_delta"), reasoningDelta: z.string() }).strict(),
  z.object({ event: z.literal("loop:tool_call_started"), callId: z.string(), tool: z.string(), args: jsonRecordSchema }).strict(),
  z.object({ event: z.literal("loop:tool_call_result"), callId: z.string(), result: z.json().optional(), durationMs: z.number().nonnegative() }).strict(),
  z.object({ event: z.literal("loop:tool_call_error"), callId: z.string(), error: z.string(), durationMs: z.number().nonnegative() }).strict(),
  z.object({ event: z.literal("loop:approval_pending"), callId: z.string(), tool: z.string(), args: jsonRecordSchema, preview: z.string() }).strict(),
  z
    .object({
      event: z.literal("loop:approval_resolved"),
      callId: z.string(),
      approved: z.boolean(),
      reason: z.string().optional(),
    })
    .strict()
    .superRefine((event, context) => {
      if (event.approved === (event.reason !== undefined)) {
        context.addIssue({ code: "custom", path: ["reason"], message: "approval reason does not match the decision" });
      }
    }),
  z.object({ event: z.literal("loop:context_summarized"), conversationId: z.string(), model: z.string(), originalTokens: z.number().int().nonnegative(), summarizedTokens: z.number().int().nonnegative() }).strict(),
  z.object({ event: z.literal("loop:context_overflow_warning"), conversationId: z.string(), model: z.string(), configuredTokens: z.number().int().positive(), estimatedTokens: z.number().int().nonnegative() }).strict(),
  z.object({ event: z.literal("loop:tool_mode_probed"), model: z.string(), mode: z.string(), attempts: z.number().int().nonnegative() }).strict(),
  z.object({ event: z.literal("loop:done"), finalMessage: chatMessageSchema, truncated: z.boolean() }).strict(),
  z.object({ event: z.literal("loop:error"), message: z.string() }).strict(),
  z.object({ event: z.literal("turn:usage"), attempts: z.array(inferenceAttemptSchema), durationMs: z.number().nonnegative() }).strict(),
  z.object({ event: z.literal("turn:complete"), conversation: conversationSchema }).strict(),
  z.object({ event: z.literal("turn:aborted"), reason: z.string() }).strict(),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

export const chatStreamFailureSchema = z
  .object({
    event: z.literal("notient.error"),
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    outcomeMayBeUnknown: z.boolean().optional(),
  })
  .strict();
