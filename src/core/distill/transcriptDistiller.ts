/**
 * Single-shot LLM-driven transcript distiller used by `agent.distill`.
 *
 * The original spec assumed the existing Synthesizer agent could ingest
 * external transcript chunks. It cannot: Synthesizer queries indexed notes
 * and clusters them via DBSCAN, returning a proposal count. The distill verb
 * needs to ingest a transcript supplied by the caller (markdown / JSONL /
 * JSON) and emit candidate proposals across four kinds (claim / decision /
 * question / note). This module owns that LLM call. It bypasses Synthesizer
 * and Extractor entirely so the handler stays thin.
 */

import type { LLMProvider, ChatMessage as ProviderChatMessage } from "../llm/provider";
import type { TranscriptMessage } from "./transcriptParser";

export type CandidateKind = "claim" | "decision" | "question" | "note";

export interface Candidate {
  kind: CandidateKind;
  text: string;
  sourceMessageIds: string[];
}

export interface TranscriptDistiller {
  distill(messages: TranscriptMessage[], signal?: AbortSignal): Promise<Candidate[]>;
}

export interface TranscriptDistillerDeps {
  provider: LLMProvider;
  /** Optional override for the chat model. Defaults to a single-shot temp 0.2 call. */
  model?: string;
}

const SUPPORTED_KINDS: ReadonlySet<CandidateKind> = new Set([
  "claim",
  "decision",
  "question",
  "note",
]);

const PER_MESSAGE_CHAR_CAP = 1200;
const DISTILLER_MAX_TOKENS = 1200;
const DEFAULT_MODEL = "default";

const SYSTEM_PROMPT = [
  "You distill an external conversation transcript into discrete proposal candidates for a personal knowledge vault. Each candidate has one of four kinds:",
  "",
  '- claim: a factual statement asserted in the transcript (e.g., "OAuth2 needs PKCE for SPA clients").',
  '- decision: a choice made (e.g., "Going with PostgreSQL over SQLite for the prod DB").',
  '- question: an unanswered or partially answered question (e.g., "How do we handle token rotation?").',
  '- note: a standalone insight or observation that does not fit the above (e.g., "The auth refactor blocks the multi-tenant work.").',
  "",
  'Return a JSON array. Each element is an object: { "kind": "claim|decision|question|note", "text": "<one or two sentences>", "sourceMessageIds": ["<id1>", "<id2>"] }. Skip filler. Do not invent content not present in the transcript. If nothing distillable is present, return an empty array.',
  "",
  "Output exactly the JSON array. No prose before or after. No code fences.",
].join("\n");

export function createTranscriptDistiller(deps: TranscriptDistillerDeps): TranscriptDistiller {
  return {
    distill: (messages, signal) => distillImpl(deps, messages, signal),
  };
}

async function distillImpl(
  deps: TranscriptDistillerDeps,
  messages: TranscriptMessage[],
  signal?: AbortSignal,
): Promise<Candidate[]> {
  if (messages.length === 0) return [];
  const knownIds = new Set(messages.map((entry) => entry.sourceMessageId));
  const userPrompt = buildUserPrompt(messages);
  const chatMessages: ProviderChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let raw: string;
  try {
    raw = await deps.provider.chat(chatMessages, {
      model: deps.model ?? DEFAULT_MODEL,
      temperature: 0.2,
      maxTokens: DISTILLER_MAX_TOKENS,
      signal,
      enableThinking: false,
    });
  } catch {
    // Provider failures surface as an empty candidate list. The handler
    // still emits a structured response with proposalsCreated = 0 so the
    // caller can re-run.
    return [];
  }

  const parsed = tryParseCandidatesArray(raw);
  if (parsed === null) return [];
  return validateCandidates(parsed, knownIds);
}

function buildUserPrompt(messages: TranscriptMessage[]): string {
  const lines: string[] = ["Transcript messages (id | role | content):", ""];
  messages.forEach((entry, index) => {
    const truncated = truncate(entry.content, PER_MESSAGE_CHAR_CAP);
    lines.push(`${index + 1}. ${entry.sourceMessageId} | ${entry.role} | ${truncated}`);
  });
  return lines.join("\n");
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function tryParseCandidatesArray(raw: string): unknown[] | null {
  const stripped = stripCodeFences(raw).trim();
  if (stripped.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

function stripCodeFences(input: string): string {
  const fencePattern = /^```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/i;
  const match = input.trim().match(fencePattern);
  if (match === null) return input;
  return match[1];
}

function validateCandidates(entries: unknown[], knownIds: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of entries) {
    const candidate = validateOneCandidate(entry, knownIds);
    if (candidate !== null) out.push(candidate);
  }
  return out;
}

function validateOneCandidate(value: unknown, knownIds: Set<string>): Candidate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kindRaw = record.kind;
  if (typeof kindRaw !== "string") return null;
  if (!SUPPORTED_KINDS.has(kindRaw as CandidateKind)) return null;
  const textRaw = record.text;
  if (typeof textRaw !== "string") return null;
  const text = textRaw.trim();
  if (text.length === 0) return null;
  const idsRaw = record.sourceMessageIds;
  if (!Array.isArray(idsRaw)) return null;
  const filteredIds: string[] = [];
  for (const id of idsRaw) {
    if (typeof id !== "string") continue;
    if (!knownIds.has(id)) continue;
    filteredIds.push(id);
  }
  return { kind: kindRaw as CandidateKind, text, sourceMessageIds: filteredIds };
}
