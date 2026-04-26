import type { ChatMessage, JsonSchema, LLMProvider } from "../llm/provider";
import type { Chunk, Extraction } from "./types";

export interface ExtractorOptions {
  model: string;
  concurrency?: number;
  signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are Notient's extractor. From a note chunk, identify:
- entities: people, projects, named systems, recurring themes, technical terms (canonical singular form)
- claims: atomic propositions the chunk asserts (one sentence each, declarative)
- questions: open questions the chunk raises (end with "?")
Return only JSON matching the schema. If a category has nothing, return an empty array. Do not invent facts.`;

const SCHEMA: JsonSchema = {
  name: "Extraction",
  schema: {
    type: "object",
    properties: {
      entities: { type: "array", items: { type: "string" } },
      claims: { type: "array", items: { type: "string" } },
      questions: { type: "array", items: { type: "string" } },
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
    const concurrency = Math.max(1, this.opts.concurrency ?? 2);
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
      entities: ensureStringArray(result.entities),
      claims: ensureStringArray(result.claims),
      questions: ensureStringArray(result.questions),
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
