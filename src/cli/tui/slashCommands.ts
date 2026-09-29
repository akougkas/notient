/**
 * Slash command parser + dispatcher for the Notient TUI.
 *
 * The verb table is the only routing surface. Each domain lives in its own
 * module under `slash/` so a verb's implementation and its daemon RPC stay
 * next to each other.
 */

import type { Intent } from "./keymap";
import { NAVIGATION_ACTIONS } from "./navigation";
import { createRpc } from "./rpc";
import { rpcGraph, rpcPulse } from "./slash/graph";
import { copyLastAssistant, rpcHistory, rpcUndo } from "./slash/history";
import { inspectJob, listJobs } from "./slash/jobs";
import { modelVerb } from "./slash/model";
import { listPipelines, runPipeline } from "./slash/pipelines";
import {
  approveEdgeVerb,
  defaultProposalActions,
  proposalsVerb,
  rejectEdgeVerb,
  rpcDiff,
} from "./slash/proposals";
import { formatError } from "./slash/rpc";
import type { SlashContext, SlashHandler, SlashOutcome } from "./slash/types";
import { rpcHealth, rpcSentient, rpcVitals } from "./slash/vitals";

export type { SlashContext, SlashOutcome, ProposalActions, ProposalListItem } from "./slash/types";
export { defaultProposalActions };

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

const ADVANCED_HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["/awaken", "index the vault"],
  ["/vitals <path>", "note structure: words, links, edit recency (proxies, not understanding)"],
  ["/health", "daemon and model endpoint status"],
  ["/approve <id>", "approve a pending tool call"],
  ["/deny <id> [reason]", "deny a pending tool call"],
  ["/proposals [page]", "list pending edge proposals"],
  ["/approve-edge <id>", "approve a pending edge"],
  ["/reject-edge <id> [reason]", "reject a pending edge"],
  ["/graph <from> [to]", "inspect note graph edges or path"],
  ["/sentient", "daemon, endpoint and note-agent status"],
  ["/pulse <path>", "maturity label and link tier (structural proxies, not understanding)"],
  ["/diff [id]", "preview proposal writeback diff"],
  ["/undo [historyId]", "reverse one write"],
  ["/history", "list recent chat-driven writes"],
  ["/jobs [cursor]", "list durable pipeline jobs"],
  ["/pipelines", "inspect built-in pipelines and current policies"],
  ["/pipeline <JSON request>", "start a bounded live pipeline and return its job"],
  ["/job <id> [pause|resume|cancel|retry <revision> <key>]", "inspect or control a durable job"],
  ["/quit", "exit the TUI"],
];

const EXTRA_HELP_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["/read <path>", "", "read a vault note here in the conversation"],
  ["/search <words>", "", "search saved text; -s adds meaning when a model is ready"],
  ["/model", "", "show the model, embeddings and context in use"],
  ["/copy", "", "copy the last reply"],
  ["/clear", "", "clear this transcript"],
  ["/quit", "Ctrl+C", "leave the workspace"],
];

export function buildHelpText(): string {
  const actions = NAVIGATION_ACTIONS.filter((action) => action.slash !== undefined).map(
    (action) => {
      const [name, description] = action.label.split(" — ");
      return [`/${action.slash}`, action.keys ?? "", `${name}: ${description}`] as const;
    },
  );
  const rows = [...actions, ...EXTRA_HELP_ROWS];
  const slashWidth = rows.reduce((max, [slash]) => Math.max(max, slash.length), 0);
  const keysWidth = rows.reduce((max, [, keys]) => Math.max(max, keys.length), 0);
  return [
    "Ask, capture a thought, or find a note. Everything below is also in the menu (Ctrl+P).",
    "",
    "Type a question and press Enter. Bring a note into it with @path. Esc moves around the chat.",
    "",
    ...rows.map(
      ([slash, keys, description]) =>
        `${slash.padEnd(slashWidth)}  ${keys.padEnd(keysWidth)}  ${description}`,
    ),
    "",
    "Alt+C, Alt+S and Alt+O work where a terminal or tmux takes Ctrl+B or Ctrl+S.",
    "/help advanced lists reviewed-change, job and graph commands.",
  ].join("\n");
}

