import { type OperationInput, operationInputs } from "../../api/operations";
import {
  type ImplementedOperation,
  type OperationResult,
  operationOutputs,
} from "../../api/results";
import { NoteApiError, apiErrorCodeSchema } from "../../api/schema";
import { currentPlatform, resolveSocketPath } from "../../daemon/socket";
import { type ClientHandle, connectClient } from "../client";
import type { Emitter } from "../output";

/** Typed domain calls over the same authenticated local connection as CLI API. */
export async function callApi<Name extends ImplementedOperation>(
  client: ClientHandle,
  method: Name,
  input: OperationInput<Name>,
): Promise<OperationResult<Name>> {
  const params = operationInputs[method].parse(input);
  for await (const frame of client.call(method, params)) {
    if (frame.type === "error") {
      const code = apiErrorCodeSchema.safeParse(frame.code);
      throw new NoteApiError(
        code.success ? code.data : "INTERNAL_ERROR",
        typeof frame.message === "string" ? frame.message : `${method} failed`,
      );
    }
    if (frame.type === "result")
      return operationOutputs[method].parse(frame) as OperationResult<Name>;
  }
  throw new NoteApiError(
    "INTERNAL_ERROR",
    "daemon disconnected without a result; inspect the operation before retrying",
  );
}

/** Direct domain access for scripts; exactly the same validated API as HTTP. */
export async function runApiCommand(options: {
  vaultPath: string;
  method: string;
  input: unknown;
  emitter: Emitter;
  clientIdentity?: string;
  pairing?: boolean;
}): Promise<number> {
  const { method } = options;
  if (
    !Object.hasOwn(operationOutputs, method) &&
    !(options.pairing && ["pairing.create", "pairing.list", "pairing.revoke"].includes(method))
  )
    throw new Error("INVALID_PARAMS: unknown API operation");
  const input = options.pairing
    ? options.input
    : operationInputs[method as ImplementedOperation].parse(options.input);
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("INVALID_PARAMS: input must be an object");
  const client = await connectClient({
    vaultPath: options.vaultPath,
    socketPath: resolveSocketPath(options.vaultPath, currentPlatform()),
    clientIdentity: options.clientIdentity,
  });
  try {
    for await (const frame of client.call(method, input as Record<string, unknown>)) {
      if (frame.type === "error") {
        options.emitter.emit(frame);
        return 1;
      }
      if (frame.type === "result") {
        const result = options.pairing
          ? frame
          : operationOutputs[method as ImplementedOperation].parse(frame);
        options.emitter.emit({ ...result, type: "api:result", operation: method });
        return 0;
      }
    }
    throw new Error("daemon disconnected without a result; inspect the operation before retrying");
  } finally {
    await client.close();
  }
}
