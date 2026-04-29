import type {
  ApprovalMode,
  ApprovalRecord,
  ChatMessage,
  ChatRole,
  Conversation,
  ToolCall,
  ToolResult,
} from "./types";

/**
 * Markdown roundtrip for vault-stored conversations.
 *
 * Wire format:
 *   - Frontmatter: flat YAML (one key per line, JSON-encoded scalar values).
 *     Flat keys keep us out of YAML quoting hell (Phase 4 Task 9 lesson).
 *   - Body: `## <Role> · <ISO timestamp>` headings start each message.
 *     Tool calls + approvals serialize as native Obsidian callouts so the
 *     file renders correctly in Reading view without a custom renderer.
 *
 * Roundtrip contract: `parseConversation(serializeConversation(c)).messages`
 * preserves role, content, toolCalls, toolResults, approvals, and createdAt
 * (timestamp goes through ISO 8601 which is millisecond-precise). Message
 * `id` is regenerated on parse since the markdown does not carry it; callers
 * that need stable ids should keep the in-memory Conversation alive.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

interface ConversationFrontmatter {
  conversation_id: string;
  model: string;
  pinned_context: string[];
  approval_mode: ApprovalMode;
  topic: string;
  summary: string;
  summary_embedding_b64: string | null;
  client_identity: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface CalloutExtraction {
  contentWithoutCallouts: string;
  toolCalls: ToolCall[] | undefined;
  toolResults: ToolResult[] | undefined;
  approvals: ApprovalRecord[] | undefined;
}

export function serializeConversation(conv: Conversation): string {
  const fm = renderFrontmatter({
    conversation_id: conv.id,
    model: conv.model,
    pinned_context: conv.pinnedContext,
    approval_mode: conv.approvalMode,
    topic: conv.topic,
    summary: conv.summary,
    summary_embedding_b64: conv.summaryEmbeddingB64,
    client_identity: conv.clientIdentity,
    created_at: conv.createdAt,
    updated_at: conv.updatedAt,
    message_count: conv.messageCount,
  });
  const heading = `# ${conv.topic.length > 0 ? conv.topic : "Conversation"}`;
  const messages = conv.messages.map((message) => renderMessage(message)).join("\n\n");
  const body = messages.length > 0 ? `${heading}\n\n${messages}\n` : `${heading}\n`;
  return `${fm}\n${body}`;
}

export function parseConversation(raw: string, notePath: string): Conversation {
  const match = FRONTMATTER_RE.exec(raw);
  const frontmatter = match ? parseFrontmatter(match[1] ?? "") : defaultFrontmatter();
  const body = match ? raw.slice(match[0].length) : raw;
  const messages = parseMessages(body);
  return {
    id: frontmatter.conversation_id,
    notePath,
    model: frontmatter.model,
    pinnedContext: frontmatter.pinned_context,
    approvalMode: frontmatter.approval_mode,
    topic: frontmatter.topic,
    summary: frontmatter.summary,
    summaryEmbeddingB64: frontmatter.summary_embedding_b64,
    clientIdentity: frontmatter.client_identity,
    messageCount: messages.length,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    messages,
  };
}

function renderFrontmatter(values: ConversationFrontmatter): string {
  const lines = [
    "---",
    `conversation_id: ${JSON.stringify(values.conversation_id)}`,
    `model: ${JSON.stringify(values.model)}`,
    `pinned_context: ${JSON.stringify(values.pinned_context)}`,
    `approval_mode: ${values.approval_mode}`,
    `topic: ${JSON.stringify(values.topic)}`,
    `summary: ${JSON.stringify(values.summary)}`,
    `summary_embedding_b64: ${values.summary_embedding_b64 === null ? "null" : JSON.stringify(values.summary_embedding_b64)}`,
    `client_identity: ${JSON.stringify(values.client_identity)}`,
    `created_at: ${values.created_at}`,
    `updated_at: ${values.updated_at}`,
    `message_count: ${values.message_count}`,
    "---",
  ];
  return lines.join("\n");
}

function parseFrontmatter(yaml: string): ConversationFrontmatter {
  const fields = parseFlatYaml(yaml);
  const fallback = defaultFrontmatter();

  const pinnedRaw = fields.pinned_context;
  let pinnedContext = fallback.pinned_context;
  if (typeof pinnedRaw === "string" && pinnedRaw.length > 0) {
    try {
      const parsed = JSON.parse(pinnedRaw) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        pinnedContext = parsed;
      }
    } catch {
      pinnedContext = fallback.pinned_context;
    }
  }

  const summaryEmbeddingRaw = fields.summary_embedding_b64;
  let summaryEmbeddingB64: string | null = null;
  if (typeof summaryEmbeddingRaw === "string" && summaryEmbeddingRaw !== "null") {
    summaryEmbeddingB64 = stripJsonString(summaryEmbeddingRaw);
  }

  return {
    conversation_id: stripJsonString(fields.conversation_id ?? fallback.conversation_id),
    model: stripJsonString(fields.model ?? fallback.model),
    pinned_context: pinnedContext,
    approval_mode: normalizeApprovalMode(fields.approval_mode) ?? fallback.approval_mode,
    topic: stripJsonString(fields.topic ?? fallback.topic),
    summary: stripJsonString(fields.summary ?? fallback.summary),
    summary_embedding_b64: summaryEmbeddingB64,
    client_identity: stripJsonString(fields.client_identity ?? fallback.client_identity),
    created_at: numericField(fields.created_at, fallback.created_at),
    updated_at: numericField(fields.updated_at, fallback.updated_at),
    message_count: numericField(fields.message_count, fallback.message_count),
  };
}

function defaultFrontmatter(): ConversationFrontmatter {
  return {
    conversation_id: "",
    model: "",
    pinned_context: [],
    approval_mode: "safe",
    topic: "Conversation",
    summary: "",
    summary_embedding_b64: null,
    client_identity: "human",
    created_at: 0,
    updated_at: 0,
    message_count: 0,
  };
}

function renderMessage(message: ChatMessage): string {
  const header = `## ${capitalize(message.role)} · ${formatTimestamp(message.createdAt)}`;
  const blocks: string[] = [header];

  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const call of message.toolCalls) {
      const result = message.toolResults?.find((entry) => entry.callId === call.id);
      const approval = message.approvals?.find((entry) => entry.callId === call.id);
      blocks.push(renderToolCall(call, result, approval));
    }
  }

  if (message.content.trim().length > 0) {
    blocks.push(message.content.trim());
  }

  return blocks.join("\n\n");
}

function renderToolCall(
  call: ToolCall,
  result: ToolResult | undefined,
  approval: ApprovalRecord | undefined,
): string {
  const lines = [`> [!notient-tool] ${call.name}`, `> id: ${call.id}`];
  lines.push(`> args: ${JSON.stringify(call.args)}`);
  if (result) {
    lines.push(`> status: ${result.status}`);
    lines.push(`> duration_ms: ${result.durationMs}`);
    if (result.data !== undefined) {
      lines.push(`> data: ${JSON.stringify(result.data)}`);
    }
    if (result.error !== undefined) {
      lines.push(`> error: ${JSON.stringify(result.error)}`);
    }
  }
  let block = lines.join("\n");

  if (approval) {
    const approvalLines = [
      `> [!notient-approval] ${call.name}`,
      `> call_id: ${call.id}`,
      `> approved: ${approval.approved ? "true" : "false"}`,
      `> decided_at: ${approval.decidedAt}`,
    ];
    if (approval.reason !== undefined) {
      approvalLines.push(`> reason: ${JSON.stringify(approval.reason)}`);
    }
    block += `\n\n${approvalLines.join("\n")}`;
  }

  return block;
}

function parseMessages(body: string): ChatMessage[] {
  const sections = body.split(/^## /m).slice(1);
  const messages: ChatMessage[] = [];
  for (const section of sections) {
    const headerEnd = section.indexOf("\n");
    const header = headerEnd >= 0 ? section.slice(0, headerEnd) : section;
    const rest = headerEnd >= 0 ? section.slice(headerEnd + 1) : "";
    const role = parseRole(header);
    if (role === null) continue;
    const createdAt = parseTimestamp(header);
    const callouts = extractCallouts(rest);
    messages.push({
      id: cryptoRandomId(),
      role,
      content: callouts.contentWithoutCallouts.trim(),
      toolCalls: callouts.toolCalls,
      toolResults: callouts.toolResults,
      approvals: callouts.approvals,
      createdAt,
    });
  }
  return messages;
}

interface CalloutBlock {
  kind: "notient-tool" | "notient-approval";
  headerTitle: string;
  blockLines: string[];
  endIndex: number;
}

const CALLOUT_HEADER_RE = /^> \[!(notient-tool|notient-approval)\] *(.*)$/;

function readCalloutBlock(lines: string[], start: number): CalloutBlock | null {
  const match = CALLOUT_HEADER_RE.exec(lines[start]);
  if (!match) return null;
  const kindRaw = match[1];
  if (kindRaw !== "notient-tool" && kindRaw !== "notient-approval") return null;
  const blockLines: string[] = [];
  let cursor = start + 1;
  while (cursor < lines.length && lines[cursor].startsWith(">")) {
    blockLines.push(lines[cursor]);
    cursor++;
  }
  return { kind: kindRaw, headerTitle: match[2], blockLines, endIndex: cursor };
}

function extractCallouts(body: string): CalloutExtraction {
  const lines = body.split("\n");
  const remaining: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const approvals: ApprovalRecord[] = [];

  let index = 0;
  while (index < lines.length) {
    const block = readCalloutBlock(lines, index);
    if (block === null) {
      remaining.push(lines[index]);
      index++;
      continue;
    }
    if (block.kind === "notient-tool") {
      collectToolCallout(block.headerTitle, block.blockLines, toolCalls, toolResults);
    } else {
      const approval = parseApprovalCallout(block.headerTitle, block.blockLines);
      if (approval) approvals.push(approval);
    }
    index = block.endIndex;
  }

  return {
    contentWithoutCallouts: remaining.join("\n"),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    approvals: approvals.length > 0 ? approvals : undefined,
  };
}

function collectToolCallout(
  headerTitle: string,
  blockLines: string[],
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
): void {
  const parsed = parseToolCallout(headerTitle, blockLines);
  if (!parsed) return;
  toolCalls.push(parsed.call);
  if (parsed.result) toolResults.push(parsed.result);
}

function parseToolCallout(
  headerTitle: string,
  blockLines: string[],
): { call: ToolCall; result: ToolResult | undefined } | null {
  const fields = parseCalloutFields(blockLines);
  const id = fields.id ?? "";
  const argsRaw = fields.args ?? "{}";
  const args = parseToolArgs(argsRaw);
  const call: ToolCall = { id, name: headerTitle.trim(), args };

  const status = fields.status;
  if (status !== "ok" && status !== "error") {
    return { call, result: undefined };
  }
  const result: ToolResult = {
    callId: id,
    status,
    durationMs: numericField(fields.duration_ms, 0),
  };
  if (fields.data !== undefined) result.data = decodeJsonOrRaw(fields.data);
  if (fields.error !== undefined) result.error = decodeJsonString(fields.error);
  return { call, result };
}

function parseToolArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to raw payload
  }
  return { __raw_payload__: argsRaw };
}

function decodeJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function decodeJsonString(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

function parseApprovalCallout(_headerTitle: string, blockLines: string[]): ApprovalRecord | null {
  const fields = parseCalloutFields(blockLines);
  const callId = fields.call_id;
  if (!callId) return null;
  const approved = fields.approved === "true";
  const decidedAt = numericField(fields.decided_at, 0);
  const reasonRaw = fields.reason;
  const approval: ApprovalRecord = {
    callId,
    approved,
    decidedAt,
  };
  if (reasonRaw !== undefined) {
    try {
      const parsed = JSON.parse(reasonRaw) as unknown;
      approval.reason = typeof parsed === "string" ? parsed : reasonRaw;
    } catch {
      approval.reason = reasonRaw;
    }
  }
  return approval;
}

function parseCalloutFields(blockLines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of blockLines) {
    const stripped = raw.replace(/^>\s?/, "");
    const colon = stripped.indexOf(":");
    if (colon < 0) continue;
    const key = stripped.slice(0, colon).trim();
    const value = stripped.slice(colon + 1).trim();
    if (key.length === 0) continue;
    fields[key] = value;
  }
  return fields;
}

function parseRole(header: string): ChatRole | null {
  const beforeSeparator = header.split("·")[0]?.trim().toLowerCase() ?? "";
  if (
    beforeSeparator === "user" ||
    beforeSeparator === "assistant" ||
    beforeSeparator === "system" ||
    beforeSeparator === "tool"
  ) {
    return beforeSeparator;
  }
  return null;
}

function parseTimestamp(header: string): number {
  const after = header.split("·").slice(1).join("·").trim();
  if (after.length === 0) return 0;
  const millis = Date.parse(after);
  return Number.isFinite(millis) ? millis : 0;
}

function formatTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function cryptoRandomId(): string {
  const cryptoRef = (
    globalThis as unknown as {
      crypto?: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  if (cryptoRef?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `message-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function parseFlatYaml(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;
    fields[key] = value;
  }
  return fields;
}

function normalizeApprovalMode(value: string | undefined): ApprovalMode | null {
  if (value === "safe" || value === "yolo") return value;
  return null;
}

function stripJsonString(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}

function numericField(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
