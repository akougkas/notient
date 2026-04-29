import type { RecordId, Surreal } from "surrealdb";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { EdgeTable } from "../db/edgeTables";
import { linkerNeighbors, lookupNoteByPath, relateEdge } from "../db/surreal";
import type { LLMProvider } from "../llm/provider";

/**
 * Linker agent: proposes typed semantic edges between the active note and
 * its kNN neighbours. Reads chunks + vectors from SurrealDB, asks the
 * reasoning model for a small set of typed proposals, and writes each
 * accepted proposal as an unapproved edge in the target table.
 *
 * Spec: Phase 3 plan §Task 8. Edges land with `class = 'INFERRED'`,
 * `agent = 'linker'`, `source = 'linker'`, `approved = false` so the
 * /links inbox surfaces them for human review.
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

interface LinkerProposal {
  targetNotePath: string;
  type: AllowedEdgeType;
  confidence: number;
  rationale: string;
  evidenceChunkIds: string[];
}

interface LinkerJsonResponse {
  edges: Array<{
    targetNotePath: string;
    type: string;
    confidence: number;
    rationale: string;
    evidenceChunkIds: string[];
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
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["targetNotePath", "type", "confidence", "rationale", "evidenceChunkIds"],
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
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 240 },
            evidenceChunkIds: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
        },
      },
    },
  },
} as const;

interface ChunkRow {
  ord: number;
  text: string;
  vector: number[];
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
        content:
          "You are the Notient Linker. Given an active note and its top embedding neighbours, propose typed edges with evidence. Cite only chunk IDs that appear in the input. Be conservative: confidence < 0.6 means do not propose.",
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
            evidenceChunkIds: candidate.evidenceChunkIds.map((id) => id.toString()),
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

    const proposals = this.filterProposals(response);

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

  private filterProposals(response: LinkerJsonResponse): LinkerProposal[] {
    const accepted: LinkerProposal[] = [];
    for (const edge of response.edges) {
      if (!isAllowedEdgeType(edge.type)) continue;
      if (typeof edge.targetNotePath !== "string" || edge.targetNotePath.length === 0) continue;
      if (typeof edge.confidence !== "number" || edge.confidence < 0 || edge.confidence > 1) {
        continue;
      }
      accepted.push({
        targetNotePath: edge.targetNotePath,
        type: edge.type,
        confidence: edge.confidence,
        rationale: typeof edge.rationale === "string" ? edge.rationale : "",
        evidenceChunkIds: Array.isArray(edge.evidenceChunkIds)
          ? edge.evidenceChunkIds.filter((id): id is string => typeof id === "string")
          : [],
      });
    }
    return accepted;
  }
}
