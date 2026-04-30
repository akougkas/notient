import type { RecordId, Surreal } from "surrealdb";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { EdgeTable } from "../db/edgeTables";
import { linkerNeighbors, lookupNoteByPath, relateEdge } from "../db/surreal";
import type { LLMProvider } from "../llm/provider";

/**
 * Linker agent: proposes typed semantic edges between the active note and
 * its kNN neighbours. Reads chunks + vectors from SurrealDB, asks the
 * reasoning model to rank the strongest few neighbours, and writes each
 * accepted proposal as an unapproved edge in the target table.
 *
 * Spec: Phase 3 plan §Task 8 with M3 rewrite. The model is asked to pick the
 * top few related neighbours (no per-pair confidence number); rank position
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

const ALLOWED_EDGE_TYPES = [
  "supports",
  "contradicts",
  "extends",
  "exemplifies",
  "synthesizes",
  "related_to",
] as const satisfies readonly EdgeTable[];

type AllowedEdgeType = (typeof ALLOWED_EDGE_TYPES)[number];

function isAllowedEdgeType(value: string): value is AllowedEdgeType {
  return (ALLOWED_EDGE_TYPES as readonly string[]).includes(value);
}

/**
 * Confidence for a kept proposal is derived from its rank position in the
 * model's returned array, not from a model-emitted number. The ladder spreads
 * across {0.95, 0.85, 0.75, 0.65} so the inbox shows a graded distribution.
 * MAX_PROPOSALS_PER_NOTE and RANK_TO_CONFIDENCE.length must stay in sync.
 */
export const MAX_PROPOSALS_PER_NOTE = 4;
export const RANK_TO_CONFIDENCE: readonly number[] = [0.95, 0.85, 0.75, 0.65];

if (RANK_TO_CONFIDENCE.length !== MAX_PROPOSALS_PER_NOTE) {
  throw new Error(
    "linker: RANK_TO_CONFIDENCE length must equal MAX_PROPOSALS_PER_NOTE",
  );
}

export interface LinkerProposal {
  targetNotePath: string;
  type: AllowedEdgeType;
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
              enum: [
                "supports",
                "contradicts",
                "extends",
                "exemplifies",
                "synthesizes",
                "related_to",
              ],
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
- type: one of supports | contradicts | extends | exemplifies | synthesizes | related_to
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
 * Pure post-processor exported for unit tests. Validates each model-emitted
 * edge, truncates to MAX_PROPOSALS_PER_NOTE, and assigns confidence by rank
 * position via RANK_TO_CONFIDENCE.
 */
export function filterProposals(response: LinkerJsonResponse): LinkerProposal[] {
  if (response === null || response === undefined) return [];
  const edges = Array.isArray(response.edges) ? response.edges : [];
  const accepted: LinkerProposal[] = [];
  for (const edge of edges) {
    if (accepted.length >= MAX_PROPOSALS_PER_NOTE) break;
    if (edge === null || typeof edge !== "object") continue;
    if (typeof edge.targetNotePath !== "string" || edge.targetNotePath.length === 0) continue;
    if (typeof edge.type !== "string" || !isAllowedEdgeType(edge.type)) continue;
    const rank = accepted.length;
    accepted.push({
      targetNotePath: edge.targetNotePath,
      type: edge.type,
      confidence: RANK_TO_CONFIDENCE[rank],
      rationale: typeof edge.rationale === "string" ? edge.rationale : "",
    });
  }
  return accepted;
}

export class Linker implements Agent {
  readonly name = "linker" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: LinkerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (context.notePath === null) return { proposals: 0 };

    const activeNoteId = await lookupNoteByPath(this.opts.db, context.notePath);
    if (activeNoteId === null) return { proposals: 0 };

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
            chunks: activeChunks.map((chunk) => ({
              id: `chunk-${chunk.ord}`,
              ord: chunk.ord,
              text: chunk.text,
            })),
          },
          neighbors: neighbors.map((candidate) => ({
            notePath: candidate.notePath,
            bestDistance: candidate.bestDistance,
          })),
          edgeTypes: ALLOWED_EDGE_TYPES,
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
      },
      SCHEMA,
    );

    const proposals = filterProposals(response);

    let written = 0;
    for (const proposal of proposals) {
      const targetId = await lookupNoteByPath(this.opts.db, proposal.targetNotePath);
      if (targetId === null) continue;
      await relateEdge(this.opts.db, {
        table: proposal.type,
        from: activeNoteId,
        to: targetId,
        source: "linker",
        confidenceClass: "INFERRED",
        confidence: proposal.confidence,
        agent: "linker",
        approved: false,
      });
      context.bus.emit({
        type: "swarm:link_proposed",
        edgeId: `${proposal.type}:${activeNoteId.toString()}->${targetId.toString()}`,
        sourceId: activeNoteId.toString(),
        targetId: targetId.toString(),
        edgeType: proposal.type,
        confidence: proposal.confidence,
        runId: context.runId,
      });
      written += 1;
    }

    return { proposals: written };
  }

  private async fetchActiveChunks(noteId: RecordId<"note">): Promise<ChunkRow[]> {
    const [rows] = await this.opts.db
      .query<[ChunkRow[]]>(
        "SELECT ord, text, vector FROM chunk WHERE note = $note AND vector != NONE ORDER BY ord;",
        { note: noteId },
      )
      .collect<[ChunkRow[]]>();
    return rows;
  }
}
