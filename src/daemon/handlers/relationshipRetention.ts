import { operationInputs } from "../../api/operations";
import { relationshipRetentionResultSchema } from "../../api/relationshipRetention";
import { NoteReadService } from "../../api/notes";
import { NoteApiError } from "../../api/schema";
import type { Surreal } from "surrealdb";
import type { ApprovalService } from "../../core/approvals/approvalService";
import { stageRelationshipRetention } from "../../core/approvals/relationshipRetention";
import type { GraphService } from "../../core/graph/graphService";
import type { ChangeService } from "../../core/history/changeService";
import type { VaultAdapter } from "../../adapters/vaultAdapter";
import type { SettingsService } from "../../core/settings/settingsService";
import { RpcError, type RpcRequestContext } from "../rpc";

export function makeRelationshipRetentionHandler(deps: {
  db: Surreal;
  graph: Pick<GraphService, "neighbors">;
  vault: VaultAdapter;
  changes: ChangeService;
  approvals: Pick<ApprovalService, "submitReview">;
  settings: SettingsService;
}) {
  const notes = new NoteReadService(deps.vault);
  return async (context: RpcRequestContext) => {
    const { principal, params, signal } = context;
    if (!principal.scopes.includes("read") || !principal.scopes.includes("write"))
      throw new RpcError("FORBIDDEN", "relationship retention requires read and write scopes");
    const parsed = operationInputs["relationships.retain"].safeParse(params);
    if (!parsed.success) throw new RpcError("INVALID_PARAMS", parsed.error.message);
    try {
      await deps.settings.refreshBackground();
      const section =
        deps.settings.background().settings.pipelines.reconsider.allowedSections[0] ??
        "Notient understanding";
      return relationshipRetentionResultSchema.parse(
        await stageRelationshipRetention(
          {
            db: deps.db,
            graph: deps.graph,
            notes,
            changes: deps.changes,
            approvals: deps.approvals,
          },
          parsed.data,
          principal,
          section,
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof NoteApiError) throw new RpcError(error.code, error.message);
      if (error instanceof Error && error.name === "ZodError")
        throw new RpcError("INVALID_PARAMS", error.message);
      if (error instanceof Error && error.name === "EditedIntelligenceRecordError")
        throw new RpcError("CONFLICT", error.message);
      throw error;
    }
  };
}
