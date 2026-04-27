/**
 * Wires the five existing tool packages (notes, vault, proposals, agents,
 * graph) into a single populated ToolRegistry. Phase C does not add tools;
 * it just constructs a registry from the substrate's existing factories.
 *
 * Bootstrap calls this once at startup with the live substrate dependencies
 * and registers the result in the kernel under `toolRegistry`.
 */

import type { ContradictionHunter } from "../core/agents/contradictionHunter";
import type { Synthesizer } from "../core/agents/synthesizer";
import type { ApprovalGate } from "../core/chat/approvalGate";
import { makeContradictionCheckTool, makeSynthesizeTool } from "../core/chat/tools/agents";
import {
  type ClusterCache,
  makeFindPathTool,
  makeListClustersTool,
} from "../core/chat/tools/graph";
import {
  type NotesFacade,
  type NotesHistoryRecord,
  makeAppendNoteTool,
  makeCreateNoteTool,
  makeReplaceSectionTool,
  makeUpdateFrontmatterTool,
} from "../core/chat/tools/notes";
import { makeGetProposalTool, makeListProposalsTool } from "../core/chat/tools/proposals";
import { ToolRegistry } from "../core/chat/tools/registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "../core/chat/tools/vault";
import type { ApprovalMode } from "../core/chat/types";
import type { Database } from "../core/db/database";
import type { SearchPipeline } from "../core/search/searchPipeline";
import type { VitalsService } from "../core/vitals/vitalsService";

export interface AgentToolDeps {
  database: Database;
  searchPipeline: SearchPipeline;
  vitalsService: VitalsService;
  vaultFacade: VaultFacade;
  notesFacade: NotesFacade;
  approvalGate: ApprovalGate;
  echoGuard: { mark: (path: string, sha: string) => void };
  hash: (content: string) => Promise<string>;
  approvalMode: () => ApprovalMode;
  recordHistory: (record: NotesHistoryRecord) => Promise<number>;
  generateCallId: () => string;
  contradictionHunter: ContradictionHunter;
  synthesizer: Synthesizer;
  clusterCache: ClusterCache | null;
}

export function buildAgentToolRegistry(deps: AgentToolDeps): ToolRegistry {
  const registry = new ToolRegistry();

  // vault.* (read-only)
  registry.register(makeVaultSearchTool(deps.searchPipeline));
  registry.register(makeReadNoteTool(deps.vaultFacade));
  registry.register(makeListNeighborsTool(deps.database));
  registry.register(makeGetVitalsTool(deps.vitalsService));

  // notes.* (write-gated)
  const notesContext = {
    facade: deps.notesFacade,
    approvalGate: deps.approvalGate,
    echoGuard: deps.echoGuard,
    hash: deps.hash,
    approvalMode: deps.approvalMode,
    recordHistory: deps.recordHistory,
    generateCallId: deps.generateCallId,
  };
  registry.register(makeCreateNoteTool(notesContext));
  registry.register(makeAppendNoteTool(notesContext));
  registry.register(makeReplaceSectionTool(notesContext));
  registry.register(makeUpdateFrontmatterTool(notesContext));

  // proposals.* (read-only)
  registry.register(makeListProposalsTool(deps.database));
  registry.register(makeGetProposalTool(deps.database));

  // graph.* (read-only)
  registry.register(makeFindPathTool(deps.database));
  registry.register(makeListClustersTool(deps.clusterCache));

  // agents.* (trigger background subagents)
  registry.register(
    makeContradictionCheckTool({
      db: deps.database,
      hunter: deps.contradictionHunter,
    }),
  );
  registry.register(
    makeSynthesizeTool({
      db: deps.database,
      synthesizer: deps.synthesizer,
    }),
  );

  return registry;
}
