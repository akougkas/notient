/**
 * agent.ask RPC handler (Phase D1 LD-2/LD-3/LD-8).
 *
 * The peer-callable verb that turns the daemon into a peer agent. External
 * agents send a single natural-language intent and receive a structured JSON
 * answer carrying citations, open questions, and confidence.
 *
 * Implementation notes:
 *
 *   - Bypasses ChatService entirely. ChatService persists to ConversationStore
 *     and runs ContextManager's eight-layer composition, neither of which fits
 *     an ephemeral one-shot ask. Instead we drive runAgentTurn directly with a
 *     two-message system+user buffer.
 *   - The tool registry is filtered to a read-only allowlist before the loop
 *     starts so the LLM never sees write tools in its catalog. A defense-in-
 *     depth check in the event drain rejects any out-of-band call.
 *   - The final assistant message is parsed as JSON; on parse or shape failure
 *     the handler wraps the raw text into a confidence-zero fallback so a
 *     misbehaving model never crashes the verb.
 */

import { runAgentTurn } from "../../core/chat/agentLoop";
import type { ApprovalGate } from "../../core/chat/approvalGate";
import { type ToolMode, type ToolModeCache, probeToolMode } from "../../core/chat/toolModeProbe";
import type { ToolRegistry } from "../../core/chat/tools/registry";
import type { Conversation } from "../../core/chat/types";
import type { EventBus } from "../../core/events/eventBus";
import type { LLMProvider, ChatMessage as ProviderChatMessage } from "../../core/llm/provider";

export interface AgentAskHandlerDeps {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  toolModeCache: ToolModeCache;
  bus: EventBus;
  settings: () => AgentAskRuntimeSettings;
}

export interface AgentAskRuntimeSettings {
  model: string;
  defaultMaxRoundsPerTurn: number;
}

export interface AgentAskCitation {
  path: string;
  score: number;
  snippet: string;
}

export interface AgentAskToolCallSummary {
  name: string;
  args: unknown;
  durationMs: number;
}

export interface AgentAskResponsePayload {
  answer: string;
  citations: AgentAskCitation[];
  openQuestions: string[];
  confidence: number;
  toolCalls: AgentAskToolCallSummary[];
  durationMs: number;
}

export const AGENT_ASK_ROUND_CAP = 8;

const READ_ONLY_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "vault.read_note",
  "vault.search_notes",
  "vault.list_neighbors",
  "vault.get_vitals",
  "proposals.list_pending",
  "proposals.get",
  "graph.find_path",
  "graph.list_clusters",
  "agents.contradiction_check",
  "agents.synthesize",
]);

const ASK_SYSTEM_PROMPT = [
  "You are Notient, a local-first knowledge agent. Answer the operator's intent using the read-only tools available.",
  "",
  "Your final message MUST be a single JSON object with this exact shape:",
  "{",
  '  "answer": "<concise prose answer, 1-3 paragraphs>",',
  '  "citations": [{"path": "<note path>", "score": <0-1>, "snippet": "<short quote>"}],',
  '  "openQuestions": ["<question 1>", ...],',
  '  "confidence": <0-1, your confidence in the answer>',
  "}",
  "",
  "Do not wrap the JSON in code fences. Do not include any prose before or after the JSON. Do not include tool-call narration in your final message.",
].join("\n");

export type AgentAskHandler = (
  params: Record<string, unknown>,
  emit: (line: string) => void,
  envelopeId: string,
  clientIdentity: string,
) => Promise<Record<string, unknown>>;

export function makeAgentAskHandler(deps: AgentAskHandlerDeps): AgentAskHandler {
  const filteredRegistry = deps.toolRegistry.withFilter((name) =>
    READ_ONLY_TOOL_ALLOWLIST.has(name),
  );

  return async (params, _emit, _envelopeId, clientIdentity) => {
    const parsed = parseAskParams(params);
    const settings = deps.settings();
    const requestedRounds = parsed.maxRoundsPerTurn ?? settings.defaultMaxRoundsPerTurn;
    const maxRoundsPerTurn = Math.min(Math.max(1, requestedRounds), AGENT_ASK_ROUND_CAP);

    const controller = new AbortController();
    const startedAt = Date.now();
    const toolMode = await ensureToolMode(deps, settings.model, controller.signal);
    if (toolMode === "disabled") {
      return wrapFallback(
        "Tool calling is disabled for the configured chat model; agent.ask requires a tool-capable model.",
        [],
        startedAt,
      );
    }

    const generator = runAgentTurn(
      {
        provider: deps.provider,
        toolRegistry: filteredRegistry,
        approvalGate: deps.approvalGate,
        maxRoundsPerTurn,
        toolMode: () => toolMode,
      },
      {
        conversation: makeEphemeralConversation(clientIdentity, settings.model),
        systemAndHistory: buildAskMessages(parsed.intent),
        model: settings.model,
        signal: controller.signal,
      },
    );

    const drained = await drainAskEvents(generator, controller);
    if (drained.unauthorizedTool !== null) {
      throw new Error(`tool '${drained.unauthorizedTool}' is not available to agent.ask`);
    }
    if (drained.loopError !== null && drained.finalContent.length === 0) {
      throw new Error(`agent.ask turn failed: ${drained.loopError}`);
    }
    return buildAskResponse(drained, startedAt);
  };
}

