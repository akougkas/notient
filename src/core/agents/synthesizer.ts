import type { RecordId, Surreal } from "surrealdb";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import { linkerNeighbors, lookupNoteByPath, relateEdge } from "../db/surreal";
import type { LLMProvider } from "../llm/provider";
import { deletePendingProposals } from "./pendingProposals";

export interface SynthesizerOptions {
  db: Surreal;
  provider: LLMProvider;
  reasoningModel: string;
  topK?: number;
}

export interface SynthesizerJsonResponse {
  syntheses: Array<{
    targetNotePath: string;
    evidence: string;
  }>;
}

const SCHEMA = {
  name: "SynthesizerProposals",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["syntheses"],
    properties: {
      syntheses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["targetNotePath", "evidence"],
          properties: {
            targetNotePath: { type: "string" },
            evidence: { type: "string" },
          },
        },
      },
    },
  },
};

interface ChunkRow {
  vector: number[];
}

export class Synthesizer implements Agent {
  readonly name = "synthesizer" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly options: SynthesizerOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    if (context.notePath === null) return { proposals: 0 };
    const noteId = await lookupNoteByPath(this.options.db, context.notePath);
    if (noteId === null) return { proposals: 0 };

    await deletePendingProposals(this.options.db, {
      tables: ["synthesizes"],
      agent: "synthesizer",
      noteId,
    });

    const activeChunks = await this.fetchActiveChunks(noteId);
    if (activeChunks.length === 0) return { proposals: 0 };

    const topK = this.options.topK ?? 10;
    const candidates = await linkerNeighbors(this.options.db, {
      activeNoteId: noteId,
      activeChunkVectors: activeChunks.map((chunk) => chunk.vector),
      k: topK,
    });
    if (candidates.length === 0) return { proposals: 0 };

    const candidatePaths = candidates.map((candidate) => candidate.notePath);

    const prompt = [
      `Active Note Path: ${context.notePath}`,
      "Candidate Target Note Paths for Synthesis:",
      ...candidates.map((candidate) => `- ${candidate.notePath}`),
      "",
      "Identify candidate notes that can be synthesized or merged into a higher-level summary or MOC with the active note.",
      "Only return candidates where a strong thematic synthesis exists.",
    ].join("\n");

    const response = await this.options.provider.chatJson<SynthesizerJsonResponse>(
      [{ role: "user", content: prompt }],
      { model: this.options.reasoningModel, signal: context.signal, enableThinking: false },
      SCHEMA,
    );

    let proposalsCount = 0;
    for (const item of response.syntheses) {
      if (!candidatePaths.includes(item.targetNotePath)) continue;
      const targetId = await lookupNoteByPath(this.options.db, item.targetNotePath);
      if (targetId === null) continue;

      const created = await relateEdge(this.options.db, {
        table: "synthesizes",
        from: noteId,
        to: targetId,
        source: "synthesizer",
        confidenceClass: "INFERRED",
        confidence: 0.8,
        agent: "synthesizer",
        approved: false,
      });

      if (!created) continue;

      context.bus.emit({
        type: "swarm:link_proposed",
        edgeId: `synthesizes:${noteId.toString()}:${targetId.toString()}`,
        sourceId: noteId.toString(),
        targetId: targetId.toString(),
        edgeType: "synthesizes",
        confidence: 0.8,
        runId: context.runId,
      });

      proposalsCount++;
    }

    return { proposals: proposalsCount };
  }

  private async fetchActiveChunks(noteId: RecordId<"note">): Promise<ChunkRow[]> {
    const result: unknown = await this.options.db
      .query("SELECT vector FROM chunk WHERE note = $note AND vector != NONE;", {
        note: noteId,
      })
      .collect();
    return readSingleStatementRows(result, "synthesizer chunks").map(parseChunkRow);
  }
}

function parseChunkRow(raw: unknown): ChunkRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("synthesizer storage integrity: chunk row is not an object");
  }
  const vector = (raw as Record<string, unknown>).vector;
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("synthesizer storage integrity: chunk vector is invalid");
  }
  return { vector };
}

function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}
