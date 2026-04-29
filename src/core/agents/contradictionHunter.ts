import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import type { Database } from "../db/database";
import { ChatJsonParseError, type LLMProvider } from "../llm/provider";

export interface ClaimNeighbor {
  id: string;
  score: number;
  chunkIds: string[];
}

export type ClaimNeighborsFn = (
  recentClaimIds: string[],
  options: { signal: AbortSignal; topK: number },
) => Promise<ClaimNeighbor[]>;

export interface ContradictionHunterOptions {
  db: Database;
  provider: LLMProvider;
  reasoningModel: string;
  neighbors: ClaimNeighborsFn;
  maxPairs: number;
  topK?: number;
}

const SCHEMA = {
  name: "ContradictionPairs",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["pairs"],
    properties: {
      pairs: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claimAId", "claimBId", "confidence", "rationale", "evidenceChunkIds"],
          properties: {
            claimAId: { type: "string" },
            claimBId: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", maxLength: 240 },
            evidenceChunkIds: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
          },
        },
      },
    },
  },
} as const;

interface PairsResponse {
  pairs: Array<{
    claimAId: string;
    claimBId: string;
    confidence: number;
    rationale: string;
    evidenceChunkIds: string[];
  }>;
}

export class ContradictionHunter implements Agent {
  readonly name = "contradictionHunter" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly opts: ContradictionHunterOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const recentClaims = this.opts.db.query<{
      id: string;
      label: string;
      payload: string | null;
    }>(
      context.notePath
        ? "SELECT id, label, payload FROM graph_nodes WHERE type = 'claim' AND note_path = ? ORDER BY created_at DESC LIMIT 10;"
        : "SELECT id, label, payload FROM graph_nodes WHERE type = 'claim' ORDER BY created_at DESC LIMIT 10;",
      context.notePath ? [context.notePath] : [],
    );
    if (recentClaims.length === 0) return { proposals: 0 };

    const neighbors = await this.opts.neighbors(
      recentClaims.map((c) => c.id),
      { signal: context.signal, topK: this.opts.topK ?? 50 },
    );
    if (neighbors.length === 0) return { proposals: 0 };

    const neighborClaims = this.opts.db.query<{
      id: string;
      label: string;
      payload: string | null;
    }>(
      `SELECT id, label, payload FROM graph_nodes WHERE id IN (${neighbors.map(() => "?").join(",")});`,
      neighbors.map((n) => n.id),
    );

    const messages = [
      {
        role: "system" as const,
        content:
          "You are the Notient Contradiction Hunter. Identify pairs of claims that directly contradict. Confidence < 0.6 means do not propose. Cite the chunk IDs that prove the contradiction.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          recentClaims: recentClaims.map((c) => ({
            id: c.id,
            text: c.label,
            chunkIds: extractChunkIds(c.payload),
          })),
          candidateClaims: neighborClaims.map((c) => ({
            id: c.id,
            text: c.label,
            chunkIds: extractChunkIds(c.payload),
          })),
        }),
      },
    ];

    let response: PairsResponse;
    try {
      response = await this.opts.provider.chatJson<PairsResponse>(
        messages,
        {
          model: this.opts.reasoningModel,
          temperature: 0.1,
          signal: context.signal,
          // 8 pairs * (240-char rationale + IDs + 4 chunk IDs) ≈ 3 KB.
          // Reasoning models also burn tokens on internal CoT before the JSON,
          // so 1000 was reliably truncating against nemotron-cascade. Bump to
          // 2000 to leave room for both the CoT and the structured payload.
          maxTokens: 2000,
        },
        SCHEMA,
      );
    } catch (error) {
      if (error instanceof ChatJsonParseError) {
        // Reasoning models on the local llama-server occasionally truncate the JSON
        // when they hit max_tokens. Skip the run instead of crashing the
        // coordinator; the next idle-5m tick will retry.
        console.warn(
          `[Notient][ContradictionHunter] chatJson parse failed: ${error.message.slice(0, 160)}`,
        );
        return { proposals: 0 };
      }
      throw error;
    }

    const pairs = Array.isArray(response.pairs) ? response.pairs : [];
    const validIds = new Set([
      ...recentClaims.map((c) => c.id),
      ...neighborClaims.map((c) => c.id),
    ]);
    const notePathById = this.collectNotePaths(
      [...recentClaims, ...neighborClaims].map((c) => c.id),
    );
    return { proposals: this.stagePairs(pairs, validIds, notePathById, context) };
  }

  private collectNotePaths(claimIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const claimId of claimIds) {
      const rows = this.opts.db.query<{ note_path: string | null }>(
        "SELECT note_path FROM graph_nodes WHERE id = ? LIMIT 1;",
        [claimId],
      );
      const found = rows[0]?.note_path ?? null;
      if (found !== null) out.set(claimId, found);
    }
    return out;
  }

  private stagePairs(
    pairs: PairsResponse["pairs"],
    validIds: Set<string>,
    notePathById: Map<string, string>,
    context: AgentRunContext,
  ): number {
    let staged = 0;
    for (const pair of pairs.slice(0, this.opts.maxPairs)) {
      if (pair.confidence < 0.6) continue;
      if (!validIds.has(pair.claimAId) || !validIds.has(pair.claimBId)) continue;
      const id = `staging:${this.name}:${pair.claimAId}:${pair.claimBId}:${Date.now()}:${staged}`;
      this.opts.db.run(
        `INSERT INTO staging_edges (id, type, source_id, target_id, confidence, agent, evidence, rationale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?);`,
        [
          id,
          "contradicts",
          pair.claimAId,
          pair.claimBId,
          pair.confidence,
          this.name,
          JSON.stringify(pair.evidenceChunkIds),
          pair.rationale,
          Date.now(),
        ],
      );
      context.bus.emit({
        type: "swarm:contradiction_discovered",
        pair: [pair.claimAId, pair.claimBId],
        severity: pair.confidence,
        notePaths: [notePathById.get(pair.claimAId) ?? "", notePathById.get(pair.claimBId) ?? ""],
        runId: context.runId,
      });
      staged++;
    }
    return staged;
  }
}

function extractChunkIds(payload: string | null): string[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as { chunkIds?: string[] };
    return Array.isArray(parsed.chunkIds) ? parsed.chunkIds : [];
  } catch {
    return [];
  }
}
