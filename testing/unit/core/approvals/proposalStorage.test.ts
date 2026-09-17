import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import {
  parseSelectedProposalEdge,
  parseStoredPendingProposal,
} from "../../../../src/core/approvals/proposalStorage";

const EDGE_ID = new RecordId("related_to", "0123456789abcdefabcd");
const FROM = new RecordId("note", "source00000000000001");
const TO = new RecordId("note", "target00000000000001");
const CREATED_AT = new DateTime(new Date("2026-08-29T12:00:00.000Z"));

function selected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EDGE_ID,
    in: FROM,
    out: TO,
    source: "user",
    class: "INFERRED",
    agent: "claude-code",
    confidence: 1,
    evidence: undefined,
    approved: false,
    applied: true,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function hydrated(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row = selected(overrides);
  const { in: fromId, out: toId, ...rest } = row;
  return {
    ...rest,
    fromId,
    toId,
    fromPath: "source.md",
    toPath: "target.md",
  };
}

describe("proposal storage provenance authority", () => {
  test("accepts an explicit user proposal attributed to one canonical client", () => {
    const edge = parseSelectedProposalEdge(selected(), "related_to", "pending");
    expect(edge).toMatchObject({
      source: "user",
      agent: "claude-code",
      confidence: 1,
      evidence: undefined,
      approved: false,
      applied: true,
    });

    const listed = parseStoredPendingProposal(hydrated(), "related_to");
    expect(listed).toMatchObject({
      source: "user",
      agent: "claude-code",
      confidence: 1,
      evidence: [],
    });
  });

  test.each([
    [{ agent: "Claude Code" }, "canonical authenticated client identity"],
    [{ agent: "" }, "canonical authenticated client identity"],
    [{ confidence: 0.99 }, "must have confidence 1"],
    [{ evidence: [new RecordId("chunk", "evidence00000000001")] }, "must not invent evidence"],
  ])("rejects malformed explicit user provenance %#", (overrides, message) => {
    expect(() => parseSelectedProposalEdge(selected(overrides), "related_to", "pending")).toThrow(
      message,
    );
  });

  test("retains strict source/agent and producer/table invariants for autonomous rows", () => {
    expect(() =>
      parseSelectedProposalEdge(
        selected({ source: "linker", agent: "synthesizer", confidence: 0.8 }),
        "related_to",
        "pending",
      ),
    ).toThrow("agent must exactly match");
    expect(() =>
      parseSelectedProposalEdge(
        selected({ source: "synthesizer", agent: "synthesizer", confidence: 0.8 }),
        "related_to",
        "pending",
      ),
    ).toThrow("may only author synthesizes");
    expect(() =>
      parseSelectedProposalEdge(
        selected({
          source: "contradictionHunter",
          agent: "contradictionHunter",
          confidence: 0.8,
        }),
        "related_to",
        "pending",
      ),
    ).toThrow("may only author contradicts");
  });
});
