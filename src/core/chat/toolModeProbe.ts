/** Probe native tool calling with a bounded shared reasoning/answer ceiling.
 * Only completed responses classify capability; outages and truncation never
 * poison learned state. Probe generations share their caller's run budget. */
import { type EventBus, assertEventBus } from "../events/eventBus";
import type { ToolModeProbedEvent } from "../events/types";
import { IncompleteCompletionError } from "../llm/completion";
import type { ChatWithToolsToolCall, LLMProvider } from "../llm/provider";

export type ToolMode = "native" | "disabled";

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
  /** Receives `loop:tool_mode_probed` for every terminal classification. */
  bus: EventBus;
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

type ProbeStatus = "native" | "no-calls";

export async function probeToolMode(options: ToolModeProbeOptions): Promise<ToolMode> {
  assertEventBus(options.bus, "probeToolMode");
  const cached = options.cache.read(options.model);
  if (cached) return cached;
  if (!options.provider.chatWithTools) return finalize(options, "disabled", 0);
  for (const [index, maxTokens] of [4096, 8192].entries()) {
    options.signal.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.retryTimeoutMs ?? 60000);
    const signal = AbortSignal.any([options.signal, controller.signal]);
    try {
      const result = await runProbe(
        options,
        signal,
        index === 0 ? FIRST_ATTEMPT_TEMPERATURE : RETRY_ATTEMPT_TEMPERATURE,
        maxTokens,
      );
      signal.throwIfAborted();
      if (result === "native") return finalize(options, "native", index + 1);
      if (index === 1) return finalize(options, "disabled", 2);
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(
          index === 0 &&
          error instanceof IncompleteCompletionError &&
          error.completion.state === "truncated"
        )
      )
        throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("tool capability could not be established");
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
  options.bus.emit(event);
  return mode;
}

async function runProbe(
  options: ToolModeProbeOptions,
  signal: AbortSignal,
  temperature: number,
  maxTokens: number,
): Promise<ProbeStatus> {
  if (!options.provider.chatWithTools)
    throw new Error("provider has no native tool-call interface");
  const chatWithTools = options.provider.chatWithTools.bind(options.provider);
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
    maxTokens,
  });
  for await (const _event of handle.events) {
    // Drain stream so the aggregator collects the final state.
  }
  const result = await handle.result();
  if (result.toolCalls.length > 0) {
    if (result.toolCalls.every(isToolCallWellFormed)) return "native";
    return "no-calls";
  }
  return "no-calls";
}

function isToolCallWellFormed(call: ChatWithToolsToolCall): boolean {
  return (
    typeof call.id === "string" &&
    call.id.trim().length > 0 &&
    call.name === "echo" &&
    Object.keys(call.args).length === 1 &&
    call.args.value === "ping"
  );
}
