/**
 * Run a write invocation without making an RPC caller wait for a human.
 *
 * ApprovalGate registers and emits a pending approval before `request()`
 * starts waiting for its decision. Subscribing first lets an RPC handler race
 * the invocation against that event:
 *
 *   - policy and session-grant approvals complete inline;
 *   - a human decision returns `pending` immediately while the invocation
 *     remains alive and performs the write only if it is later approved.
 *
 * The invocation promise always has a rejection observer because a parked
 * call can fail after its originating RPC request has already completed.
 */

import type { ApprovalGate } from "../../core/chat/approvalGate";

export type NonBlockingApprovalOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "pending"; preview: string };

export interface NonBlockingApprovalInvocation<T> {
  approvalGate: ApprovalGate;
  callId: string;
  invoke: (signal: AbortSignal) => Promise<T>;
  tracker: NonBlockingApprovalTracker | undefined;
}

type TrackedState = "starting" | "pending" | "running";

interface TrackedInvocation {
  completion: Promise<unknown>;
  classified: Promise<void>;
  resolveClassified(): void;
  state: TrackedState;
}

/** Process-wide fence for write invocations that outlive their originating RPC. */
export class NonBlockingApprovalTracker {
  private readonly invocations = new Map<string, TrackedInvocation>();
  private accepting = true;

  track(callId: string, completion: Promise<unknown>): void {
    if (!this.accepting) throw new Error("non-blocking approval admission is paused");
    if (this.invocations.has(callId)) {
      throw new Error(`duplicate non-blocking approval call id: ${callId}`);
    }
    let resolveClassified = (): void => {};
    const classified = new Promise<void>((resolve) => {
      resolveClassified = resolve;
    });
    const entry: TrackedInvocation = {
      completion,
      classified,
      resolveClassified,
      state: "starting",
    };
    this.invocations.set(callId, entry);
    void completion.then(
      () => this.finish(callId, entry),
      () => this.finish(callId, entry),
    );
  }

  markPending(callId: string): void {
    const entry = this.invocations.get(callId);
    if (entry === undefined) return;
    entry.state = "pending";
    entry.resolveClassified();
  }

  markResolved(callId: string): void {
    const entry = this.invocations.get(callId);
    if (entry === undefined) return;
    entry.state = "running";
    entry.resolveClassified();
  }

  /**
   * Close admission, classify every invocation, and drain approved/rejected
   * work. Parked human decisions are reported instead of awaited forever.
   */
  async pauseAndDrain(): Promise<number> {
    this.accepting = false;
    while (this.invocations.size > 0) {
      const snapshot = [...this.invocations.entries()];
      await Promise.all(snapshot.map(([, entry]) => entry.classified));
      const parked = snapshot.filter(
        ([callId, entry]) => this.invocations.get(callId) === entry && entry.state === "pending",
      ).length;
      if (parked > 0) return parked;
      await Promise.allSettled(snapshot.map(([, entry]) => entry.completion));
    }
    return 0;
  }

  resume(): void {
    this.accepting = true;
  }

  private finish(callId: string, entry: TrackedInvocation): void {
    entry.resolveClassified();
    if (this.invocations.get(callId) === entry) this.invocations.delete(callId);
  }
}

/**
 * Permanently close delayed-write admission during daemon shutdown. Parked
 * decisions are rejected through ApprovalGate, while already-approved
 * continuations are allowed to finish and are fully drained before the
 * database transport can close.
 */
export async function shutdownNonBlockingApprovals(
  tracker: NonBlockingApprovalTracker,
  approvalGate: Pick<ApprovalGate, "cancelAll">,
): Promise<void> {
  // Calling pauseAndDrain closes tracker admission synchronously before its
  // first await. Cancel the entire gate immediately afterwards so blocking
  // chat approvals as well as detached non-blocking approvals are released.
  const draining = tracker.pauseAndDrain();
  approvalGate.cancelAll("daemon_shutdown");
  await draining;
  const stillParked = await tracker.pauseAndDrain();
  if (stillParked > 0) {
    throw new Error(`shutdown could not cancel ${stillParked} parked approval invocation(s)`);
  }
}

export async function invokeWithNonBlockingApproval<T>(
  options: NonBlockingApprovalInvocation<T>,
): Promise<NonBlockingApprovalOutcome<T>> {
  const pending = watchForPending(options.approvalGate, options.callId, options.tracker);
  const controller = new AbortController();
  const invocation = Promise.resolve()
    .then(() => options.invoke(controller.signal))
    .finally(pending.cancel);
  try {
    options.tracker?.track(options.callId, invocation);
  } catch (error) {
    controller.abort();
    pending.cancel();
    invocation.catch(() => {});
    throw error;
  }

  // A pending invocation settles after this function has returned. Attach a
  // rejection observer now so a later adapter or history failure cannot
  // become an unhandled daemon rejection.
  invocation.catch(() => {});

  return await Promise.race([
    invocation.then((value) => ({ kind: "completed" as const, value })),
    pending.promise.then((preview) => ({ kind: "pending" as const, preview })),
  ]);
}

/** Resolve once, and only for the approval belonging to this invocation. */
function watchForPending(
  gate: ApprovalGate,
  callId: string,
  tracker: NonBlockingApprovalTracker | undefined,
): { promise: Promise<string>; cancel: () => void } {
  let unsubscribe = (): void => {};
  let resolvePending: ((preview: string) => void) | null = null;
  const promise = new Promise<string>((resolve) => {
    resolvePending = resolve;
  });

  unsubscribe = gate.subscribe({
    onPending: (entry) => {
      if (entry.callId !== callId) return;
      tracker?.markPending(callId);
      resolvePending?.(entry.preview);
    },
    onResolved: (resolvedCallId) => {
      if (resolvedCallId === callId) tracker?.markResolved(callId);
    },
  });

  return { promise, cancel: unsubscribe };
}
