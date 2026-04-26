/**
 * Indexer Web Worker
 *
 * Offloads chunk + embed + extract from the main thread so the UI remains
 * responsive during large vault runs (e.g. AwakenRunner over 894 notes).
 *
 * Protocol (main → worker):
 *   { type: "run", id, notePath, noteBody,
 *     embedConfig: { baseUrl, model, batchSize? },
 *     extractConfig: { baseUrl, model, concurrency? } }
 *   { type: "cancel", id }
 *
 * Protocol (worker → main):
 *   { type: "result", id, ok: true, chunks, vectors, extraction }
 *   { type: "result", id, ok: false, message }
 *
 * The worker re-implements only the LM Studio HTTP wire calls it needs
 * (mirroring src/core/llm/lmStudioProvider.ts including the reasoning_content
 * JSON fallback). It does NOT import LMStudioProvider directly because the
 * main-thread provider is wired to plugin-side code paths.
 */

import { chunkNote } from "../core/indexer/chunker";
import type { Chunk, Extraction } from "../core/indexer/types";

interface EmbedConfig {
  baseUrl: string;
  model: string;
  batchSize?: number;
}

interface ExtractConfig {
  baseUrl: string;
  model: string;
  concurrency?: number;
}

interface RunMessage {
  type: "run";
  id: string;
  notePath: string;
  noteBody: string;
  embedConfig: EmbedConfig;
  extractConfig: ExtractConfig;
}

interface CancelMessage {
  type: "cancel";
  id: string;
}

type IncomingMessage = RunMessage | CancelMessage;

interface ResultPayload {
  type: "result";
  id: string;
  ok: true;
  chunks: Chunk[];
  vectors: number[][];
  extraction: Extraction;
}

interface ErrorPayload {
  type: "result";
  id: string;
  ok: false;
  message: string;
}

type OutgoingMessage = ResultPayload | ErrorPayload;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
}

interface ChatCompletionResponse {
  choices: { message: { content: string; reasoning_content?: string } }[];
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

const MAX_ENTITIES_PER_CHUNK = 5;
const MAX_CLAIMS_PER_CHUNK = 3;
const MAX_QUESTIONS_PER_CHUNK = 3;

const EXTRACTOR_SYSTEM_PROMPT = `You are Notient's extractor. Read one note chunk and output ONLY what a careful human reader would highlight as worth tracking.

Return at most:
- ${MAX_ENTITIES_PER_CHUNK} entities — proper nouns (people, named projects, named systems, products), or domain-specific technical terms with strong specificity. Use the canonical singular form. Skip generic words like "system", "process", "note", "thing", "user". If the chunk has none, return [].
- ${MAX_CLAIMS_PER_CHUNK} claims — non-trivial, specific assertions the chunk makes. A claim must be sharp enough that a thoughtful reader could disagree. Skip restatements of obvious facts and definitions. One declarative sentence each. If the chunk has none, return [].
- ${MAX_QUESTIONS_PER_CHUNK} questions — genuine open questions the chunk raises and does not answer. End each with "?". Skip rhetorical questions. If the chunk has none, return [].

Quality over quantity. Empty arrays are correct when nothing is worth tracking. Never invent facts.`;

const EXTRACTOR_SCHEMA: JsonSchema = {
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

const FENCE = "---";
const EMBED_RETRY_DELAY_MS = 250;

const inflight = new Map<string, AbortController>();

function postOut(message: OutgoingMessage): void {
  (self as unknown as { postMessage: (m: OutgoingMessage) => void }).postMessage(message);
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith(FENCE)) return content;
  const closeIdx = content.indexOf(`\n${FENCE}`, FENCE.length);
  if (closeIdx === -1) return content;
  const after = closeIdx + 1 + FENCE.length;
  return content.slice(after).replace(/^\r?\n/, "");
}

function pickJsonPayload(content: string, reasoningContent: string): string {
  const trimmed = content.trim();
  if (trimmed.length > 0) return content;
  return reasoningContent;
}

function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function mergeExtractions(parts: Extraction[]): Extraction {
  const entitySeen = new Map<string, string>();
  for (const part of parts) {
    for (const entity of part.entities) {
      const key = entity.toLowerCase();
      if (!entitySeen.has(key)) entitySeen.set(key, entity);
    }
  }
  const entities = Array.from(entitySeen.values());
  const claims = Array.from(new Set(parts.flatMap((p) => p.claims)));
  const questions = Array.from(new Set(parts.flatMap((p) => p.questions)));
  return { entities, claims, questions };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(
  baseUrl: string,
  model: string,
  inputs: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ model, input: inputs }),
  });
  if (!response.ok) throw new Error(`Embed ${response.status} ${response.statusText}`);
  const data = (await response.json()) as EmbeddingResponse;
  return data.data.map((d) => d.embedding);
}

