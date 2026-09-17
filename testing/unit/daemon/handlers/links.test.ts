import { describe, expect, test } from "bun:test";
import { makeLinksSyncHandler } from "../../../../src/daemon/handlers/links";
import { rpcRequest } from "../../../rpcRequest";

describe("links.sync handler", () => {
  test("returns the approval service reconciliation counters", async () => {
    let calls = 0;
    const handler = makeLinksSyncHandler({
      approvalService: {
        reconcilePendingApplications: async () => {
          calls += 1;
          return { replayed: 3, abandoned: 0, failed: 1, deferred: 0 };
        },
      },
    });
    expect(await handler(rpcRequest())).toEqual({ ok: true, replayed: 3, abandoned: 0, failed: 1 });
    expect(calls).toBe(1);
  });

  test("does not translate reconciliation failures into a successful result", async () => {
    const handler = makeLinksSyncHandler({
      approvalService: {
        reconcilePendingApplications: async () => {
          throw new Error("writeback failed");
        },
      },
    });
    await expect(handler(rpcRequest())).rejects.toThrow("writeback failed");
  });
});
