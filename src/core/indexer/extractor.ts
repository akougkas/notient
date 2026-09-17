import { RecordId, type Surreal } from "surrealdb";
import type { ReasoningScheduler } from "../coordinator/reasoningScheduler";
import type { ExtractorEdgeTable as ExtractorRelationTable } from "../db/edgeTables";
import { isRetryableSurrealError } from "../db/retry";
import { upsertClaim, upsertConcept, upsertQuestion } from "../db/surreal";
import type { ChatMessage, JsonSchema, LLMProvider } from "../llm/provider";
import { EXTRACT } from "./concurrencyDefaults";
import { deleteExtractorTargetWhenUnreferenced } from "./extractorTargets";
import type {
  Chunk,
  ClaimKind,
  ConceptKind,
  ConceptSource,
  EvidenceMap,
  Extraction,
} from "./types";

export type ExtractionChunk = Pick<Chunk, "id" | "ord" | "text" | "tokenEstimate">;

export interface ExtractorOptions {
  model: string;
  /** Includes reasoning tokens on providers that cannot disable thinking. */
  maxOutputTokens?: number;
  scheduler: ReasoningScheduler;
  concurrency: number;
  /** Soft token ceiling for one extraction window. Defaults to EXTRACT.windowTokens. */
  windowTokens?: number;
  /** Minimum window size before an H1/H2 boundary may close it early. */
  headingBreakMinTokens?: number;
}

const MAX_ENTITIES_PER_WINDOW = EXTRACT.maxEntities;
const MAX_CLAIMS_PER_WINDOW = EXTRACT.maxClaims;
const MAX_QUESTIONS_PER_WINDOW = EXTRACT.maxQuestions;
const EXTRACTION_WRITE_ATTEMPTS = 5;
const EXTRACTION_WRITE_RETRY_BASE_DELAY_MS = 10;

const SYSTEM_PROMPT = `You are Notient's extractor. Read a contiguous run of chunks from ONE note and output ONLY what a careful human reader would highlight as worth tracking across the whole run.

Each chunk is introduced by a marker line of the form [c<N>], where <N> is that chunk's ordinal. Every item you emit must carry chunkRefs: an array of those ordinals naming the chunks that actually support the item. Cite at least one, and cite every chunk that genuinely supports it. Never cite an ordinal absent from the input.

Return at most:
- ${MAX_ENTITIES_PER_WINDOW} entities — proper nouns (people, named projects, named systems, products), or domain-specific technical terms with strong specificity. Use the canonical singular form. Skip generic words like "system", "process", "note", "thing", "user", "structure", "wrappers", "Distributed". Skip code-shaped tokens with underscores or hyphens (e.g. "connection_builder", "npm-db"); name the concept they represent in plain words instead, or omit. Skip generic two-word UI/design phrases (e.g. "Container Dark", "Elegant Technical") unless the phrase is a named framework, named pattern, or domain term that the surrounding text treats as a concept. Valid examples include "Stakeholder Trifecta"; invalid examples include visual style fragments and adjective-noun labels. If the run has none, return [].
  Each entity must include kind: proper_noun, system, technique, metric, quantity, event, or other.
- ${MAX_CLAIMS_PER_WINDOW} claims — non-trivial, specific assertions the text makes. A claim must be sharp enough that a thoughtful reader could disagree. Skip restatements of obvious facts and definitions. One declarative sentence each, under 200 characters. If the run has none, return [].
  Each claim must include kind: definition, assertion, datum, or speculation.
- ${MAX_QUESTIONS_PER_WINDOW} questions — genuine open questions the text raises and does not answer. End each with "?", under 160 characters. Skip rhetorical questions. If the run has none, return [].

Do not repeat one entity, claim, or question under different wording; merge it into a single item that cites every supporting chunk. Quality over quantity. Empty arrays are correct when nothing is worth tracking. Never invent facts.`;

const CHUNK_REFS_SCHEMA = {
  type: "array",
  items: { type: "integer", minimum: 0 },
  minItems: 1,
  uniqueItems: true,
} as const;

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
            label: { type: "string", minLength: 1 },
            kind: {
              type: "string",
              enum: ["proper_noun", "system", "technique", "metric", "quantity", "event", "other"],
            },
            chunkRefs: CHUNK_REFS_SCHEMA,
          },
          required: ["label", "kind", "chunkRefs"],
          additionalProperties: false,
        },
        maxItems: MAX_ENTITIES_PER_WINDOW,
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 200 },
            kind: {
              type: "string",
              enum: ["definition", "assertion", "datum", "speculation"],
            },
            chunkRefs: CHUNK_REFS_SCHEMA,
          },
          required: ["text", "kind", "chunkRefs"],
          additionalProperties: false,
        },
        maxItems: MAX_CLAIMS_PER_WINDOW,
      },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 160 },
            chunkRefs: CHUNK_REFS_SCHEMA,
          },
          required: ["text", "chunkRefs"],
          additionalProperties: false,
        },
        maxItems: MAX_QUESTIONS_PER_WINDOW,
      },
    },
    required: ["entities", "claims", "questions"],
    additionalProperties: false,
  },
};