async function embedAll(
  config: EmbedConfig,
  inputs: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const batchSize = Math.max(1, config.batchSize ?? 16);
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    let vectors: number[][];
    try {
      vectors = await embedBatch(config.baseUrl, config.model, batch, signal);
    } catch (firstError) {
      if (signal.aborted) throw firstError;
      await sleep(EMBED_RETRY_DELAY_MS);
      try {
        vectors = await embedBatch(config.baseUrl, config.model, batch, signal);
      } catch {
        throw firstError;
      }
    }
    for (const vector of vectors) out.push(vector);
  }
  return out;
}

async function chatJson<T>(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  schema: JsonSchema,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: schema.name, strict: true, schema: schema.schema },
      },
    }),
  });
  if (!response.ok) throw new Error(`LLM ${response.status} ${response.statusText}`);
  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices[0]?.message;
  const raw = pickJsonPayload(message?.content ?? "", message?.reasoning_content ?? "");
  const stripped = stripJsonFences(raw).trim();
  try {
    return JSON.parse(stripped) as T;
  } catch (error) {
    throw new Error(
      `chatJson failed to parse JSON: ${(error as Error).message}; raw=${raw.slice(0, 200)}`,
    );
  }
}

async function extractOne(
  config: ExtractConfig,
  chunk: Chunk,
  signal: AbortSignal,
): Promise<Extraction> {
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
    { role: "user", content: chunk.text },
  ];
  const result = await chatJson<Extraction>(
    config.baseUrl,
    config.model,
    messages,
    EXTRACTOR_SCHEMA,
    signal,
  );
  return {
    entities: ensureStringArray(result.entities).slice(0, MAX_ENTITIES_PER_CHUNK),
    claims: ensureStringArray(result.claims).slice(0, MAX_CLAIMS_PER_CHUNK),
    questions: ensureStringArray(result.questions).slice(0, MAX_QUESTIONS_PER_CHUNK),
  };
}

async function extractAll(
  config: ExtractConfig,
  chunks: Chunk[],
  signal: AbortSignal,
): Promise<Extraction> {
  if (chunks.length === 0) return { entities: [], claims: [], questions: [] };
  const concurrency = Math.max(1, config.concurrency ?? 4);
  const results: Extraction[] = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = chunks.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((c) => extractOne(config, c, signal)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") results.push(outcome.value);
    }
  }
  return mergeExtractions(results);
}

async function runJob(message: RunMessage): Promise<void> {
  const controller = new AbortController();
  inflight.set(message.id, controller);
  try {
    const body = stripFrontmatter(message.noteBody);
    const chunks = await chunkNote(message.notePath, body);
    const vectors =
      chunks.length > 0
        ? await embedAll(
            message.embedConfig,
            chunks.map((c) => c.text),
            controller.signal,
          )
        : [];
    const extraction = await extractAll(message.extractConfig, chunks, controller.signal);
    postOut({ type: "result", id: message.id, ok: true, chunks, vectors, extraction });
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error);
    postOut({ type: "result", id: message.id, ok: false, message: reason });
  } finally {
    inflight.delete(message.id);
  }
}

function handleMessage(message: IncomingMessage): void {
  if (message.type === "run") {
    void runJob(message);
    return;
  }
  if (message.type === "cancel") {
    const controller = inflight.get(message.id);
    if (controller) controller.abort();
  }
}

(self as unknown as { onmessage: (event: MessageEvent<IncomingMessage>) => void }).onmessage = (
  event,
) => {
  handleMessage(event.data);
};
