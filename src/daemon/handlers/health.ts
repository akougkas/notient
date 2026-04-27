import type { HealthMonitor } from "../../core/services/healthMonitor";
import { encodeEvent } from "../rpc";

export interface HealthHandlerDeps {
  health: HealthMonitor;
  bridgeUp: () => boolean;
}

export function makeHealthHandler(deps: HealthHandlerDeps) {
  return async (
    _params: Record<string, unknown>,
    emit: (line: string) => void,
    envelopeId: string,
  ): Promise<Record<string, unknown>> => {
    const endpoints = deps.health.current();
    const bridge = deps.bridgeUp();
    const tick = {
      type: "health:tick" as const,
      endpoints,
      bridge,
    };
    emit(encodeEvent(envelopeId, "health:tick", tick as unknown as Record<string, unknown>));
    return { ok: true, endpoints, bridge };
  };
}
