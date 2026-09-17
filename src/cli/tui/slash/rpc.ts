import { RpcCallError } from "../rpc";

/** Render a thrown RPC/decoder failure without hiding its daemon or integrity code. */
export function formatError(error: unknown): string {
  if (error instanceof RpcCallError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return `unexpected non-Error failure (${typeof error})`;
}
