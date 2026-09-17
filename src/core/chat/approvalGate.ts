import { assertInferenceBudgetAvailable } from "../llm/executionBudget";
/**
 * Per-call approval gate for chat write tools.
 *
 * Every write-gated tool routes through `request(call, mode, preview, signal,
 * context)` before touching the vault. The gate evaluates three layers in
 * order:
 *
 *   1. Active session grants. `SessionGrants.claim` atomically reserves each
 *      planned write from a row matching `(client, tool, folder)`, and the gate stamps
 *      the decision with `sessionId` so downstream
 *      audit records can attribute the approval.
 *   2. Per-tool policy overrides (`auto` / `ask`).
 *   3. Conversation-level mode default (`safe` -> ask, `yolo` -> auto).
 *
 * Expired, revoked, or exhausted grants degrade to layers 2 and 3 unchanged.
 * In `safe` mode (after layers 1 and 2 fall through) the promise blocks until
 * the UI calls `resolve(callId, decision)`; in `yolo` mode it auto-approves
 * and records to the history table for one-click undo.
 *
 * Aborting the per-call signal rejects the pending promise with an AbortError
 * and removes the entry from the pending map so the UI does not leak a card.
 */

import type { SessionGrant, SessionGrantClaimQuery } from "../services/sessionGrants";
import {
  type ApprovalOperator,
  type ToolApproval,
  toolApproval,
  toolApprovalPaths,
} from "./toolAuthority";
import type { ApprovalMode, ToolCall } from "./types";

/**
 * Structural slice of `SessionGrants` covering only what the gate calls.
 * Carrying the slice (rather than the class) keeps tests cheap while retaining
 * the same asynchronous contract as the live SurrealDB implementation.
 */
export interface SessionGrantLookup {
  claim(query: SessionGrantClaimQuery): Promise<SessionGrant | null>;
}

