/**
 * Wires the existing tool packages (notes, vault, proposals, graph) into a
 * single populated ToolRegistry from the substrate's existing factories.
 *
 * Bootstrap calls this once at startup with the live substrate dependencies
 * and registers the result in the kernel under `toolRegistry`.
 */

import type { Surreal } from "surrealdb";
import type { NoteAnalysis } from "../core/analysis/noteAnalysis";
import type { ApprovalService } from "../core/approvals/approvalService";
import type { ApprovalGate } from "../core/chat/approvalGate";
import { makeAnalysisTools } from "../core/chat/tools/analysis";
import { type ChangeToolsContext, makeChangeTools } from "../core/chat/tools/changes";
import { makePrepareDraftTool } from "../core/chat/tools/draft";
import { makeFindPathTool } from "../core/chat/tools/graph";
import {
  type NotesFacade,
  type NotesToolsContext,
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
import type { GraphService } from "../core/graph/graphService";
import type { SearchPipeline } from "../core/search/searchPipeline";
import type { VitalsService } from "../core/vitals/vitalsService";

export interface AgentToolDeps {
  analysis: NoteAnalysis;
  /** Proposal inspection reads the canonical writeback tables. */
  db: Surreal;
  /** Revision-checked connections and routes shared with external clients. */
  graph: GraphService;
  searchPipeline: SearchPipeline;
  vitalsService: VitalsService;
  vaultFacade: VaultFacade;
  notesFacade: NotesFacade;
  approvalGate: ApprovalGate;
  /**
   * SurrealDB-backed approval service. Powers the write-gated
   * `proposals.approve` and `proposals.reject` chat tools. Production shares
   * the same instance the daemon uses for the boot-time
   * reconcileLinkerWritebacks call.
   */
  approvalService: ApprovalService;
  /** Canonical exact previews; the assistant plans and submits, never applies. */
  changes: ChangeToolsContext["changes"];
  authorizeIdentity: ChangeToolsContext["authorizeIdentity"];
  hash: (content: string) => Promise<string>;
  approvalMode: () => ApprovalMode;
  applyWrite: NotesToolsContext["applyWrite"];
  generateCallId: () => string;
}

export function buildAgentToolRegistry(deps: AgentToolDeps): ToolRegistry {
  const registry = new ToolRegistry();

  // vault.* (read-only)
  registry.register(makeVaultSearchTool(deps.searchPipeline));
  registry.register(makeReadNoteTool(deps.vaultFacade));
  registry.register(makeListNeighborsTool(deps.graph));
  registry.register(makeGetVitalsTool(deps.vitalsService));
  registry.register(makePrepareDraftTool());
  for (const tool of makeAnalysisTools(deps.analysis)) registry.register(tool);

  // notes.* (write-gated)
  const notesContext = {
    facade: deps.notesFacade,
    approvalGate: deps.approvalGate,
    hash: deps.hash,
    approvalMode: deps.approvalMode,
    applyWrite: deps.applyWrite,
    generateCallId: deps.generateCallId,
  };
  registry.register(makeCreateNoteTool(notesContext));
  registry.register(makeAppendNoteTool(notesContext));
  registry.register(makeReplaceSectionTool(notesContext));
  registry.register(makeUpdateFrontmatterTool(notesContext));

  // changes.* (stored preview + request for the human's review; no effects)
  const [previewChanges, submitChange] = makeChangeTools({
    changes: deps.changes,
    approvalService: deps.approvalService,
    authorizeIdentity: deps.authorizeIdentity,
  });
  registry.register(previewChanges);
  registry.register(submitChange);

  // proposals.* (read-only list/get + write-gated approve/reject)
  registry.register(makeListProposalsTool(deps.db));
  registry.register(makeGetProposalTool(deps.db));
  const proposalsWriteContext = {
    approvalService: deps.approvalService,
    approvalGate: deps.approvalGate,
    approvalMode: deps.approvalMode,
    generateCallId: deps.generateCallId,
  };
  registry.register(makeApproveProposalTool(proposalsWriteContext));
  registry.register(makeRejectProposalTool(proposalsWriteContext));

  // graph.* (read-only)
  registry.register(makeFindPathTool(deps.graph));

  return registry;
}
