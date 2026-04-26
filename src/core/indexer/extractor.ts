import type { ChatMessage, JsonSchema, LLMProvider } from "../llm/provider";
import type { Chunk, Extraction } from "./types";

export interface ExtractorOptions {
  model: string;
  concurrency?: number;
  signal?: AbortSignal;
}

const MAX_ENTITIES_PER_CHUNK = 5;
const MAX_CLAIMS_PER_CHUNK = 3;
const MAX_QUESTIONS_PER_CHUNK = 3;

const SYSTEM_PROMPT = `You are Notient's extractor. Read one note chunk and output ONLY what a careful human reader would highlight as worth tracking.

Return at most:
- ${MAX_ENTITIES_PER_CHUNK} entities — proper nouns (people, named projects, named systems, products), or domain-specific technical terms with strong specificity. Use the canonical singular form. Skip generic words like "system", "process", "note", "thing", "user". If the chunk has none, return [].
- ${MAX_CLAIMS_PER_CHUNK} claims — non-trivial, specific assertions the chunk makes. A claim must be sharp enough that a thoughtful reader could disagree. Skip restatements of obvious facts and definitions. One declarative sentence each. If the chunk has none, return [].
- ${MAX_QUESTIONS_PER_CHUNK} questions — genuine open questions the chunk raises and does not answer. End each with "?". Skip rhetorical questions. If the chunk has none, return [].

Quality over quantity. Empty arrays are correct when nothing is worth tracking. Never invent facts.`;

const SCHEMA: JsonSchema = {
  name: "Extraction",
  schema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_ENTITIES_PER_CHUNK,
      },
      claims: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_CLAIMS_PER_CHUNK,
      },
      questions: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_QUESTIONS_PER_CHUNK,
      },
    },
    required: ["entities", "claims", "questions"],
    additionalProperties: false,
  },
};

export class Extractor {
  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: ExtractorOptions,
  ) {}

  async extract(chunks: Chunk[]): Promise<Extraction> {
    if (chunks.length === 0) return { entities: [], claims: [], questions: [] };
    const concurrency = Math.max(1, this.opts.concurrency ?? 4);
    const results: Extraction[] = [];

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((c) => this.extractOne(c)));
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
      }
    }

    return mergeExtractions(results);
  }

  private async extractOne(chunk: Chunk): Promise<Extraction> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: chunk.text },
    ];
    const result = await this.provider.chatJson<Extraction>(
      messages,
      { model: this.opts.model, signal: this.opts.signal, temperature: 0.1 },
      SCHEMA,
    );
    return {
      entities: ensureStringArray(result.entities).slice(0, MAX_ENTITIES_PER_CHUNK),
      claims: ensureStringArray(result.claims).slice(0, MAX_CLAIMS_PER_CHUNK),
      questions: ensureStringArray(result.questions).slice(0, MAX_QUESTIONS_PER_CHUNK),
    };
  }
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function mergeExtractions(parts: Extraction[]): Extraction {
  const entities = dedupeCaseInsensitive(parts.flatMap((p) => p.entities));
  const claims = dedupe(parts.flatMap((p) => p.claims));
  const questions = dedupe(parts.flatMap((p) => p.questions));
  return { entities, claims, questions };
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values());
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}
