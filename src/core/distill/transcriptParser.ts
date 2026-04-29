/**
 * Pure transcript parser used by `agent.distill`. Accepts markdown / JSONL /
 * JSON inputs and returns a canonical message list. No I/O, no DB, no LLM.
 *
 * Responsibilities:
 *
 *   - Recognize Claude Code's JSONL session shape (`type: "user" | "assistant"
 *     | "tool_use" | "tool_result"`) so external skills can hand the daemon a
 *     ~/.claude/projects/<slug>/*.jsonl file directly.
 *   - Recognize the OpenAI-style `{ role, content }` shape so generic chat
 *     exports work without a re-encode step.
 *   - Recognize markdown blocks of the form `User: ...`, `Assistant: ...`,
 *     `System: ...`, `Tool: ...` so a hand-edited paste works as well.
 *
 * Source ids are derived from the message position plus a hash of the
 * normalized (role, content) tuple so the same transcript reparsed yields the
 * same ids. The handler echoes those ids back into proposal frontmatter so the
 * caller can correlate proposals with original transcript turns.
 */

export type TranscriptFormat = "markdown" | "jsonl" | "json" | "auto";

export type TranscriptRole = "user" | "assistant" | "system" | "tool";

export interface TranscriptMessage {
  role: TranscriptRole;
  content: string;
  sourceMessageId: string;
}

interface ContentTextPart {
  type: "text";
  text: string;
}

interface ClaudeCodeMessageEnvelope {
  content: string | ContentTextPart[];
}

interface RawMessage {
  role: TranscriptRole;
  content: string;
}

const MARKDOWN_HEADER_PATTERN = /^\s*(user|assistant|system|tool)\s*:\s*(.*)$/i;
const TOOL_RESULT_PREVIEW_CHARS = 240;

export function detectFormat(content: string, filenameHint?: string): TranscriptFormat {
  const fromHint = formatFromFilename(filenameHint);
  if (fromHint !== null) return fromHint;
  return formatFromContent(content);
}

export function parseTranscript(content: string, format: TranscriptFormat): TranscriptMessage[] {
  const resolved: Exclude<TranscriptFormat, "auto"> =
    format === "auto" ? formatFromContent(content) : format;
  const raw = parseByFormat(content, resolved);
  return raw.map((entry, index) => ({
    role: entry.role,
    content: entry.content,
    sourceMessageId: makeSourceMessageId(index, entry),
  }));
}

function parseByFormat(content: string, format: Exclude<TranscriptFormat, "auto">): RawMessage[] {
  switch (format) {
    case "markdown":
      return parseMarkdown(content);
    case "jsonl":
      return parseJsonl(content);
    case "json":
      return parseJson(content);
  }
}

function formatFromFilename(filenameHint?: string): TranscriptFormat | null {
  if (filenameHint === undefined) return null;
  const lower = filenameHint.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  return null;
}

function formatFromContent(content: string): Exclude<TranscriptFormat, "auto"> {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return "json";
    } catch {
      // Fall through to JSONL / markdown sniffing.
    }
  }
  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 1 && lines.every(isJsonObjectLine)) return "jsonl";
  return "markdown";
}

function isJsonObjectLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function parseMarkdown(content: string): RawMessage[] {
  const lines = content.split("\n");
  const messages: RawMessage[] = [];
  let active: { role: TranscriptRole; lines: string[] } | null = null;

  for (const line of lines) {
    const headerMatch = line.match(MARKDOWN_HEADER_PATTERN);
    if (headerMatch) {
      flushMarkdownBlock(active, messages);
      const role = normalizeRole(headerMatch[1].toLowerCase());
      active = { role, lines: [headerMatch[2]] };
      continue;
    }
    if (active === null) {
      // Pre-header text without a recognized role is dropped; the caller can
      // re-shape the transcript if it carries useful preamble.
      continue;
    }
    active.lines.push(line);
  }
  flushMarkdownBlock(active, messages);
  return messages;
}

function flushMarkdownBlock(
  block: { role: TranscriptRole; lines: string[] } | null,
  messages: RawMessage[],
): void {
  if (block === null) return;
  const joined = block.lines.join("\n").trim();
  if (joined.length === 0) return;
  messages.push({ role: block.role, content: joined });
}

function parseJsonl(content: string): RawMessage[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const messages: RawMessage[] = [];
  const pendingToolResults: string[] = [];
  for (const line of lines) {
    const parsed = safeParseObject(line);
    if (parsed === null) continue;
    interpretJsonlEntry(parsed, messages, pendingToolResults);
  }
  // Flush any unattached tool_result markers as a standalone tool message so
  // their content still reaches the distiller.
  if (pendingToolResults.length > 0) {
    messages.push({ role: "tool", content: pendingToolResults.join("\n") });
    pendingToolResults.length = 0;
  }
  return messages;
}

