import type { RecordId, Surreal } from "surrealdb";
import { relateEdge, upsertClaim, upsertConcept, upsertQuestion } from "../db/surreal";
import type { ChatMessage, JsonSchema, LLMProvider } from "../llm/provider";
import type { Chunk, ClaimKind, ConceptKind, ConceptSource, Extraction } from "./types";

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
- ${MAX_ENTITIES_PER_CHUNK} entities — proper nouns (people, named projects, named systems, products), or domain-specific technical terms with strong specificity. Use the canonical singular form. Skip generic words like "system", "process", "note", "thing", "user", "structure", "wrappers", "Distributed". Skip code-shaped tokens with underscores or hyphens (e.g. "connection_builder", "npm-db"); name the concept they represent in plain words instead, or omit. Skip generic two-word UI/design phrases (e.g. "Container Dark", "Elegant Technical") unless the phrase is a named framework, named pattern, or domain term that the surrounding chunk treats as a concept. Valid examples include "Stakeholder Trifecta"; invalid examples include visual style fragments and adjective-noun labels. If the chunk has none, return [].
  Each entity must include kind: proper_noun, system, technique, metric, quantity, event, or other.
- ${MAX_CLAIMS_PER_CHUNK} claims — non-trivial, specific assertions the chunk makes. A claim must be sharp enough that a thoughtful reader could disagree. Skip restatements of obvious facts and definitions. One declarative sentence each. If the chunk has none, return [].
  Each claim must include kind: definition, assertion, datum, or speculation.
- ${MAX_QUESTIONS_PER_CHUNK} questions — genuine open questions the chunk raises and does not answer. End each with "?". Skip rhetorical questions. If the chunk has none, return [].

