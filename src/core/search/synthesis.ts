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
  /** Optional cap on response tokens. Defaults to 600. */
  maxTokens?: number;
  /** Optional callback invoked for each streamed delta. */
  onToken?: (token: string) => void;
}

const CITATION_PATTERN = /\[\[[^\]]+\]\]/g;

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
    const stream = options.provider.chatStream(messages, {
      model: options.model,
      signal: options.signal,
      temperature: 0.2,
      maxTokens: options.maxTokens ?? 600,
    });
    for await (const token of stream) {
      if (options.signal.aborted) {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      if (token.length === 0) continue;
      buffer += token;
      options.onToken?.(token);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { bullets: [], rawText: buffer, error: message };
  }
  if (buffer.trim().length === 0) {
    return { bullets: [], rawText: buffer, error: "empty-response" };
  }
  return parseSynthesis(buffer);
}

/**
 * Extracts cited bullets from the model's markdown response. Bullets without
 * a `[[wikilink]]` citation are dropped per the "cite or skip" contract.
 * Tolerates trailing prose by ignoring lines that do not match the bullet
 * regex.
 */
export function parseSynthesis(text: string): SynthesisCard {
  const bulletPattern = /^[\s>]*[-*]\s+(.*)$/gm;
  const bullets: SynthesisBullet[] = [];
  let match: RegExpExecArray | null = bulletPattern.exec(text);
  while (match !== null) {
    const line = match[1].trim();
    const citations = Array.from(line.matchAll(CITATION_PATTERN)).map((entry) => entry[0]);
    if (citations.length > 0) {
      bullets.push({ text: line, citations });
    }
    match = bulletPattern.exec(text);
  }
  if (bullets.length === 0) {
    return { bullets: [], rawText: text, error: "no-citations" };
  }
  return { bullets, rawText: text };
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}
