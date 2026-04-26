import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { Database } from "../db/database";
import type { LLMProvider } from "../llm/provider";

export interface NeighborChunk {
  notePath: string;
  chunkId: string;
  text: string;
  score: number;
}

export type NeighborhoodFn = (
  notePath: string,
  options: { signal: AbortSignal; topK: number },
) => Promise<NeighborChunk[]>;

export interface LinkerOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  neighborhood: NeighborhoodFn;
  topK?: number;
}

interface LinkerJsonResponse {
  edges: Array<{
    targetNotePath: string;
    type: "supports" | "extends" | "exemplifies" | "related_to";
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
            type: { type: "string", enum: ["supports", "extends", "exemplifies", "related_to"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 240 },
            evidenceChunkIds: { type: "array", items: { type: "string" }, maxItems: 4 },
          },
        },
      },
    },
  },
} as const;

export class Linker implements Agent {
  readonly name = "linker" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: LinkerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (!context.notePath) return { proposals: 0 };
    const topK = this.opts.topK ?? 20;
    const neighbors = await this.opts.neighborhood(context.notePath, {
      signal: context.signal,
      topK,
    });
    if (neighbors.length === 0) return { proposals: 0 };

    const activeChunks = this.opts.db.query<{ id: string; text: string }>(
      "SELECT id, text FROM chunks WHERE note_path = ? ORDER BY ord LIMIT 6;",
      [context.notePath],
    );
    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Notient Linker. Given an active note and its top embedding neighbours, propose typed edges with evidence. Cite only chunk IDs that appear in the input. Be conservative: confidence < 0.6 means do not propose.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          activeNote: { path: context.notePath, chunks: activeChunks },
          neighbors,
          edgeTypes: ["supports", "extends", "exemplifies", "related_to"],
        }),
      },
    ];

    const response = await this.opts.provider.chatJson<LinkerJsonResponse>(
      messages,
      {
        model: this.opts.reasoningModel,
        temperature: 0.1,
        signal: context.signal,
        maxTokens: 800,
      },
      SCHEMA,
    );

    const allowedChunkIds = new Set([
      ...activeChunks.map((c) => c.id),
      ...neighbors.map((n) => n.chunkId),
    ]);

    const sourceId = `note:${context.notePath}`;
    let staged = 0;
    for (const edge of response.edges) {
      if (edge.confidence < 0.6) continue;
      const evidence = edge.evidenceChunkIds.filter((id) => allowedChunkIds.has(id));
      if (evidence.length === 0) continue;
      const targetId = `note:${edge.targetNotePath}`;
      const id = `staging:${this.name}:${sourceId}:${targetId}:${Date.now()}:${staged}`;
      this.opts.db.run(
        `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          id,
          edge.type,
          sourceId,
          targetId,
          edge.confidence,
          this.name,
          JSON.stringify(evidence),
          edge.rationale,
          Date.now(),
        ],
      );
      staged++;
    }
    return { proposals: staged };
  }
}