Quality over quantity. Empty arrays are correct when nothing is worth tracking. Never invent facts.`;

const SCHEMA: JsonSchema = {
  name: "Extraction",
  schema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            kind: {
              type: "string",
              enum: ["proper_noun", "system", "technique", "metric", "quantity", "event", "other"],
            },
          },
          required: ["label", "kind"],
          additionalProperties: false,
        },
        maxItems: MAX_ENTITIES_PER_CHUNK,
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            kind: {
              type: "string",
              enum: ["definition", "assertion", "datum", "speculation"],
            },
          },
          required: ["text", "kind"],
          additionalProperties: false,
        },
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
      ...normalizeEntities(result.entities, MAX_ENTITIES_PER_CHUNK),
      ...normalizeClaims(result.claims, MAX_CLAIMS_PER_CHUNK),
      questions: ensureStringArray(result.questions).slice(0, MAX_QUESTIONS_PER_CHUNK),
    };
  }
}

interface EntityNormalization {
  entities: string[];
  entityKinds: Record<string, ConceptKind>;
}

interface ClaimNormalization {
  claims: string[];
  claimKinds: Record<string, ClaimKind>;
}

const CONCEPT_KINDS: ReadonlySet<string> = new Set([
  "proper_noun",
  "system",
  "technique",
  "metric",
  "quantity",
  "event",
  "other",
]);

const CLAIM_KINDS: ReadonlySet<string> = new Set([
  "definition",
  "assertion",
  "datum",
  "speculation",
]);

function normalizeEntities(value: unknown, limit: number): EntityNormalization {
  if (!Array.isArray(value)) return { entities: [], entityKinds: {} };
  const entities: string[] = [];
  const entityKinds: Record<string, ConceptKind> = {};
  for (const entry of value) {
    const normalized = normalizeEntityEntry(entry);
    if (normalized === null) continue;
    entities.push(normalized.label);
    entityKinds[normalized.label] = normalized.kind;
    if (entities.length >= limit) break;
  }
  return { entities, entityKinds };
}

function normalizeEntityEntry(entry: unknown): { label: string; kind: ConceptKind } | null {
  if (typeof entry === "string") {
    const label = entry.trim();
    return label.length === 0 ? null : { label, kind: "other" };
  }
  if (!isRecord(entry)) return null;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  if (label.length === 0) return null;
  const kind =
    typeof entry.kind === "string" && CONCEPT_KINDS.has(entry.kind) ? entry.kind : "other";
  return { label, kind: kind as ConceptKind };
}

function normalizeClaims(value: unknown, limit: number): ClaimNormalization {
  if (!Array.isArray(value)) return { claims: [], claimKinds: {} };
  const claims: string[] = [];
  const claimKinds: Record<string, ClaimKind> = {};
  for (const entry of value) {
    const normalized = normalizeClaimEntry(entry);
    if (normalized === null) continue;
    claims.push(normalized.text);
    claimKinds[normalized.text] = normalized.kind;
    if (claims.length >= limit) break;
  }
  return { claims, claimKinds };
}

function normalizeClaimEntry(entry: unknown): { text: string; kind: ClaimKind } | null {
  if (typeof entry === "string") {
    const text = entry.trim();
    return text.length === 0 ? null : { text, kind: "assertion" };
  }
  if (!isRecord(entry)) return null;
  const text = typeof entry.text === "string" ? entry.text.trim() : "";
  if (text.length === 0) return null;
  const kind =
    typeof entry.kind === "string" && CLAIM_KINDS.has(entry.kind) ? entry.kind : "assertion";
  return { text, kind: kind as ClaimKind };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function mergeExtractions(parts: Extraction[]): Extraction {
  const rawEntities = filterNoiseEntities(parts.flatMap((p) => p.entities));
  const entities = dedupeCaseInsensitive(rawEntities);
  const entityKinds = mergeEntityKinds(parts, entities);
  const claims = dedupe(parts.flatMap((p) => p.claims));
  const claimKinds = mergeClaimKinds(parts, claims);
  const questions = dedupe(parts.flatMap((p) => p.questions));
  return { entities, claims, questions, entityKinds, claimKinds };
}

function mergeEntityKinds(parts: Extraction[], entities: string[]): Record<string, ConceptKind> {
  const out: Record<string, ConceptKind> = {};
  for (const entity of entities) {
    out[entity] = "other";
    const norm = entity.toLowerCase();
    for (const part of parts) {
      const match = Object.entries(part.entityKinds ?? {}).find(
        ([label]) => label.toLowerCase() === norm,
      );
      if (match !== undefined) {
        out[entity] = match[1];
        break;
      }
    }
  }
  return out;
}

function mergeClaimKinds(parts: Extraction[], claims: string[]): Record<string, ClaimKind> {
  const out: Record<string, ClaimKind> = {};
  for (const claim of claims) {
    out[claim] = "assertion";
    for (const part of parts) {
      const kind = part.claimKinds?.[claim];
      if (kind !== undefined) {
        out[claim] = kind;
        break;
      }
    }
  }
  return out;
}

/**
 * Drop generic-noise entity strings the LLM emits despite the prompt.
 *
 * Defense-in-depth post-extraction filter: the prompt asks the model to skip
 * these patterns, but the model partially ignores it. Three small predicates
 * run per entity; any match drops the entity. Pure and synchronous.
 *
 * Trade-off: single capitalized abstract nouns and two-word Title Case
 * phrases are NOT filtered here because that risks dropping legitimate
 * concepts ("Hermes", "Nemotron", "Stakeholder Trifecta"). The prompt
 * sharpening handles those instead.
 */
export function filterNoiseEntities(entities: string[]): string[] {
  return entities.filter((e) => !isNoiseEntity(e));
}

function isNoiseEntity(entity: string): boolean {
  return isBareLowercaseToken(entity) || isShortCodeIdentifier(entity);
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
  await deletePriorExtractorRelations(db, noteId);
  for (const entity of extraction.entities) {
    const conceptId = await upsertConcept(db, entity, {
      kind: extraction.entityKinds?.[entity] ?? "other",
      source: "extractor" satisfies ConceptSource,
    });
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
    const claimId = await upsertClaim(db, claim, {
      kind: extraction.claimKinds?.[claim] ?? "assertion",
    });
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

async function deletePriorExtractorRelations(db: Surreal, noteId: RecordId<"note">): Promise<void> {
  for (const table of ["mentions", "asserts", "asks"] as const) {
    await db
      .query(
        `DELETE ${table} WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');`,
        { note: noteId },
      )
      .collect();
  }
}