export function buildHelpTable(): string {
  const verbWidth = ADVANCED_HELP_ROWS.reduce((max, [verb]) => Math.max(max, verb.length), 0);
  const descWidth = ADVANCED_HELP_ROWS.reduce((max, [, desc]) => Math.max(max, desc.length), 0);
  const top = `┌${"─".repeat(verbWidth + 2)}┬${"─".repeat(descWidth + 2)}┐`;
  const bottom = `└${"─".repeat(verbWidth + 2)}┴${"─".repeat(descWidth + 2)}┘`;
  const rows = ADVANCED_HELP_ROWS.map(
    ([verb, desc]) => `│ ${verb.padEnd(verbWidth)} │ ${desc.padEnd(descWidth)} │`,
  );
  return [top, ...rows, bottom].join("\n");
}

const VERB_TABLE: Record<string, SlashHandler> = {
  threads: async (_rest, context) => {
    if (!context.openConversations) return { message: "Open the TUI to choose a conversation." };
    await context.openConversations();
    return { message: "" };
  },
  new: async (_rest, context) => {
    if (!context.newConversation) return { message: "Open the TUI to start a conversation." };
    await context.newConversation();
    return { message: "" };
  },
  quit: async () => ({ message: "bye.", exit: true }),
  help: async (rest) => ({
    message: rest.trim() === "advanced" ? buildHelpTable() : buildHelpText(),
  }),
  clear: async () => ({ message: "", resetTranscript: true }),
  read: async (rest, context) =>
    rest.length === 0 ? { message: "/read needs a path" } : rpcReadNote(context, rest),
  search: async (rest, context) => rpcSearch(context, rest),
  awaken: async (_rest, context) => rpcAwaken(context),
  vitals: async (rest, context) =>
    rest.length === 0 ? { message: "/vitals needs a path" } : rpcVitals(context, rest),
  health: async (_rest, context) => rpcHealth(context),
  approve: async (rest, context) => approvalVerb(rest, context, true),
  deny: async (rest, context) => approvalVerb(rest, context, false),
  proposals: async (rest, context) => proposalsVerb(rest, context),
  "approve-edge": async (rest, context) => approveEdgeVerb(rest, context),
  "reject-edge": async (rest, context) => rejectEdgeVerb(rest, context),
  graph: async (rest, context) => rpcGraph(context, rest),
  sentient: async (_rest, context) => rpcSentient(context),
  pulse: async (rest, context) =>
    rest.length === 0 ? { message: "/pulse needs a note path" } : rpcPulse(context, rest),
  diff: async (rest, context) => rpcDiff(context, rest.length === 0 ? undefined : rest),
  undo: async (rest, context) => rpcUndo(context, rest.length === 0 ? undefined : rest),
  history: async (_rest, context) => rpcHistory(context),
  jobs: async (rest, context) => listJobs(context, rest),
  pipelines: async (_rest, context) => listPipelines(context),
  pipeline: async (rest, context) => runPipeline(context, rest),
  job: async (rest, context) => inspectJob(context, rest),
  copy: async (_rest, context) => copyLastAssistant(context),
  model: async (rest, context) => modelVerb(rest, context),
};

VERB_TABLE.menu = async (_rest, context) => openIntent(context, { kind: "navigation" });
VERB_TABLE.find = async (rest, context) => {
  if (rest.length > 0 && context.findNote) {
    await context.findNote(rest);
    return { message: "" };
  }
  return openIntent(context, { kind: "prompt-open", prompt: "note-picker" });
};
for (const action of NAVIGATION_ACTIONS) {
  const verb = action.slash;
  if (verb !== undefined && VERB_TABLE[verb] === undefined)
    VERB_TABLE[verb] = async (_rest, context) => openIntent(context, action.intent);
}

function openIntent(context: SlashContext, intent: Intent): SlashOutcome {
  if (!context.runIntent) return { message: "Open the TUI to use this." };
  context.runIntent(intent);
  return { message: "" };
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
  const callId = (space < 0 ? rest : rest.slice(0, space)).trim();
  if (callId.length === 0) {
    return { message: `/${approved ? "approve" : "deny"} needs <callId>` };
  }
  if (approved) {
    if (space >= 0) return { message: "/approve accepts only <callId>" };
    return rpcChatApprove(context, { callId, approved: true });
  }
  const reason = space < 0 ? undefined : rest.slice(space + 1).trim();
  return rpcChatApprove(context, {
    callId,
    approved: false,
    ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
  });
}

export const READ_NOTE_MAX_CHARS = 5000;
export const READ_NOTE_HEAD_CHARS = 3500;
export const READ_NOTE_TAIL_CHARS = 1500;

