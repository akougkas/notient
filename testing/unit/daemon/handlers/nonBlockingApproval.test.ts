import { describe, expect, test } from "bun:test";
import {
  NonBlockingApprovalTracker,
  shutdownNonBlockingApprovals,
} from "../../../../src/daemon/handlers/nonBlockingApproval";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("NonBlockingApprovalTracker", () => {
  test("reports a parked human decision instead of hanging maintenance", async () => {
    const tracker = new NonBlockingApprovalTracker();
    const work = deferred();
    tracker.track("parked", work.promise);
    tracker.markPending("parked");

    expect(await tracker.pauseAndDrain()).toBe(1);

    tracker.markResolved("parked");
    work.resolve();
    tracker.resume();
    expect(await tracker.pauseAndDrain()).toBe(0);
  });

  test("waits for an approved invocation's post-RPC write to finish", async () => {
    const tracker = new NonBlockingApprovalTracker();
    const work = deferred();
    tracker.track("approved", work.promise);
    tracker.markResolved("approved");
    let drained = false;
    const draining = tracker.pauseAndDrain().then((parked) => {
      drained = true;
      return parked;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    work.resolve();
    expect(await draining).toBe(0);
    expect(drained).toBe(true);
  });

  test("shutdown fences an already-approved continuation before teardown", async () => {
    const tracker = new NonBlockingApprovalTracker();
    const work = deferred();
    tracker.track("approved-at-shutdown", work.promise);
    tracker.markResolved("approved-at-shutdown");
    let shutdownFinished = false;
    let cancellations = 0;
    const shuttingDown = shutdownNonBlockingApprovals(tracker, {
      cancelAll: () => {
        cancellations += 1;
      },
    }).then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(cancellations).toBe(1);
    work.resolve();
    await shuttingDown;
    expect(shutdownFinished).toBe(true);
  });

  test("shutdown cancels parked decisions with the durable shutdown reason", async () => {
    const tracker = new NonBlockingApprovalTracker();
    const work = deferred();
    tracker.track("parked-at-shutdown", work.promise);
    tracker.markPending("parked-at-shutdown");
    const reasons: string[] = [];
    const shuttingDown = shutdownNonBlockingApprovals(tracker, {
      cancelAll: (reason) => {
        if (reason === undefined) throw new Error("shutdown cancellation reason is required");
        reasons.push(reason);
        tracker.markResolved("parked-at-shutdown");
        work.resolve();
      },
    });

    await shuttingDown;
    expect(reasons).toEqual(["daemon_shutdown"]);
  });
});
