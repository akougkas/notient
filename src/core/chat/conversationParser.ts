import { AGENT_ID_PATTERN, isCanonicalAgentId } from "../auth/agentIdentity";
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
 *     `notient: conversation` and `conversation_version: 1` identify the
 *     file before any transcript data is accepted.
 *   - Body: an invisible `notient-message` boundary wraps each
 *     `## <Role> · <ISO timestamp>` message. The boundary keeps headings in
 *     message content from being mistaken for a new turn. Tool calls and
 *     approvals remain native Obsidian callouts.
 *
 * Roundtrip contract: `parseConversation(serializeConversation(c)).messages`
 * preserves role, content, toolCalls, toolResults, approvals, and createdAt
 * (timestamp goes through ISO 8601 which is millisecond-precise). Message
 * `id` is regenerated on parse since the markdown does not carry it; callers
 * that need stable ids should keep the in-memory Conversation alive.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const CONVERSATION_MARKER = "conversation";
const CONVERSATION_VERSION = 1;
const MESSAGE_START = "<!-- notient-message -->";
const MESSAGE_END = "<!-- /notient-message -->";
const MESSAGE_BLOCK_RE = /^<!-- notient-message -->\n([\s\S]*?)\n<!-- \/notient-message -->$/gm;
const MESSAGE_HEADER_RE = /^## (User|Assistant|System|Tool) · (.+)$/;
const RETIRED_MESSAGE_SENDER_RE = /^(Sender|Client|Human|Agent)(?:\s|·|$)/i;

const FRONTMATTER_FIELDS = [
  "notient",
  "conversation_version",
  "conversation_id",
  "model",
  "pinned_context",
  "approval_mode",
  "topic",
  "summary",
  "client_identity",
  "created_at",
  "updated_at",
  "message_count",
] as const;

const FRONTMATTER_FIELD_SET = new Set<string>(FRONTMATTER_FIELDS);
const RETIRED_IDENTITY_FIELDS = new Set([
  "sender",
  "sender_identity",
  "senderIdentity",
  "client",
  "client_id",
  "clientId",
  "clientIdentity",
  "agent",
  "agent_identity",
  "agentIdentity",
]);
interface ConversationFrontmatter {
  notient: typeof CONVERSATION_MARKER;
  conversation_version: typeof CONVERSATION_VERSION;
  conversation_id: string;
  model: string;
  pinned_context: string[];
  approval_mode: ApprovalMode;
  topic: string;
  summary: string;
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
  /** From a `> [!notient-tool-result] <call id>` callout. */
  toolCallId: string | undefined;
}

export function serializeConversation(conv: Conversation): string {
  const frontmatter: ConversationFrontmatter = {
    notient: CONVERSATION_MARKER,
    conversation_version: CONVERSATION_VERSION,
    conversation_id: conv.id,
    model: conv.model,
    pinned_context: conv.pinnedContext,
    approval_mode: conv.approvalMode,
    topic: conv.topic,
    summary: conv.summary,
    client_identity: conv.clientIdentity,
    created_at: conv.createdAt,
    updated_at: conv.updatedAt,
    message_count: conv.messages.length,
  };
  assertSerializableFrontmatter(frontmatter);
  const fm = renderFrontmatter(frontmatter);
  const heading = `# ${conv.topic.length > 0 ? conv.topic : "Conversation"}`;
  const messages = conv.messages.map((message) => renderMessage(message)).join("\n\n");
  const body = messages.length > 0 ? `${heading}\n\n${messages}\n` : `${heading}\n`;
  return `${fm}\n${body}`;
}

export function parseConversation(raw: string, notePath: string): Conversation {
  const match = FRONTMATTER_RE.exec(raw);
  if (match === null) {
    throw new Error("invalid conversation: missing Notient conversation frontmatter");
  }
  const frontmatter = parseFrontmatter(match[1] ?? "");
  const body = raw.slice(match[0].length);
  const messages = parseMessages(body, frontmatter.topic);
  if (frontmatter.message_count !== messages.length) {
    throw new Error(
      `invalid conversation: message_count is ${frontmatter.message_count}, parsed ${messages.length}`,
    );
  }
  return {
    id: frontmatter.conversation_id,
    notePath,
    model: frontmatter.model,
    pinnedContext: frontmatter.pinned_context,
    approvalMode: frontmatter.approval_mode,
    topic: frontmatter.topic,
    summary: frontmatter.summary,
    clientIdentity: frontmatter.client_identity,
    messageCount: frontmatter.message_count,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    messages,
  };
}