export function renderNoteBody(path: string, body: string): string {
  if (body.length <= READ_NOTE_MAX_CHARS) {
    return `\`\`\`md\n${body}\n\`\`\``;
  }
  if (body.startsWith("---\n")) {
    const endFm = body.indexOf("\n---\n", 4);
    if (endFm > 0) {
      const fm = body.slice(0, endFm + 5);
      const rest = body.slice(endFm + 5);
      const limit = READ_NOTE_MAX_CHARS - fm.length;
      if (limit > 0 && rest.length > limit) {
        const elided = rest.length - limit;
        return `\`\`\`md\n${fm}${rest.slice(0, limit)}\n[…${elided} characters elided…]\n\`\`\``;
      }
    }
  }
  const head = body.slice(0, READ_NOTE_HEAD_CHARS);
  const tail = body.slice(body.length - READ_NOTE_TAIL_CHARS);
  const elided = body.length - READ_NOTE_MAX_CHARS;
  return `\`\`\`md\n${head}\n[…${elided} characters elided…]\n${tail}\n\`\`\``;
}

async function rpcReadNote(context: SlashContext, path: string): Promise<SlashOutcome> {
  try {
    const result = await createRpc(context.client).noteBody(path);
    return { message: renderNoteBody(path, result.body) };
  } catch (error) {
    return { message: `read error: ${formatError(error)}` };
  }
}

const SEARCH_SNIPPET_CHARS = 140;

function hitSnippet(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > SEARCH_SNIPPET_CHARS ? `${flat.slice(0, SEARCH_SNIPPET_CHARS - 1)}…` : flat;
}

async function rpcSearch(context: SlashContext, rest: string): Promise<SlashOutcome> {
  const semantic = /^(--semantic|-s)(\s|$)/.test(rest);
  const query = semantic ? rest.replace(/^(--semantic|-s)\s*/, "") : rest;
  if (query.length === 0) return { message: "/search needs a query" };
  try {
    const result = await createRpc(context.client).searchText(
      query,
      8,
      semantic ? "hybrid" : "lexical",
    );
    const label = semantic
      ? "Saved-text and meaning search"
      : "Saved-text search (no model used)";
    const coverage = result.coverage.message;
    if (result.hits.length === 0)
      return {
        message: [
          `${label}: no notes matched "${query}".`,
          coverage ?? "Try other words from the note, or /find to browse by name.",
        ].join("\n"),
      };
    const lines = result.hits.map((hit, index) => {
      const quote = hit.evidence ? ` "${hitSnippet(hit.evidence.quote)}"` : "";
      const stale = hit.freshness.state === "current" ? "" : " (index behind this note)";
      return `${index + 1}. ${hit.note.path}${stale}${quote}`;
    });
    const omitted = result.omitted > 0 ? `${result.omitted} more not shown.` : null;
    await context.findNote?.(query);
    return {
      message: [
        `${label}: ${result.hits.length} ${result.hits.length === 1 ? "note" : "notes"} for "${query}".`,
        coverage,
        ...lines,
        omitted,
        "Choose one below with Up/Down and Enter to open it.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    };
  } catch (error) {
    return {
      message: `search error: ${formatError(error)}. /find still lists notes by name, and /read <path> opens one.`,
    };
  }
}

async function rpcAwaken(context: SlashContext): Promise<SlashOutcome> {
  try {
    const result = await createRpc(context.client).awaken();
    return { message: `awaken indexing started (runId: ${result.runId})` };
  } catch (error) {
    return { message: `awaken error: ${formatError(error)}` };
  }
}

async function rpcChatApprove(
  context: SlashContext,
  decision:
    | { callId: string; approved: true }
    | { callId: string; approved: false; reason?: string },
): Promise<SlashOutcome> {
  const verb = decision.approved ? "approve" : "deny";
  try {
    const result = await createRpc(context.client).chatApprove(decision);
    if (result.callId !== decision.callId || result.approved !== decision.approved) {
      return {
        message: `${verb} error: chat.approve answered for another decision`,
        pendingTransition: { id: decision.callId, state: "uncertain" },
      };
    }
    if (result.approved) {
      return {
        message: `approved ${result.callId}`,
        pendingTransition: { id: result.callId, state: "resolved" },
      };
    }
    return {
      message: `denied ${result.callId}: ${result.reason}`,
      pendingTransition: { id: result.callId, state: "resolved" },
    };
  } catch (error) {
    return {
      message: `${verb} error: ${formatError(error)}`,
      pendingTransition: { id: decision.callId, state: "uncertain" },
    };
  }
}
