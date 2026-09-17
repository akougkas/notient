import { describe, expect, test } from "bun:test";
import {
  buildProposalNotePlan,
  parseProposalNoteInput,
  proposalSlug,
} from "../../../../src/core/approvals/proposalNote";

describe("proposal note plan", () => {
  test("builds the canonical server-authored path and frontmatter", () => {
    const plan = buildProposalNotePlan({
      input: parseProposalNoteInput({
        title: "Auth: passkeys, not TOTP!",
        body: "because recovery",
        kind: "decision",
      }),
      proposedBy: "claude-code",
      now: Date.parse("2026-03-04T09:15:00.000Z"),
    });

    expect(plan.path).toBe("Notient/proposals/2026-03-04-auth-passkeys-not-totp.md");
    expect(plan.content).toContain('title: "Auth: passkeys, not TOTP!"');
    expect(plan.content).toContain('kind: "decision"');
    expect(plan.content).toContain('proposedBy: "claude-code"');
    expect(plan.content).toContain('proposedAt: "2026-03-04T09:15:00.000Z"');
    expect(plan.content).toEndWith("because recovery\n");
  });

  test("slug normalization is deterministic and capped", () => {
    expect(proposalSlug("  Hello, World!  ")).toBe("hello-world");
    expect(proposalSlug("###")).toBe("untitled");
    expect(proposalSlug("a".repeat(80))).toBe("a".repeat(60));
    expect(proposalSlug(`${"b".repeat(59)} tail`)).toBe("b".repeat(59));
  });

  test.each([
    [{ title: "", body: "x" }, "title"],
    [{ title: " padded ", body: "x" }, "title"],
    [{ title: "line\nbreak", body: "x" }, "title"],
    [{ title: "x", body: 1 }, "body"],
    [{ title: "x", body: "nul\u0000byte" }, "body"],
    [{ title: "x", body: "y", kind: "Not Valid" }, "kind"],
    [{ title: "x", body: "y", extra: true }, "exactly"],
  ])("rejects malformed proposal input %#", (raw, message) => {
    expect(() => parseProposalNoteInput(raw)).toThrow(message);
  });

  test("rejects forged identity and clock inputs", () => {
    const input = parseProposalNoteInput({ title: "x", body: "y" });
    expect(() => buildProposalNotePlan({ input, proposedBy: "human\nforged", now: 0 })).toThrow(
      "authenticated client identity",
    );
    expect(() => buildProposalNotePlan({ input, proposedBy: "human", now: -1 })).toThrow(
      "non-negative safe integer",
    );
  });
});
