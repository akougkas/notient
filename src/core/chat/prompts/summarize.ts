/**
 * Conversation summarization prompt for the budgeted-history pass of the
 * context manager. Returns a `[system, user]` pair tailored for the LLMProvider
 * chat shape (not the chat-module ChatMessage). The system message constrains
 * the model to a JSON object so the caller can reuse `provider.chatJson`.
 */

import { NOTIENT_IDENTITY } from "../../../agent/identity";
import type { ChatMessage as ProviderChatMessage } from "../../llm/provider";
import type { ChatMessage } from "../types";

export const SUMMARY_JSON_SCHEMA = {
  name: "conversation_summary",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string" },
    },
  },
};

export function summarizePrompt(messages: ChatMessage[]): ProviderChatMessage[] {
  const transcript = messages.map((message) => renderMessage(message)).join("\n\n");
  return [
    {
      role: "system",
      content: [
        NOTIENT_IDENTITY,
        "Preserve the conversation as memory for the notes themselves. Keep key facts, decisions, disagreement, uncertainty, and every referenced [[note]] path.",
        'Reply with JSON: {"summary": string}. Keep the summary under 600 tokens.',
      ].join("\n\n"),
    },
    {
      role: "user",
      content: `Summarize the conversation so far, preserving key facts, decisions, and note paths referenced.\n\n${transcript}`,
    },
  ];
}

function renderMessage(message: ChatMessage): string {
  const role =
    message.role === "assistant" ? "Notient" : message.role === "user" ? "User" : "System";
  const content = message.content.trim();
  return `${role}: ${content}`;
}
