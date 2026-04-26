/**
 * Tool-mode probe. Determines whether the active chat model supports the
 * OpenAI-compatible `tools` parameter natively. Probes once per model id and
 * caches the result via a settings setter passed in by the caller.
 *
 * Cache key is the EXACT model id (case-sensitive, including any quantization
 * suffix such as `Q4_K_M`). The Phase 4 PRIMARY model
 * `Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M` is expected to probe as `native`.
 *
 * Per-model-family behaviour reference (forward-looking guidance for users
 * who later swap models in settings; only the two PRIMARY entries ship):
 *
 *   Nemotron-Cascade-2-30B-A3B-i1-Q4_K_M  -> native (Phase 4 PRIMARY chat model)
 *   nomic-embed-text-v2-moe                -> embedding-only (Phase 4 PRIMARY)
 *   llama-3.{1,3}-instruct                 -> native
 *   qwen2.5-{coder,instruct}                -> native
 *   deepseek-r1 distills, qwq-32b           -> json-fallback
 *   gpt-oss-20b/120b                        -> native
 *   unknown                                 -> probe and cache
 *
 * Hardening: if the first probe attempt classifies as `disabled`, the probe
 * retries once with a 60s timeout before persisting `disabled`. Llama-server
 * cold-load can take longer than the default fetch timeout, so a transient
 * failure should not poison the cache.
 */

import type { LLMProvider } from "../llm/provider";

export type ToolMode = "native" | "json-fallback" | "disabled";

export interface ToolModeCache {
  read: (model: string) => ToolMode | null;
  write: (model: string, mode: ToolMode) => Promise<void>;
}

export interface ToolModeProbeOptions {
  provider: LLMProvider;
  model: string;
  signal: AbortSignal;
  cache: ToolModeCache;
  /**
   * Override the retry timeout in milliseconds. Defaults to 60_000.
   * Tests can lower this to keep the suite fast.
   */
  retryTimeoutMs?: number;
}

const PROBE_TOOL = {
  type: "function" as const,
  function: {
    name: "echo",
    description: "Returns the input string. Probe-only, ignored after detection.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
};

const PROBE_PROMPT = "Call the echo tool with value=ping.";

export async function probeToolMode(options: ToolModeProbeOptions): Promise<ToolMode> {
  const cached = options.cache.read(options.model);
  if (cached) return cached;
  const first = await runProbe(options, options.signal);
  if (first !== "disabled") {
    await options.cache.write(options.model, first);
    return first;
  }
  // Retry once with a longer fuse before locking in `disabled`.
  if (options.signal.aborted) {
    throw asAbortError();
  }
  const retryMs = options.retryTimeoutMs ?? 60_000;
  const retryController = new AbortController();
  const timeout = setTimeout(() => retryController.abort(), retryMs);
  const onParentAbort = (): void => retryController.abort();
  options.signal.addEventListener("abort", onParentAbort, { once: true });
  let retryResult: ToolMode = "disabled";
  try {
    retryResult = await runProbe(options, retryController.signal);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onParentAbort);
  }
  await options.cache.write(options.model, retryResult);
  return retryResult;
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function runProbe(options: ToolModeProbeOptions, signal: AbortSignal): Promise<ToolMode> {
  if (!options.provider.chatWithTools) return "disabled";
  const chatWithTools = options.provider.chatWithTools.bind(options.provider);
  try {
    const handle = await chatWithTools({
      model: options.model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      tools: [PROBE_TOOL],
      toolChoice: "required",
      signal,
      maxTokens: 256,
    });
    for await (const _event of handle.events) {
      // Drain stream so the aggregator collects the final state.
    }
    const result = await handle.result();
    if (result.toolCalls.length > 0) return "native";
    if (tryParseToolJson(result.content)) return "json-fallback";
    return "disabled";
  } catch (error) {
    if (isAbortError(error)) throw error;
    return "disabled";
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return false;
}

export interface ParsedToolJson {
  tool: string;
  args: Record<string, unknown>;
}

export function tryParseToolJson(content: string): ParsedToolJson | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  const stripped = stripJsonFences(trimmed);
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const tool = obj.tool;
    if (typeof tool !== "string" || tool.length === 0) return null;
    const args = obj.args;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return { tool, args: args as Record<string, unknown> };
    }
    return { tool, args: {} };
  } catch {
    return null;
  }
}

function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text;
}
