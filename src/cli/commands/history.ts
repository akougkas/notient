import { historyIdSchema } from "../../api/history";
import { NoteApiError } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, type ClientOptions, connectClient } from "../client";
import type { Emitter } from "../output";
import { callApi } from "./api";

export interface HistoryCommandOptions {
  action: "list" | "undo";
  vaultPath: string;
  emitter: Emitter;
  clientIdentity?: string;
  historyId?: string;
  limit?: number;
  connect?: (options: ClientOptions) => Promise<ClientHandle>;
}

export async function runHistoryCommand(options: HistoryCommandOptions): Promise<number> {
  if (options.historyId) historyIdSchema.parse(options.historyId);
  const client = await (options.connect ?? connectClient)({
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    vaultPath: options.vaultPath,
    clientIdentity: options.clientIdentity,
  });
  try {
    if (options.action === "list") {
      const result = await callApi(client, "history.list", { limit: options.limit ?? 10 });
      if (!result.entries.length) options.emitter.emit({ type: "history:empty" });
      for (const entry of result.entries) options.emitter.emit({ type: "history:entry", ...entry });
      if (result.nextCursor)
        options.emitter.emit({ type: "history:more", cursor: result.nextCursor });
      return 0;
    }
    const id = options.historyId ?? (await latestUndoId(client));
    if (!id) throw new NoteApiError("NOT_FOUND", "no reversible history");
    const detail = await callApi(client, "history.get", { id });
    // Expose the exact target before submission so a lost reply can be inspected
    // and retried by id instead of accidentally choosing the next history entry.
    options.emitter.emit({ type: "history:undo_requested", id });
    const result = await callApi(client, "history.undo", {
      id,
      sources: detail.sources,
      idempotencyKey: `undo:${id}`,
    });
    options.emitter.emit({ type: "history:undone", entry: result.entry });
    return 0;
  } catch (error) {
    if (!(error instanceof NoteApiError)) throw error;
    options.emitter.emit({ type: "error", code: error.code, message: error.message });
    return 1;
  } finally {
    await client.close();
  }
}

export async function latestUndoId(client: ClientHandle): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const result = await callApi(client, "history.list", {
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const entry = result.entries.find(
      (entry) => entry.reversible && entry.undo?.completedAt == null,
    );
    if (entry) return entry.id;
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}

export function parseHistoryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200)
    throw new Error("INVALID_PARAMS: --limit must be an integer between 1 and 200");
  return parsed;
}