export interface PendingApproval {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
  /** Principal id whose turn parked this call. Attribution only. */
  requestedBy: string;
  /** Wall-clock ms at which the call entered the pending map. */
  requestedAt: number;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * Read-only projection of a pending entry for the `approvals.pending` RPC.
 * Deliberately omits `resolve` (a capability) and `args` (unbounded tool
 * payload); the target path is lifted out of `args` instead.
 */
export interface PendingApprovalView {
  callId: string;
  toolName: string;
  preview: string;
  path: string | null;
  requestedBy: string;
  requestedAt: number;
}

export type ApprovalDecision =
  | {
      approved: true;
      /** Rejection reasons do not belong on an accepted decision. */
      reason?: never;
      /** Session grant that authorized this decision, when applicable. */
      sessionId?: string;
    }
  | {
      approved: false;
      /** Non-empty explanation returned to the parked tool caller. */
      reason: string;
      sessionId?: never;
    };

/*
 * A decision is deliberately discriminated rather than `{ approved: boolean,
 * reason?: string }`: accepting a free-floating reason on approvals made the
 * UI promise an audit note that no durable write path consumed.
 */

export interface ApprovalGateEvents {
  onPending: (pending: PendingApproval) => void;
  onResolved: (callId: string, decision: ApprovalDecision) => void;
}

/**
 * Authenticated per-invocation context. Requiring the identity at the gate
 * boundary prevents unattributed writes and accidental human impersonation.
 */
export interface ApprovalContext {
  clientIdentity: string;
}

export interface ApprovalGateOptions {
  /**
   * Persists a yolo-mode decision before the approved tool starts its write.
   * Tool implementations record their own resulting mutations separately.
   */
  recordHistoryAutoApprove: (call: ToolCall) => Promise<void>;
  /**
   * Per-tool override map. When the tool name is present, the override wins
   * over the conversation-level mode: `auto` skips the gate; `ask` engages
   * it even in yolo mode. Absent entries fall back to mode defaults
   * (safe -> ask, yolo -> auto). Bootstrap populates this from
   * `chat.perTool` settings.
   */
  perToolPolicy: () => Record<string, "auto" | "ask">;
  authorize?: (approval: ToolApproval) => Promise<void>;
  /**
   * Session grant lookup service. The gate consults this before falling back
   * to per-tool policy or mode default. Callers wanting to disable the layer
   * must intentionally pass a stub whose `claim` always returns null.
   */
  sessionGrants: SessionGrantLookup;
  /**
   * Wall-clock source for grant expiry checks. Defaults to `Date.now`. Tests
   * inject a fixed value to make grant-expiry transitions deterministic.
   */
  now?: () => number;
}

/**
 * Returns the parent folder prefix of a vault-relative path, with a trailing
 * slash, so it can be matched against `SessionGrants.claim`'s prefix test. The
 * grant table normalizes `allowed_folders` entries to end in `/` at insert
 * time, so the comparison is a straight `String#startsWith` against the value
 * returned here.
 *
 * Examples:
 *   - "Inbox/today.md"             -> "Inbox/"
 *   - "Notient/agent-asks/auth.md" -> "Notient/agent-asks/"
 *   - "top.md" (file at root)      -> "" (only matches an "all folders" grant)
 *   - undefined / empty / non-str  -> ""
 *
 * Returning the full parent path lets operators scope unattended writes to a
 * narrow workspace such as `Notient/live-battle-test/` while broader grants
 * like `Notient/` still match nested writes through the service-side prefix
 * comparison.
 */
export function extractFolder(path?: string): string {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  if (trimmed.length === 0) return "";
  const slashIndex = trimmed.lastIndexOf("/");
  if (slashIndex < 0) return "";
  return trimmed.slice(0, slashIndex + 1);
}

/**
 * Reads the vault-relative target from canonical write-tool arguments.
 * Notes tools use `notePath`; batch distillation uses `path`. Anything that
 * is not a non-empty string returns undefined.
 */
function readPathArg(args: Record<string, unknown>): string | undefined {
  const notePath = args.notePath;
  if (typeof notePath === "string" && notePath.length > 0) return notePath;
  const path = args.path;
  if (typeof path === "string" && path.length > 0) return path;
  return undefined;
}

function asAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export class ApprovalGate {
  private readonly authorities = new WeakMap<ApprovalDecision, ToolApproval>();
  private readonly operators = new Map<string, ApprovalOperator>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<ApprovalGateEvents>();
  private readonly sessionGrants: SessionGrantLookup;
  private readonly now: () => number;

  constructor(private readonly options: ApprovalGateOptions) {
    this.sessionGrants = options.sessionGrants;
    this.now = options.now ?? Date.now;
  }

  /**
   * Register a listener for pending and resolved decisions. Returns an
   * unsubscribe function. Chat turns and non-blocking RPC handlers both use
   * this single delivery plane.
   */
  subscribe(listener: ApprovalGateEvents): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitPending(pending: PendingApproval): void {
    for (const listener of this.listeners) listener.onPending(pending);
  }

  private emitResolved(callId: string, decision: ApprovalDecision): void {
    for (const listener of this.listeners) listener.onResolved(callId, decision);
  }

  policyFor(toolName: string, mode: ApprovalMode): "auto" | "ask" {
    const override = this.options.perToolPolicy()[toolName];
    if (override !== undefined) return override;
    return mode === "yolo" ? "auto" : "ask";
  }

  async request(
    call: ToolCall,
    mode: ApprovalMode,
    preview: string,
    signal: AbortSignal,
    context: ApprovalContext,
  ): Promise<ApprovalDecision> {
    assertApprovalContext(context);
    assertNotAborted(signal);
    const paths = toolApprovalPaths(call);
    const writeCount = Math.max(1, paths.length);
    const grant = await awaitUnlessAborted(
      this.sessionGrants.claim({
        client: context.clientIdentity,
        tool: call.name,
        folder: extractFolder(readPathArg(call.args)),
        now: this.now(),
        writeCount,
      }),
      signal,
    );
    assertNotAborted(signal);
    if (grant !== null) {
      if (grant.usedWrites < writeCount)
        throw new Error("session grant did not reserve the complete write allowance");
      const decision: ApprovalDecision = {
        approved: true,
        sessionId: grant.id,
      };
      this.authorities.set(
        decision,
        toolApproval(call, context.clientIdentity, {
          kind: "session",
          id: grant.id,
          claimedWrite: grant.usedWrites,
          claimedWrites: writeCount,
        }),
      );
      this.emitResolved(call.id, decision);
      return decision;
    }
    if (this.policyFor(call.name, mode) === "auto") {
      await awaitUnlessAborted(this.options.recordHistoryAutoApprove(call), signal);
      assertNotAborted(signal);
      const decision: ApprovalDecision = { approved: true };
      this.authorities.set(
        decision,
        toolApproval(call, context.clientIdentity, { kind: "policy" }),
      );
      this.emitResolved(call.id, decision);
      return decision;
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(call.id);
        signal.removeEventListener("abort", onAbort);
        reject(asAbortError());
      };
      const pending: PendingApproval = {
        callId: call.id,
        toolName: call.name,
        args: call.args,
        preview,
        requestedBy: context.clientIdentity,
        requestedAt: this.now(),
        resolve: (decision) => {
          if (!this.pending.has(call.id)) return;
          this.pending.delete(call.id);
          const operator = this.operators.get(call.id);
          this.operators.delete(call.id);
          if (decision.approved && operator)
            this.authorities.set(
              decision,
              toolApproval(call, context.clientIdentity, { kind: "human", operator }),
            );
          signal.removeEventListener("abort", onAbort);
          this.emitResolved(call.id, decision);
          resolve(decision);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(call.id, pending);
      this.emitPending(pending);
    });
  }

  resolve(callId: string, decision: ApprovalDecision, operator?: ApprovalOperator): boolean {
    const pending = this.pending.get(callId);
    if (!pending) return false;
    if (decision.approved) {
      if (!operator || operator.kind !== "human" || !operator.scopes.includes("admin"))
        throw new Error("tool approval requires an authenticated human administrator");
      this.operators.set(callId, structuredClone(operator));
    }
    pending.resolve(decision);
    return true;
  }

  writeGuard(
    decision: ApprovalDecision,
    signal: AbortSignal,
  ): { toolApproval: ToolApproval; authorize: () => Promise<void> } {
    const proof = this.authorities.get(decision);
    if (!decision.approved || !proof) throw new Error("write lacks a gate-issued approval");
    return {
      toolApproval: structuredClone(proof),
      authorize: async () => {
        signal.throwIfAborted();
        await this.options.authorize?.(proof);
        signal.throwIfAborted();
        assertInferenceBudgetAvailable();
      },
    };
  }

  /**
   * Cancel every pending approval at once. Each waiting promise resolves with
   * `{ approved: false, reason }` so callers can observe the cancellation
   * without a try/catch. Used when the chat turn is aborted while a tool call
   * is still parked at the approval gate.
   */
  cancelAll(reason = "cancelled"): void {
    const entries = Array.from(this.pending.values());
    for (const entry of entries) {
      entry.resolve({ approved: false, reason });
    }
  }

  list(): PendingApproval[] {
    return Array.from(this.pending.values());
  }

  /**
   * Snapshot of what is parked at the gate, oldest first, with no
   * capability handles attached. Pure read: it never resolves, removes, or
   * re-emits an entry, so an RPC poll cannot disturb a waiting turn.
   */
  listPending(): PendingApprovalView[] {
    return Array.from(this.pending.values())
      .map((entry) => ({
        callId: entry.callId,
        toolName: entry.toolName,
        preview: entry.preview,
        path: readPathArg(entry.args) ?? null,
        requestedBy: entry.requestedBy,
        requestedAt: entry.requestedAt,
      }))
      .sort((left, right) => left.requestedAt - right.requestedAt);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}

function assertApprovalContext(context: ApprovalContext): void {
  if (
    context === undefined ||
    typeof context.clientIdentity !== "string" ||
    context.clientIdentity.trim().length === 0
  ) {
    throw new Error("approval request requires an authenticated clientIdentity");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw asAbortError();
}

function awaitUnlessAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(asAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