/**
 * Reports whether a Markdown document explicitly claims the Notient
 * conversation format. This is intentionally narrower than parsing: the
 * store uses it only to leave unrelated Markdown alone. Once a document
 * carries the marker, every other field is validated by parseConversation
 * and corruption is surfaced rather than silently skipped.
 */
export function claimsNotientConversation(raw: string): boolean {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/\r$/, "");
    if (line === "---") return false;
    if (line === "notient: conversation") return true;
  }
  return false;
}

function renderFrontmatter(values: ConversationFrontmatter): string {
  const lines = [
    "---",
    `notient: ${values.notient}`,
    `conversation_version: ${values.conversation_version}`,
    `conversation_id: ${JSON.stringify(values.conversation_id)}`,
    `model: ${JSON.stringify(values.model)}`,
    `pinned_context: ${JSON.stringify(values.pinned_context)}`,
    `approval_mode: ${values.approval_mode}`,
    `topic: ${JSON.stringify(values.topic)}`,
    `summary: ${JSON.stringify(values.summary)}`,
    `client_identity: ${JSON.stringify(values.client_identity)}`,
    `created_at: ${values.created_at}`,
    `updated_at: ${values.updated_at}`,
    `message_count: ${values.message_count}`,
    "---",
  ];
  return lines.join("\n");
}

function assertSerializableFrontmatter(values: ConversationFrontmatter): void {
  if (values.conversation_id.length === 0) {
    throw new Error("invalid conversation: conversation_id must not be empty");
  }
  if (values.model.length === 0) {
    throw new Error("invalid conversation: model must not be empty");
  }
  if (values.topic.includes("\n") || values.topic.includes("\r")) {
    throw new Error("invalid conversation: topic must fit on one line");
  }
  if (!isCanonicalAgentId(values.client_identity)) {
    throw new Error(`invalid conversation: client_identity must match ${AGENT_ID_PATTERN.source}`);
  }
  if (!values.pinned_context.every((entry) => typeof entry === "string")) {
    throw new Error("invalid conversation: pinned_context must contain only strings");
  }
  if (values.approval_mode !== "safe" && values.approval_mode !== "yolo") {
    throw new Error("invalid conversation: approval_mode must be 'safe' or 'yolo'");
  }
  assertSerializableInteger("created_at", values.created_at);
  assertSerializableInteger("updated_at", values.updated_at);
  assertSerializableInteger("message_count", values.message_count);
  if (values.updated_at < values.created_at) {
    throw new Error("invalid conversation: updated_at must be at or after created_at");
  }
}

function assertSerializableInteger(key: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid conversation: ${key} must be a non-negative safe integer`);
  }
}

function parseFrontmatter(yaml: string): ConversationFrontmatter {
  const fields = parseFlatYaml(yaml);
  assertCanonicalFrontmatterFields(fields);

  if (fields.notient !== CONVERSATION_MARKER) {
    throw new Error("invalid conversation: missing marker 'notient: conversation'");
  }
  const version = parseIntegerField(fields, "conversation_version");
  if (version !== CONVERSATION_VERSION) {
    throw new Error(
      `invalid conversation: unsupported conversation_version ${version}; expected ${CONVERSATION_VERSION}`,
    );
  }

  const conversationId = parseJsonStringField(fields, "conversation_id");
  if (conversationId.length === 0) {
    throw new Error("invalid conversation: conversation_id must not be empty");
  }
  const model = parseJsonStringField(fields, "model");
  if (model.length === 0) {
    throw new Error("invalid conversation: model must not be empty");
  }
  const pinnedContext = parseStringArrayField(fields, "pinned_context");
  const approvalMode = normalizeApprovalMode(fields.approval_mode);
  if (approvalMode === null) {
    throw new Error("invalid conversation: approval_mode must be 'safe' or 'yolo'");
  }
  const clientIdentity = parseJsonStringField(fields, "client_identity");
  if (!isCanonicalAgentId(clientIdentity)) {
    throw new Error(`invalid conversation: client_identity must match ${AGENT_ID_PATTERN.source}`);
  }
  const createdAt = parseIntegerField(fields, "created_at");
  const updatedAt = parseIntegerField(fields, "updated_at");
  if (updatedAt < createdAt) {
    throw new Error("invalid conversation: updated_at must be at or after created_at");
  }

  return {
    notient: CONVERSATION_MARKER,
    conversation_version: CONVERSATION_VERSION,
    conversation_id: conversationId,
    model,
    pinned_context: pinnedContext,
    approval_mode: approvalMode,
    topic: parseJsonStringField(fields, "topic"),
    summary: parseJsonStringField(fields, "summary"),
    client_identity: clientIdentity,
    created_at: createdAt,
    updated_at: updatedAt,
    message_count: parseIntegerField(fields, "message_count"),
  };
}

function renderMessage(message: ChatMessage): string {
  assertSerializableMessage(message);
  const header = `## ${capitalize(message.role)} · ${formatTimestamp(message.createdAt)}`;
  const blocks: string[] = [header];

  if (message.role === "tool") {
    blocks.push(`> [!notient-tool-result] ${message.toolCallId}`);
  }

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

  const rendered = blocks.join("\n\n");
  if (rendered.includes(MESSAGE_START) || rendered.includes(MESSAGE_END)) {
    throw new Error("invalid conversation: message content contains a reserved boundary");
  }
  return `${MESSAGE_START}\n${rendered}\n${MESSAGE_END}`;
}

