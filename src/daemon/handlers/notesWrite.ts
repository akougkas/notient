/**
 * `notes.write` RPC handler.
 *
 * One write verb for external agents (the MCP server), covering the same
 * four operations as the chat write tools. It does not re-implement or
 * rebuild them: it invokes the exact note tools registered once during
 * daemon bootstrap, so the
 * policy chain (session grant → per-tool policy → approval mode), the
 * previews, the history rows and the undo journal are identical to what a
 * chat turn produces.
 *
 * The one difference is timing. A chat turn blocks inside the agent loop
 * until the human answers; an RPC caller must not. So the handler mints a
 * unique call id, passes it to the tool through the per-invocation context,
 * and races the invocation against the gate's `onPending` for that id:
 *
 *   - auto-approved (grant or policy): the tool finishes inline and the
 *     handler returns `{ applied: true, path, historyId }`.
 *   - the gate wants a human: the handler returns
 *     `{ applied: false, pending: true, callId, preview }` immediately and
 *     leaves the invocation running. The pending entry is a normal gate
 *     entry, so the TUI lists it and `chat.approve` resolves it; the tool's
 *     own code then performs the write.
 *
 * That is why no `ApprovalGate.requestDeferred` was added: `request()`
 * already registers the pending entry synchronously and emits `onPending`
 * before it blocks, so the non-blocking shape is expressible without
 * touching the gate.
 */

import { VaultPathError } from "../../adapters/vaultAdapter";
import { NoteApiError } from "../../api/schema";
import type { ApprovalGate } from "../../core/chat/approvalGate";
import type { NotesWriteResult } from "../../core/chat/tools/notes";
import { type ToolRegistry, ToolValidationError, isObject } from "../../core/chat/tools/registry";
import { isCanonicalOrdinaryNotePath } from "../../core/vault/publicPath";
import { type MethodHandler, RpcError } from "../rpc";
import {
  type NonBlockingApprovalOutcome,
  type NonBlockingApprovalTracker,
  invokeWithNonBlockingApproval,
} from "./nonBlockingApproval";

export type NotesWriteOp = "create" | "append" | "replace_section" | "update_frontmatter";

export interface NotesWriteHandlerDeps {
  toolRegistry: ToolRegistry;
  approvalGate: ApprovalGate;
  approvalTracker?: NonBlockingApprovalTracker;
}

export type NotesWriteHandler = MethodHandler;

const OPS: ReadonlySet<string> = new Set([
  "create",
  "append",
  "replace_section",
  "update_frontmatter",
]);

interface ParsedNotesWrite {
  op: NotesWriteOp;
  toolName: string;
  args: Record<string, unknown>;
  path: string;
}

export function makeNotesWriteHandler(deps: NotesWriteHandlerDeps): NotesWriteHandler {
  let counter = 0;
  assertCanonicalWriteTools(deps.toolRegistry);

  return async ({ params, principal }) => {
    const parsed = parseNotesWriteParams(params);
    // The call id travels with this invocation so concurrent approvals cannot
    // exchange responses, previews, or pending-gate entries.
    const callId = `notes-write-${Date.now().toString(36)}-${counter++}`;
    let outcome: NonBlockingApprovalOutcome<unknown>;
    try {
      outcome = await invokeWithNonBlockingApproval({
        approvalGate: deps.approvalGate,
        tracker: deps.approvalTracker,
        callId,
        invoke: (signal) =>
          deps.toolRegistry.invoke(parsed.toolName, parsed.args, signal, {
            clientIdentity: principal.id,
            callId,
          }),
      });
    } catch (error) {
      throw toRpcError(error);
    }

    if (outcome.kind === "pending") {
      return {
        ok: true,
        applied: false,
        pending: true,
        callId,
        preview: outcome.preview,
        path: parsed.path,
      };
    }
    const result = readNotesWriteResult(outcome.value, parsed.toolName);
    if (result.applied && result.path !== parsed.path) {
      throw new Error(
        `notes.write integrity failure: ${parsed.toolName} returned path ${result.path} for ${parsed.path}`,
      );
    }
    if (!result.applied) {
      return {
        ok: true,
        applied: false,
        pending: false,
        reason: result.reason,
        path: parsed.path,
      };
    }
    return {
      ok: true,
      applied: true,
      path: result.path,
      sha: result.sha,
      historyId: result.historyId,
    };
  };
}

/** Invalid arguments and domain preconditions keep their typed RPC codes. */
function toRpcError(error: unknown): unknown {
  if (error instanceof ToolValidationError || error instanceof VaultPathError)
    return new RpcError("INVALID_PARAMS", error.message);
  if (error instanceof NoteApiError) return new RpcError(error.code, error.message);
  return error;
}

const CANONICAL_WRITE_TOOLS = [
  "notes.create",
  "notes.append",
  "notes.replace_section",
  "notes.update_frontmatter",
] as const;

function assertCanonicalWriteTools(registry: ToolRegistry): void {
  for (const name of CANONICAL_WRITE_TOOLS) {
    if (!registry.has(name) || !registry.isWriteGated(name)) {
      throw new Error(`notes.write requires canonical write-gated tool ${name}`);
    }
  }
}

function readNotesWriteResult(raw: unknown, toolName: string): NotesWriteResult {
  if (!isObject(raw) || typeof raw.applied !== "boolean") {
    throw new Error(`notes.write integrity failure: ${toolName} returned an invalid result`);
  }
  if (!raw.applied) {
    if (typeof raw.reason !== "string" || raw.reason.length === 0) {
      throw new Error(`notes.write integrity failure: ${toolName} returned an invalid refusal`);
    }
    return { applied: false, reason: raw.reason };
  }
  if (
    typeof raw.path !== "string" ||
    typeof raw.sha !== "string" ||
    typeof raw.historyId !== "string"
  ) {
    throw new Error(`notes.write integrity failure: ${toolName} returned an invalid receipt`);
  }
  return {
    applied: true,
    path: raw.path,
    sha: raw.sha,
    historyId: raw.historyId,
  };
}

/**
 * Maps the RPC envelope onto the tool's own arguments. The tool's strict
 * validator is the single authority for required revisions, selectors and
 * unexpected fields, so this layer never silently drops an argument.
 */
function parseNotesWriteParams(params: Record<string, unknown>): ParsedNotesWrite {
  const { op, path, ...rest } = params;
  if (typeof op !== "string" || !OPS.has(op)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "op must be one of create | append | replace_section | update_frontmatter",
    );
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new RpcError("INVALID_PARAMS", "path is required");
  }
  assertVaultRelative(path);
  if ("notePath" in rest) throw new RpcError("INVALID_PARAMS", "use path, not notePath");
  return {
    op: op as NotesWriteOp,
    toolName: `notes.${op}`,
    path,
    args: { notePath: path, ...rest },
  };
}

/**
 * Reject an escaping path before the gate ever sees it. `FsVault` enforces
 * the same rule (including symlink escapes) at write time; checking here
 * means an invalid path never produces an approval card.
 */
function assertVaultRelative(path: string): void {
  if (!isCanonicalOrdinaryNotePath(path)) {
    throw new RpcError(
      "INVALID_PARAMS",
      "path must be an exact writable public vault-relative Markdown note path outside Notient-owned artifact folders",
    );
  }
}
