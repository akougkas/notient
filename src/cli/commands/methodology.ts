import { operationInputs } from "../../api/operations";
import { NoteApiError, notePathSchema } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { connectClient } from "../client";
import type { Emitter } from "../output";
import { callApi } from "./api";

export interface MethodologySuggestionCommandOptions {
  vaultPath: string;
  notePath: string;
  candidateLimit?: number;
  idempotencyKey?: string;
  clientIdentity?: string;
  emitter: Emitter;
  signal?: AbortSignal;
}

export async function runMethodologySuggestionCommand(
  options: MethodologySuggestionCommandOptions,
): Promise<number> {
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    const path = notePathSchema.parse(options.notePath);
    const candidateLimit = operationInputs["methodology.suggest"].shape.candidateLimit.parse(
      options.candidateLimit,
    );
    client = await connectClient({
      vaultPath: options.vaultPath,
      socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
      clientIdentity: options.clientIdentity,
      signal: options.signal,
    });
    const source = (await callApi(client, "notes.read", { path })).note;
    const result = await callApi(client, "methodology.suggest", {
      source,
      candidateLimit,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    options.emitter.emit({ type: "api:result", operation: "methodology.suggest", ...result });
    return 0;
  } catch (error) {
    if (error instanceof NoteApiError) {
      options.emitter.emit({ type: "error", code: error.code, message: error.message });
      return 1;
    }
    throw error;
  } finally {
    await client?.close().catch(() => {});
  }
}
