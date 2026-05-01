import { describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { buildAgentToolRegistry } from "../../../src/agent/toolBundle";
import type { ApprovalService } from "../../../src/core/approvals/approvalService";
import { ApprovalGate } from "../../../src/core/chat/approvalGate";
import type { Agent, AgentRunResult } from "../../../src/core/coordinator/types";
import { EventBus } from "../../../src/core/events/eventBus";
import type { SearchPipeline } from "../../../src/core/search/searchPipeline";
import type { VitalsService } from "../../../src/core/vitals/vitalsService";

function noopAgent(name: Agent["name"]): Agent {
  return {
    name,
    usesReasoningModel: false,
    run: async (): Promise<AgentRunResult> => ({ proposals: 0 }),
  };
}

function makeDeps(): Parameters<typeof buildAgentToolRegistry>[0] {
  return {
    db: {} as Surreal,
    searchPipeline: {} as SearchPipeline,
    vitalsService: {} as VitalsService,
    vaultFacade: { readNote: async () => "" },
    notesFacade: {
      readNote: async () => "",
      writeNote: async () => {},
      exists: async () => false,
    },
    approvalGate: new ApprovalGate({
      events: { onPending: () => {}, onResolved: () => {} },
      recordHistoryAutoApprove: async () => {},
      sessionGrants: { find: () => null, incrementWriteCount: () => {} },
    }),
    approvalService: {} as ApprovalService,
    hash: async () => "00",
    approvalMode: () => "yolo",
    recordHistory: async () => "history:fake-0",
    generateCallId: () => "call-1",
    contradictionHunter: noopAgent("contradictionHunter"),
    synthesizer: noopAgent("synthesizer"),
    clusterCache: null,
    bus: new EventBus(),
  };
}

describe("buildAgentToolRegistry", () => {
  test("registers all five tool packages", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("vault.search_notes");
    expect(names).toContain("vault.read_note");
    expect(names).toContain("vault.list_neighbors");
    expect(names).toContain("vault.get_vitals");
    expect(names).toContain("notes.create");
    expect(names).toContain("notes.append");
    expect(names).toContain("notes.replace_section");
    expect(names).toContain("notes.update_frontmatter");
    expect(names).toContain("proposals.list_pending");
    expect(names).toContain("proposals.get");
    expect(names).toContain("proposals.approve");
    expect(names).toContain("proposals.reject");
    expect(names).toContain("graph.find_path");
    expect(names).toContain("graph.list_clusters");
    expect(names).toContain("agents.contradiction_check");
    expect(names).toContain("agents.synthesize");
  });

  test("write-style tools are flagged writeGated", () => {
    const registry = buildAgentToolRegistry(makeDeps());
    expect(registry.isWriteGated("notes.create")).toBe(true);
    expect(registry.isWriteGated("notes.append")).toBe(true);
    expect(registry.isWriteGated("notes.replace_section")).toBe(true);
    expect(registry.isWriteGated("notes.update_frontmatter")).toBe(true);
    expect(registry.isWriteGated("proposals.approve")).toBe(true);
    expect(registry.isWriteGated("proposals.reject")).toBe(true);
    expect(registry.isWriteGated("proposals.list_pending")).toBe(false);
    expect(registry.isWriteGated("proposals.get")).toBe(false);
    expect(registry.isWriteGated("vault.search_notes")).toBe(false);
    expect(registry.isWriteGated("vault.read_note")).toBe(false);
    expect(registry.isWriteGated("graph.find_path")).toBe(false);
  });

  test("agents.* chat tools return Locked Decision 11 no-op result shapes", async () => {
    const registry = buildAgentToolRegistry(makeDeps());
    const contradictionTool = registry.get("agents.contradiction_check");
    if (!contradictionTool) throw new Error("missing agents.contradiction_check");
    const contradictionResult = await contradictionTool.invoke(
      { notePath: "a.md" },
      new AbortController().signal,
    );
    expect(contradictionResult).toEqual({ proposalsCount: 0, newProposals: [] });
    const synthesizeTool = registry.get("agents.synthesize");
    if (!synthesizeTool) throw new Error("missing agents.synthesize");
    const synthesizeResult = await synthesizeTool.invoke({}, new AbortController().signal);
    expect(synthesizeResult).toEqual({ proposalsCount: 0, newProposals: [] });
  });
});