function interpretJsonlEntry(
  entry: Record<string, unknown>,
  messages: RawMessage[],
  pendingToolResults: string[],
): void {
  const type = typeof entry.type === "string" ? entry.type : null;
  if (type === "user" || type === "assistant") {
    handleClaudeCodeMessage(type, entry, messages, pendingToolResults);
    return;
  }
  if (type === "tool_use") {
    const name = typeof entry.name === "string" ? entry.name : "tool";
    appendToolUseMarker(messages, `[tool_use: ${name}]`);
    return;
  }
  if (type === "tool_result") {
    const raw = typeof entry.content === "string" ? entry.content : safeStringify(entry.content);
    const truncated = truncate(raw, TOOL_RESULT_PREVIEW_CHARS);
    pendingToolResults.push(`[tool_result: ${truncated}]`);
    return;
  }
  handleGenericRoleEntry(entry, messages);
}

function handleClaudeCodeMessage(
  role: "user" | "assistant",
  entry: Record<string, unknown>,
  messages: RawMessage[],
  pendingToolResults: string[],
): void {
  const flat = flattenEnvelopeContent(entry.message);
  if (flat === null) return;
  const content =
    role === "assistant" && pendingToolResults.length > 0
      ? `${pendingToolResults.splice(0).join("\n")}\n${flat}`.trim()
      : flat;
  messages.push({ role, content });
}

function handleGenericRoleEntry(entry: Record<string, unknown>, messages: RawMessage[]): void {
  if (typeof entry.role !== "string" || typeof entry.content !== "string") return;
  const role = normalizeRole(entry.role);
  messages.push({ role, content: entry.content.trim() });
}

function flattenEnvelopeContent(envelope: unknown): string | null {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const candidate = envelope as ClaudeCodeMessageEnvelope;
  if (typeof candidate.content === "string") return candidate.content.trim();
  if (Array.isArray(candidate.content)) {
    const parts = candidate.content
      .filter((part): part is ContentTextPart => isTextPart(part))
      .map((part) => part.text);
    return parts.join("\n\n").trim();
  }
  return null;
}

function isTextPart(value: unknown): value is ContentTextPart {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string";
}

function appendToolUseMarker(messages: RawMessage[], marker: string): void {
  const tail = messages[messages.length - 1];
  if (tail !== undefined && tail.role === "assistant") {
    tail.content = `${tail.content}\n${marker}`.trim();
    return;
  }
  messages.push({ role: "assistant", content: marker });
}

function parseJson(content: string): RawMessage[] {
  const root = parseJsonRoot(content);
  const list = pickMessageList(root);
  const out: RawMessage[] = [];
  for (const entry of list) {
    const message = toRawJsonMessage(entry);
    if (message !== null) out.push(message);
  }
  return out;
}

function parseJsonRoot(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`unrecognized JSON shape: ${reason}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unrecognized JSON shape: root must be an object");
  }
  return parsed as Record<string, unknown>;
}

function pickMessageList(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.messages)) return root.messages;
  if (Array.isArray(root.transcript)) return root.transcript;
  throw new Error("unrecognized JSON shape: expected 'messages' or 'transcript' array at root");
}

function toRawJsonMessage(entry: unknown): RawMessage | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.role !== "string") return null;
  const role = normalizeRole(record.role);
  const flatContent = extractJsonContent(record.content);
  if (flatContent === null) return null;
  return { role, content: flatContent };
}

function extractJsonContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts = content.filter((part): part is ContentTextPart => isTextPart(part));
    if (parts.length === 0) return null;
    return parts
      .map((part) => part.text)
      .join("\n\n")
      .trim();
  }
  return null;
}

function normalizeRole(input: string): TranscriptRole {
  const lowered = input.toLowerCase();
  if (lowered === "user" || lowered === "assistant" || lowered === "system" || lowered === "tool") {
    return lowered;
  }
  // Unknown roles fall back to "user" so external transcripts with custom
  // labels (e.g. "human") still surface their text into the distiller input.
  return "user";
}

function safeParseObject(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(input: string, max: number): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function makeSourceMessageId(index: number, raw: RawMessage): string {
  const seed = `${index}|${raw.role}|${raw.content}`;
  return `msg-${index}-${djb2Hex(seed)}`;
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let cursor = 0; cursor < input.length; cursor++) {
    hash = ((hash << 5) + hash + input.charCodeAt(cursor)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
