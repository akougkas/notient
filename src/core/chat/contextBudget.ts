import { sourceReferenceSchema } from "../../api/schema";
import type { ChatContent } from "../llm/provider";

/** Pack provider context without altering the persisted transcript. Keep short,
 * attributed note excerpts before resorting to removing old tool results. */
export function fitToolEvidence<T extends { role: string; content: ChatContent }>(
  input: readonly T[],
  budget: number,
  estimate: (text: string) => number,
): T[] {
  const messages = [...input];
  const total = () =>
    messages.reduce((sum, message) => sum + estimate(contentText(message.content)), 0);
  if (total() <= budget) return messages;
  const excerptBudget = Math.max(1, Math.min(2000, Math.floor(budget / 4)));
  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    const excerpt = noteExcerpt(message.content, excerptBudget, estimate);
    if (excerpt !== null) messages[index] = { ...message, content: excerpt };
    if (total() <= budget) return messages;
  }
  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    if (/^\[truncated \d+ chars\]$/.test(message.content)) continue;
    messages[index] = { ...message, content: `[truncated ${message.content.length} chars]` };
    if (total() <= budget) return messages;
  }
  return messages;
}

function noteExcerpt(
  content: string,
  budget: number,
  estimate: (text: string) => number,
): string | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.body !== "string" || typeof data.notePath !== "string")
    return null;
  const body = data.body;
  const tokens = estimate(body);
  if (tokens <= budget) return null;
  const boundary = Math.max(1, Math.floor((body.length * budget) / Math.max(1, tokens)));
  const newline = body.lastIndexOf("\n", boundary);
  const lineEnd = newline > 0 && body[newline - 1] === "\r" ? newline - 1 : newline;
  const excerpt = body.slice(0, lineEnd > 0 ? lineEnd : boundary);
  const start =
    isRecord(data.lineRange) && Number.isSafeInteger(data.lineRange.start)
      ? Number(data.lineRange.start)
      : 1;
  const source = sourceReferenceSchema.safeParse(data.evidence);
  const evidence =
    source.success && source.data.quote === body
      ? {
          ...source.data,
          quote: excerpt,
          range: {
            ...source.data.range,
            end: source.data.range.start + excerpt.length,
            endLine: source.data.range.startLine + excerpt.split(/\r\n|\n|\r/).length - 1,
          },
        }
      : undefined;
  return JSON.stringify({
    ...data,
    ...(evidence ? { evidence } : {}),
    ...(Object.hasOwn(data, "structure") ? { structure: null, structureOmitted: true } : {}),
    body: excerpt,
    lineRange: { start, end: start + excerpt.split("\n").length - 1 },
    contextTruncation: {
      originalCharacters: body.length,
      retainedCharacters: excerpt.length,
      endsMidLine: newline <= 0,
      notice:
        "The remaining source text is omitted from this model context. Only the excerpt above is available as evidence.",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: ChatContent): string {
  return typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : part.image_url.url)).join("");
}
