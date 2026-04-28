/**
 * Slash command parser + dispatcher for the Phase C TUI.
 *
 * Supported verbs (locked in the Phase C plan): /read, /search, /awaken,
 * /vitals, /health, /clear, /quit, /help. Unknown verbs return a usage hint.
 *
 * The dispatcher routes each verb to the daemon RPC equivalent of the
 * existing Phase B verb (search.run, awaken.run, vitals.get, health.probe)
 * and formats the terminal frame into a single system-line message that the
 * App appends to the transcript.
 */

import type { ClientHandle, RpcResponseFrame } from "../client";

export interface SlashContext {
  client: ClientHandle;
  vaultPath: string;
}

export interface SlashOutcome {
  message: string;
  exit?: boolean;
}

export function isSlashCommand(line: string): boolean {
  return line.startsWith("/");
}

export function parseSlashCommand(line: string): { verb: string; rest: string } {
  const trimmed = line.trim().slice(1);
  const space = trimmed.indexOf(" ");
  if (space < 0) return { verb: trimmed, rest: "" };
  return {
    verb: trimmed.slice(0, space),
    rest: trimmed.slice(space + 1).trim(),
  };
}

const HELP_LINES = [
  "/read <path>       — read a vault note",
  "/search <query>    — balanced search",
  "/awaken            — index the vault",
  "/vitals <path>     — note health snapshot",
  "/health            — substrate + bridge status",
  "/approve <id> [r]  — approve a pending tool call",
  "/deny <id> [r]     — deny a pending tool call",
  "/undo              — reverse the latest write",
  "/history           — list recent chat-driven writes",
  "/clear             — clear the transcript",
  "/quit              — exit the TUI",
];

type SlashHandler = (rest: string, context: SlashContext) => Promise<SlashOutcome>;

const VERB_TABLE: Record<string, SlashHandler> = {
  quit: async () => ({ message: "bye.", exit: true }),
  exit: async () => ({ message: "bye.", exit: true }),
  help: async () => ({ message: HELP_LINES.join("\n") }),
  clear: async () => ({ message: "" }),
  read: async (rest, context) =>
    rest.length === 0 ? { message: "/read needs a path" } : rpcReadNote(context, rest),
  search: async (rest, context) =>
    rest.length === 0 ? { message: "/search needs a query" } : rpcSearch(context, rest),
  awaken: async (_rest, context) => rpcAwaken(context),
  vitals: async (rest, context) =>
    rest.length === 0 ? { message: "/vitals needs a path" } : rpcVitals(context, rest),
  health: async (_rest, context) => rpcHealth(context),
  approve: async (rest, context) => approvalVerb(rest, context, true),
  deny: async (rest, context) => approvalVerb(rest, context, false),
  undo: async (_rest, context) => rpcUndo(context),
  history: async (_rest, context) => rpcHistory(context),
};

export async function dispatchSlashCommand(
  line: string,
  context: SlashContext,
): Promise<SlashOutcome> {
  const { verb, rest } = parseSlashCommand(line);
  const handler = VERB_TABLE[verb];
  if (!handler) return { message: `unknown command: /${verb} (try /help)` };
  return handler(rest, context);
}

async function approvalVerb(
  rest: string,
  context: SlashContext,
  approved: boolean,
): Promise<SlashOutcome> {
  const space = rest.indexOf(" ");
  const callId = space < 0 ? rest : rest.slice(0, space);
  const reason = space < 0 ? "" : rest.slice(space + 1).trim();
  if (callId.length === 0) {
    return { message: `/${approved ? "approve" : "deny"} needs <callId>` };
  }
  return rpcChatApprove(context, callId, approved, reason);
}

