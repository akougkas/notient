import type { StartupProbeEvent, StartupProbeStatus } from "../events/types";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StartupProbeInput {
  readonly endpoint: string;
  readonly modelId: string;
  readonly configuredContextTokens: number;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: FetchLike;
  /** Wall-clock cap for the probe; default 2000ms. */
  readonly timeoutMs?: number;
}

interface RawModel {
  readonly id?: unknown;
  readonly state?: unknown;
  readonly loaded_context_length?: unknown;
}

/**
 * Hit the LM Studio native API to discover the actually-loaded context
 * window for a given model and report whether the persisted context budget
 * exceeds it. Designed to run fire-and-forget at daemon boot, so it must:
 *   • never throw; every failure resolves to a structured event.
 *   • bound network time via AbortController (default 2s).
 *   • return enough detail for the caller to log a useful warning.
 *
 * Returned message is a single human-readable line ready to surface to a
 * log or system-line transcript.
 */
export async function runStartupProbe(input: StartupProbeInput): Promise<StartupProbeEvent> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 2000;
  const baseUrl = input.endpoint.replace(/\/v1\/?$/, "");
  const url = `${baseUrl}/api/v0/models`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return buildEvent(input, null, "endpoint-unreachable", `HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: ReadonlyArray<RawModel> };
    const match = (body.data ?? []).find((m) => m?.id === input.modelId);
    if (match === undefined) {
      return buildEvent(input, null, "model-not-loaded", "model id not present in /api/v0/models");
    }
    if (match.state !== "loaded") {
      return buildEvent(input, null, "model-not-loaded", `model state is ${String(match.state)}`);
    }
    const loaded =
      typeof match.loaded_context_length === "number" ? match.loaded_context_length : null;
    if (loaded === null) {
      return buildEvent(input, null, "model-not-loaded", "loaded_context_length missing");
    }
    if (input.configuredContextTokens > loaded) {
      return buildEvent(
        input,
        loaded,
        "loaded-too-small",
        `configured ${input.configuredContextTokens.toLocaleString()} > loaded ${loaded.toLocaleString()}; reduce chat.modelContextTokens or load a larger window`,
      );
    }
    return buildEvent(input, loaded, "ok", "context budget within loaded window");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return buildEvent(input, null, "endpoint-unreachable", reason);
  } finally {
    clearTimeout(timer);
  }
}

function buildEvent(
  input: StartupProbeInput,
  loaded: number | null,
  status: StartupProbeStatus,
  message: string,
): StartupProbeEvent {
  return {
    endpoint: input.endpoint,
    modelId: input.modelId,
    configuredContextTokens: input.configuredContextTokens,
    loadedContextLength: loaded,
    status,
    message,
  };
}
