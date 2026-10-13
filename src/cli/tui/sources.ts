import { noteExcerptSchema, retrievalResultSchema } from "../../api/retrieval";
import type { SourceReference } from "../../api/schema";
import type { ChatMessage } from "../../core/chat/types";

/** Source cards come from completed, paired domain reads, never model prose,
 * reasoning or tool arguments. Restored transcripts are checked again on open. */
export function conversationSources(messages: readonly ChatMessage[]): SourceReference[] {
  const sources: SourceReference[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      const results = message.toolResults?.filter((item) => item.callId === call.id);
      if (results?.length !== 1 || results[0]?.status !== "ok") continue;
      for (const source of toolSources(call.name, results[0].data)) addSource(sources, source);
    }
  }
  return sources;
}

/** Only completed domain results can supply early evidence; never call arguments. */
export function toolSources(tool: string, data: unknown): SourceReference[] {
  const sources: SourceReference[] = [];
  if (tool === "vault.read_note") {
    const parsed = noteExcerptSchema.safeParse(data);
    if (
      parsed.success &&
      parsed.data.notePath === parsed.data.evidence.path &&
      parsed.data.body === parsed.data.evidence.quote
    ) {
      addSource(sources, parsed.data.evidence);
      for (const record of parsed.data.retainedUnderstanding?.records ?? [])
        if (
          record.source.path === parsed.data.notePath &&
          record.source.revision === parsed.data.evidence.revision
        )
          addSource(sources, record.source);
    }
  } else if (tool === "vault.search_notes") {
    const parsed = retrievalResultSchema.safeParse(data);
    if (parsed.success)
      for (const hit of parsed.data.hits) {
        if (
          hit.evidence &&
          hit.freshness.state === "current" &&
          hit.note.path === hit.evidence.path &&
          hit.note.revision === hit.evidence.revision
        )
          addSource(sources, hit.evidence);
      }
  }
  return sources;
}

export function mergeSources(
  previous: readonly SourceReference[],
  incoming: readonly SourceReference[],
): SourceReference[] {
  const sources = [...previous];
  for (const source of incoming) addSource(sources, source);
  return sources;
}

function addSource(sources: SourceReference[], source: SourceReference): void {
  if (!source.quote.trim() || source.range.end - source.range.start !== source.quote.length) return;
  const same = (other: SourceReference) =>
    other.path === source.path && other.revision === source.revision;
  if (
    sources.some(
      (other) =>
        same(other) &&
        other.range.start <= source.range.start &&
        other.range.end >= source.range.end,
    )
  )
    return;
  const contained = sources.findIndex(
    (other) =>
      same(other) && source.range.start <= other.range.start && source.range.end >= other.range.end,
  );
  if (contained !== -1) {
    sources.splice(contained, 1, source);
    for (let i = sources.length - 1; i > contained; i--) {
      const other = sources[i];
      if (
        other &&
        same(other) &&
        source.range.start <= other.range.start &&
        source.range.end >= other.range.end
      )
        sources.splice(i, 1);
    }
  } else if (sources.length < 50) sources.push(source);
}

export function sourceLabel(source: SourceReference, width = 100): string {
  const name = source.path.split("/").at(-1)?.replace(/\.md$/, "") ?? source.path;
  const range = source.range;
  const suffix = ` · L${range.startLine}${range.endLine === range.startLine ? "" : `–${range.endLine}`}`;
  const room = Math.max(1, width - suffix.length);
  return `${name.length > room ? `${name.slice(0, Math.max(0, room - 1))}…` : name}${suffix}`;
}
