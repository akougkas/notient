import type { RecordId, Surreal } from "surrealdb";
import { relateEdge, upsertClaim, upsertConcept, upsertQuestion } from "../db/surreal";
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
- ${MAX_ENTITIES_PER_CHUNK} entities — proper nouns (people, named projects, named systems, products), or domain-specific technical terms with strong specificity. Use the canonical singular form. Skip generic words like "system", "process", "note", "thing", "user", "structure", "wrappers", "Distributed". Skip code-shaped tokens with underscores or hyphens (e.g. "connection_builder", "npm-db"); name the concept they represent in plain words instead, or omit. Skip generic two-word UI/design phrases (e.g. "Container Dark", "Elegant Technical") that are not specific entities. If the chunk has none, return [].
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
      { role: "system", content: `${SYSTEM_PROMPT}\n\n/no_think` },
      { role: "user", content: `/no_think\n\n${chunk.text}` },
    ];
    const result = await this.provider.chatJson<Extraction>(
      messages,
      {
        model: this.opts.model,
        signal: this.opts.signal,
        temperature: 0.1,
        enableThinking: false,
      },
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
  const entities = dedupeCaseInsensitive(filterNoiseEntities(parts.flatMap((p) => p.entities)));
  const claims = dedupe(parts.flatMap((p) => p.claims));
  const questions = dedupe(parts.flatMap((p) => p.questions));
  return { entities, claims, questions };
}

/**
 * Drop generic-noise entity strings the LLM emits despite the prompt.
 *
 * Defense-in-depth post-extraction filter: the prompt asks the model to skip
 * these patterns, but the model partially ignores it. Three small predicates
 * run per entity; any match drops the entity. Pure and synchronous.
 *
 * Trade-off: single capitalized abstract nouns like "Distributed" are NOT
 * filtered here because that risks dropping legitimate proper nouns
 * ("Hermes", "Nemotron"). The prompt sharpening handles those instead.
 */
export function filterNoiseEntities(entities: string[]): string[] {
  return entities.filter((e) => !isNoiseEntity(e));
}

function isNoiseEntity(entity: string): boolean {
  return (
    isBareLowercaseToken(entity) ||
    isShortCodeIdentifier(entity) ||
    isGenericTwoWordPhrase(entity)
  );
}

// Predicate (a): single token, all-lowercase letters only. Filters bare
// common words like "structure", "wrappers", "haiku". Capitalized variants
// ("Haiku", "Drive") and uppercase tokens ("POSIX") pass through unchanged.
function isBareLowercaseToken(entity: string): boolean {
  if (entity.includes(" ")) return false;
  return /^[a-z]+$/.test(entity);
}

// Predicate (b): single token containing _ or -, no spaces, length < 30.
// Filters code-shaped identifiers like "connection_builder" and "npm-db".
// Long hyphenated names like model IDs (e.g. length 38) pass through.
function isShortCodeIdentifier(entity: string): boolean {
  if (entity.includes(" ")) return false;
  if (entity.length >= 30) return false;
  return /[_-]/.test(entity);
}

// Predicate (c): two tokens both matching ^[A-Z][a-z]+$. Filters generic
// UI/design phrases like "Container Dark" and "Elegant Technical" while
// keeping mixed-case second words ("Illumina MiSeq") and uppercase tokens
// ("Drive API") that fail the all-lowercase-tail constraint.
function isGenericTwoWordPhrase(entity: string): boolean {
  return /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(entity);
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

/**
 * Persist an Extraction to SurrealDB by upserting concepts/claims/questions
 * and relating each one back to the originating note via the
 * `mentions`, `asserts`, and `asks` edge tables.
 *
 * Spec: Phase 3 plan §Task 8. Extractor edges land with
 * `class = 'INFERRED'`, `confidence = 0.7`, `agent = 'extractor'`,
 * `approved = true` (extractor outputs are auto-approved per the plan
 * invariant).
 */
export async function writeExtractionToSurreal(
  db: Surreal,
  noteId: RecordId<"note">,
  extraction: Extraction,
): Promise<void> {
  for (const entity of extraction.entities) {
    const conceptId = await upsertConcept(db, entity);
    await relateEdge(db, {
      table: "mentions",
      from: noteId,
      to: conceptId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
  }
  for (const claim of extraction.claims) {
    const claimId = await upsertClaim(db, claim);
    await relateEdge(db, {
      table: "asserts",
      from: noteId,
      to: claimId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
  }
  for (const question of extraction.questions) {
    const questionId = await upsertQuestion(db, question);
    await relateEdge(db, {
      table: "asks",
      from: noteId,
      to: questionId,
      source: "extractor",
      confidenceClass: "INFERRED",
      confidence: 0.7,
      agent: "extractor",
      approved: true,
    });
  }
}
