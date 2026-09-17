import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import type { LLMProvider } from "../llm/provider";
import { deepSynthesizePrompt } from "./prompts/deepSynthesize";
import type { SearchHit, SynthesisBullet, SynthesisCard } from "./types";

export type { SynthesisCard } from "./types";

export interface SynthesizerOptions {
  provider: LLMProvider;
  model: string;
  query: string;
  hits: SearchHit[];
  signal: AbortSignal;
  scheduler: ReasoningScheduler;
  /** Optional cap on response tokens. Undefined lets the local server decide. */
  maxTokens?: number;
  /** Optional callback invoked for each streamed delta. */
  onToken?: (token: string) => void;
}

const CITATION_PATTERN = /\[\[[^\]]+\]\]/g;
const FENCED_BLOCK_PATTERN = /```[\s\S]*?```/g;

/**
 * Streams a grounded synthesis from the LLM and parses bullets out of the
 * response. The function never throws on malformed payloads. When the model
 * returns nothing useful or a transport error fires, the result carries an
 * `error` field instead so callers can render a degraded card. Abort signals
 * propagate so the pipeline can short-circuit cleanly.
 */
export async function synthesize(options: SynthesizerOptions): Promise<SynthesisCard> {
  if (options.hits.length === 0) {
    return { bullets: [], rawText: "", error: "no-hits" };
  }
  const messages = deepSynthesizePrompt({ query: options.query, hits: options.hits });
  let buffer = "";
  try {
    await options.scheduler.run(
      "search:synthesis",
      async (scheduledSignal) => {
        const stream = options.provider.chatStream(messages, {
          model: options.model,
          signal: scheduledSignal,
          temperature: 0.2,
          maxTokens: options.maxTokens,
          enableThinking: false,
        });
        for await (const token of stream) {
          if (scheduledSignal.aborted) {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            throw abortError;
          }
          if (token.length === 0) continue;
          buffer += token;
          options.onToken?.(token);
        }
      },
      { signal: options.signal },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { bullets: [], rawText: buffer, error: message };
  }
  if (buffer.trim().length === 0) {
    return { bullets: [], rawText: buffer, error: "empty-response" };
  }
  return parseSynthesis(buffer, allowedCitationsForHits(options.hits));
}

/**
 * Extracts cited bullets from the model's markdown response. Bullets without
 * a `[[wikilink]]` citation are dropped per the "cite or skip" contract. When
 * an allowlist is supplied, every citation in a kept bullet must point at one
 * of the retrieved source notes. Fenced blocks are removed before parsing so
 * malformed JSON/code does not accidentally count as grounded prose.
 */
export function parseSynthesis(
  text: string,
  allowedCitations?: ReadonlySet<string>,
): SynthesisCard {
  const bulletPattern = /^[\s>]*[-*]\s+(.*)$/gm;
  const bullets: SynthesisBullet[] = [];
  const parseableText = text.replace(FENCED_BLOCK_PATTERN, "");
  let match: RegExpExecArray | null = bulletPattern.exec(parseableText);
  while (match !== null) {
    const line = match[1].trim();
    const citations = Array.from(line.matchAll(CITATION_PATTERN)).map((entry) => entry[0]);
    if (citations.length > 0 && citationsAllowed(citations, allowedCitations)) {
      bullets.push({ text: line, citations });
    }
    match = bulletPattern.exec(parseableText);
  }
  if (bullets.length === 0) {
    return { bullets: [], rawText: text, error: "no-citations" };
  }
  return { bullets, rawText: text };
}

function citationsAllowed(
  citations: string[],
  allowedCitations: ReadonlySet<string> | undefined,
): boolean {
  if (allowedCitations === undefined) return true;
  return citations.every((citation) => allowedCitations.has(citation));
}

function allowedCitationsForHits(hits: SearchHit[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const hit of hits) {
    const sourcePath = hit.notePath;
    if (sourcePath.length === 0) continue;
    const cleanPath = sourcePath.replace(/^\/+/, "");
    const withoutExtension = cleanPath.replace(/\.md$/i, "");
    const title = wikiTitleFor(cleanPath);
    out.add(`[[${title}]]`);
    out.add(`[[${withoutExtension}]]`);
    out.add(`[[${cleanPath}]]`);
  }
  return out;
}

function wikiTitleFor(notePath: string): string {
  if (notePath.length === 0) return "unknown";
  const fileName = notePath.split("/").pop() ?? notePath;
  return fileName.replace(/\.md$/i, "");
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
