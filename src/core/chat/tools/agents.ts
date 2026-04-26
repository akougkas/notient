import type { ContradictionHunter } from "../../agents/contradictionHunter";
import type { Synthesizer } from "../../agents/synthesizer";
import type { AgentTrigger } from "../../coordinator/types";
import type { Database } from "../../db/database";
import { type ToolDefinition, isObject, optionalStringArray, requireString } from "./registry";

export interface AgentsContradictionCheckArgs {
  notePath: string;
}

export interface ProposedContradiction {
  id: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  rationale: string | null;
  evidence: string[];
}

export interface AgentsContradictionCheckResult {
  proposalsCount: number;
  newProposals: ProposedContradiction[];
}

interface StagingEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  confidence: number;
  rationale: string | null;
  evidence: string;
  created_at: number;
}

/**
 * Triggers a single ContradictionHunter run scoped to one note. The existing
 * agent writes any pairs it finds to `staging_edges`; this tool surfaces the
 * just-staged rows so the chat UI can render them as proposals. Acceptance is
 * still gated by ApprovalService, so the chat surface never auto-promotes.
 */
export function makeContradictionCheckTool(deps: {
  db: Database;
  hunter: ContradictionHunter;
  trigger?: AgentTrigger;
}): ToolDefinition<AgentsContradictionCheckArgs, AgentsContradictionCheckResult> {
  return {
    name: "agents.contradiction_check",
    description:
      "Run the Contradiction Hunter scoped to one note. Newly proposed contradicts edges are returned and also staged for approval.",
    schema: {
      type: "object",
      properties: {
        notePath: { type: "string", description: "Vault-relative path of the note to inspect." },
      },
      required: ["notePath"],
    },
    validate: (raw) => {
      if (!isObject(raw)) throw new Error("expected object");
      const notePath = requireString(raw.notePath, "notePath");
      return { notePath };
    },
    invoke: async (args, signal) => {
      const before = readStagedIds(deps.db, "contradictionHunter");
      const result = await deps.hunter.run({
        trigger: deps.trigger ?? "user-action",
        notePath: args.notePath,
        signal,
      });
      const newProposals = readNewProposals(deps.db, "contradictionHunter", before);
      return { proposalsCount: result.proposals, newProposals };
    },
    writeGated: false,
  };
}

export interface AgentsSynthesizeArgs {
  /** When omitted the Synthesizer runs across all eligible notes. */
  notePaths?: string[];
}

export interface ProposedSynthesis {
  id: string;
  label: string;
  confidence: number;
  memberPaths: string[];
  body: string;
  targetPath: string | null;
}

export interface AgentsSynthesizeResult {
  proposalsCount: number;
  newProposals: ProposedSynthesis[];
}

interface StagingNodeRow {
  id: string;
  label: string;
  payload: string | null;
  confidence: number;
  created_at: number;
}

/**
 * Triggers a single Synthesizer run. The Synthesizer clusters notes
 * internally and writes one staging_nodes row per accepted draft. The
 * `notePaths` argument is informational; it is forwarded as the trigger
 * hint, and this tool surfaces the just-staged rows for the chat UI.
 */
export function makeSynthesizeTool(deps: {
  db: Database;
  synthesizer: Synthesizer;
  trigger?: AgentTrigger;
}): ToolDefinition<AgentsSynthesizeArgs, AgentsSynthesizeResult> {
  return {
    name: "agents.synthesize",
    description:
      "Run the Synthesizer on demand. Drafts are staged for approval; their bodies are returned to the chat.",
    schema: {
      type: "object",
      properties: {
        notePaths: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of focal notes the synthesizer should consider.",
        },
      },
      required: [],
    },
    validate: (raw) => {
      if (raw === undefined || raw === null) return {};
      if (!isObject(raw)) throw new Error("expected object");
      const notePaths = optionalStringArray(raw.notePaths, "notePaths");
      return { notePaths };
    },
    invoke: async (_args, signal) => {
      const before = readStagedNodeIds(deps.db, "synthesizer");
      const result = await deps.synthesizer.run({
        trigger: deps.trigger ?? "user-action",
        notePath: null,
        signal,
      });
      const newProposals = readNewSynthesisNodes(deps.db, "synthesizer", before);
      return { proposalsCount: result.proposals, newProposals };
    },
    writeGated: false,
  };
}

function readStagedIds(db: Database, agent: string): Set<string> {
  const rows = db.query<{ id: string }>("SELECT id FROM staging_edges WHERE agent = ?;", [agent]);
  return new Set(rows.map((r) => r.id));
}

function readStagedNodeIds(db: Database, agent: string): Set<string> {
  const rows = db.query<{ id: string }>("SELECT id FROM staging_nodes WHERE agent = ?;", [agent]);
  return new Set(rows.map((r) => r.id));
}

function readNewProposals(
  db: Database,
  agent: string,
  before: Set<string>,
): ProposedContradiction[] {
  const rows = db.query<StagingEdgeRow>(
    `SELECT id, source_id, target_id, confidence, rationale, evidence, created_at
     FROM staging_edges WHERE agent = ? ORDER BY created_at DESC;`,
    [agent],
  );
  const fresh = rows.filter((row) => !before.has(row.id));
  return fresh.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    confidence: row.confidence,
    rationale: row.rationale,
    evidence: parseEvidence(row.evidence),
  }));
}

function readNewSynthesisNodes(
  db: Database,
  agent: string,
  before: Set<string>,
): ProposedSynthesis[] {
  const rows = db.query<StagingNodeRow>(
    `SELECT id, label, payload, confidence, created_at FROM staging_nodes
     WHERE agent = ? ORDER BY created_at DESC;`,
    [agent],
  );
  const fresh = rows.filter((row) => !before.has(row.id));
  return fresh.map((row) => {
    const parsed = parsePayload(row.payload);
    return {
      id: row.id,
      label: row.label,
      confidence: row.confidence,
      memberPaths: Array.isArray(parsed.memberPaths) ? parsed.memberPaths : [],
      body: typeof parsed.body === "string" ? parsed.body : "",
      targetPath: typeof parsed.targetPath === "string" ? parsed.targetPath : null,
    };
  });
}

function parseEvidence(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

function parsePayload(raw: string | null): {
  body?: unknown;
  memberPaths?: unknown;
  targetPath?: unknown;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
