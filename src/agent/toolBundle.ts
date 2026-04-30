/**
 * Wires the five existing tool packages (notes, vault, proposals, agents,
 * graph) into a single populated ToolRegistry. Phase C does not add tools;
 * it just constructs a registry from the substrate's existing factories.
 *
 * Bootstrap calls this once at startup with the live substrate dependencies
 * and registers the result in the kernel under `toolRegistry`.
 *
 * Phase 5 Task 7 migrated the four database-bound factories
 * (listNeighbors, listProposals, getProposal, findPath) onto the SurrealDB
 * substrate and the `agents.contradiction_check` / `agents.synthesize` chat
 * tools onto the Locked Decision 11 no-op shells. The toolbundle now
 * accepts an `Agent`-typed placeholder for both swarm agents (matching the
 * shape Bootstrap registers with the Coordinator) so the transitional
 * `as unknown as Synthesizer/ContradictionHunter` casts in bootstrap.ts
 * are retired.
 */

import type { Surreal } from "surrealdb";
import type { ApprovalService } from "../core/approvals/approvalService";
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
import {
  makeApproveProposalTool,
  makeGetProposalTool,
  makeListProposalsTool,
  makeRejectProposalTool,
} from "../core/chat/tools/proposals";
import { ToolRegistry } from "../core/chat/tools/registry";
import {
  type VaultFacade,
  makeGetVitalsTool,
  makeListNeighborsTool,
  makeReadNoteTool,
  makeVaultSearchTool,
} from "../core/chat/tools/vault";
import type { ApprovalMode } from "../core/chat/types";
import type { Agent } from "../core/coordinator/types";
import type { EventBus } from "../core/events/eventBus";
import type { SearchPipeline } from "../core/search/searchPipeline";
import type { VitalsService } from "../core/vitals/vitalsService";

export interface AgentToolDeps {
  /**
   * SurrealDB connection used by the four graph-shape factories
   * (listNeighbors, listProposals, getProposal, findPath). Phase 5 Task 7
   * retired the legacy `database: Database` field; the chat tools now read
   * the SurrealDB writeback edge tables directly.
   */
  db: Surreal;
  searchPipeline: SearchPipeline;
  vitalsService: VitalsService;
  vaultFacade: VaultFacade;
  notesFacade: NotesFacade;
  approvalGate: ApprovalGate;
  /**
   * SurrealDB-backed approval service. Powers the write-gated
   * `proposals.approve` and `proposals.reject` chat tools (M1). Production
   * shares the same instance the daemon uses for the boot-time
   * reconcileLinkerWritebacks call.
   */
  approvalService: ApprovalService;
  hash: (content: string) => Promise<string>;
  approvalMode: () => ApprovalMode;
  recordHistory: (record: NotesHistoryRecord) => Promise<string>;
  generateCallId: () => string;
  /**
   * The Phase 5 Locked Decision 11 no-op `Agent` shells produced by
   * bootstrap. The toolbundle does not call `.run()` on these (the
   * `agents.*` chat tools are themselves no-ops); the field is kept so a
   * future task can re-introduce the SurrealDB-backed implementations
   * without a toolBundle signature change.
   */
  contradictionHunter: Agent;
  synthesizer: Agent;
  clusterCache: ClusterCache | null;
  bus: EventBus;
}

export function buildAgentToolRegistry(deps: AgentToolDeps): ToolRegistry {
  const registry = new ToolRegistry();

  // vault.* (read-only)
  registry.register(makeVaultSearchTool(deps.searchPipeline));
  registry.register(makeReadNoteTool(deps.vaultFacade));
  registry.register(makeListNeighborsTool(deps.db));
  registry.register(makeGetVitalsTool(deps.vitalsService));

  // notes.* (write-gated)
  const notesContext = {
    facade: deps.notesFacade,
    approvalGate: deps.approvalGate,
    hash: deps.hash,
    approvalMode: deps.approvalMode,
    recordHistory: deps.recordHistory,
    generateCallId: deps.generateCallId,
  };
  registry.register(makeCreateNoteTool(notesContext));
  registry.register(makeAppendNoteTool(notesContext));
  registry.register(makeReplaceSectionTool(notesContext));
  registry.register(makeUpdateFrontmatterTool(notesContext));

  // proposals.* (read-only list/get + write-gated approve/reject)
  registry.register(makeListProposalsTool(deps.db));
  registry.register(makeGetProposalTool(deps.db));
  const proposalsWriteContext = {
    db: deps.db,
    approvalService: deps.approvalService,
    approvalGate: deps.approvalGate,
    approvalMode: deps.approvalMode,
    generateCallId: deps.generateCallId,
  };
  registry.register(makeApproveProposalTool(proposalsWriteContext));
  registry.register(makeRejectProposalTool({ ...proposalsWriteContext, bus: deps.bus }));

  // graph.* (read-only)
  registry.register(makeFindPathTool(deps.db));
  registry.register(makeListClustersTool(deps.clusterCache));

  // agents.* (Phase 5 Locked Decision 11 no-op shells)
  registry.register(
    makeContradictionCheckTool({
      hunter: deps.contradictionHunter,
      bus: deps.bus,
    }),
  );
  registry.register(
    makeSynthesizeTool({
      synthesizer: deps.synthesizer,
      bus: deps.bus,
    }),
  );

  return registry;
}
