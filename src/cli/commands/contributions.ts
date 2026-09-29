import { contributionStatusSchema } from "../../api/contributionContracts";
import { NoteApiError, notePathSchema, revisionSchema } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, type ClientOptions, connectClient } from "../client";
import type { Emitter } from "../output";
import { callApi } from "./api";

export interface ContributionsCommandOptions {
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
  kind?: "contribution" | "feedback";
  state?: string;
  note?: string;
  review?: string;
  limit?: number;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

export async function runContributionsCommand(
  options: ContributionsCommandOptions,
): Promise<number> {
  const state =
    options.state === undefined ? undefined : contributionStatusSchema.parse(options.state);
  const path = options.note === undefined ? undefined : notePathSchema.parse(options.note);
  const proposalId =
    options.review === undefined ? undefined : revisionSchema.parse(options.review);
  const client = await (options.connect ?? connectClient)({
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  try {
    const result = await callApi(client, "contributions.list", {
      limit: options.limit ?? 20,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(state ? { state } : {}),
      ...(path ? { path } : {}),
      ...(proposalId ? { proposalId } : {}),
    });
    if (!result.contributions.length) options.emitter.emit({ type: "contributions:empty" });
    for (const item of result.contributions)
      options.emitter.emit({
        type: "contributions:entry",
        id: item.id,
        revision: item.revision,
        kind: item.kind,
        contributionKind: item.contributionKind,
        status: item.status,
        note: item.target.path,
        contributor: item.attribution.id,
        statement: item.statement,
        reviewId: item.proposalId,
        reason: item.dispositionReason,
      });
    if (result.nextCursor)
      options.emitter.emit({ type: "contributions:more", cursor: result.nextCursor });
    return 0;
  } catch (error) {
    if (!(error instanceof NoteApiError)) throw error;
    options.emitter.emit({ type: "error", code: error.code, message: error.message });
    return 1;
  } finally {
    await client.close();
  }
}

export function parseContributionKind(value: unknown): "contribution" | "feedback" | undefined {
  if (value === undefined) return undefined;
  if (value === "contribution" || value === "feedback") return value;
  throw new Error("INVALID_PARAMS: --kind must be contribution or feedback");
}
