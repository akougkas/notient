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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NotientSettings } from "../../core/settings/types";
import type { ClientHandle, RpcResponseFrame } from "../client";
import {
  runProposalsApproveCommand,
  runProposalsListCommand,
  runProposalsRejectCommand,
} from "../commands/proposalsCli";
import type { Emitter } from "../output";
import {
  type ModelInfo,
  buildEndpointPatch,
  buildModelView,
  buildUseEmbedPatch,
  buildUseModelPatch,
  formatModelList,
  formatModelView,
} from "./modelVerb";

export interface SlashContext {
  client: ClientHandle;
  vaultPath: string;
  proposals?: ProposalActions;
  /**
   * Returns the most recent fully streamed assistant reply, or null when no
   * turn has produced an assistant message yet. Used by /copy.
   */
  getLastAssistant?: () => string | null;
}

export interface ProposalListItem {
  id: string;
  table: string;
  source: string | null;
  target: string | null;
  agent: string | null;
  confidence: number;
}

export interface ProposalActions {
  list(): Promise<ProposalListItem[]>;
  approve(id: string): Promise<string>;
  reject(id: string, reason?: string): Promise<string>;
}

export interface SlashOutcome {
  message: string;
  exit?: boolean;
  resetTranscript?: boolean;
  proposalItems?: ProposalListItem[];
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

const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["/read <path>", "read a vault note"],
  ["/search <query>", "balanced search"],
  ["/awaken", "index the vault"],
  ["/vitals <path>", "note health snapshot"],
  ["/health", "substrate + bridge status"],
  ["/model", "show endpoint, model, embed, context"],
  ["/model list", "list models on the active endpoint"],
  ["/model use <id>", "switch the chat model"],
  ["/model embed <id>", "switch the embedding model"],
  ["/model endpoint <url>", "switch the OpenAI-compatible endpoint"],
  ["/approve <id> [r]", "approve a pending tool call"],
  ["/deny <id> [r]", "deny a pending tool call"],
  ["/proposals [page]", "list pending edge proposals"],
  ["/approve-edge <id>", "approve a pending edge"],
  ["/reject-edge <id> [r]", "reject a pending edge"],
  ["/undo", "reverse the latest write"],
  ["/history", "list recent chat-driven writes"],
  ["/copy", "save the last assistant reply"],
  ["/clear", "clear the transcript"],
  ["/help", "show this table"],
  ["/quit", "exit the TUI"],
];

export function buildHelpTable(): string {
  const verbWidth = HELP_ROWS.reduce((max, [verb]) => Math.max(max, verb.length), 0);
  const descWidth = HELP_ROWS.reduce((max, [, desc]) => Math.max(max, desc.length), 0);
  const top = `┌${"─".repeat(verbWidth + 2)}┬${"─".repeat(descWidth + 2)}┐`;
  const bottom = `└${"─".repeat(verbWidth + 2)}┴${"─".repeat(descWidth + 2)}┘`;
  const rows = HELP_ROWS.map(
    ([verb, desc]) => `│ ${verb.padEnd(verbWidth)} │ ${desc.padEnd(descWidth)} │`,
  );
  return [top, ...rows, bottom].join("\n");
}

type SlashHandler = (rest: string, context: SlashContext) => Promise<SlashOutcome>;

const VERB_TABLE: Record<string, SlashHandler> = {
  quit: async () => ({ message: "bye.", exit: true }),
  exit: async () => ({ message: "bye.", exit: true }),
  help: async () => ({ message: buildHelpTable() }),
  clear: async () => ({ message: "", resetTranscript: true }),
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
  proposals: async (rest, context) => proposalsVerb(rest, context),
  "approve-edge": async (rest, context) => approveEdgeVerb(rest, context),
  "reject-edge": async (rest, context) => rejectEdgeVerb(rest, context),
  undo: async (_rest, context) => rpcUndo(context),
  history: async (_rest, context) => rpcHistory(context),
  copy: async (_rest, context) => copyLastAssistant(context),
  model: async (rest, context) => modelVerb(rest, context),
};

