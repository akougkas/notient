import type { ClientHandle } from "../../client";
import { RpcCallError, createRpc } from "../rpc";
import type { ProposalActions, ProposalListItem, SlashContext, SlashOutcome } from "./types";

const PROPOSALS_PAGE_SIZE = 8;

export async function proposalsVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const page = parseProposalPage(rest);
  const actions = context.proposals ?? defaultProposalActions(context.client);
  let items: ProposalListItem[];
  try {
    items = await actions.list();
  } catch (error) {
    return { message: `proposals error: ${describe(error)}` };
  }
  if (items.length === 0) return { message: "proposals: (empty)", proposalItems: [] };
  const totalPages = Math.max(1, Math.ceil(items.length / PROPOSALS_PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * PROPOSALS_PAGE_SIZE;
  const pageItems = items.slice(offset, offset + PROPOSALS_PAGE_SIZE);
  const rows = pageItems.map(
    (item, index) =>
      `${offset + index + 1}. ${item.id} ${item.table} ${item.source ?? "?"} -> ${
        item.target ?? "?"
      } agent=${item.agent} confidence=${item.confidence.toFixed(2)}`,
  );
  return {
    message: [
      `proposals page ${clampedPage}/${totalPages}`,
      ...rows,
      "actions: /approve-edge <id>, /reject-edge <id> [reason]",
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

export async function approveEdgeVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const id = rest.trim();
  if (id.length === 0) return { message: "/approve-edge needs <id>" };
  const actions = context.proposals ?? defaultProposalActions(context.client);
  const decision = await actions.approve(id);
  return { message: decision.message, pendingTransition: { id, state: decision.state } };
}

export async function rejectEdgeVerb(rest: string, context: SlashContext): Promise<SlashOutcome> {
  const space = rest.indexOf(" ");
  const id = space < 0 ? rest.trim() : rest.slice(0, space).trim();
  const reason = space < 0 ? undefined : rest.slice(space + 1).trim();
  if (id.length === 0) return { message: "/reject-edge needs <id>" };
  const actions = context.proposals ?? defaultProposalActions(context.client);
  const decision = await actions.reject(id, reason === "" ? undefined : reason);
  return {
    message: decision.message,
    pendingTransition: { id, state: decision.state },
  };
}

export async function rpcDiff(context: SlashContext, id?: string): Promise<SlashOutcome> {
  const actions = context.proposals ?? defaultProposalActions(context.client);
  let items: ProposalListItem[];
  try {
    items = await actions.list();
  } catch (error) {
    return { message: `diff error: ${describe(error)}` };
  }
  if (items.length === 0) return { message: "diff: no pending proposals." };
  const target = id ? items.find((item) => item.id === id) : items[0];
  if (!target) return { message: `diff: proposal '${id}' not found.` };
  return { message: formatProposalDiff(target) };
}

function formatProposalDiff(item: ProposalListItem): string {
  return [
    "proposal diff",
    `id:         ${item.id}`,
    `table:      ${item.table}`,
    `connection: ${item.source ?? "?"} ──► ${item.target ?? "?"}`,
    `agent:      ${item.agent}`,
    `confidence: ${(item.confidence * 100).toFixed(0)}%`,
    "status:     pending human review",
    "",
    `approve: /approve-edge ${item.id}`,
    `reject:  /reject-edge ${item.id} [reason]`,
  ].join("\n");
}

/**
 * Proposal actions backed by the daemon's `proposals.*` RPCs.
 *
 * The daemon owns the database write, event emission, and admin-scope check.
 */
export function defaultProposalActions(client: ClientHandle): ProposalActions {
  const rpc = createRpc(client);
  return {
    list: async () => {
      const result = await rpc.proposalsList({ limit: 100 });
      return result.proposals.map(
        (proposal): ProposalListItem => ({
          id: proposal.id,
          table: proposal.table,
          source: proposal.fromNotePath,
          target: proposal.toNotePath,
          agent: proposal.agent,
          confidence: proposal.confidence,
        }),
      );
    },
    approve: async (id) => {
      try {
        const result = await rpc.proposalsApprove(id);
        return {
          message: result.found
            ? `edge approved ${id} · audit: ${result.historyId}`
            : "proposal not found or already applied",
          state: "resolved",
        };
      } catch (error) {
        return { message: `approved error: ${describe(error)}`, state: "uncertain" };
      }
    },
    reject: async (id, reason) => {
      try {
        const result = await rpc.proposalsReject(id, reason);
        return {
          message: result.found
            ? `edge rejected ${id} · reason: ${result.reason ?? "(none)"} · audit: ${result.historyId}`
            : "proposal not found or already applied",
          state: "resolved",
        };
      } catch (error) {
        return { message: `rejected error: ${describe(error)}`, state: "uncertain" };
      }
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof RpcCallError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