function assertSerializableMessage(message: ChatMessage): void {
  assertSerializableInteger("message created_at", message.createdAt);
  if (message.role === "tool") {
    if (message.toolCallId.length === 0) {
      throw new Error("invalid conversation: tool message requires a tool-call id");
    }
    return;
  }

  const toolCalls = message.toolCalls ?? [];
  const toolResults = message.toolResults ?? [];
  const approvals = message.approvals ?? [];
  if (message.role !== "assistant" && (toolCalls.length > 0 || toolResults.length > 0)) {
    throw new Error("invalid conversation: only assistant messages may contain tool calls");
  }
  const callIds = collectSerializableToolCallIds(toolCalls);
  assertSerializableToolResults(toolResults, callIds);
  assertSerializableApprovals(approvals, callIds);
}

function collectSerializableToolCallIds(toolCalls: readonly ToolCall[]): Set<string> {
  const callIds = new Set<string>();
  for (const call of toolCalls) {
    if (call.id.length === 0 || call.name.length === 0) {
      throw new Error("invalid conversation: tool calls require an id and name");
    }
    if (callIds.has(call.id)) {
      throw new Error(`invalid conversation: duplicate tool call id ${call.id}`);
    }
    callIds.add(call.id);
  }
  return callIds;
}

function assertSerializableToolResults(
  toolResults: readonly ToolResult[],
  callIds: ReadonlySet<string>,
): void {
  assertSerializableCallRecords(
    "tool result",
    toolResults.map((result) => result.callId),
    callIds,
  );
  for (const result of toolResults) {
    assertSerializableInteger("tool result duration_ms", result.durationMs);
  }
}

function assertSerializableApprovals(
  approvals: readonly ApprovalRecord[],
  callIds: ReadonlySet<string>,
): void {
  assertSerializableCallRecords(
    "approval",
    approvals.map((approval) => approval.callId),
    callIds,
  );
  for (const approval of approvals) {
    assertSerializableInteger("approval decided_at", approval.decidedAt);
  }
}

function assertSerializableCallRecords(
  recordName: string,
  recordCallIds: readonly string[],
  callIds: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const callId of recordCallIds) {
    if (!callIds.has(callId)) {
      throw new Error(`invalid conversation: ${recordName} ${callId} has no matching tool call`);
    }
    if (seen.has(callId)) {
      throw new Error(`invalid conversation: tool call ${callId} has multiple ${recordName}s`);
    }
    seen.add(callId);
  }
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