/**
 * Raised when at least one extraction WINDOW rejected. Carries the merged
 * extraction of the windows that DID succeed so `runTier3` can persist the
 * partial result before rethrowing; `tier3_at` stays NONE and the note is
 * retried on the next enqueue/awaken pass.
 */
export class PartialExtractionError extends Error {
  readonly name = "PartialExtractionError";
  readonly successfulChunkIds: ReadonlySet<string>;

  constructor(
    readonly extraction: Extraction,
    readonly failedWindows: number,
    readonly totalWindows: number,
    successfulChunkIds: ReadonlySet<string>,
    readonly firstError?: unknown,
  ) {
    super(
      `extractor: ${failedWindows} of ${totalWindows} window extractions failed${
        firstError instanceof Error ? `: ${firstError.message}` : ""
      }`,
    );
    this.successfulChunkIds = new Set(successfulChunkIds);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Chunk text that opens a new H1/H2 section. The chunker keeps a section's
 * heading markers at the head of its first chunk, so this is the only heading
 * signal that survives the trip through the `chunk` table (which stores no
 * heading level of its own).
 */
function startsMajorSection(chunk: ExtractionChunk): boolean {
  return /^#{1,2}\s/.test(chunk.text.trimStart());
}

function chunkTokens(chunk: ExtractionChunk): number {
  if (Number.isFinite(chunk.tokenEstimate) && chunk.tokenEstimate > 0) return chunk.tokenEstimate;
  return Math.ceil(chunk.text.length / 4);
}

export interface WindowOptions {
  windowTokens?: number;
  headingBreakMinTokens?: number;
}

/**
 * Pack a note's chunks, in order, into extraction windows.
 *
 * A window closes when the next chunk would push it past `windowTokens`, or
 * when the next chunk opens a new H1/H2 section and the window already holds
 * `headingBreakMinTokens`. A note smaller than one window becomes exactly one
 * window, hence one LLM call. Exported for tests.
 */
export function buildExtractionWindows(
  chunks: ExtractionChunk[],
  opts: WindowOptions = {},
): ExtractionChunk[][] {
  const windowTokens = Math.max(1, opts.windowTokens ?? EXTRACT.windowTokens);
  const headingBreakMinTokens = Math.max(
    0,
    opts.headingBreakMinTokens ?? EXTRACT.headingBreakMinTokens,
  );
  const windows: ExtractionChunk[][] = [];
  let current: ExtractionChunk[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    const tokens = chunkTokens(chunk);
    if (current.length > 0) {
      const overflows = currentTokens + tokens > windowTokens;
      const headingBreak = startsMajorSection(chunk) && currentTokens >= headingBreakMinTokens;
      if (overflows || headingBreak) {
        windows.push(current);
        current = [];
        currentTokens = 0;
      }
    }
    current.push(chunk);
    currentTokens += tokens;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

interface BatchOutcome {
  results: Extraction[];
  successfulChunkIds: Set<string>;
  failed: number;
  calls: number;
  firstError: unknown;
}

/**
 * Fold one settled batch into the running outcome. AbortError is rethrown
 * rather than counted so cancellation never degrades into a partial result.
 */
function collectSettled(
  settled: Array<PromiseSettledResult<Extraction>>,
  windows: ExtractionChunk[][],
  outcome: BatchOutcome,
): void {
  for (let index = 0; index < settled.length; index += 1) {
    const s = settled[index];
    if (s.status === "fulfilled") {
      outcome.results.push(s.value);
      // Coverage belongs to the WINDOW, not to the extraction it happened to
      // yield. An empty fulfilled response is still authoritative for every
      // chunk in that window and must be able to remove stale relations.
      for (const chunk of windows[index]) outcome.successfulChunkIds.add(chunk.id);
      continue;
    }
    if (isAbortError(s.reason)) throw s.reason;
    outcome.failed += 1;
    if (outcome.firstError === undefined) outcome.firstError = s.reason;
  }
}

interface RawEntity {
  label: string;
  kind: ConceptKind;
  chunkRefs: number[];
}

interface RawClaim {
  text: string;
  kind: ClaimKind;
  chunkRefs: number[];
}

interface RawQuestion {
  text: string;
  chunkRefs: number[];
}

interface RawWindowResponse {
  entities: RawEntity[];
  claims: RawClaim[];
  questions: RawQuestion[];
}

export class Extractor {
  private readonly concurrency: number;

  constructor(
    private readonly provider: LLMProvider,
    private readonly opts: ExtractorOptions,
  ) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 128) {
      throw new Error("Extractor concurrency must be an integer between 1 and 128");
    }
    if (
      opts.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(opts.maxOutputTokens) ||
        opts.maxOutputTokens < 256 ||
        opts.maxOutputTokens > 16384)
    )
      throw new Error("Extractor maxOutputTokens must be an integer between 256 and 16384");
    this.concurrency = opts.concurrency;
  }

  /**
   * Extract over the note's chunks with one structured-output call per window
   * rather than one per chunk. Window-level rejections are not
   * swallowed: the successful windows are merged and handed to the caller
   * inside a {@link PartialExtractionError} so the caller can persist what
   * succeeded and still fail the note. A failed note must not stamp
   * `tier3_at`; it has to come back on the next enqueue/awaken pass.
   *
   * AbortError propagates unchanged so cancellation stays cancellation.
   */
  async extract(chunks: ExtractionChunk[], signal?: AbortSignal): Promise<Extraction> {
    if (chunks.length === 0) {
      return { entities: [], claims: [], questions: [], stats: { llmCalls: 0, windows: 0 } };
    }
    const windows = buildExtractionWindows(chunks, {
      ...(this.opts.windowTokens !== undefined ? { windowTokens: this.opts.windowTokens } : {}),
      ...(this.opts.headingBreakMinTokens !== undefined
        ? { headingBreakMinTokens: this.opts.headingBreakMinTokens }
        : {}),
    });
    const outcome: BatchOutcome = {
      results: [],
      successfulChunkIds: new Set(),
      failed: 0,
      calls: 0,
      firstError: undefined,
    };

    for (let i = 0; i < windows.length; i += this.concurrency) {
      const batch = windows.slice(i, i + this.concurrency);
      const settled = await Promise.allSettled(
        batch.map((window) => this.extractWindow(window, signal)),
      );
      outcome.calls += batch.length;
      collectSettled(settled, batch, outcome);
    }

    const merged = mergeExtractions(outcome.results);
    merged.stats = { llmCalls: outcome.calls, windows: windows.length };
    if (outcome.failed > 0) {
      throw new PartialExtractionError(
        merged,
        outcome.failed,
        windows.length,
        outcome.successfulChunkIds,
        outcome.firstError,
      );
    }
    return merged;
  }

  private async extractWindow(
    window: ExtractionChunk[],
    signal?: AbortSignal,
  ): Promise<Extraction> {
    const body = window.map((chunk) => `[c${chunk.ord}]\n${chunk.text}`).join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n/no_think` },
      { role: "user", content: `/no_think\n\n${body}` },
    ];
    const result = await this.opts.scheduler.run(
      "extractor",
      (scheduledSignal) =>
        this.provider.chatJson<RawWindowResponse>(
          messages,
          {
            model: this.opts.model,
            signal: scheduledSignal,
            temperature: 0.1,
            maxTokens: this.opts.maxOutputTokens ?? EXTRACT.maxTokens,
            enableThinking: false,
          },
          SCHEMA,
        ),
      signal === undefined ? {} : { signal },
    );
    return normalizeWindowResult(result, window);
  }
}

/**
 * Turn one exact structured-output window into an Extraction whose evidence
 * maps hold chunk IDs. A malformed row or an unsupported chunk reference
 * rejects the whole window. The caller records that as a partial extraction,
 * leaving the note eligible for retry instead of silently erasing a finding.
 */
export function normalizeWindowResult(result: unknown, window: ExtractionChunk[]): Extraction {
  const raw = decodeWindowResponse(result);
  const mapRefs = makeRefMapper(window);
  const entities = normalizeEntitySection(raw.entities, mapRefs);
  const claims = normalizeClaimSection(raw.claims, mapRefs);
  const questions = normalizeQuestionSection(raw.questions, mapRefs);
  return { ...entities, ...claims, ...questions };
}

type RefMapper = (refs: number[], label: string) => string[];

/**
 * Resolve a window's model-emitted `chunkRefs` to chunk IDs. Every reference
 * must name exactly one input chunk and duplicates are forbidden.
 */
function makeRefMapper(window: ExtractionChunk[]): RefMapper {
  const ordToId = new Map<number, string>();
  const ids = new Set<string>();
  for (const chunk of window) {
    if (ordToId.has(chunk.ord) || ids.has(chunk.id)) {
      throw new Error("invalid extraction window: chunk ordinals and ids must be unique");
    }
    ordToId.set(chunk.ord, chunk.id);
    ids.add(chunk.id);
  }
  return (refs: number[], label: string): string[] => {
    const out: string[] = [];
    const seen = new Set<number>();
    for (const ref of refs) {
      if (seen.has(ref)) {
        throw new Error(`invalid extraction: ${label}.chunkRefs contains duplicate ordinal ${ref}`);
      }
      seen.add(ref);
      const id = ordToId.get(ref);
      if (id === undefined) {
        throw new Error(`invalid extraction: ${label}.chunkRefs names absent ordinal ${ref}`);
      }
      out.push(id);
    }
    return out;
  };
}

function normalizeEntitySection(
  raw: RawEntity[],
  mapRefs: RefMapper,
): Pick<Extraction, "entities" | "entityKinds" | "entityEvidence"> {
  const entities: string[] = [];
  const entityKinds: Record<string, ConceptKind> = {};
  const entityEvidence: EvidenceMap = {};
  for (const [index, entry] of raw.entries()) {
    const evidence = mapRefs(entry.chunkRefs, `entities[${index}]`);
    entities.push(entry.label);
    entityKinds[entry.label] = entry.kind;
    entityEvidence[entry.label] = evidence;
  }
  return { entities, entityKinds, entityEvidence };
}

function normalizeClaimSection(
  raw: RawClaim[],
  mapRefs: RefMapper,
): Pick<Extraction, "claims" | "claimKinds" | "claimEvidence"> {
  const claims: string[] = [];
  const claimKinds: Record<string, ClaimKind> = {};
  const claimEvidence: EvidenceMap = {};
  for (const [index, entry] of raw.entries()) {
    const evidence = mapRefs(entry.chunkRefs, `claims[${index}]`);
    claims.push(entry.text);
    claimKinds[entry.text] = entry.kind;
    claimEvidence[entry.text] = evidence;
  }
  return { claims, claimKinds, claimEvidence };
}

function normalizeQuestionSection(
  raw: RawQuestion[],
  mapRefs: RefMapper,
): Pick<Extraction, "questions" | "questionEvidence"> {
  const questions: string[] = [];
  const questionEvidence: EvidenceMap = {};
  for (const [index, entry] of raw.entries()) {
    const evidence = mapRefs(entry.chunkRefs, `questions[${index}]`);
    questions.push(entry.text);
    questionEvidence[entry.text] = evidence;
  }
  return { questions, questionEvidence };
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

function decodeWindowResponse(raw: unknown): RawWindowResponse {
  assertExactRecord(raw, ["entities", "claims", "questions"], "extraction result");
  const entities = decodeEntries(raw.entities, MAX_ENTITIES_PER_WINDOW, decodeEntity, "entities");
  const claims = decodeEntries(raw.claims, MAX_CLAIMS_PER_WINDOW, decodeClaim, "claims");
  const questions = decodeEntries(
    raw.questions,
    MAX_QUESTIONS_PER_WINDOW,
    decodeQuestion,
    "questions",
  );
  assertUnique(
    entities.map((entry) => entry.label.toLowerCase()),
    "entities",
  );
  assertUnique(
    claims.map((entry) => entry.text),
    "claims",
  );
  assertUnique(
    questions.map((entry) => entry.text),
    "questions",
  );
  return { entities, claims, questions };
}

function decodeEntries<Value>(
  raw: unknown,
  max: number,
  decode: (entry: unknown, index: number) => Value,
  label: string,
): Value[] {
  if (!Array.isArray(raw) || raw.length > max) {
    throw new Error(`invalid extraction: ${label} must be an array with at most ${max} entries`);
  }
  return raw.map(decode);
}

function decodeEntity(raw: unknown, index: number): RawEntity {
  const label = `entities[${index}]`;
  assertExactRecord(raw, ["label", "kind", "chunkRefs"], label);
  return {
    label: canonicalText(raw.label, `${label}.label`),
    kind: enumValue(raw.kind, CONCEPT_KINDS, `${label}.kind`) as ConceptKind,
    chunkRefs: decodeChunkRefs(raw.chunkRefs, label),
  };
}

function decodeClaim(raw: unknown, index: number): RawClaim {
  const label = `claims[${index}]`;
  assertExactRecord(raw, ["text", "kind", "chunkRefs"], label);
  const text = canonicalText(raw.text, `${label}.text`);
  if (text.length > 200)
    throw new Error(`invalid extraction: ${label}.text exceeds 200 characters`);
  return {
    text,
    kind: enumValue(raw.kind, CLAIM_KINDS, `${label}.kind`) as ClaimKind,
    chunkRefs: decodeChunkRefs(raw.chunkRefs, label),
  };
}

function decodeQuestion(raw: unknown, index: number): RawQuestion {
  const label = `questions[${index}]`;
  assertExactRecord(raw, ["text", "chunkRefs"], label);
  const text = canonicalText(raw.text, `${label}.text`);
  if (text.length > 160 || !text.endsWith("?")) {
    throw new Error(`invalid extraction: ${label}.text must end with '?' within 160 characters`);
  }
  return { text, chunkRefs: decodeChunkRefs(raw.chunkRefs, label) };
}

function decodeChunkRefs(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`invalid extraction: ${label}.chunkRefs must be a non-empty array`);
  }
  const refs: number[] = [];
  for (const [index, ref] of raw.entries()) {
    if (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref < 0) {
      throw new Error(
        `invalid extraction: ${label}.chunkRefs[${index}] must be a non-negative safe integer`,
      );
    }
    refs.push(ref);
  }
  return refs;
}

function canonicalText(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    throw new Error(`invalid extraction: ${label} must be a canonical nonblank string`);
  }
  return raw;
}

function enumValue(raw: unknown, allowed: ReadonlySet<string>, label: string): string {
  if (typeof raw !== "string" || !allowed.has(raw)) {
    throw new Error(`invalid extraction: ${label} has an unsupported value`);
  }
  return raw;
}

function assertExactRecord(
  raw: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts raw is Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`invalid extraction: ${label} must be an object`);
  const actual = Object.keys(raw).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid extraction: ${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`invalid extraction: ${label} contains duplicate findings`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeExtractions(parts: Extraction[]): Extraction {
  const rawEntities = filterNoiseEntities(parts.flatMap((p) => p.entities));
  const entities = dedupeCaseInsensitive(rawEntities);
  const entityKinds = mergeEntityKinds(parts, entities);
  const claims = dedupe(parts.flatMap((p) => p.claims));
  const claimKinds = mergeClaimKinds(parts, claims);
  const questions = dedupe(parts.flatMap((p) => p.questions));
  return {
    entities,
    claims,
    questions,
    entityKinds,
    claimKinds,
    entityEvidence: mergeEvidenceCaseInsensitive(parts, entities, (p) => p.entityEvidence),
    claimEvidence: mergeEvidence(parts, claims, (p) => p.claimEvidence),
    questionEvidence: mergeEvidence(parts, questions, (p) => p.questionEvidence),
  };
}

/**
 * Union the per-window evidence for each surviving key. An item extracted in
 * two windows carries the chunks cited in both, which is the whole point of
 * keeping chunk-level evidence while collapsing the call count.
 */
function mergeEvidence(
  parts: Extraction[],
  keys: string[],
  pick: (part: Extraction) => EvidenceMap | undefined,
): EvidenceMap {
  const out: EvidenceMap = {};
  for (const key of keys) {
    const merged: string[] = [];
    for (const part of parts) {
      for (const id of pick(part)?.[key] ?? []) {
        if (!merged.includes(id)) merged.push(id);
      }
    }
    out[key] = merged;
  }
  return out;
}

/** Entity labels dedupe case-insensitively, so their evidence must too. */
function mergeEvidenceCaseInsensitive(
  parts: Extraction[],
  keys: string[],
  pick: (part: Extraction) => EvidenceMap | undefined,
): EvidenceMap {
  const byNormalizedLabel = new Map<string, string[]>();
  for (const part of parts) {
    for (const [label, ids] of Object.entries(pick(part) ?? {})) {
      const bucket = byNormalizedLabel.get(label.toLowerCase()) ?? [];
      for (const id of ids) {
        if (!bucket.includes(id)) bucket.push(id);
      }
      byNormalizedLabel.set(label.toLowerCase(), bucket);
    }
  }
  const out: EvidenceMap = {};
  for (const key of keys) {
    out[key] = byNormalizedLabel.get(key.toLowerCase()) ?? [];
  }
  return out;
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
 * Maps the chunk ids carried in an Extraction's evidence maps back to the
 * `chunk` records they name, so `writeExtractionToSurreal` can populate the
 * `evidence: option<array<record<chunk>>>` field on the extractor edges.
 */
export type ChunkRecordIndex = ReadonlyMap<string, RecordId<"chunk">>;

export type ExtractionCoverage =
  | { kind: "full" }
  | { kind: "partial"; chunkIds: ReadonlySet<string> };

export interface WriteExtractionOptions {
  chunkIndex: ChunkRecordIndex;
  coverage: ExtractionCoverage;
}

/**
 * Persist an Extraction to SurrealDB by upserting concepts/claims/questions
 * and relating each one back to the originating note via the
 * `mentions`, `asserts`, and `asks` edge tables.
 *
 * A full extraction replaces the note's extractor-owned relation set. A
 * partial extraction reconciles only the chunks whose windows succeeded:
 * evidence from those chunks is replaced, evidence from failed windows is
 * retained, and evidence for chunks absent from the current index is dropped.
 * Every surviving relation has at least one current chunk and canonical
 * extractor provenance; model output whose evidence cannot be resolved does
 * not create a semantic node or relation.
 * All `mentions` / `asserts` / `asks` mutations commit together, and one
 * existing relation id per table+target is reused whenever possible. The
 * relation tables enforce both endpoints. If a concurrent purge removes a
 * target between its content-keyed upsert and this relation transaction, the
 * complete write is retried after atomically pruning anything this failed
 * attempt left unowned.
 */
export async function writeExtractionToSurreal(
  db: Surreal,
  noteId: RecordId<"note">,
  extraction: Extraction,
  options: WriteExtractionOptions,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXTRACTION_WRITE_ATTEMPTS; attempt += 1) {
    let priorRelations: ExtractorRelationSnapshot | undefined;
    const desired = emptyDesiredRelations();
    let relationCommitted = false;
    try {
      priorRelations = await collectPriorExtractorRelations(db, noteId);
      await upsertDesiredExtractorTargets(db, extraction, options, desired);

      const transaction = buildRelationReconciliation(noteId, priorRelations, desired, options);
      await db.query(transaction.sql, transaction.bindings).collect();
      relationCommitted = true;
      await pruneUnreferencedExtractorTargets(db, targetsFromRelations(priorRelations));
      return;
    } catch (error) {
      lastError = error;
      if (relationCommitted) throw error;

      const cleanup = mergeExtractorTargetSnapshots(
        priorRelations === undefined
          ? emptyExtractorTargetSnapshot()
          : targetsFromRelations(priorRelations),
        targetsFromDesiredRelations(desired),
      );
      await prepareExtractionWriteRetry(db, cleanup, error, attempt);
    }
  }
  throw lastError;
}

async function prepareExtractionWriteRetry(
  db: Surreal,
  cleanup: ExtractorTargetSnapshot,
  error: unknown,
  attempt: number,
): Promise<void> {
  try {
    await pruneUnreferencedExtractorTargets(db, cleanup);
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "extractor graph write failed and target ownership cleanup did not complete",
    );
  }
  if (!isRetryableExtractionWriteError(error) || attempt === EXTRACTION_WRITE_ATTEMPTS) {
    throw error;
  }
  await waitBeforeExtractionWriteRetry(attempt);
}

async function upsertDesiredExtractorTargets(
  db: Surreal,
  extraction: Extraction,
  options: WriteExtractionOptions,
  desired: DesiredExtractorRelations,
): Promise<void> {
  for (const entity of extraction.entities) {
    const evidence = evidenceFor(extraction.entityEvidence?.[entity], options);
    if (evidence.length === 0) continue;
    const conceptId = await upsertConcept(db, entity, {
      kind: extraction.entityKinds?.[entity] ?? "other",
      source: "extractor" satisfies ConceptSource,
    });
    addDesiredRelation(desired.mentions, conceptId, evidence);
  }
  for (const claim of extraction.claims) {
    const evidence = evidenceFor(extraction.claimEvidence?.[claim], options);
    if (evidence.length === 0) continue;
    const claimId = await upsertClaim(db, claim, {
      kind: extraction.claimKinds?.[claim] ?? "assertion",
    });
    addDesiredRelation(desired.asserts, claimId, evidence);
  }
  for (const question of extraction.questions) {
    const evidence = evidenceFor(extraction.questionEvidence?.[question], options);
    if (evidence.length === 0) continue;
    const questionId = await upsertQuestion(db, question);
    addDesiredRelation(desired.asks, questionId, evidence);
  }
}

function isRetryableExtractionWriteError(error: unknown): boolean {
  if (isRetryableSurrealError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\bThe record ['`][^'`]+['`] does not exist\b/i.test(message);
}

async function waitBeforeExtractionWriteRetry(attempt: number): Promise<void> {
  const delayMs = EXTRACTION_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function evidenceFor(
  chunkIds: string[] | undefined,
  options: WriteExtractionOptions,
): Array<RecordId<"chunk">> {
  if (chunkIds === undefined) return [];
  const records: Array<RecordId<"chunk">> = [];
  for (const id of chunkIds) {
    if (options.coverage.kind === "partial" && !options.coverage.chunkIds.has(id)) continue;
    const record = options.chunkIndex.get(id);
    if (record !== undefined && !hasRecordId(records, record)) records.push(record);
  }
  return records;
}

interface ExistingExtractorRelation {
  id: RecordId;
  out: RecordId;
  evidence: Array<RecordId<"chunk">>;
}

interface ExtractorRelationSnapshot {
  mentions: ExistingExtractorRelation[];
  asserts: ExistingExtractorRelation[];
  asks: ExistingExtractorRelation[];
}

interface DesiredExtractorRelation {
  target: RecordId;
  evidence: Array<RecordId<"chunk">>;
}

type DesiredRelationMap = Map<string, DesiredExtractorRelation>;

interface DesiredExtractorRelations {
  mentions: DesiredRelationMap;
  asserts: DesiredRelationMap;
  asks: DesiredRelationMap;
}

interface RelationTransaction {
  sql: string;
  bindings: Record<string, unknown>;
}

interface RelationReconciliationContext {
  statements: string[];
  bindings: Record<string, unknown>;
  nextBindingIndex: number;
  coverageKind: ExtractionCoverage["kind"];
  currentEvidenceIds: ReadonlySet<string>;
  coveredEvidenceIds: ReadonlySet<string>;
}

function emptyDesiredRelations(): DesiredExtractorRelations {
  return {
    mentions: new Map(),
    asserts: new Map(),
    asks: new Map(),
  };
}

function addDesiredRelation(
  relations: DesiredRelationMap,
  target: RecordId,
  evidence: Array<RecordId<"chunk">>,
): void {
  const key = target.toString();
  const existing = relations.get(key);
  if (existing === undefined) {
    relations.set(key, { target, evidence });
    return;
  }
  existing.evidence = mergeRecordIds(existing.evidence, evidence);
}

async function collectPriorExtractorRelations(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<ExtractorRelationSnapshot> {
  const slices: unknown = await db
    .query(
      [
        "SELECT id, out, evidence FROM mentions WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
        "SELECT id, out, evidence FROM asserts WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
        "SELECT id, out, evidence FROM asks WHERE in = $note AND (agent = 'extractor' OR source = 'extractor');",
      ].join("\n"),
      { note: noteId },
    )
    .collect();
  if (!Array.isArray(slices) || slices.length !== 3) {
    throw new Error("extractor relation storage integrity: expected three query result slices");
  }
  return {
    mentions: parseExtractorRelationRows(slices[0], "mentions", "concept"),
    asserts: parseExtractorRelationRows(slices[1], "asserts", "claim"),
    asks: parseExtractorRelationRows(slices[2], "asks", "question"),
  };
}

function parseExtractorRelationRows(
  raw: unknown,
  relationTable: ExtractorRelationTable,
  targetTable: "concept" | "claim" | "question",
): ExistingExtractorRelation[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `extractor relation storage integrity: ${relationTable} result is not an array`,
    );
  }
  return raw.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`extractor relation storage integrity: malformed ${relationTable} row`);
    }
    const row = value as Record<string, unknown>;
    if (!(row.id instanceof RecordId) || row.id.table.name !== relationTable) {
      throw new Error(
        `extractor relation storage integrity: ${relationTable} row has an invalid id`,
      );
    }
    if (!(row.out instanceof RecordId) || row.out.table.name !== targetTable) {
      throw new Error(
        `extractor relation storage integrity: ${relationTable} row has an invalid target`,
      );
    }
    if (
      !Array.isArray(row.evidence) ||
      row.evidence.length === 0 ||
      row.evidence.some(
        (evidence) => !(evidence instanceof RecordId) || evidence.table.name !== "chunk",
      )
    ) {
      throw new Error(
        `extractor relation storage integrity: ${relationTable} row has invalid evidence`,
      );
    }
    return {
      id: row.id,
      out: row.out,
      evidence: row.evidence as Array<RecordId<"chunk">>,
    };
  });
}

function buildRelationReconciliation(
  noteId: RecordId<"note">,
  prior: ExtractorRelationSnapshot,
  desired: DesiredExtractorRelations,
  options: WriteExtractionOptions,
): RelationTransaction {
  const context = createRelationReconciliationContext(noteId, options);
  for (const table of ["mentions", "asserts", "asks"] as const) {
    reconcileRelationTable(context, table, prior[table], desired[table]);
  }
  context.statements.push("COMMIT TRANSACTION;");
  return { sql: context.statements.join("\n"), bindings: context.bindings };
}

function createRelationReconciliationContext(
  noteId: RecordId<"note">,
  options: WriteExtractionOptions,
): RelationReconciliationContext {
  const currentEvidenceIds = new Set(
    Array.from(options.chunkIndex.values(), (record) => record.toString()),
  );
  const coveredEvidenceIds = new Set<string>();
  if (options.coverage.kind === "partial") {
    for (const chunkId of options.coverage.chunkIds) {
      const record = options.chunkIndex.get(chunkId);
      if (record !== undefined) coveredEvidenceIds.add(record.toString());
    }
  }
  return {
    statements: ["BEGIN TRANSACTION;"],
    bindings: { note: noteId },
    nextBindingIndex: 0,
    coverageKind: options.coverage.kind,
    currentEvidenceIds,
    coveredEvidenceIds,
  };
}

function reconcileRelationTable(
  context: RelationReconciliationContext,
  table: ExtractorRelationTable,
  prior: ExistingExtractorRelation[],
  desired: DesiredRelationMap,
): void {
  const existingByTarget = groupRelationsByTarget(prior);
  const targetKeys = new Set([...existingByTarget.keys(), ...desired.keys()]);
  for (const targetKey of targetKeys) {
    const existing = [...(existingByTarget.get(targetKey) ?? [])].sort((left, right) =>
      left.id.toString().localeCompare(right.id.toString()),
    );
    reconcileRelationTarget(context, table, existing, desired.get(targetKey));
  }
}

function reconcileRelationTarget(
  context: RelationReconciliationContext,
  table: ExtractorRelationTable,
  existing: ExistingExtractorRelation[],
  replacement: DesiredExtractorRelation | undefined,
): void {
  const retained = retainedPartialEvidence(
    existing,
    context.currentEvidenceIds,
    context.coveredEvidenceIds,
  );
  if (!relationShouldSurvive(context.coverageKind, replacement, retained)) {
    for (const relation of existing) deleteRelation(context, relation);
    return;
  }

  const evidence = reconciledEvidence(context.coverageKind, replacement, retained);
  const keeper = existing[0];
  if (keeper === undefined) {
    if (replacement !== undefined) createRelation(context, table, replacement.target, evidence);
    return;
  }

  updateRelation(context, keeper, evidence);
  for (const duplicate of existing.slice(1)) deleteRelation(context, duplicate);
}

function relationShouldSurvive(
  coverageKind: ExtractionCoverage["kind"],
  replacement: DesiredExtractorRelation | undefined,
  retained: Array<RecordId<"chunk">>,
): boolean {
  if (replacement !== undefined) return true;
  if (coverageKind === "full") return false;
  return retained.length > 0;
}

function reconciledEvidence(
  coverageKind: ExtractionCoverage["kind"],
  replacement: DesiredExtractorRelation | undefined,
  retained: Array<RecordId<"chunk">>,
): Array<RecordId<"chunk">> {
  if (replacement === undefined) return retained;
  if (coverageKind === "full") return replacement.evidence;
  return mergeRecordIds(retained, replacement.evidence);
}

function updateRelation(
  context: RelationReconciliationContext,
  keeper: ExistingExtractorRelation,
  evidence: Array<RecordId<"chunk">>,
): void {
  const keeperBinding = nextRelationBinding(context, "keeperId", keeper.id);
  context.statements.push(
    `UPDATE ${keeperBinding} SET source = 'extractor', class = 'INFERRED', confidence = 0.7, agent = 'extractor', approved = true, applied = true, ${evidenceAssignment(context, evidence)};`,
  );
}

function createRelation(
  context: RelationReconciliationContext,
  table: ExtractorRelationTable,
  target: RecordId,
  evidence: Array<RecordId<"chunk">>,
): void {
  const targetBinding = nextRelationBinding(context, "target", target);
  context.statements.push(
    `RELATE $note->${table}->${targetBinding} SET source = 'extractor', class = 'INFERRED', confidence = 0.7, agent = 'extractor', approved = true, applied = true, ${evidenceAssignment(context, evidence)};`,
  );
}

function deleteRelation(
  context: RelationReconciliationContext,
  relation: ExistingExtractorRelation,
): void {
  context.statements.push(`DELETE ${nextRelationBinding(context, "deleteId", relation.id)};`);
}

function evidenceAssignment(
  context: RelationReconciliationContext,
  evidence: Array<RecordId<"chunk">>,
): string {
  if (evidence.length === 0) {
    throw new Error("extractor relation requires current chunk evidence");
  }
  return `evidence = ${nextRelationBinding(context, "evidence", evidence)}`;
}

function nextRelationBinding(
  context: RelationReconciliationContext,
  suffix: string,
  value: unknown,
): string {
  const name = `relation${context.nextBindingIndex}_${suffix}`;
  context.nextBindingIndex += 1;
  context.bindings[name] = value;
  return `$${name}`;
}

function groupRelationsByTarget(
  relations: ExistingExtractorRelation[],
): Map<string, ExistingExtractorRelation[]> {
  const grouped = new Map<string, ExistingExtractorRelation[]>();
  for (const relation of relations) {
    const key = relation.out.toString();
    const bucket = grouped.get(key) ?? [];
    bucket.push(relation);
    grouped.set(key, bucket);
  }
  return grouped;
}

function retainedPartialEvidence(
  relations: ExistingExtractorRelation[],
  currentEvidenceIds: ReadonlySet<string>,
  coveredEvidenceIds: ReadonlySet<string>,
): Array<RecordId<"chunk">> {
  const retained: Array<RecordId<"chunk">> = [];
  for (const relation of relations) {
    for (const evidence of relation.evidence) {
      const key = evidence.toString();
      if (!currentEvidenceIds.has(key) || coveredEvidenceIds.has(key)) continue;
      if (!hasRecordId(retained, evidence)) retained.push(evidence);
    }
  }
  return retained;
}

function mergeRecordIds<T extends RecordId>(left: T[], right: T[]): T[] {
  const merged = [...left];
  for (const record of right) {
    if (!hasRecordId(merged, record)) merged.push(record);
  }
  return merged;
}

function hasRecordId(records: readonly RecordId[], candidate: RecordId): boolean {
  const key = candidate.toString();
  return records.some((record) => record.toString() === key);
}

interface ExtractorTargetSnapshot {
  concepts: Array<RecordId<"concept">>;
  claims: Array<RecordId<"claim">>;
  questions: Array<RecordId<"question">>;
}

function emptyExtractorTargetSnapshot(): ExtractorTargetSnapshot {
  return { concepts: [], claims: [], questions: [] };
}

function targetsFromRelations(relations: ExtractorRelationSnapshot): ExtractorTargetSnapshot {
  return {
    concepts: uniqueRecordIds(relations.mentions.map((row) => row.out)) as Array<
      RecordId<"concept">
    >,
    claims: uniqueRecordIds(relations.asserts.map((row) => row.out)) as Array<RecordId<"claim">>,
    questions: uniqueRecordIds(relations.asks.map((row) => row.out)) as Array<RecordId<"question">>,
  };
}

function targetsFromDesiredRelations(
  relations: DesiredExtractorRelations,
): ExtractorTargetSnapshot {
  return {
    concepts: uniqueRecordIds(
      Array.from(relations.mentions.values(), (relation) => relation.target),
    ) as Array<RecordId<"concept">>,
    claims: uniqueRecordIds(
      Array.from(relations.asserts.values(), (relation) => relation.target),
    ) as Array<RecordId<"claim">>,
    questions: uniqueRecordIds(
      Array.from(relations.asks.values(), (relation) => relation.target),
    ) as Array<RecordId<"question">>,
  };
}

function mergeExtractorTargetSnapshots(
  left: ExtractorTargetSnapshot,
  right: ExtractorTargetSnapshot,
): ExtractorTargetSnapshot {
  return {
    concepts: uniqueRecordIds([...left.concepts, ...right.concepts]) as Array<RecordId<"concept">>,
    claims: uniqueRecordIds([...left.claims, ...right.claims]) as Array<RecordId<"claim">>,
    questions: uniqueRecordIds([...left.questions, ...right.questions]) as Array<
      RecordId<"question">
    >,
  };
}

function uniqueRecordIds(records: RecordId[]): RecordId[] {
  const unique: RecordId[] = [];
  for (const record of records) {
    if (!hasRecordId(unique, record)) unique.push(record);
  }
  return unique;
}

async function pruneUnreferencedExtractorTargets(
  db: Surreal,
  snapshot: ExtractorTargetSnapshot,
): Promise<void> {
  for (const conceptId of snapshot.concepts) {
    await deleteExtractorTargetWhenUnreferenced(db, "mentions", conceptId);
  }
  for (const claimId of snapshot.claims) {
    await deleteExtractorTargetWhenUnreferenced(db, "asserts", claimId);
  }
  for (const questionId of snapshot.questions) {
    await deleteExtractorTargetWhenUnreferenced(db, "asks", questionId);
  }
}
