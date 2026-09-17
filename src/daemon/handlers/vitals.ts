import { type VaultAdapter, VaultPathError } from "../../adapters/vaultAdapter";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import type { VitalsService } from "../../core/vitals/vitalsService";
import { type MethodHandler, RpcError, encodeEvent } from "../rpc";

export interface VitalsHandlerDeps {
  vitalsService: VitalsService;
  vault: Pick<VaultAdapter, "exists">;
}

/**
 * `vitals.get` is a pure read: it computes a snapshot and returns it.
 *
 * Persisting a snapshot (the note-row UPDATE plus the optional
 * `vitals.writeToFrontmatter` write-back) lives in
 * `VitalsService.persistSnapshot`, which only the indexer/coordinator path
 * calls. Keep it that way — a `read`-scoped method must not touch disk.
 */
export function makeVitalsHandler(deps: VitalsHandlerDeps): MethodHandler {
  return async ({ params, emit, requestId }) => {
    const path = typeof params.path === "string" ? params.path : "";
    if (!isCanonicalOrdinaryNotePath(path)) {
      throw new RpcError(
        "INVALID_PARAMS",
        "path must be an exact ordinary public vault-relative Markdown note path",
      );
    }
    let exists: boolean;
    try {
      exists = await deps.vault.exists(path);
    } catch (error) {
      if (error instanceof VaultPathError) {
        throw new RpcError("INVALID_PARAMS", `note is not accessible: ${path}`);
      }
      throw error;
    }
    if (!exists) {
      throw new RpcError("INVALID_PARAMS", `note is not accessible: ${path}`);
    }
    const snapshot = await deps.vitalsService.computeSnapshot(path);
    if (!snapshot) {
      throw new RpcError("INVALID_PARAMS", `note not indexed: ${path}`);
    }
    emit(encodeEvent(requestId, "vitals:snapshot", snapshot as unknown as Record<string, unknown>));
    return { ok: true, snapshot };
  };
}
