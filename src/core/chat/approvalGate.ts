/**
 * Per-call approval gate for chat write tools.
 *
 * Every write-gated tool routes through `request(call, mode, preview, signal,
 * context?)` before touching the vault. The gate evaluates three layers in
 * order:
 *
 *   1. Active session grants. When `SessionGrants.find` returns a row matching
 *      the call's `(client, tool, folder)`, the gate auto-approves, increments
 *      `usedWrites`, and stamps the decision with `sessionId` plus a
 *      `session-grant#<id>` reason so history can attribute the approval.
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

import type { SessionGrant, SessionGrantFindQuery } from "../services/sessionGrants";
import type { ApprovalMode, ToolCall } from "./types";

/**
 * Structural slice of `SessionGrants` covering only what the gate calls.
 * Carrying the slice (rather than the class) keeps tests cheap: harnesses can
 * assemble a stub literal without standing up a real database, and the live
 * `SessionGrants` instance from bootstrap satisfies it via duck typing.
 *
 * Phase 4 Task 12 widened the return shape to a Promise so the SurrealDB
 * implementation can satisfy it; tests that wire a synchronous stub remain
 * compatible because TypeScript accepts a sync return value where a Promise
 * is expected.
 */
export interface SessionGrantLookup {
  find(query: SessionGrantFindQuery): Promise<SessionGrant | null> | SessionGrant | null;
  incrementWriteCount(id: number): Promise<void> | void;
}

export interface PendingApproval {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
  resolve: (decision: ApprovalDecision) => void;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /**
   * Set only when a session grant covered the call. Carries the grant row id
   * so callers (history, audit log, smoke harnesses) can attribute the
   * auto-approval to a specific grant. Absent on user-prompt and per-tool
   * policy approvals.
   */
  sessionId?: number;
}

export interface ApprovalGateEvents {
  onPending: (pending: PendingApproval) => void;
  onResolved: (callId: string, decision: ApprovalDecision) => void;
}

/**
 * Per-invocation context the caller threads alongside the tool call. The gate
 * uses `clientIdentity` to look up active session grants; an absent value
 * defaults to `human` to match the T1 RPC envelope default.
 */
export interface ApprovalContext {
  clientIdentity?: string;
}

export interface ApprovalGateOptions {
  events: ApprovalGateEvents;
  /**
   * Yolo-mode hook. Tool implementations also write their own history rows on
   * success; this hook runs first so the history shows the auto-approval
   * decision even if the subsequent write fails.
   */
  recordHistoryAutoApprove: (call: ToolCall) => Promise<void>;
  /**
   * Per-tool override map. When the tool name is present, the override wins
   * over the conversation-level mode: `auto` skips the gate; `ask` engages
   * it even in yolo mode. Absent entries fall back to mode defaults
   * (safe -> ask, yolo -> auto). Bootstrap populates this from
   * `chat.perTool` settings.
   */
  perToolPolicy?: Record<string, "auto" | "ask">;
  /**
   * Session grant lookup service. The gate consults this before falling back
   * to per-tool policy or mode default. T7 ships the storage layer; T8 wires
   * it in here. Required so callers wanting to disable the layer must
   * intentionally pass a stub (e.g. one whose `find` always returns null)
   * rather than silently dropping the check.
   */
  sessionGrants: SessionGrantLookup;
  /**
   * Wall-clock source for grant expiry checks. Defaults to `Date.now`. Tests
   * inject a fixed value to make grant-expiry transitions deterministic.
   */
  now?: () => number;
}

/**
 * Returns the leading folder segment of a vault-relative path, with a
 * trailing slash, so it can be matched against `SessionGrants.find`'s prefix
 * test. The grant table normalizes `allowed_folders` entries to end in `/` at
 * insert time, so the comparison is a straight `String#startsWith` against
 * the value returned here.
 *
 * Examples:
 *   - "Inbox/today.md"             -> "Inbox/"
 *   - "Notient/agent-asks/auth.md" -> "Notient/"
 *   - "top.md" (file at root)      -> "" (only matches an "all folders" grant)
 *   - undefined / empty / non-str  -> ""
 *
 * Only the leading segment is returned. Grants therefore have to be issued
 * at top-folder granularity (e.g. `Notient/`) for the gate's lookup to find
 * them; finer grants like `Notient/agent-asks/` are intentionally narrower
 * than this one-segment lookup window. This keeps the gate's surface small
 * and predictable, and matches LD-6's "scope grants at the workspace folder"
 * intent.
 */
