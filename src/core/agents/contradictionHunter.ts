import type { RecordId, Surreal } from "surrealdb";
import type { Agent, AgentRunContext, AgentRunResult } from "../coordinator/types";
import { lookupNoteByPath, relateEdge } from "../db/surreal";
import type { LLMProvider } from "../llm/provider";
import { deletePendingProposals } from "./pendingProposals";

export interface ContradictionHunterOptions {
  db: Surreal;
  provider: LLMProvider;
  reasoningModel: string;
  maxClaims?: number;
}

export interface ContradictionJsonResponse {
  contradictions: Array<{
    sourceNotePath: string;
    targetNotePath: string;
    evidence: string;
  }>;
}

const SCHEMA = {
  name: "ContradictionProposals",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["contradictions"],
    properties: {
      contradictions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceNotePath", "targetNotePath", "evidence"],
          properties: {
            sourceNotePath: { type: "string" },
            targetNotePath: { type: "string" },
            evidence: { type: "string" },
          },
        },
      },
    },
  },
};

interface ClaimRow {
  note_path: string;
  claim_text: string;
}

export class ContradictionHunter implements Agent {
  readonly name = "contradictionHunter" as const;
  readonly usesReasoningModel = true;

  constructor(private readonly options: ContradictionHunterOptions) {}

  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const maxClaims = this.options.maxClaims ?? 20;
    const claims = await this.fetchRecentClaims(maxClaims);
    if (claims.length < 2) return { proposals: 0 };

    // This agent scans the whole claim set rather than one active note, so the
    // sweep is vault-wide too.
    await deletePendingProposals(this.options.db, {
      tables: ["contradicts"],
      agent: "contradictionHunter",
    });

    const prompt = [
      "Extracted Claims Across Notes:",
      ...claims.map((c) => `- Note [${c.note_path}]: "${c.claim_text}"`),
      "",
      "Identify pairs of notes with opposing or contradictory claims.",
      "Only return genuine contradictions where claims directly conflict.",
    ].join("\n");

    const response = await this.options.provider.chatJson<ContradictionJsonResponse>(
      [{ role: "user", content: prompt }],
      { model: this.options.reasoningModel, signal: context.signal, enableThinking: false },
      SCHEMA,
    );

    let proposalsCount = 0;
    for (const item of response.contradictions) {
      if (item.sourceNotePath === item.targetNotePath) continue;
      const sourceId = await lookupNoteByPath(this.options.db, item.sourceNotePath);
      const targetId = await lookupNoteByPath(this.options.db, item.targetNotePath);
      if (sourceId === null || targetId === null) continue;

      const created = await relateEdge(this.options.db, {
        table: "contradicts",
        from: sourceId,
        to: targetId,
        source: "contradictionHunter",
        confidenceClass: "INFERRED",
        confidence: 0.85,
        agent: "contradictionHunter",
        approved: false,
      });

      if (!created) continue;

      context.bus.emit({
        type: "swarm:contradiction_discovered",
        pair: [sourceId.toString(), targetId.toString()],
        severity: 0.85,
        notePaths: [item.sourceNotePath, item.targetNotePath],
        runId: context.runId,
      });

      proposalsCount++;
    }

    return { proposals: proposalsCount };
  }

  private async fetchRecentClaims(limit: number): Promise<ClaimRow[]> {
    const result: unknown = await this.options.db
      .query(
        // `created_at` is projected because SurrealDB requires the ORDER BY
        // idiom to appear in the selection. Block-anchored assertions are not
        // note-to-note contradiction candidates.
        "SELECT in.path AS note_path, out.text AS claim_text, created_at FROM asserts WHERE in.path != NONE ORDER BY created_at DESC LIMIT $limit;",
        { limit },
      )
      .collect();
    return readSingleStatementRows(result, "contradiction claims").map(parseClaimRow);
  }
}

function parseClaimRow(raw: unknown): ClaimRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("contradiction storage integrity: claim row is not an object");
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.note_path !== "string" ||
    row.note_path.trim().length === 0 ||
    typeof row.claim_text !== "string" ||
    row.claim_text.trim().length === 0
  ) {
    throw new Error("contradiction storage integrity: claim row is invalid");
  }
  return { note_path: row.note_path, claim_text: row.claim_text };
}

function readSingleStatementRows(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(raw[0])) {
    throw new Error(`${label} storage integrity: invalid statement envelope`);
  }
  return raw[0];
}
