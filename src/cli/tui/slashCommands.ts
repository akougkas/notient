/**
 * Slash command parser + dispatcher for the Notient TUI.
 *
 * The verb table is the only routing surface. Each domain lives in its own
 * module under `slash/` so a verb's implementation and its daemon RPC stay
 * next to each other.
 */

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

const HELP_ROWS: ReadonlyArray<readonly [string, string]> = [
  ["/threads", "choose a saved conversation (Ctrl+O)"],
  ["/new", "start a new conversation (Ctrl+N)"],
  ["/read <path>", "read a vault note"],
  ["/search <query>", "balanced search"],
  ["/awaken", "index the vault"],
  ["/vitals <path>", "note health snapshot"],
  ["/health", "substrate status"],
  ["/model", "show endpoint, model, embed, context"],
  ["/model list", "list models on the active endpoint"],
  ["/approve <id>", "approve a pending tool call"],
  ["/deny <id> [reason]", "deny a pending tool call"],
  ["/proposals [page]", "list pending edge proposals"],
  ["/approve-edge <id>", "approve a pending edge"],
  ["/reject-edge <id> [reason]", "reject a pending edge"],
  ["/graph <from> [to]", "inspect note graph edges or path"],
  ["/sentient", "substrate + swarm status"],
  ["/pulse <path>", "note maturity and connectivity"],
  ["/diff [id]", "preview proposal writeback diff"],
  ["/undo [historyId]", "reverse one write"],
  ["/history", "list recent chat-driven writes"],
  ["/jobs [cursor]", "list durable pipeline jobs"],
  ["/pipelines", "inspect built-in pipelines and current policies"],
  ["/pipeline <JSON request>", "start a bounded live pipeline and return its job"],
  ["/job <id> [pause|resume|cancel|retry <revision> <key>]", "inspect or control a durable job"],
  ["/copy", "save the last reply from your notes"],
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

async function rpcSearch(context: SlashContext, query: string): Promise<SlashOutcome> {
  try {
    const result = await createRpc(context.client).search(query, 5);
    if (result.result === null) return { message: "search completed without a result." };
    const coverage = result.result.coverage.message;
    if (result.result.hits.length === 0)
      return { message: coverage ? `No hits yet. ${coverage}` : "no hits." };
    return {
      message: [coverage, ...result.result.hits.map((hit) => `${hit.notePath} (${hit.score})`)]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (error) {
    return { message: `search error: ${formatError(error)}` };
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