export function extractFolder(path?: string): string {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  if (trimmed.length === 0) return "";
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) return "";
  return trimmed.slice(0, slashIndex + 1);
}

/**
 * Reads a vault-relative path string from a tool call's args. Notient's
 * write-gated tools all expose the target path under `notePath`; the
 * `path` fallback exists for parity with external tool authors who may use
 * the shorter key. Anything that isn't a non-empty string returns undefined.
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
  private readonly pending = new Map<string, PendingApproval>();
  private readonly extraListeners = new Set<ApprovalGateEvents>();
  private readonly sessionGrants: SessionGrantLookup;
  private readonly now: () => number;

  constructor(private readonly options: ApprovalGateOptions) {
    this.sessionGrants = options.sessionGrants;
    this.now = options.now ?? Date.now;
  }

  /**
   * Register an additional listener for the duration of a chat turn. Returns
   * an unsubscribe function. The constructor-supplied `events` always fires;
   * extra listeners fire alongside without replacing it. The chat handler
   * uses this so each turn's NDJSON stream receives `loop:approval_pending`
   * and `loop:approval_resolved` frames scoped to the active envelope id.
   */
  subscribe(listener: ApprovalGateEvents): () => void {
    this.extraListeners.add(listener);
    return () => {
      this.extraListeners.delete(listener);
    };
  }

  private emitPending(pending: PendingApproval): void {
    this.options.events.onPending(pending);
    for (const listener of this.extraListeners) listener.onPending(pending);
  }

  private emitResolved(callId: string, decision: ApprovalDecision): void {
    this.options.events.onResolved(callId, decision);
    for (const listener of this.extraListeners) listener.onResolved(callId, decision);
  }

  policyFor(toolName: string, mode: ApprovalMode): "auto" | "ask" {
    const override = this.options.perToolPolicy?.[toolName];
    if (override !== undefined) return override;
    return mode === "yolo" ? "auto" : "ask";
  }

  async request(
    call: ToolCall,
    mode: ApprovalMode,
    preview: string,
    signal: AbortSignal,
    context?: ApprovalContext,
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      throw asAbortError();
    }
    // Sync-or-async lookup: existing test stubs return SessionGrant | null
    // synchronously; the SurrealDB-backed implementation returns a Promise.
    // Detect a Promise return so the synchronous fast path stays sync (the
    // pending-state assertion in approvalGate.test.ts samples
    // `gate.hasPending()` immediately after `gate.request(...)` returns and
    // depends on the request body running far enough to push into the
    // pending map without yielding to a microtask).
    const grantLookup = this.sessionGrants.find({
      client: context?.clientIdentity ?? "human",
      tool: call.name,
      folder: extractFolder(readPathArg(call.args)),
      now: this.now(),
    });
    const grant = grantLookup instanceof Promise ? await grantLookup : grantLookup;
    if (grant !== null) {
      const incrementResult = this.sessionGrants.incrementWriteCount(grant.id);
      if (incrementResult instanceof Promise) {
        await incrementResult;
      }
      const decision: ApprovalDecision = {
        approved: true,
        reason: `session-grant#${grant.id}`,
        sessionId: grant.id,
      };
      this.emitResolved(call.id, decision);
      return decision;
    }
    if (this.policyFor(call.name, mode) === "auto") {
      await this.options.recordHistoryAutoApprove(call);
      const decision: ApprovalDecision = { approved: true };
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
        resolve: (decision) => {
          if (!this.pending.has(call.id)) return;
          this.pending.delete(call.id);
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

  resolve(callId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    pending.resolve(decision);
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

  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