async function rpcSearch(context: SlashContext, query: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("search.run", { query, mode: "balanced" }));
  if (!result || result.type === "error") {
    return { message: `search error: ${formatError(result)}` };
  }
  const detail = result as unknown as {
    result?: { hits?: { path: string; score: number }[] };
  };
  const hits = detail.result?.hits ?? [];
  if (hits.length === 0) return { message: "no hits." };
  return {
    message: hits
      .slice(0, 5)
      .map((hit) => `${hit.path} (${hit.score.toFixed(2)})`)
      .join("\n"),
  };
}

async function rpcAwaken(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("awaken.run", {}));
  if (!result || result.type === "error") {
    return { message: `awaken error: ${formatError(result)}` };
  }
  const detail = result as unknown as { queued?: number };
  return { message: `awaken: queued ${detail.queued ?? 0} notes` };
}

async function rpcVitals(context: SlashContext, path: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("vitals.get", { path }));
  if (!result || result.type === "error") {
    return { message: `vitals error: ${formatError(result)}` };
  }
  const detail = result as unknown as { snapshot?: unknown };
  return { message: `vitals: ${JSON.stringify(detail.snapshot ?? {})}` };
}

async function rpcHealth(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("health.probe", {}));
  if (!result || result.type === "error") {
    return { message: `health error: ${formatError(result)}` };
  }
  return { message: `health: ${JSON.stringify(result)}` };
}

async function rpcChatApprove(
  context: SlashContext,
  callId: string,
  approved: boolean,
  reason: string,
): Promise<SlashOutcome> {
  const params: Record<string, unknown> = { callId, approved };
  if (reason.length > 0) params.reason = reason;
  const result = await drainResult(context.client.call("chat.approve", params));
  if (!result || result.type === "error") {
    return { message: `${approved ? "approve" : "deny"} error: ${formatError(result)}` };
  }
  return { message: `${approved ? "approved" : "denied"} ${callId}` };
}

async function rpcUndo(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.undo", {}));
  if (!result || result.type === "error") return { message: `undo error: ${formatError(result)}` };
  const detail = result as unknown as {
    ok?: boolean;
    error?: string;
    reversed?: { kind?: string; target?: string };
  };
  if (detail.ok !== true) {
    return { message: `undo: ${detail.error ?? "unknown"}` };
  }
  const reversed = detail.reversed;
  return { message: `undone: ${reversed?.kind ?? "?"} ${reversed?.target ?? ""}` };
}

async function rpcHistory(context: SlashContext): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.history", { limit: 10 }));
  if (!result || result.type === "error")
    return { message: `history error: ${formatError(result)}` };
  const detail = result as unknown as {
    entries?: { kind: string; target: string; createdAt: number }[];
  };
  const entries = detail.entries ?? [];
  if (entries.length === 0) return { message: "history: (empty)" };
  return {
    message: entries
      .map((entry) => `${entry.kind} ${entry.target} ${new Date(entry.createdAt).toISOString()}`)
      .join("\n"),
  };
}

async function rpcReadNote(context: SlashContext, path: string): Promise<SlashOutcome> {
  const result = await drainResult(context.client.call("notes.read", { path }));
  if (!result || result.type === "error") return { message: `read error: ${formatError(result)}` };
  const detail = result as unknown as { body?: string };
  const body = detail.body ?? "";
  return { message: renderNoteBody(path, body) };
}

function renderNoteBody(_path: string, body: string): string {
  const limit = 5000;
  if (body.length <= limit) return `\`\`\`md\n${body}\n\`\`\``;
  const head = body.slice(0, Math.floor(limit * 0.7));
  const tail = body.slice(body.length - Math.floor(limit * 0.3));
  return `\`\`\`md\n${head}\n[…${body.length - limit} characters elided…]\n${tail}\n\`\`\``;
}

async function drainResult(
  stream: AsyncIterable<RpcResponseFrame>,
): Promise<RpcResponseFrame | null> {
  for await (const frame of stream) {
    if (frame.type === "result" || frame.type === "error") return frame;
  }
  return null;
}

function formatError(frame: RpcResponseFrame | null): string {
  if (frame === null) return "no response";
  return (frame as { message?: string }).message ?? "unknown";
}
