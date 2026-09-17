import type { Conversation } from "../src/core/chat/types";

export function conversationFixture(overrides: Partial<Conversation> = {}): Conversation {
  const messages: Conversation["messages"] = [
    { id: "user-1", role: "user", content: "What did we learn about storage?", createdAt: 1000 },
    {
      id: "answer-1",
      role: "assistant",
      content: "Use a durable journal. See [[Storage#Recovery]].",
      createdAt: 1001,
    },
  ];
  return {
    id: "thread-storage",
    notePath: "Notient/conversations/2026-09-16 Storage thread-storage.md",
    topic: "Storage research",
    model: "test-model",
    clientIdentity: "human",
    approvalMode: "safe",
    pinnedContext: ["Storage.md"],
    summary: "A durable journal protects recovery.",
    createdAt: 1000,
    updatedAt: 1001,
    messages,
    messageCount: messages.length,
    ...overrides,
  };
}