function buildAskMessages(intent: string): ProviderChatMessage[] {
  return [
    { role: "system", content: ASK_SYSTEM_PROMPT },
    { role: "user", content: intent },
  ];
}

interface DrainedTurn {
  toolCalls: AgentAskToolCallSummary[];
  finalContent: string;
  loopError: string | null;
  unauthorizedTool: string | null;
  seenPaths: Set<string>;
}

async function drainAskEvents(
  generator: AsyncGenerator<import("../../core/chat/agentLoop").AgentLoopEvent>,
  controller: AbortController,
): Promise<DrainedTurn> {
  const toolCalls: AgentAskToolCallSummary[] = [];
  const callStartTimes = new Map<string, number>();
  // Map call id -> tool name + args so we can interpret the matching result.
  // The model picks both, and we only see the name on the loop:tool-call event.
  const callMetadata = new Map<string, { name: string; args: unknown }>();
  const seenPaths = new Set<string>();
  let finalContent = "";
  let loopError: string | null = null;
  let unauthorizedTool: string | null = null;

  for await (const event of generator) {
    if (event.type === "loop:tool-call") {
      if (!READ_ONLY_TOOL_ALLOWLIST.has(event.call.name)) {
        unauthorizedTool = event.call.name;
        controller.abort();
        continue;
      }
      callStartTimes.set(event.call.id, Date.now());
      callMetadata.set(event.call.id, { name: event.call.name, args: event.call.args });
      toolCalls.push({ name: event.call.name, args: event.call.args, durationMs: 0 });
      continue;
    }
    if (event.type === "loop:tool-result") {
      finalizeToolCallDuration(toolCalls, callStartTimes, event.result.callId);
      handleToolResultPaths(event.result, callMetadata, seenPaths);
      continue;
    }
    if (event.type === "loop:done") {
      finalContent = event.finalMessage.content;
      continue;
    }
    if (event.type === "loop:error") {
      loopError = event.message;
    }
  }

  return { toolCalls, finalContent, loopError, unauthorizedTool, seenPaths };
}

function handleToolResultPaths(
  result: import("../../core/chat/types").ToolResult,
  callMetadata: Map<string, { name: string; args: unknown }>,
  seenPaths: Set<string>,
): void {
  const metadata = callMetadata.get(result.callId);
  callMetadata.delete(result.callId);
  if (!metadata || result.status !== "ok") return;
  collectSeenPaths(metadata.name, metadata.args, result.data, seenPaths);
}

/**
 * Records every vault path that the agent legitimately observed via a
 * successful tool call. The handler later filters model-emitted citations
 * against this set so a hallucinated "looks like a path" citation cannot
 * leak into the response.
 *
 * The extraction is best-effort and per-tool: shapes that don't match are
 * silently skipped so a malformed tool result never crashes the turn.
 *
 * proposals.*, graph.*, and agents.* are intentionally absent; they do not
 * return note paths the model would cite. Extend this map if a future tool
 * starts returning paths.
 */
function collectSeenPaths(
  toolName: string,
  args: unknown,
  data: unknown,
  seenPaths: Set<string>,
): void {
  const collector = SEEN_PATH_COLLECTORS[toolName];
  if (collector) collector(args, data, seenPaths);
}

type SeenPathCollector = (args: unknown, data: unknown, seenPaths: Set<string>) => void;

const SEEN_PATH_COLLECTORS: Record<string, SeenPathCollector> = {
  "vault.search_notes": (_args, data, seenPaths) => {
    const hits = isRecord(data) ? data.hits : undefined;
    if (Array.isArray(hits)) addNotePathsFromArray(hits, seenPaths);
  },
  "vault.read_note": (args, data, seenPaths) => {
    addNotePathFromRecord(args, seenPaths);
    addNotePathFromRecord(data, seenPaths);
  },
  "vault.list_neighbors": (_args, data, seenPaths) => {
    addNotePathFromRecord(data, seenPaths);
    const neighbors = isRecord(data) ? data.neighbors : undefined;
    if (Array.isArray(neighbors)) addNotePathsFromArray(neighbors, seenPaths);
  },
  "vault.get_vitals": (args, _data, seenPaths) => {
    addNotePathFromRecord(args, seenPaths);
  },
};

