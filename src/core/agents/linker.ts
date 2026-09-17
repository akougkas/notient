import type { RecordId, Surreal } from "surrealdb";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import {
  WRITEBACK_EDGE_TABLES,
  type WritebackEdgeTable,
  isWritebackEdgeTable,
} from "../db/edgeTables";
import { fetchChunkTexts, linkerNeighbors, lookupNoteByPath, relateEdge } from "../db/surreal";
import { LINKER } from "../indexer/concurrencyDefaults";
import type { LLMProvider } from "../llm/provider";
import { deletePendingProposals } from "./pendingProposals";

/**
 * Linker agent: proposes typed semantic edges between the active note and
 * its kNN neighbours. Reads chunks + vectors from SurrealDB, asks the
 * reasoning model to rank the strongest few neighbours, and writes each
 * accepted proposal as an unapproved edge in the target table. Rank supplies
 * only a ceiling for confidence; vector distance supplies its retrieval bound.
 *
 * The model picks the top few related neighbours without assigning per-pair
 * confidence; rank position
 * in the model's returned array maps deterministically to confidence via
 * RANK_TO_CONFIDENCE so the operator sees a graded distribution instead of
 * the bimodal cluster the threshold-anchored prompt produced. Edges land
 * with `class = 'INFERRED'`, `agent = 'linker'`, `source = 'linker'`,
 * `approved = false` so the /links inbox surfaces them for human review.
 */

export interface LinkerOptions {
  db: Surreal;
  provider: LLMProvider;
  reasoningModel: string;
  topK?: number;
  ef?: number;
}

/**
 * Rank ceiling for a kept proposal. The final confidence is the lesser of
 * this ceiling and cosine similarity (`1 - bestDistance`), so retrieval and
 * graph scoring never consume an unsupported positional constant.
 */
export const MAX_PROPOSALS_PER_NOTE = 4;
export const RANK_TO_CONFIDENCE: readonly number[] = [0.95, 0.85, 0.75, 0.65];

if (RANK_TO_CONFIDENCE.length !== MAX_PROPOSALS_PER_NOTE) {
  throw new Error("linker: RANK_TO_CONFIDENCE length must equal MAX_PROPOSALS_PER_NOTE");
}

export interface LinkerProposal {
  targetNotePath: string;
  type: WritebackEdgeTable;
  confidence: number;
  rationale: string;
}

export interface LinkerJsonResponse {
  edges: Array<{
    targetNotePath: string;
    type: string;
    rationale: string;
  }>;
}