async function modelVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const space = rest.indexOf(" ");
  const sub = (space < 0 ? rest : rest.slice(0, space)).trim();
  const arg = space < 0 ? "" : rest.slice(space + 1).trim();
  if (sub.length === 0) return modelShow(context);
  if (sub === "show") return modelShow(context);
  if (sub === "list") return modelList(context);
  if (sub === "use") {
    if (arg.length === 0) return { message: "/model use needs <id>" };
    return modelApplyPatch(context, buildUseModelPatch(arg), `chat model → ${arg}`);
  }
  if (sub === "embed") {
    if (arg.length === 0) return { message: "/model embed needs <id>" };
    return modelApplyPatch(context, buildUseEmbedPatch(arg), `embed model → ${arg}`);
  }
  if (sub === "endpoint") {
    if (arg.length === 0) return { message: "/model endpoint needs <url>" };
    return modelApplyPatch(context, buildEndpointPatch(arg), `endpoint → ${arg}`);
  }
  return { message: `/model: unknown action '${sub}' (try /help)` };
}

const PROPOSALS_PAGE_SIZE = 8;

async function proposalsVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const page = parseProposalPage(rest);
  const actions = context.proposals ?? defaultProposalActions(context.vaultPath);
  const items = await actions.list();
  if (items.length === 0) return { message: "proposals: (empty)", proposalItems: [] };
  const totalPages = Math.max(1, Math.ceil(items.length / PROPOSALS_PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * PROPOSALS_PAGE_SIZE;
  const pageItems = items.slice(offset, offset + PROPOSALS_PAGE_SIZE);
  const rows = pageItems.map(
    (item, index) =>
      `${offset + index + 1}. ${item.id} ${item.table} ${item.source ?? "?"} -> ${
        item.target ?? "?"
      } agent=${item.agent ?? "?"} confidence=${item.confidence.toFixed(2)}`,
  );
  return {
    message: [
      `proposals page ${clampedPage}/${totalPages}`,
      ...rows,
      "keys: a approve first visible, r reject first visible, /approve-edge <id>, /reject-edge <id>",
    ].join("\n"),
    proposalItems: pageItems,
  };
}

function parseProposalPage(rest: string): number {
  if (rest.length === 0) return 1;
  const parsed = Number(rest);
  if (!Number.isInteger(parsed) || parsed <= 0) return 1;
  return parsed;
}

async function approveEdgeVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const id = rest.trim();
  if (id.length === 0) return { message: "/approve-edge needs <id>" };
  const actions = context.proposals ?? defaultProposalActions(context.vaultPath);
  return { message: await actions.approve(id) };
}

async function rejectEdgeVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const space = rest.indexOf(" ");
  const id = space < 0 ? rest.trim() : rest.slice(0, space).trim();
  const reason = space < 0 ? undefined : rest.slice(space + 1).trim();
  if (id.length === 0) return { message: "/reject-edge needs <id>" };
  const actions = context.proposals ?? defaultProposalActions(context.vaultPath);
  return { message: await actions.reject(id, reason === "" ? undefined : reason) };
}

function defaultProposalActions(vaultPath: string): ProposalActions {
  return {
    list: async () => {
      let captured = "";
      const exitCode = await runProposalsListCommand({
        vaultPath,
        emitter: silentEmitter,
        asJson: true,
        limit: 100,
        writeStdout: (line) => {
          captured += line;
        },
      });
      if (exitCode !== 0) return [];
      const parsed = JSON.parse(captured) as ProposalListItem[];
      return parsed;
    },
    approve: async (id) => {
      const events = captureEvents();
      const exitCode = await runProposalsApproveCommand({
        vaultPath,
        vaultRoot: vaultPath,
        emitter: events.emitter,
        id,
      });
      return proposalActionMessage(exitCode, events.events, "approved", id);
    },
    reject: async (id, reason) => {
      const events = captureEvents();
      const exitCode = await runProposalsRejectCommand({
        vaultPath,
        vaultRoot: vaultPath,
        emitter: events.emitter,
        id,
        reason,
      });
      return proposalActionMessage(exitCode, events.events, "rejected", id);
    },
  };
}

const silentEmitter: Emitter = {
  emit: () => {},
};

function captureEvents(): { emitter: Emitter; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    emitter: {
      emit: (event) => {
        events.push(event);
      },
    },
  };
}

function proposalActionMessage(
  exitCode: number,
  events: ReadonlyArray<Record<string, unknown>>,
  verb: "approved" | "rejected",
  id: string,
): string {
  const error = events.find((event) => event.type === "error");
  if (error !== undefined) return `${verb} error: ${String(error.message ?? "unknown")}`;
  const notFound = events.find((event) => event.type === "proposals:not_found");
  if (notFound !== undefined) return String(notFound.message ?? "proposal not found");
  if (exitCode !== 0) return `${verb} error: exit ${exitCode}`;
  return `edge ${verb} ${id}`;
}