function parseMessages(body: string, topic: string): ChatMessage[] {
  const heading = `# ${topic.length > 0 ? topic : "Conversation"}`;
  if (body !== heading && !body.startsWith(`${heading}\n`)) {
    throw new Error("invalid conversation: body title does not match topic");
  }
  const transcript = body.slice(heading.length);
  if (transcript.trim().length === 0) return [];

  const messages: ChatMessage[] = [];
  let cursor = 0;
  MESSAGE_BLOCK_RE.lastIndex = 0;
  for (const match of transcript.matchAll(MESSAGE_BLOCK_RE)) {
    const start = match.index;
    if (transcript.slice(cursor, start).trim().length > 0) {
      throw new Error("invalid conversation: content outside a Notient message boundary");
    }
    messages.push(parseMessageSection(match[1] ?? ""));
    cursor = start + match[0].length;
  }
  if (transcript.slice(cursor).trim().length > 0) {
    throw new Error("invalid conversation: content outside a Notient message boundary");
  }
  return messages;
}

function parseMessageSection(section: string): ChatMessage {
  const headerEnd = section.indexOf("\n");
  const header = headerEnd >= 0 ? section.slice(0, headerEnd) : section;
  const rest = headerEnd >= 0 ? section.slice(headerEnd + 1) : "";
  const { role, createdAt } = parseMessageHeader(header);
  const callouts = extractCallouts(rest);
  const content = callouts.contentWithoutCallouts.trim();
  if (role === "tool") {
    return parseToolMessage(content, createdAt, callouts);
  }
  if (callouts.toolCallId !== undefined) {
    throw new Error("invalid conversation: tool-result callout is outside a tool message");
  }
  if (
    role !== "assistant" &&
    (callouts.toolCalls !== undefined ||
      callouts.toolResults !== undefined ||
      callouts.approvals !== undefined)
  ) {
    throw new Error("invalid conversation: only assistant messages may contain tool calls");
  }
  return {
    id: cryptoRandomId(),
    role,
    content,
    toolCalls: callouts.toolCalls,
    toolResults: callouts.toolResults,
    approvals: callouts.approvals,
    createdAt,
  };
}

function parseToolMessage(
  content: string,
  createdAt: number,
  callouts: CalloutExtraction,
): ChatMessage {
  if (callouts.toolCallId === undefined) {
    throw new Error("invalid conversation: tool message is missing its tool-call id");
  }
  if (
    callouts.toolCalls !== undefined ||
    callouts.toolResults !== undefined ||
    callouts.approvals !== undefined
  ) {
    throw new Error("invalid conversation: tool message contains assistant callouts");
  }
  return {
    id: cryptoRandomId(),
    role: "tool",
    content,
    toolCallId: callouts.toolCallId,
    createdAt,
  };
}

type CalloutKind = "notient-tool" | "notient-tool-result" | "notient-approval";

interface CalloutBlock {
  kind: CalloutKind;
  headerTitle: string;
  blockLines: string[];
  endIndex: number;
}

// `notient-tool-result` must precede `notient-tool` in the alternation so the
// longer kind wins; regex alternation is first-match, not longest-match.
const CALLOUT_HEADER_RE = /^> \[!(notient-tool-result|notient-tool|notient-approval)\] *(.*)$/;

function isCalloutKind(value: string): value is CalloutKind {
  return (
    value === "notient-tool" || value === "notient-tool-result" || value === "notient-approval"
  );
}

function readCalloutBlock(lines: string[], start: number): CalloutBlock | null {
  const match = CALLOUT_HEADER_RE.exec(lines[start]);
  if (!match) return null;
  const kindRaw = match[1];
  if (kindRaw === undefined || !isCalloutKind(kindRaw)) return null;
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
  const sink: CalloutSink = { toolCalls, toolResults, approvals, toolCallId: undefined };

  let index = 0;
  while (index < lines.length) {
    const block = readCalloutBlock(lines, index);
    if (block === null) {
      remaining.push(lines[index]);
      index++;
      continue;
    }
    applyCallout(block, sink);
    index = block.endIndex;
  }
  const toolCallId = sink.toolCallId;
  validateCalloutRelationships(toolCalls, approvals);

  return {
    contentWithoutCallouts: remaining.join("\n"),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    approvals: approvals.length > 0 ? approvals : undefined,
    toolCallId,
  };
}

function validateCalloutRelationships(
  toolCalls: readonly ToolCall[],
  approvals: readonly ApprovalRecord[],
): void {
  const callIds = new Set(toolCalls.map((call) => call.id));
  const approvedCallIds = new Set<string>();
  for (const approval of approvals) {
    if (!callIds.has(approval.callId)) {
      throw new Error(
        `invalid conversation: approval ${approval.callId} has no matching tool call`,
      );
    }
    if (approvedCallIds.has(approval.callId)) {
      throw new Error(`invalid conversation: tool call ${approval.callId} has multiple approvals`);
    }
    approvedCallIds.add(approval.callId);
  }
}

