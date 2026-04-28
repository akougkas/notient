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
 * Hardening (Phase D, locked decision 11):
 * - First probe attempt runs at temperature 0.3.
 * - If the first attempt returns no tool calls (and no JSON fallback), the
 *   probe retries once at temperature 0.7 with a 60s timeout fuse. The
 *   temperature lift is the cold-start mitigation for tool-capable models
 *   that miss the first probe under low-temperature greedy decoding.
 * - A returned tool call whose required arg (`value`) is missing or empty
 *   counts as malformed and downgrades the classification away from
 *   `native`. The probe never persists `native` on the strength of an
 *   unparseable response.
 * - Every terminal classification emits `loop:tool_mode_probed` on the bus
 *   so operators can see retry counts on the wire.
 * - AbortError propagates without writing the cache.
 */

import type { EventBus } from "../events/eventBus";
import type { ToolModeProbedEvent } from "../events/types";
import type { ChatWithToolsToolCall, LLMProvider } from "../llm/provider";

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
  /**
   * Optional event bus. When provided the probe emits
   * `loop:tool_mode_probed` on every terminal classification.
   */
  bus?: EventBus;
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
const FIRST_ATTEMPT_TEMPERATURE = 0.3;
const RETRY_ATTEMPT_TEMPERATURE = 0.7;

type ProbeStatus = "native" | "json-fallback" | "no-calls" | "errored";

export async function probeToolMode(options: ToolModeProbeOptions): Promise<ToolMode> {
  const cached = options.cache.read(options.model);
  if (cached) return cached;
  const first = await runProbe(options, options.signal, FIRST_ATTEMPT_TEMPERATURE);
  if (first === "native") {
    return await finalize(options, "native", 1);
  }
  if (first === "json-fallback") {
    return await finalize(options, "json-fallback", 1);
  }
  if (first === "errored") {
    return await finalize(options, "disabled", 1);
  }
  // first === "no-calls": retry once at higher temperature with timeout fuse.
  if (options.signal.aborted) {
    throw asAbortError();
  }
  const retryMs = options.retryTimeoutMs ?? 60_000;
  const retryController = new AbortController();
  const timeout = setTimeout(() => retryController.abort(), retryMs);
  const onParentAbort = (): void => retryController.abort();
  options.signal.addEventListener("abort", onParentAbort, { once: true });
  let retry: ProbeStatus;
  try {
    retry = await runProbe(options, retryController.signal, RETRY_ATTEMPT_TEMPERATURE);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onParentAbort);
  }
  if (retry === "native") {
    return await finalize(options, "native", 2);
  }
  if (retry === "json-fallback") {
    return await finalize(options, "json-fallback", 2);
  }
  return await finalize(options, "disabled", 2);
}

async function finalize(
  options: ToolModeProbeOptions,
  mode: ToolMode,
  attempts: number,
): Promise<ToolMode> {
  await options.cache.write(options.model, mode);
  const event: { type: "loop:tool_mode_probed" } & ToolModeProbedEvent = {
    type: "loop:tool_mode_probed",
    model: options.model,
    mode,
    attempts,
  };
  options.bus?.emit(event);
  return mode;
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function runProbe(
  options: ToolModeProbeOptions,
  signal: AbortSignal,
  temperature: number,
): Promise<ProbeStatus> {
  if (!options.provider.chatWithTools) return "errored";
  const chatWithTools = options.provider.chatWithTools.bind(options.provider);
  try {
    const handle = await chatWithTools({
      model: options.model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      tools: [PROBE_TOOL],
      // toolChoice "auto" rather than "required": some tool-capable models
      // (Nemotron-Cascade family observed against LM Studio) interpret
      // "required" loosely and degrade to a custom XML tool-call format
      // emitted as reasoning text rather than the OpenAI tool_calls field,
      // which would mis-classify them as `disabled`. The PROBE_PROMPT
      // ("Call the echo tool with value=ping.") is unambiguous enough that
      // a tool-capable model will pick the tool call under "auto".
      toolChoice: "auto",
      signal,
      temperature,
      maxTokens: 256,
    });
    for await (const _event of handle.events) {
      // Drain stream so the aggregator collects the final state.
    }
    const result = await handle.result();
    if (result.toolCalls.length > 0) {
      if (result.toolCalls.every(isToolCallWellFormed)) return "native";
      return "no-calls";
    }
    if (tryParseToolJson(result.content)) return "json-fallback";
    return "no-calls";
  } catch (error) {
    if (isAbortError(error)) throw error;
    return "errored";
  }
}

function isToolCallWellFormed(call: ChatWithToolsToolCall): boolean {
  if (Object.keys(call.args).length === 0) return false;
  const value = call.args.value;
  if (typeof value !== "string" || value.length === 0) return false;
  return true;
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