async function modelShow(context: SlashContext): Promise<SlashOutcome> {
  const settings = await fetchSettings(context);
  if (settings === null) return { message: "/model: failed to read daemon config." };
  return { message: formatModelView(buildModelView(settings)) };
}

async function modelList(context: SlashContext): Promise<SlashOutcome> {
  const settings = await fetchSettings(context);
  if (settings === null) return { message: "/model list: failed to read daemon config." };
  const baseUrl = settings.primary.baseUrl.replace(/\/v1\/?$/, "");
  try {
    const response = await fetch(`${baseUrl}/api/v0/models`);
    if (!response.ok) {
      return { message: `/model list: endpoint returned HTTP ${response.status}` };
    }
    const body = (await response.json()) as { data?: ReadonlyArray<Record<string, unknown>> };
    const models = (body.data ?? []).map(
      (m): ModelInfo => ({
        id: String(m.id ?? ""),
        type: String(m.type ?? "?"),
        state: m.state === "loaded" ? "loaded" : "not-loaded",
        loadedContextLength:
          typeof m.loaded_context_length === "number" ? m.loaded_context_length : undefined,
        maxContextLength:
          typeof m.max_context_length === "number" ? m.max_context_length : undefined,
      }),
    );
    return { message: formatModelList(models) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return { message: `/model list: fetch failed — ${message}` };
  }
}

async function modelApplyPatch(
  context: SlashContext,
  patch: Partial<NotientSettings>,
  label: string,
): Promise<SlashOutcome> {
  const result = await drainResult(
    context.client.call("daemon.config_set", patch as Record<string, unknown>),
  );
  if (!result || result.type === "error") {
    return { message: `/model: config update failed — ${formatError(result)}` };
  }
  return { message: `/model: ${label}.` };
}

async function fetchSettings(context: SlashContext): Promise<NotientSettings | null> {
  const result = await drainResult(context.client.call("daemon.config_get", {}));
  if (!result || result.type !== "result") return null;
  const detail = result as unknown as { config?: NotientSettings };
  return detail.config ?? null;
}

async function copyLastAssistant(context: SlashContext): Promise<SlashOutcome> {
  const text = context.getLastAssistant?.() ?? null;
  if (text === null || text.length === 0) {
    return { message: "/copy: no assistant reply yet to copy." };
  }
  const target = join(context.vaultPath, ".notient", "last.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return { message: `Copied ${text.length} chars → ${target}` };
}

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
    result?: { hits?: { notePath: string; score: number }[] };
  };
  const hits = detail.result?.hits ?? [];
  if (hits.length === 0) return { message: "no hits." };
  return {
    message: hits
      .slice(0, 5)
      .map((hit) => `${hit.notePath} (${hit.score.toFixed(2)})`)
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

const RENDER_LIMIT = 5000;

/**
 * Format a vault note body inside a fenced markdown block, head/tail
 * truncated to ~5000 characters. When the body opens with a YAML
 * frontmatter block (`---\n...\n---\n`), the entire block is preserved
 * verbatim and only the body content after it is truncated; otherwise the
 * head/tail split runs over the whole body. The truncation marker carries
 * the elided character count so the operator knows how much was dropped.
 */
export function renderNoteBody(_path: string, body: string): string {
  if (body.length <= RENDER_LIMIT) return `\`\`\`md\n${body}\n\`\`\``;
  const frontmatter = extractFrontmatter(body);
  if (frontmatter) {
    const remaining = Math.max(RENDER_LIMIT - frontmatter.block.length, 800);
    const truncatedRest = truncateMiddle(frontmatter.rest, remaining);
    return `\`\`\`md\n${frontmatter.block}${truncatedRest}\n\`\`\``;
  }
  return `\`\`\`md\n${truncateMiddle(body, RENDER_LIMIT)}\n\`\`\``;
}

function extractFrontmatter(body: string): { block: string; rest: string } | null {
  if (!body.startsWith("---\n")) return null;
  const closeMarker = "\n---\n";
  const closeIndex = body.indexOf(closeMarker, 4);
  if (closeIndex < 0) return null;
  const blockEnd = closeIndex + closeMarker.length;
  return { block: body.slice(0, blockEnd), rest: body.slice(blockEnd) };
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(text.length - Math.floor(limit * 0.3));
  const elided = text.length - head.length - tail.length;
  return `${head}\n[…${elided} characters elided…]\n${tail}`;
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
