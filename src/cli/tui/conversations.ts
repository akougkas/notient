import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { preparedDrafts } from "../../core/chat/tools/draft";
import type { ChatMessage, Conversation } from "../../core/chat/types";
import { vaultStateDir } from "../../core/vault/identity";
import { isCanonicalConversationPath } from "../../core/vault/publicPath";
import { readPrivateJson, writePrivateJson } from "../../daemon/ipcSecurity";
import type { ChatLine } from "./ChatView";
import type { NotientRpc } from "./rpc";

const selectionSchema = z.strictObject({
  notePath: z.string().refine(isCanonicalConversationPath).nullable(),
});

function selectionPath(vaultPath: string, identity: string): string {
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(vaultStateDir(vaultPath), `tui-session-${key}.json`);
}

/** Only the selection lives here; canonical transcripts remain in Markdown. */
export async function rememberConversation(
  vaultPath: string,
  identity: string,
  notePath: string | null,
): Promise<void> {
  await writePrivateJson(selectionPath(vaultPath, identity), selectionSchema.parse({ notePath }));
}

export async function ownConversations(rpc: NotientRpc): Promise<Conversation[]> {
  const result = await rpc.chatList();
  return result.conversations
    .filter((conversation) => conversation.clientIdentity === rpc.client.principal.id)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function loadOwnConversation(
  rpc: NotientRpc,
  notePath: string,
): Promise<Conversation> {
  const { conversation } = await rpc.chatLoad(notePath);
  if (conversation.clientIdentity !== rpc.client.principal.id) {
    throw new Error("This conversation belongs to another identity; start your own thread.");
  }
  return conversation;
}

/** A failed load never silently creates a replacement or replays a turn. */
export async function restoreConversation(
  rpc: NotientRpc,
  vaultPath: string,
): Promise<Conversation | null> {
  let selection: z.infer<typeof selectionSchema> | undefined;
  try {
    selection = selectionSchema.parse(
      await readPrivateJson(selectionPath(vaultPath, rpc.client.principal.id)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (selection !== undefined) {
    return selection.notePath === null ? null : loadOwnConversation(rpc, selection.notePath);
  }
  const latest = (await ownConversations(rpc))[0];
  return latest === undefined ? null : loadOwnConversation(rpc, latest.notePath);
}

export function conversationTitle(conversation: Conversation): string {
  if (!["TUI session", "Untitled", "single-shot"].includes(conversation.topic)) {
    return conversation.topic;
  }
  return (
    conversation.messages
      .find((message) => message.role === "user")
      ?.content.replace(/\s+/g, " ")
      .slice(0, 90) || "New conversation"
  );
}

export function conversationMatches(
  conversations: readonly Conversation[],
  query: string,
): Conversation[] {
  const search = query.trim().toLowerCase();
  return conversations.filter((conversation) =>
    `${conversationTitle(conversation)} ${conversation.summary} ${conversation.notePath}`
      .toLowerCase()
      .includes(search),
  );
}

export function conversationLabel(conversation: Conversation): string {
  const date = new Date(conversation.updatedAt).toLocaleDateString();
  return `${conversationTitle(conversation)} · ${date} · ${conversation.messageCount} messages · ${conversation.id.slice(-6)}`;
}

/** Restore visible exchanges; recorded tool calls and approvals are never executable UI state. */
export function conversationLines(conversation: Conversation): ChatLine[] {
  return conversation.messages.flatMap(messageLines);
}

export function lastPreparedDraft(lines: readonly ChatLine[]) {
  for (const line of [...lines].reverse()) {
    if (line.kind === "user") break;
    if (line.kind === "draft") return line.draft;
  }
  return null;
}

function messageLines(message: ChatMessage): ChatLine[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  const lines: ChatLine[] = [];
  if (message.content) lines.push({ kind: message.role, text: message.content });
  for (const call of message.toolCalls ?? []) {
    lines.push({ kind: "tool", text: `${call.name} (recorded)` });
  }
  for (const draft of preparedDrafts([message])) lines.push({ kind: "draft", draft });
  for (const approval of message.approvals ?? []) {
    lines.push({
      kind: "system",
      text: `${approval.approved ? "Approved" : "Denied"} ${approval.callId} (recorded)${approval.reason ? `: ${approval.reason}` : ""}`,
    });
  }
  return lines;
}
