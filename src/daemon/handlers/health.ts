import type { HealthMonitor } from "../../core/services/healthMonitor";
import { type MethodHandler, encodeEvent } from "../rpc";

export interface HealthHandlerDeps {
  health: HealthMonitor;
}

export function makeHealthHandler(deps: HealthHandlerDeps): MethodHandler {
  return async ({ emit, requestId }) => {
    const endpoints = deps.health.current();
    const tick = {
      type: "health:tick" as const,
      endpoints,
    };
    emit(encodeEvent(requestId, "health:tick", tick as unknown as Record<string, unknown>));
    return { ok: true, endpoints };
  };
}