const SCHEMA = {
  name: "LinkerEdges",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["edges"],
    properties: {
      edges: {
        type: "array",
        maxItems: MAX_PROPOSALS_PER_NOTE,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["targetNotePath", "type", "rationale"],
          properties: {
            targetNotePath: { type: "string" },
            type: {
              type: "string",
              enum: WRITEBACK_EDGE_TABLES,
            },
            rationale: { type: "string", maxLength: 240 },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the Notient Linker. You are given an active note and a set of candidate neighbour notes selected by embedding similarity. Your job is to rank the neighbours by how strongly the active note actually relates to them in substance, then output only the strongest few.

Return at most ${MAX_PROPOSALS_PER_NOTE} edges, ordered from strongest relationship to weakest. For each kept neighbour emit:
- targetNotePath: the neighbour's path exactly as given
- type: one of ${WRITEBACK_EDGE_TABLES.join(" | ")}
- rationale: one short sentence naming the specific shared idea

Edge type rubric:
- supports: the active note argues for or provides evidence for a position the neighbour holds
- contradicts: the active note argues against a position the neighbour holds
- extends: the active note builds on or generalises a thread the neighbour starts
- exemplifies: the active note is a concrete instance of a pattern the neighbour describes (or vice versa)
- synthesizes: the active note combines threads from the neighbour with other material
- related_to: same domain and clearly relevant, but the relationship is not one of the above

Quality over quantity. Skip neighbours that are merely topically adjacent or that share vocabulary without sharing an argument. An empty array is correct when nothing is worth proposing. Never invent paths or claims.`;

interface ChunkRow {
  ord: number;
  text: string;
  vector: number[];
}

/**
 * Prompt bounding for linker inference. `linkerNeighbors` merges four kNN
 * probes and truncates them to `LINKER.maxCandidates`; this layer also bounds
 * the active note and each candidate's evidence snippets.
 */
function truncateSnippet(text: string, limit = LINKER.evidenceSnippetChars): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

interface PromptChunk {
  id: string;
  ord: number;
  text: string;
}

/** First `LINKER.maxActiveChunksInPrompt` chunks, plus a marker for the rest. */
export function buildActiveNotePrompt(chunks: ChunkRow[]): {
  chunks: PromptChunk[];
  omitted: string | undefined;
} {
  const kept = chunks.slice(0, LINKER.maxActiveChunksInPrompt);
  const remaining = chunks.length - kept.length;
  return {
    chunks: kept.map((chunk) => ({
      id: `chunk-${chunk.ord}`,
      ord: chunk.ord,
      text: chunk.text,
    })),
    omitted: remaining > 0 ? `[... ${remaining} more chunks]` : undefined,
  };
}

/**
 * Validate model-emitted edges against retrieved candidates, truncate to the
 * proposal cap, and bound each rank ceiling by its candidate's vector
 * similarity. Candidate distances are required; an LLM path without retrieval
 * provenance cannot become an edge.
 */
export function filterProposals(
  response: unknown,
  candidateDistances: ReadonlyMap<string, number>,
): LinkerProposal[] {
  const edges = parseModelEdges(response);
  assertCandidateDistances(candidateDistances);
  const accepted: LinkerProposal[] = [];
  const seenTargets = new Set<string>();
  for (const edge of edges) {
    if (seenTargets.has(edge.targetNotePath)) {
      throw new Error(`linker model integrity: duplicate target path ${edge.targetNotePath}`);
    }
    seenTargets.add(edge.targetNotePath);
    const bestDistance = candidateDistances.get(edge.targetNotePath);
    // A structurally valid model response may still invent a path. It cannot
    // acquire retrieval provenance and therefore cannot become a proposal.
    if (bestDistance === undefined) continue;
    const rank = accepted.length;
    const retrievalBound = 1 - bestDistance;
    if (retrievalBound <= 0) continue;
    accepted.push({
      targetNotePath: edge.targetNotePath,
      type: edge.type,
      confidence: Math.min(RANK_TO_CONFIDENCE[rank], retrievalBound),
      rationale: edge.rationale,
    });
  }
  return accepted;
}

function parseModelEdges(response: unknown): Array<Omit<LinkerProposal, "confidence">> {
  if (!isRecord(response) || !hasExactKeys(response, ["edges"]) || !Array.isArray(response.edges)) {
    throw new Error("linker model integrity: response must contain exactly one edges array");
  }
  if (response.edges.length > MAX_PROPOSALS_PER_NOTE) {
    throw new Error(
      `linker model integrity: edges exceeds the ${MAX_PROPOSALS_PER_NOTE}-proposal limit`,
    );
  }
  return response.edges.map((raw, index) => parseModelEdge(raw, index));
}

function parseModelEdge(raw: unknown, index: number): Omit<LinkerProposal, "confidence"> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["targetNotePath", "type", "rationale"]) ||
    typeof raw.targetNotePath !== "string" ||
    raw.targetNotePath.trim().length === 0 ||
    typeof raw.type !== "string" ||
    !isWritebackEdgeTable(raw.type) ||
    typeof raw.rationale !== "string" ||
    raw.rationale.trim().length === 0 ||
    raw.rationale.length > 240
  ) {
    throw new Error(`linker model integrity: edge ${index} is invalid`);
  }
  return {
    targetNotePath: raw.targetNotePath,
    type: raw.type,
    rationale: raw.rationale,
  };
}

function assertCandidateDistances(candidateDistances: ReadonlyMap<string, number>): void {
  for (const [path, distance] of candidateDistances) {
    if (
      typeof path !== "string" ||
      path.trim().length === 0 ||
      typeof distance !== "number" ||
      !Number.isFinite(distance) ||
      distance < 0 ||
      distance > 2
    ) {
      throw new Error("linker retrieval integrity: candidate distance is invalid");
    }
  }
}

export async function deletePendingLinkerProposals(
  db: Surreal,
  noteId: RecordId<"note">,
): Promise<void> {
  await deletePendingProposals(db, {
    tables: WRITEBACK_EDGE_TABLES,
    agent: "linker",
    noteId,
  });
}

export class Linker implements Agent {
  readonly name = "linker" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: LinkerOptions) {
    if (
      typeof opts.reasoningModel !== "string" ||
      opts.reasoningModel.trim() !== opts.reasoningModel
    ) {
      throw new Error("linker reasoningModel must be a non-blank string");
    }
    assertOptionalPositiveSafeInteger(opts.topK, "linker topK");
    assertOptionalPositiveSafeInteger(opts.ef, "linker ef");
  }

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (context.notePath === null) return { proposals: 0 };
    if (!this.opts.reasoningModel)
      throw new Error(
        "INFERENCE_UNAVAILABLE: configure a reasoning model before running relate notes",
      );

    const activeNoteId = await lookupNoteByPath(this.opts.db, context.notePath);
    if (activeNoteId === null) return { proposals: 0 };

    await deletePendingLinkerProposals(this.opts.db, activeNoteId);

    const activeChunks = await this.fetchActiveChunks(activeNoteId);
    if (activeChunks.length === 0) return { proposals: 0 };

    const topK = this.opts.topK ?? 20;
    const ef = this.opts.ef ?? 40;
    const neighbors = await linkerNeighbors(this.opts.db, {
      activeNoteId,
      activeChunkVectors: activeChunks.map((chunk) => chunk.vector),
      k: topK,
      ef,
    });
    if (neighbors.length === 0) return { proposals: 0 };

    const activeNotePrompt = buildActiveNotePrompt(activeChunks);
    const evidenceIds = neighbors.flatMap((candidate) =>
      candidate.evidenceChunkIds.slice(0, LINKER.maxEvidencePerNote),
    );
    const evidenceTexts = await fetchChunkTexts(this.opts.db, evidenceIds);

    const messages = [
      {
        role: "system" as const,
        content: SYSTEM_PROMPT,
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          activeNote: {
            path: context.notePath,
            chunks: activeNotePrompt.chunks,
            ...(activeNotePrompt.omitted !== undefined
              ? { omitted: activeNotePrompt.omitted }
              : {}),
          },
          neighbors: neighbors.map((candidate) => ({
            notePath: candidate.notePath,
            bestDistance: candidate.bestDistance,
            evidence: candidate.evidenceChunkIds
              .slice(0, LINKER.maxEvidencePerNote)
              .map((id) => evidenceTexts.get(id.toString()))
              .filter((text): text is string => typeof text === "string")
              .map((text) => truncateSnippet(text)),
          })),
          edgeTypes: WRITEBACK_EDGE_TABLES,
        }),
      },
    ];

    const response = await this.opts.provider.chatJson<LinkerJsonResponse>(
      messages,
      {
        model: this.opts.reasoningModel,
        temperature: 0.1,
        signal: context.signal,
        maxTokens: 2000,
        enableThinking: false,
      },
      SCHEMA,
    );

    const candidateDistances = new Map(
      neighbors.map((candidate) => [candidate.notePath, candidate.bestDistance] as const),
    );
    const proposals = filterProposals(response, candidateDistances);

    let written = 0;
    for (const proposal of proposals) {
      const targetId = await lookupNoteByPath(this.opts.db, proposal.targetNotePath);
      if (targetId === null) continue;
      const created = await relateEdge(this.opts.db, {
        table: proposal.type,
        from: activeNoteId,
        to: targetId,
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: proposal.confidence,
        agent: "linker",
        approved: false,
      });
      if (!created) continue;
      context.bus.emit({
        type: "swarm:link_proposed",
        edgeId: `${proposal.type}:${activeNoteId.toString()}->${targetId.toString()}`,
        sourceId: activeNoteId.toString(),
        targetId: targetId.toString(),
        sourcePath: context.notePath,
        targetPath: proposal.targetNotePath,
        edgeType: proposal.type,
        confidence: proposal.confidence,
        runId: context.runId,
      });
      written += 1;
    }

    return { proposals: written };
  }

  private async fetchActiveChunks(noteId: RecordId<"note">): Promise<ChunkRow[]> {
    const result: unknown = await this.opts.db
      .query(
        "SELECT ord, text, vector FROM chunk WHERE note = $note AND vector != NONE ORDER BY ord;",
        { note: noteId },
      )
      .collect();
    const rows = readSingleStatementRows(result, "linker chunks").map(parseChunkRow);
    const dimensions = new Set(rows.map((row) => row.vector.length));
    if (dimensions.size > 1) {
      throw new Error("linker storage integrity: chunk vector dimensions disagree");
    }
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].ord <= rows[index - 1].ord) {
        throw new Error("linker storage integrity: chunk ord values are not strictly increasing");
      }
    }
    return rows;
  }
}

function parseChunkRow(raw: unknown): ChunkRow {
  if (!isRecord(raw) || !hasExactKeys(raw, ["ord", "text", "vector"])) {
    throw new Error("linker storage integrity: chunk row is invalid");
  }
  if (
    typeof raw.ord !== "number" ||
    !Number.isSafeInteger(raw.ord) ||
    raw.ord < 0 ||
    typeof raw.text !== "string" ||
    raw.text.length === 0 ||
    !Array.isArray(raw.vector) ||
    raw.vector.length === 0 ||
    raw.vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("linker storage integrity: chunk row is invalid");
  }
  return { ord: raw.ord, text: raw.text, vector: raw.vector };
}

function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}

function assertOptionalPositiveSafeInteger(raw: unknown, label: string): void {
  if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasExactKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(raw, key));
}
