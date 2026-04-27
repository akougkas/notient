import type { VitalsService } from "../../core/vitals/vitalsService";
import { encodeEvent } from "../rpc";

export interface VitalsHandlerDeps {
  vitalsService: VitalsService;
}

export function makeVitalsHandler(deps: VitalsHandlerDeps) {
  return async (
    params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const path = typeof params.path === "string" ? params.path : "";
    if (path.trim().length === 0) {
      throw new Error("INVALID_PARAMS: path is required");
    }
    const snapshot = deps.vitalsService.computeSnapshot(path);
    if (!snapshot) {
      throw new Error(`INVALID_PARAMS: note not indexed: ${path}`);
    }
    emit(
      encodeEvent(envelopeId, "vitals:snapshot", snapshot as unknown as Record<string, unknown>),
    );
    return { ok: true, snapshot };
  };
}
