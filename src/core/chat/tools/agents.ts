/**
 * Phase 5 Locked Decision 11: the Synthesizer and ContradictionHunter agents
 * were stripped from production wiring in Task 6 because both read from
 * frozen-empty SQLite state since Phase 3. Bootstrap registers no-op
 * `Agent`-shaped placeholders for the Coordinator dispatch loop; this file
 * mirrors that decision on the chat-tool surface.
 *
 * The two tools (`agents.contradiction_check` and `agents.synthesize`)
 * remain registered so the LLM tool catalog and the chat-surface contract
 * stay stable. Each tool now returns `{ proposalsCount: 0, newProposals: [] }`
 * with a rationale string surfaced to the model. A future feature task can
 * re-wire the agents onto the SurrealDB substrate without a chat-surface
 * breaking change.
 */

import type { Agent, AgentTrigger } from "../../coordinator/types";
import type { EventBus } from "../../events/eventBus";
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

const DISABLED_NOTICE =
  "agent currently disabled (Phase 5 Locked Decision 11); a future task will re-wire the SurrealDB substrate";

/**
 * Phase 5 Locked Decision 11 no-op. The hunter parameter is accepted so the
 * bootstrap call site can pass the same `Agent`-shaped placeholder it gives
 * the Coordinator; the run is intentionally skipped because the production
 * agent reports `{ proposals: 0 }` regardless.
 */
export function makeContradictionCheckTool(deps: {
  hunter: Agent;
  bus: EventBus;
  trigger?: AgentTrigger;
}): ToolDefinition<AgentsContradictionCheckArgs, AgentsContradictionCheckResult> {
  // Reference deps so the parameter is not flagged unused; we keep the deps
  // shape stable so Task 7 can swap in a real implementation without a
  // toolBundle signature change.
  void deps;
  return {
    name: "agents.contradiction_check",
    description: `Run the Contradiction Hunter scoped to one note. ${DISABLED_NOTICE}.`,
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
    invoke: async () => ({ proposalsCount: 0, newProposals: [] }),
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

/**
 * Phase 5 Locked Decision 11 no-op. See `makeContradictionCheckTool` above.
 */
export function makeSynthesizeTool(deps: {
  synthesizer: Agent;
  bus: EventBus;
  trigger?: AgentTrigger;
}): ToolDefinition<AgentsSynthesizeArgs, AgentsSynthesizeResult> {
  void deps;
  return {
    name: "agents.synthesize",
    description: `Run the Synthesizer on demand. ${DISABLED_NOTICE}.`,
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
    invoke: async () => ({ proposalsCount: 0, newProposals: [] }),
    writeGated: false,
  };
}
