import { expect, test } from "bun:test";
import {
  assertToolApproval,
  toolApproval,
  toolApprovalPaths,
} from "../../../../src/core/chat/toolAuthority";
import type { SessionGrant } from "../../../../src/core/services/sessionGrants";

const paths = ["Notient/proposals/first.md", "Notient/proposals/second.md"];
const call = { id: "batch", name: "agent.distill", args: { path: paths[0], proposalPaths: paths } };
const grant: SessionGrant = {
  id: "agent_session:fixture",
  client: "codex",
  grantedAt: 0,
  expiresAt: 5000,
  allowedFolders: ["Notient/proposals/"],
  allowedTools: ["agent.distill"],
  maxWrites: 2,
  usedWrites: 2,
  revokedAt: null,
};
const checks = {
  authorizeIdentity: async () => {},
  grant: async () => grant,
  now: () => 1000,
  policy: async () => ({ approvalMode: "safe" as const, perTool: {} }),
};

test("batch authority retains its exact reservation across recovery and rejects old undercounted approvals", async () => {
  const proof = toolApproval(call, "codex", {
    kind: "session",
    id: grant.id,
    claimedWrite: 2,
    claimedWrites: 2,
  });
  await expect(assertToolApproval(proof, checks)).resolves.toBeUndefined();
  const oldProof = toolApproval(call, "codex", { kind: "session", id: grant.id, claimedWrite: 1 });
  await expect(assertToolApproval(oldProof, checks)).rejects.toThrow("scoped write grant");
  // A later unrelated claim cannot lend authority to the old multi-file intent.
  await expect(
    assertToolApproval(oldProof, {
      ...checks,
      grant: async () => ({ ...grant, usedWrites: 10, maxWrites: 10 }),
    }),
  ).rejects.toThrow("scoped write grant");
  await expect(
    assertToolApproval(proof, { ...checks, grant: async () => ({ ...grant, revokedAt: 900 }) }),
  ).rejects.toThrow("scoped write grant");
});

test("only the planned dedicated proposal batch defines multiple targets", () => {
  expect(toolApprovalPaths(call)).toEqual(paths);
  for (const proposalPaths of [
    [],
    [paths[0], paths[0]],
    [paths[0], "Outside.md"],
    [paths[0], "Notient/proposals/../secret.md"],
  ]) {
    expect(() => toolApprovalPaths({ ...call, args: { ...call.args, proposalPaths } })).toThrow();
  }
  expect(
    toolApprovalPaths({
      id: "single",
      name: "notes.create",
      args: { notePath: "Inbox/Thought.md", proposalPaths: paths },
    }),
  ).toEqual(["Inbox/Thought.md"]);
});