function addNotePathFromRecord(value: unknown, seenPaths: Set<string>): void {
  if (!isRecord(value)) return;
  const path = value.notePath;
  if (typeof path === "string" && path.length > 0) seenPaths.add(path);
}

function addNotePathsFromArray(entries: unknown[], seenPaths: Set<string>): void {
  for (const entry of entries) addNotePathFromRecord(entry, seenPaths);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finalizeToolCallDuration(
  toolCalls: AgentAskToolCallSummary[],
  callStartTimes: Map<string, number>,
  callId: string,
): void {
  const start = callStartTimes.get(callId);
  // The matching tool-call summary is the tail entry; finalize its duration.
  const lastIndex = toolCalls.length - 1;
  if (start === undefined || lastIndex < 0) return;
  toolCalls[lastIndex].durationMs = Date.now() - start;
  callStartTimes.delete(callId);
}

function buildAskResponse(drained: DrainedTurn, startedAt: number): Record<string, unknown> {
  const durationMs = Date.now() - startedAt;
  const parsedShape = tryParseAskShape(drained.finalContent);
  if (parsedShape === null) {
    return {
      ok: true,
      answer: drained.finalContent,
      citations: [],
      openQuestions: [],
      confidence: 0,
      toolCalls: drained.toolCalls,
      durationMs,
    };
  }
  // Filter out citations the agent could not have legitimately seen via a
  // successful tool call this turn. A model that hallucinates "looks like a
  // vault path" must not win. confidence is left untouched on purpose: the
  // operator gets the prose answer, the tool-call trail, and an honest
  // citations array, then decides what to trust.
  const validatedCitations = parsedShape.citations.filter((citation) =>
    drained.seenPaths.has(citation.path),
  );
  return {
    ok: true,
    answer: parsedShape.answer,
    citations: validatedCitations,
    openQuestions: parsedShape.openQuestions,
    confidence: parsedShape.confidence,
    toolCalls: drained.toolCalls,
    durationMs,
  };
}

interface ParsedAskParams {
  intent: string;
  maxRoundsPerTurn?: number;
}

function parseAskParams(params: Record<string, unknown>): ParsedAskParams {
  const rawIntent = typeof params.intent === "string" ? params.intent.trim() : "";
  if (rawIntent.length === 0) {
    throw new Error("INVALID_PARAMS: intent is required");
  }
  const rawRounds = params.maxRoundsPerTurn;
  if (rawRounds !== undefined && rawRounds !== null) {
    if (typeof rawRounds !== "number" || !Number.isFinite(rawRounds) || rawRounds <= 0) {
      throw new Error("INVALID_PARAMS: maxRoundsPerTurn must be a positive number");
    }
    return { intent: rawIntent, maxRoundsPerTurn: Math.floor(rawRounds) };
  }
  return { intent: rawIntent };
}

async function ensureToolMode(
  deps: AgentAskHandlerDeps,
  model: string,
  signal: AbortSignal,
): Promise<ToolMode> {
  const cached = deps.toolModeCache.read(model);
  if (cached) return cached;
  return probeToolMode({
    provider: deps.provider,
    model,
    signal,
    cache: deps.toolModeCache,
    bus: deps.bus,
  });
}

function makeEphemeralConversation(clientIdentity: string, model: string): Conversation {
  const id = `ask-${Date.now().toString(36)}`;
  return {
    id,
    notePath: "",
    model,
    pinnedContext: [],
    approvalMode: "yolo",
    topic: "agent.ask",
    summary: "",
    summaryEmbeddingB64: null,
    clientIdentity,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

interface ParsedAskShape {
  answer: string;
  citations: AgentAskCitation[];
  openQuestions: string[];
  confidence: number;
}

function tryParseAskShape(content: string): ParsedAskShape | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const answer = candidate.answer;
  const confidence = candidate.confidence;
  if (typeof answer !== "string") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  const citations = parseCitationArray(candidate.citations);
  const openQuestions = parseStringArray(candidate.openQuestions);
  if (citations === null || openQuestions === null) return null;
  return { answer, citations, openQuestions, confidence };
}

function parseCitationArray(value: unknown): AgentAskCitation[] | null {
  if (!Array.isArray(value)) return null;
  const out: AgentAskCitation[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const path = record.path;
    const score = record.score;
    const snippet = record.snippet;
    if (typeof path !== "string") return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    if (typeof snippet !== "string") return null;
    out.push({ path, score, snippet });
  }
  return out;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

function wrapFallback(
  answer: string,
  toolCalls: AgentAskToolCallSummary[],
  startedAt: number,
): Record<string, unknown> {
  return {
    ok: true,
    answer,
    citations: [],
    openQuestions: [],
    confidence: 0,
    toolCalls,
    durationMs: Date.now() - startedAt,
  };
}
