import { describe, expect, test } from "bun:test";
import type { ApprovalService } from "../../../../../src/core/approvals/approvalService";
import {
  type ChangeToolsContext,
  makeChangeTools,
} from "../../../../../src/core/chat/tools/changes";
import type { ChangeCaller, ChangeService } from "../../../../../src/core/history/changeService";

const revision = "a".repeat(64);
const changes = [
  { kind: "append", source: { path: "Plan.md", revision }, text: "line\n" },
] as const;

function harness(authorizeIdentity: ChangeToolsContext["authorizeIdentity"] = () => {}) {
  const calls: Array<{ op: string; input: unknown; caller: ChangeCaller }> = [];
  const service = {
    preview: async (input: unknown, caller: ChangeCaller) => {
      calls.push({ op: "preview", input, caller });
      return {
        previewId: "p".repeat(64),
        revision: "b".repeat(64),
        effects: [
          {
            kind: "write",
            category: "body",
            relationship: null,
            path: "Plan.md",
            destination: null,
            before: "secret before",
            after: "secret after",
            beforeRevision: revision,
            afterRevision: "c".repeat(64),
            reason: "Append",
          },
        ],
        conflicts: [],
      };
    },
  } as unknown as ChangeService;
  const approvalService = {
    submitReview: async (input: unknown, caller: ChangeCaller) => {
      calls.push({ op: "submit", input, caller });
      return { id: "r".repeat(64), state: "pending", previewId: "p".repeat(64) };
    },
  } as unknown as ApprovalService;
  const [preview, submit] = makeChangeTools({
    changes: service,
    approvalService,
    authorizeIdentity,
  });
  return { calls, preview, submit };
}

const signal = new AbortController().signal;

describe("assistant change tools", () => {
  test("plans as the assistant's own agent principal with a content-derived key", async () => {
    const { calls, preview } = harness();
    const args = preview.validate({ changes });
    const first = await preview.invoke(args, signal, { clientIdentity: "human" });
    await preview.invoke(args, signal, { clientIdentity: "human" });
    expect(calls[0].caller).toEqual({
      id: "assistant:human",
      kind: "agent",
      scopes: ["read", "write"],
    });
    const keys = calls.map((call) => (call.input as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toMatch(/^chat-[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(first.applied).toBe(false);
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(first.effects[0]).toMatchObject({ path: "Plan.md", beforeRevision: revision });
  });

  test("rejects caller-chosen keys, evidence and unknown fields", () => {
    const { preview, submit } = harness();
    expect(() => preview.validate({ changes, idempotencyKey: "mine" })).toThrow();
    expect(() => preview.validate({ changes: [] })).toThrow();
    const request = { previewId: "p", previewRevision: revision, rationale: "why" };
    expect(() => submit.validate({ ...request, approve: true })).toThrow();
    expect(() => submit.validate({ ...request, rationale: " " })).toThrow();
    expect(submit.validate(request)).toEqual(request);
  });

  test("submits without evidence or approval and reports nothing applied", async () => {
    const { calls, submit } = harness();
    const result = await submit.invoke(
      { previewId: "p".repeat(64), previewRevision: revision, rationale: "why" },
      signal,
      { clientIdentity: "paired-abc" },
    );
    expect(result).toEqual({
      reviewId: "r".repeat(64),
      state: "pending",
      previewId: "p".repeat(64),
      applied: false,
    });
    expect(calls[0].caller.id).toBe("assistant:paired-abc");
    expect(calls[0].caller.kind).toBe("agent");
    expect(calls[0].input).toMatchObject({
      evidence: [],
      idempotencyKey: `chat-submit-${"p".repeat(64)}`,
    });
  });

  test("a revoked conversation principal or a scoped read-only turn reaches no service", async () => {
    const revoked = harness(() => {
      throw new Error("credential was revoked");
    });
    const args = revoked.preview.validate({ changes });
    await expect(
      revoked.preview.invoke(args, signal, { clientIdentity: "paired-abc" }),
    ).rejects.toThrow("revoked");
    const scoped = harness();
    await expect(
      scoped.preview.invoke(args, signal, { clientIdentity: "human", noteScope: {} }),
    ).rejects.toThrow("scope-limited");
    expect([...revoked.calls, ...scoped.calls]).toEqual([]);
  });
});