interface CalloutSink {
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  approvals: ApprovalRecord[];
  toolCallId: string | undefined;
}

function applyCallout(block: CalloutBlock, sink: CalloutSink): void {
  if (block.kind === "notient-tool") {
    collectToolCallout(block.headerTitle, block.blockLines, sink.toolCalls, sink.toolResults);
    return;
  }
  if (block.kind === "notient-tool-result") {
    const id = block.headerTitle.trim();
    if (id.length === 0) {
      throw new Error("invalid conversation: tool-result callout requires a call id");
    }
    if (sink.toolCallId !== undefined) {
      throw new Error("invalid conversation: tool message has multiple tool-result callouts");
    }
    sink.toolCallId = id;
    return;
  }
  const approval = parseApprovalCallout(block.headerTitle, block.blockLines);
  sink.approvals.push(approval);
}

function collectToolCallout(
  headerTitle: string,
  blockLines: string[],
  toolCalls: ToolCall[],
  toolResults: ToolResult[],
): void {
  const parsed = parseToolCallout(headerTitle, blockLines);
  if (toolCalls.some((call) => call.id === parsed.call.id)) {
    throw new Error(`invalid conversation: duplicate tool call id ${parsed.call.id}`);
  }
  toolCalls.push(parsed.call);
  if (parsed.result) toolResults.push(parsed.result);
}

function parseToolCallout(
  headerTitle: string,
  blockLines: string[],
): { call: ToolCall; result: ToolResult | undefined } {
  const fields = parseCalloutFields(blockLines, [
    "id",
    "args",
    "status",
    "duration_ms",
    "data",
    "error",
  ]);
  const name = headerTitle.trim();
  const id = fields.id;
  const argsRaw = fields.args;
  if (name.length === 0 || id === undefined || id.length === 0 || argsRaw === undefined) {
    throw new Error("invalid conversation: tool callout requires name, id, and args");
  }
  const args = parseToolArgs(argsRaw);
  const call: ToolCall = { id, name, args };

  const status = fields.status;
  if (status === undefined) {
    if (
      fields.duration_ms !== undefined ||
      fields.data !== undefined ||
      fields.error !== undefined
    ) {
      throw new Error("invalid conversation: tool result fields require status and duration_ms");
    }
    return { call, result: undefined };
  }
  if (status !== "ok" && status !== "error") {
    throw new Error("invalid conversation: tool result status must be 'ok' or 'error'");
  }
  const durationRaw = fields.duration_ms;
  if (durationRaw === undefined) {
    throw new Error("invalid conversation: tool result requires duration_ms");
  }
  const result: ToolResult = {
    callId: id,
    status,
    durationMs: parseCalloutInteger(durationRaw, "duration_ms"),
  };
  if (fields.data !== undefined) result.data = decodeJson(fields.data, "tool result data");
  if (fields.error !== undefined)
    result.error = decodeJsonString(fields.error, "tool result error");
  return { call, result };
}

function parseToolArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error("invalid conversation: tool args must be a JSON object");
  }
  throw new Error("invalid conversation: tool args must be a JSON object");
}

function decodeJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid conversation: ${field} must be JSON`);
  }
}

function decodeJsonString(raw: string, field: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // The field-level error below is the stable public contract.
  }
  throw new Error(`invalid conversation: ${field} must be a JSON string`);
}

function parseApprovalCallout(headerTitle: string, blockLines: string[]): ApprovalRecord {
  if (headerTitle.trim().length === 0) {
    throw new Error("invalid conversation: approval callout requires a tool name");
  }
  const fields = parseCalloutFields(blockLines, ["call_id", "approved", "decided_at", "reason"]);
  const callId = fields.call_id;
  if (!callId) {
    throw new Error("invalid conversation: approval callout requires call_id");
  }
  const approvedRaw = fields.approved;
  if (approvedRaw !== "true" && approvedRaw !== "false") {
    throw new Error("invalid conversation: approval approved must be true or false");
  }
  const decidedAtRaw = fields.decided_at;
  if (decidedAtRaw === undefined) {
    throw new Error("invalid conversation: approval callout requires decided_at");
  }
  const reasonRaw = fields.reason;
  const approval: ApprovalRecord = {
    callId,
    approved: approvedRaw === "true",
    decidedAt: parseCalloutInteger(decidedAtRaw, "decided_at"),
  };
  if (reasonRaw !== undefined) {
    approval.reason = decodeJsonString(reasonRaw, "approval reason");
  }
  return approval;
}

function parseCalloutFields(
  blockLines: string[],
  allowedFields: readonly string[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  const allowed = new Set(allowedFields);
  for (const raw of blockLines) {
    const stripped = raw.replace(/^>\s?/, "");
    const colon = stripped.indexOf(":");
    if (colon <= 0) {
      throw new Error("invalid conversation: malformed callout field");
    }
    const key = stripped.slice(0, colon).trim();
    const value = stripped.slice(colon + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error("invalid conversation: malformed callout field");
    }
    if (!allowed.has(key)) {
      throw new Error(`invalid conversation: unsupported callout field '${key}'`);
    }
    if (Object.hasOwn(fields, key)) {
      throw new Error(`invalid conversation: duplicate callout field '${key}'`);
    }
    fields[key] = value;
  }
  return fields;
}

function parseCalloutInteger(raw: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`invalid conversation: ${field} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid conversation: ${field} must be a safe integer`);
  }
  return value;
}

function parseMessageHeader(header: string): { role: ChatRole; createdAt: number } {
  const match = MESSAGE_HEADER_RE.exec(header);
  if (match === null) {
    const heading = header.startsWith("## ") ? header.slice(3) : header;
    if (RETIRED_MESSAGE_SENDER_RE.test(heading)) {
      throw new Error("invalid conversation: retired sender heading; use a canonical role heading");
    }
    throw new Error("invalid conversation: malformed message heading");
  }
  const roleLabel = match[1];
  const timestamp = match[2];
  if (roleLabel === undefined || timestamp === undefined) {
    throw new Error("invalid conversation: malformed message heading");
  }
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== timestamp) {
    throw new Error("invalid conversation: message timestamp must be canonical ISO 8601");
  }
  return { role: roleLabel.toLowerCase() as ChatRole, createdAt: millis };
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
  for (const [index, line] of yaml.split("\n").entries()) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`invalid conversation: malformed frontmatter line ${index + 1}`);
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new Error(`invalid conversation: malformed frontmatter line ${index + 1}`);
    }
    if (Object.hasOwn(fields, key)) {
      throw new Error(`invalid conversation: duplicate frontmatter field '${key}'`);
    }
    fields[key] = value;
  }
  return fields;
}

function assertCanonicalFrontmatterFields(fields: Record<string, string>): void {
  for (const key of Object.keys(fields)) {
    if (RETIRED_IDENTITY_FIELDS.has(key)) {
      throw new Error(
        `invalid conversation: retired identity field '${key}'; use 'client_identity'`,
      );
    }
    if (!FRONTMATTER_FIELD_SET.has(key)) {
      throw new Error(`invalid conversation: unsupported frontmatter field '${key}'`);
    }
  }
  for (const key of FRONTMATTER_FIELDS) {
    if (!Object.hasOwn(fields, key)) {
      if (key === "notient") {
        throw new Error("invalid conversation: missing marker 'notient: conversation'");
      }
      throw new Error(`invalid conversation: missing required frontmatter field '${key}'`);
    }
  }
}

function requiredField(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined) {
    throw new Error(`invalid conversation: missing required frontmatter field '${key}'`);
  }
  return value;
}

function parseJsonStringField(fields: Record<string, string>, key: string): string {
  const raw = requiredField(fields, key);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // The field-level error below is the stable public contract.
  }
  throw new Error(`invalid conversation: ${key} must be a JSON string`);
}

function parseStringArrayField(fields: Record<string, string>, key: string): string[] {
  const raw = requiredField(fields, key);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // The field-level error below is the stable public contract.
  }
  throw new Error(`invalid conversation: ${key} must be a JSON array of strings`);
}

function parseIntegerField(fields: Record<string, string>, key: string): number {
  const raw = requiredField(fields, key);
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`invalid conversation: ${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid conversation: ${key} must be a safe integer`);
  }
  return value;
}

function normalizeApprovalMode(value: string | undefined): ApprovalMode | null {
  if (value === "safe" || value === "yolo") return value;
  return null;
}
