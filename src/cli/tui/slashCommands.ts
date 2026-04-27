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
  "/read <path>      — read a vault note",
  "/search <query>   — balanced search",
  "/awaken           — index the vault",
  "/vitals <path>    — note health snapshot",
  "/health           — substrate + bridge status",
  "/clear            — clear the transcript",
  "/quit             — exit the TUI",
];

export async function dispatchSlashCommand(
  line: string,
  context: SlashContext,
): Promise<SlashOutcome> {
  const { verb, rest } = parseSlashCommand(line);
  if (verb === "quit" || verb === "exit") {
    return { message: "bye.", exit: true };
  }
  if (verb === "help") return { message: HELP_LINES.join("\n") };
  if (verb === "clear") return { message: "" };
  if (verb === "read") {
    if (rest.length === 0) return { message: "/read needs a path" };
    return rpcVitals(context, rest);
  }
  if (verb === "search") {
    if (rest.length === 0) return { message: "/search needs a query" };
    return rpcSearch(context, rest);
  }
  if (verb === "awaken") return rpcAwaken(context);
  if (verb === "vitals") {
    if (rest.length === 0) return { message: "/vitals needs a path" };
    return rpcVitals(context, rest);
  }
  if (verb === "health") return rpcHealth(context);
  return { message: `unknown command: /${verb} (try /help)` };
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
